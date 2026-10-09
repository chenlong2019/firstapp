import * as THREE from 'three'
import type { MissionWaypoint } from './drone-sim'
import type { DroneWorld } from './drone-world'

/**
 * 场景内航点编辑器:在三维场景里直接抓航点。
 *
 * 操作约定(与真机的"地图上编辑航线"对应,但这里是在三维场景里):
 * - **拖拽航点** = 在它当前高度的水平面内移动;
 * - **Shift + 拖拽** = 改高度(按屏幕纵向映射到竖直平面);
 * - **Alt** = 暂时关掉 1 米吸附,做微调;
 * - **双击地面** = 在该处插入一个航点(高度取相邻航点);
 * - **选中后 Delete** = 删除该航点;**Esc** = 取消选中。
 *
 * 编辑只改"航点数据",飞行逻辑一行都不碰 —— 允许编辑的前提是任务未执行(内核也会再拦一次)。
 */
/** 拖拽模式:move=在当前高度的水平面内平移,altitude=改高度(Shift 拖拽) */
export type MissionDragMode = 'move' | 'altitude'

/** 编辑界限:home 位置用于限距判定,高度/距离上限由仿真内核下发(单位:米) */
export interface MissionEditLimits {
  maxAltitude: number
  maxDistance: number
  homeX: number
  homeZ: number
}

/** 编辑器对外状态快照:enabled 是面板开关,active 还需「当前确实可编辑」(观察者视角 + 任务未执行) */
export interface MissionEditState {
  /** 面板开关 */
  enabled: boolean
  /** 开关开着且当前确实可编辑(观察者视角 + 任务未执行) */
  active: boolean
  selectedIndex: number
  hoverIndex: number
  dragging: boolean
  mode: MissionDragMode | null
}

/**
 * 编辑器依赖的宿主接口:航点数据以仿真内核为权威源,编辑器只通过它读写,
 * 因此这里不含任何三维标记的实现细节(标记由 world 负责重建)。
 */
export interface MissionEditorHost {
  canvas: HTMLCanvasElement
  camera: THREE.PerspectiveCamera
  world: DroneWorld
  /** 当前是否可编辑:观察者视角 + 航线未在执行 */
  canEdit(): boolean
  /** 航点列表(权威源 = 仿真内核) */
  getWaypoints(): MissionWaypoint[]
  getSelected(): number
  setSelected(index: number): void
  /** 整表提交(新增 / 删除):会重建三维标记 */
  commitWaypoints(waypoints: Array<Partial<MissionWaypoint>>, selected: number): void
  /** 拖动中的单点实时更新,返回夹紧后的航点(限高限距已生效) */
  moveWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null
  /** 拖动期间暂停/恢复轨道控制 */
  setOrbitEnabled(enabled: boolean): void
  getLimits(): MissionEditLimits
  /** 新航点的默认参数(继承相邻航点的高度与速度) */
  newWaypointTemplate(index: number): Partial<MissionWaypoint>
  log(level: 'info' | 'warn', text: string): void
}

/** 拖动判定阈值(像素):小于它算"点击选中"而不是拖动 */
const DRAG_THRESHOLD_PX = 3
/** 默认吸附步长(米);按住 Alt 时用微调步长 */
const SNAP_STEP = 1
const SNAP_STEP_FINE = 0.2

interface DragState {
  index: number
  mode: MissionDragMode
  pointerId: number
  startClientX: number
  startClientY: number
  /** 航点按下瞬间的坐标:拖动全程以它为基准做相对位移 */
  startX: number
  startZ: number
  startAltitude: number
  moved: boolean
  /**
   * 拖动参考面(水平面或竖直面)与"按下那一像素"的交点。
   *
   * ⚠️ 必须做相对位移:用户抓住的是光柱中段或地面环,那个像素的射线与参考面的交点
   * 并不在航点本体上 —— 直接拿交点当航点坐标,一按下去航点就会瞬移到指针位置。
   */
  plane: THREE.Plane
  refX: number
  refY: number
  refZ: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step
}

/**
 * 场景内航点编辑器:接管画布的指针/键盘事件,把拖拽、双击新增、删除等操作翻译成
 * 对宿主航点数据的修改。使用:构造传入宿主 → 每帧 update() → 面板开关 setEnabled()
 * → 卸载时 destroy()。具体操作约定见本文件顶部模块说明。
 */
export class MissionEditor {
  private readonly host: MissionEditorHost
  private enabled = false
  private hoverIndex = -1
  private drag: DragState | null = null
  /** 在空白处按下:抬手时若没拖动过就取消选中 */
  private emptyClick: { x: number; y: number } | null = null
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  /** 水平移动用的地面法线 */
  private readonly groundNormal = new THREE.Vector3(0, 1, 0)
  private readonly cameraForward = new THREE.Vector3()
  private readonly planeNormal = new THREE.Vector3()
  private readonly hitPoint = new THREE.Vector3()

  constructor(host: MissionEditorHost) {
    this.host = host
    const canvas = host.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('dblclick', this.onDoubleClick)
    window.addEventListener('keydown', this.onKeyDown)
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.cancelDrag()
      this.setHover(-1)
      this.host.canvas.style.cursor = ''
    }
  }

  /** 每帧校验:不可编辑时自动收摊(切成机载视角 / 任务开始执行都会走到这里) */
  update(): void {
    if (this.host.canEdit()) return
    if (this.drag) this.cancelDrag()
    if (this.hoverIndex >= 0) this.setHover(-1)
    // 不能编辑了就不该有"选中的航点"挂着高亮 —— 指针也点不动它了
    if (this.host.getSelected() >= 0) this.host.setSelected(-1)
  }

  getState(): MissionEditState {
    return {
      enabled: this.enabled,
      active: this.enabled && this.host.canEdit(),
      selectedIndex: this.host.getSelected(),
      hoverIndex: this.hoverIndex,
      dragging: this.drag !== null,
      mode: this.drag?.mode ?? null,
    }
  }

  destroy(): void {
    const canvas = this.host.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('pointerleave', this.onPointerLeave)
    canvas.removeEventListener('dblclick', this.onDoubleClick)
    window.removeEventListener('keydown', this.onKeyDown)
    this.cancelDrag()
    this.host.canvas.style.cursor = ''
  }

  // ————————————————————————————— 指针事件 —————————————————————————————

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.active() || event.button !== 0) return
    const index = this.pickWaypoint(event)
    if (index < 0) {
      // 空白处:可能是轨道旋转的开头,先不动选中,等抬手再决定
      this.emptyClick = { x: event.clientX, y: event.clientY }
      return
    }
    const waypoint = this.host.getWaypoints()[index]
    if (!waypoint) return
    this.emptyClick = null
    this.host.setSelected(index)
    this.drag = this.createDrag(event, index, waypoint)
    this.host.setOrbitEnabled(false)
    this.host.canvas.style.cursor = event.shiftKey ? 'ns-resize' : 'grabbing'
    try {
      this.host.canvas.setPointerCapture(event.pointerId)
    } catch {
      /* 指针已释放 */
    }
  }

  /** 建立拖动状态:按 Shift 决定拖水平面还是竖直面,并记下"按下那一像素"的参考点 */
  private createDrag(
    event: { clientX: number; clientY: number; shiftKey: boolean; pointerId: number },
    index: number,
    waypoint: MissionWaypoint,
  ): DragState {
    this.updateRaycaster(event.clientX, event.clientY)
    // 参考面高度至少取 1 米:航点贴地时,水平参考面若落在 y=0 或以下,求交会退化
    const planeY = Math.max(1, waypoint.altitude)
    const plane = new THREE.Plane()
    if (event.shiftKey) {
      const normal = this.cameraForward.set(0, 0, 0)
      this.host.camera.getWorldDirection(normal)
      this.planeNormal.set(normal.x, 0, normal.z)
      // 相机几乎垂直向下时水平分量退化(lengthSq≈0),回退到 +Z 法线,避免得到非法平面
      if (this.planeNormal.lengthSq() < 1e-4) this.planeNormal.set(0, 0, 1)
      this.planeNormal.normalize()
      this.hitPoint.set(waypoint.x, planeY, waypoint.z)
      plane.setFromNormalAndCoplanarPoint(this.planeNormal, this.hitPoint)
    } else {
      plane.setFromNormalAndCoplanarPoint(
        this.groundNormal,
        this.hitPoint.set(waypoint.x, planeY, waypoint.z),
      )
    }
    const ref = this.raycaster.ray.intersectPlane(plane, this.hitPoint)
    return {
      index,
      mode: event.shiftKey ? 'altitude' : 'move',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: waypoint.x,
      startZ: waypoint.z,
      startAltitude: waypoint.altitude,
      moved: false,
      plane,
      refX: ref?.x ?? waypoint.x,
      refY: ref?.y ?? planeY,
      refZ: ref?.z ?? waypoint.z,
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return
    const drag = this.drag
    if (!drag) {
      this.setHover(this.active() ? this.pickWaypoint(event) : -1)
      this.host.canvas.style.cursor = this.hoverIndex >= 0 ? 'grab' : ''
      return
    }
    if (!drag.moved) {
      const moved = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY)
      if (moved < DRAG_THRESHOLD_PX) return
      drag.moved = true
    }
    this.applyDrag(event, drag)
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    try {
      this.host.canvas.releasePointerCapture(event.pointerId)
    } catch {
      /* 没捕获过 */
    }
    const emptyClick = this.emptyClick
    this.emptyClick = null
    const drag = this.drag
    if (!drag) {
      if (
        emptyClick &&
        Math.hypot(event.clientX - emptyClick.x, event.clientY - emptyClick.y) < DRAG_THRESHOLD_PX
      ) {
        this.host.setSelected(-1)
      }
      return
    }
    this.drag = null
    this.host.setOrbitEnabled(true)
    this.host.canvas.style.cursor = this.hoverIndex >= 0 ? 'grab' : ''
    if (!drag.moved) return
    const waypoint = this.host.getWaypoints()[drag.index]
    if (!waypoint) return
    this.host.log(
      'info',
      `场景编辑:航点 ${drag.index + 1} 已更新为 E ${waypoint.x.toFixed(0)} / S ${waypoint.z.toFixed(0)} / 高度 ${waypoint.altitude.toFixed(1)} m`,
    )
  }

  private readonly onPointerLeave = (): void => {
    if (!this.drag) this.setHover(-1)
  }

  /** 双击地面新增航点(双击已有航点不做处理,避免误插一个重合点) */
  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (!this.active() || event.button !== 0) return
    if (this.pickWaypoint(event) >= 0) return
    this.updateRaycaster(event.clientX, event.clientY)
    const ground = this.host.world.pickMissionGround(this.raycaster)
    if (!ground) return
    const limits = this.host.getLimits()
    // 瞄到地平线附近时交点会跑到几公里外,先按限距拉回来
    const offsetX = ground.x - limits.homeX
    const offsetZ = ground.z - limits.homeZ
    const distance = Math.hypot(offsetX, offsetZ)
    let x = ground.x
    let z = ground.z
    if (distance > limits.maxDistance) {
      const scale = limits.maxDistance / distance
      x = limits.homeX + offsetX * scale
      z = limits.homeZ + offsetZ * scale
    }
    x = snap(x, SNAP_STEP)
    z = snap(z, SNAP_STEP)

    const list = this.host.getWaypoints()
    const at = this.findInsertIndex(list, x, z, limits.homeX, limits.homeZ)
    const template = this.host.newWaypointTemplate(at)
    const next: Array<Partial<MissionWaypoint>> = list.map((waypoint) => ({ ...waypoint }))
    next.splice(at, 0, { ...template, x, z })
    this.host.commitWaypoints(next, at)
    this.host.log(
      'info',
      `场景编辑:在 E ${x.toFixed(0)} / S ${z.toFixed(0)} 新增航点 ${at + 1}(双击地面新增)`,
    )
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return
    const target = event.target as HTMLElement | null
    if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
    if (event.key === 'Escape') {
      this.host.setSelected(-1)
      return
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return
    const index = this.host.getSelected()
    if (index < 0) return
    // 浏览器默认会拿 Backspace 当"后退",先拦掉
    event.preventDefault()
    this.deleteWaypoint(index)
  }

  /** 删除一个航点(面板按钮与 Delete 键共用) */
  deleteWaypoint(index: number): boolean {
    if (!this.host.canEdit()) return false
    const list = this.host.getWaypoints()
    if (index < 0 || index >= list.length) return false
    const next = list.filter((_, i) => i !== index).map((waypoint) => ({ ...waypoint }))
    this.host.commitWaypoints(next, Math.min(index, next.length - 1))
    this.host.log('info', `场景编辑:已删除航点 ${index + 1}`)
    return true
  }

  // ————————————————————————————— 拖拽求解 —————————————————————————————

  private applyDrag(event: PointerEvent, drag: DragState): void {
    this.updateRaycaster(event.clientX, event.clientY)
    const step = event.altKey ? SNAP_STEP_FINE : SNAP_STEP
    const hit = this.raycaster.ray.intersectPlane(drag.plane, this.hitPoint)
    if (drag.mode === 'move') {
      if (!hit) return
      this.host.moveWaypoint(drag.index, {
        x: snap(drag.startX + (hit.x - drag.refX), step),
        z: snap(drag.startZ + (hit.z - drag.refZ), step),
      })
      return
    }
    // 改高度:按屏幕纵向映射到"过航点的竖直平面"上;平面打不中时退回米/像素映射
    const altitude = hit
      ? drag.startAltitude + (hit.y - drag.refY)
      : drag.startAltitude - (event.clientY - drag.startClientY) * this.metersPerPixel(drag)
    this.host.moveWaypoint(drag.index, {
      altitude: clamp(snap(altitude, step), 1, this.host.getLimits().maxAltitude),
    })
  }

  /** 该航点所在距离上"一个屏幕像素"对应多少米(竖直面打不中时的兜底映射) */
  private metersPerPixel(drag: DragState): number {
    const camera = this.host.camera
    const distance = camera.position.distanceTo(
      this.hitPoint.set(drag.startX, drag.startAltitude, drag.startZ),
    )
    // 视锥在 distance 处的可见高度 = 2·tan(fov/2)·distance;再按画布像素高度折算成米/像素
    const height =
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance) /
      Math.max(0.01, camera.zoom)
    const rect = this.host.canvas.getBoundingClientRect()
    // 画布尚未布局(高度为 0)时给 0.2 米/像素的保守兜底,避免除零
    return rect.height > 0 ? height / rect.height : 0.2
  }

  // ————————————————————————————— 拾取 —————————————————————————————

  private active(): boolean {
    return this.enabled && this.host.canEdit()
  }

  private pickWaypoint(event: { clientX: number; clientY: number }): number {
    this.updateRaycaster(event.clientX, event.clientY)
    return this.host.world.pickMissionWaypoint(this.raycaster)
  }

  private updateRaycaster(clientX: number, clientY: number): void {
    const rect = this.host.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    // 屏幕像素 → 归一化设备坐标(NDC):y 轴要翻转(屏幕向下为正,NDC 向上为正)
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.host.camera)
  }

  private setHover(index: number): void {
    if (this.hoverIndex === index) return
    this.hoverIndex = index
    this.host.world.setMissionHover(index)
  }

  /**
   * 新航点插到哪个位置:取"绕路最少"的那一格。
   *
   * 判据是插入后航线增加的长度(prev→新点→next 减去原来的 prev→next),
   * 而不是"离哪一段最近" —— 后者在等距处会出现平手,可能把一个明明贴着前面航段的点
   * 插到后面去,航线就绕了。最小绕路法天然没有这个歧义。
   */
  private findInsertIndex(
    list: MissionWaypoint[],
    x: number,
    z: number,
    homeX: number,
    homeZ: number,
  ): number {
    const distance = (fromX: number, fromZ: number, toX: number, toZ: number): number =>
      Math.hypot(toX - fromX, toZ - fromZ)
    let bestIndex = 0
    let bestDetour = Number.POSITIVE_INFINITY
    for (let index = 0; index <= list.length; index += 1) {
      const previous = index === 0 ? null : list[index - 1]
      const next = list[index] ?? null
      const fromX = previous ? previous.x : homeX
      const fromZ = previous ? previous.z : homeZ
      const detour = next
        ? distance(fromX, fromZ, x, z) +
          distance(x, z, next.x, next.z) -
          distance(fromX, fromZ, next.x, next.z)
        : distance(fromX, fromZ, x, z) // 接到队尾:只看从上一个航点飞过去的距离
      // 减去 1e-6 容差:浮点上打成平手时保留更靠前的插入位,避免结果抖动
      if (detour < bestDetour - 1e-6) {
        bestDetour = detour
        bestIndex = index
      }
    }
    return bestIndex
  }

  private cancelDrag(): void {
    if (!this.drag) return
    this.drag = null
    this.host.setOrbitEnabled(true)
  }
}
