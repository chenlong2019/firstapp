import * as THREE from 'three'
import type { ObstacleBox } from './drone-sim'

/**
 * 飞行沙盒的场景辅助:地面网格、返航点标记、障碍物、航迹尾迹。
 *
 * 障碍物同时喂给仿真内核做避障判定(纯 AABB),所以可视化与物理用同一份数据,
 * 不会出现"看着撞上了但没刹停"这类不一致。
 */

/** 一个障碍物(AABB 盒)规格:x/z 为中心平面坐标,width/depth/height 单位为米,color 为 0xRRGGBB */
export interface ObstacleSpec {
  name: string
  label: string
  x: number
  z: number
  width: number
  depth: number
  height: number
  color: number
  /** 底面离地高度(米)。默认 0 = 落地障碍物;>0 = 悬空障碍物(天桥等),机体上方测距用 */
  baseY?: number
}

/** 默认障碍物:两组建筑 + 一根正前方灯杆 + 三棵树 + 一道悬空天桥,都在起飞点 30 米内 */
export const DEFAULT_OBSTACLES: ObstacleSpec[] = [
  {
    name: 'BUILDING_A',
    label: '建筑 A',
    x: 16,
    z: -12,
    width: 9,
    depth: 9,
    height: 13,
    color: 0x2c3a44,
  },
  {
    name: 'BUILDING_B',
    label: '建筑 B',
    x: -20,
    z: 10,
    width: 11,
    depth: 15,
    height: 7,
    color: 0x2a3740,
  },
  // 正前方细柱(灯杆,直径 0.3 m):验证"正前方中线"盲区是否真的被消除(两条镜头视场在中线重叠)。
  // 放 16m:在 18m 量程内,又不至于挡住起飞点正前方的平飞测试路径
  {
    name: 'LAMP_POST',
    label: '灯杆',
    x: 0,
    z: -16,
    width: 0.3,
    depth: 0.3,
    height: 8,
    color: 0x44535f,
  },
  // 悬空天桥:桥底离地 7.5 m,横跨起飞点后方(x 向 18 m 宽),用来演示机体上方的视觉测距
  {
    name: 'SKY_BRIDGE',
    label: '天桥',
    x: 0,
    z: 10.5,
    width: 18,
    depth: 6,
    height: 2,
    color: 0x3a4a55,
    baseY: 7.5,
  },
  {
    name: 'TREE_1',
    label: '树 1',
    x: 9,
    z: 14,
    width: 3.2,
    depth: 3.2,
    height: 6,
    color: 0x24443a,
  },
  {
    name: 'TREE_2',
    label: '树 2',
    x: -10,
    z: -17,
    width: 2.8,
    depth: 2.8,
    height: 4.6,
    color: 0x21403a,
  },
  { name: 'TREE_3', label: '树 3', x: 24, z: 7, width: 3, depth: 3, height: 5.4, color: 0x24443a },
]

/** 航线航点(可视化用):x/z 为水平坐标,altitude 为相对起飞点高度 */
export interface MissionMarker {
  x: number
  z: number
  altitude: number
}

/** 一个航点对应的三维标记节点:原位更新(场景里拖动)时逐项改这几个,不整层重建 */
interface MissionMarkerNode {
  group: THREE.Group
  /** 竖直光柱:几何体是"单位高度、底部对齐",用 scale.y 表示高度 */
  pillar: THREE.Mesh
  altitudeRing: THREE.Mesh
  label: THREE.Sprite
  /** 拾取体:沿光柱的一根不可见圆柱,点击光柱任意高度都能抓住航点 */
  pick: THREE.Mesh
}

/** 航迹缓冲最大点数:按每 0.25 m 取一点,2400 点约覆盖 600 m 航程,防止长航线把缓冲撑爆 */
const TRAIL_MAX_POINTS = 2400
/** 航点配色:普通航点青色,当前目标琥珀色(与雷达/返航点区分开) */
const MISSION_COLOR = 0x39d0b0
const MISSION_ACTIVE_COLOR = 0xffc53d
/** 场景编辑:选中航点亮青色,悬停航点淡白(与"当前目标"的琥珀色区分开) */
const MISSION_SELECT_COLOR = 0x9ef4ff
const MISSION_HOVER_COLOR = 0xdffbff
/** 航点拾取半径(米):光柱本体只有 7 cm,得给一个手好抓的粗管子 */
const MISSION_PICK_RADIUS = 1.7

/**
 * 场景辅助的创建与更新(见文件头):地面网格 / 返航点标记 / 障碍物 / 航迹,以及航线任务可视化。
 * 障碍物同时以 AABB 形式写入 collisionBoxes 供仿真避障使用,可视化与物理共用同一份数据。
 */
export class DroneWorld {
  private readonly scene: THREE.Scene
  private readonly group = new THREE.Group()
  private readonly homeMarker = new THREE.Object3D()
  private readonly obstacles: THREE.Object3D[] = []
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = []
  private readonly trailPositions: Float32Array
  private trailLine: THREE.Line | null = null
  private trailCount = 0
  private readonly lastTrailPoint = new THREE.Vector3(Number.NaN, 0, 0)

  // —— 航线任务可视化(航点标记 + 航线折线 + 当前目标 / 场景编辑高亮) ——
  private readonly missionGroup = new THREE.Group()
  /** 航点标记(地面环 / 光柱 / 高度环 / 序号牌),与航线折线分开控制显隐 */
  private readonly missionMarkerGroup = new THREE.Group()
  /** 航线折线 */
  private readonly missionPathGroup = new THREE.Group()
  private readonly missionActiveGroup = new THREE.Group()
  /** 场景编辑的选中高亮与悬停高亮 */
  private readonly missionSelectGroup = new THREE.Group()
  private readonly missionHoverGroup = new THREE.Group()
  /** 每次重建航点时产生的可释放资源(几何 / 贴图 / 材质) */
  private readonly missionDisposables: Array<
    THREE.BufferGeometry | THREE.Texture | THREE.Material
  > = []
  private readonly missionMarkerNodes: MissionMarkerNode[] = []
  /** 当前航点数据(原位更新时改它,并据此重算航线折线) */
  private readonly missionMarkers: MissionMarker[] = []
  private missionOrigin = { x: 0, z: 0 }
  private missionPathLine: THREE.Line | null = null
  private missionPathPositions: Float32Array | null = null
  private missionActiveAltitudeRing: THREE.Mesh | null = null
  private missionSelectAltitudeRing: THREE.Mesh | null = null
  private missionHoverAltitudeRing: THREE.Mesh | null = null
  /** 图层总开关 */
  private missionVisible = true
  /** 航点标记开关 */
  private missionMarkersVisible = true
  /** 航线折线开关 */
  private missionPathVisible = true
  private missionActiveIndex = -1
  private missionSelectIndex = -1
  private missionHoverIndex = -1
  /** 地面拾取用的水平面(y=0)与命中点缓存 */
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly groundHit = new THREE.Vector3()
  private readonly missionPillarMaterial = new THREE.MeshBasicMaterial({
    color: MISSION_COLOR,
    transparent: true,
    opacity: 0.26,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly missionRingMaterial = new THREE.MeshBasicMaterial({
    color: MISSION_COLOR,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly missionActiveMaterial = new THREE.MeshBasicMaterial({
    color: MISSION_ACTIVE_COLOR,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly missionSelectMaterial = new THREE.MeshBasicMaterial({
    color: MISSION_SELECT_COLOR,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly missionHoverMaterial = new THREE.MeshBasicMaterial({
    color: MISSION_HOVER_COLOR,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  })
  /** 拾取用的不可见材质:光柱太细,给每根航点套一个粗管子专门用来抓 */
  private readonly missionPickMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
  })

  readonly collisionBoxes: ObstacleBox[] = []
  readonly specs: ObstacleSpec[]

  constructor(scene: THREE.Scene, specs: ObstacleSpec[] = DEFAULT_OBSTACLES) {
    this.scene = scene
    this.specs = specs

    // —— 地面:超大底板 + 1 米细网格 + 100 米粗网格,给出明确尺度参照 ——
    const groundGeometry = new THREE.PlaneGeometry(4000, 4000)
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a1216,
      roughness: 0.95,
      metalness: 0.05,
    })
    this.disposables.push(groundGeometry, groundMaterial)
    const ground = new THREE.Mesh(groundGeometry, groundMaterial)
    ground.rotation.x = -Math.PI / 2
    // 略微下沉,避免与 y≈0 的细网格、返航点标记同面闪烁(z-fighting)
    ground.position.y = -0.012
    ground.receiveShadow = true
    this.group.add(ground)

    const fineGrid = new THREE.GridHelper(200, 200, 0x1d3d42, 0x143033)
    fineGrid.position.y = 0
    this.tintGrid(fineGrid, 0.55)
    this.group.add(fineGrid)

    const coarseGrid = new THREE.GridHelper(2000, 20, 0x2f6f72, 0x1f4a4d)
    // 抬高 4 mm 盖在细网格之上,避免两张网格同面闪烁
    coarseGrid.position.y = 0.004
    this.tintGrid(coarseGrid, 0.75)
    this.group.add(coarseGrid)

    // —— 返航点标记:地面上一个 H 环 + 竖直光柱 ——
    const ringGeometry = new THREE.RingGeometry(1.1, 1.5, 40)
    ringGeometry.rotateX(-Math.PI / 2)
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x6ff0d0,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.disposables.push(ringGeometry, ringMaterial)
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    ring.position.y = 0.02
    this.homeMarker.add(ring)

    const beaconGeometry = new THREE.CylinderGeometry(0.045, 0.045, 3, 8, 1, true)
    beaconGeometry.translate(0, 1.5, 0)
    const beaconMaterial = new THREE.MeshBasicMaterial({
      color: 0x6ff0d0,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    this.disposables.push(beaconGeometry, beaconMaterial)
    const beacon = new THREE.Mesh(beaconGeometry, beaconMaterial)
    beacon.position.y = 0.02
    this.homeMarker.add(beacon)
    this.group.add(this.homeMarker)

    // —— 障碍物(含悬空件:baseY > 0,如天桥) ——
    for (const spec of specs) {
      const baseY = spec.baseY ?? 0
      const geometry = new THREE.BoxGeometry(spec.width, spec.height, spec.depth)
      const material = new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: 0.8,
        metalness: 0.12,
      })
      this.disposables.push(geometry, material)
      const box = new THREE.Mesh(geometry, material)
      box.position.set(spec.x, baseY + spec.height / 2, spec.z)
      box.castShadow = true
      box.receiveShadow = true
      box.name = spec.name
      this.group.add(box)
      this.obstacles.push(box)

      this.collisionBoxes.push({
        name: spec.label,
        minX: spec.x - spec.width / 2,
        maxX: spec.x + spec.width / 2,
        minY: baseY,
        maxY: baseY + spec.height,
        minZ: spec.z - spec.depth / 2,
        maxZ: spec.z + spec.depth / 2,
        solid: true,
      })
    }

    // —— 航迹尾迹 ——
    this.trailPositions = new Float32Array(TRAIL_MAX_POINTS * 3)
    const trailGeometry = new THREE.BufferGeometry()
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3))
    trailGeometry.setDrawRange(0, 0)
    const trailMaterial = new THREE.LineBasicMaterial({
      color: 0x7fd8ff,
      transparent: true,
      opacity: 0.75,
      toneMapped: false,
    })
    this.disposables.push(trailGeometry, trailMaterial)
    this.trailLine = new THREE.Line(trailGeometry, trailMaterial)
    this.trailLine.frustumCulled = false
    this.group.add(this.trailLine)

    // —— 航线任务图层(空航线时不可见,内容由 setMissionWaypoints 填充) ——
    const activeGroundGeometry = new THREE.RingGeometry(2.5, 3.1, 40)
    activeGroundGeometry.rotateX(-Math.PI / 2)
    const activeGroundRing = new THREE.Mesh(activeGroundGeometry, this.missionActiveMaterial)
    activeGroundRing.position.y = 0.04
    this.missionActiveGroup.add(activeGroundRing)

    const activeAltitudeGeometry = new THREE.RingGeometry(1.25, 1.65, 28)
    activeAltitudeGeometry.rotateX(-Math.PI / 2)
    this.missionActiveAltitudeRing = new THREE.Mesh(
      activeAltitudeGeometry,
      this.missionActiveMaterial,
    )
    this.missionActiveGroup.add(this.missionActiveAltitudeRing)

    // 场景编辑高亮:选中(亮青,双层环)与悬停(淡白,细环)
    const selectGroundGeometry = new THREE.RingGeometry(2.3, 2.55, 40)
    selectGroundGeometry.rotateX(-Math.PI / 2)
    const selectGroundRing = new THREE.Mesh(selectGroundGeometry, this.missionSelectMaterial)
    selectGroundRing.position.y = 0.05
    this.missionSelectGroup.add(selectGroundRing)
    const selectAltitudeGeometry = new THREE.RingGeometry(1.15, 1.35, 28)
    selectAltitudeGeometry.rotateX(-Math.PI / 2)
    this.missionSelectAltitudeRing = new THREE.Mesh(
      selectAltitudeGeometry,
      this.missionSelectMaterial,
    )
    this.missionSelectGroup.add(this.missionSelectAltitudeRing)

    const hoverGroundGeometry = new THREE.RingGeometry(2.05, 2.2, 36)
    hoverGroundGeometry.rotateX(-Math.PI / 2)
    const hoverGroundRing = new THREE.Mesh(hoverGroundGeometry, this.missionHoverMaterial)
    hoverGroundRing.position.y = 0.05
    this.missionHoverGroup.add(hoverGroundRing)
    const hoverAltitudeGeometry = new THREE.RingGeometry(1.0, 1.12, 28)
    hoverAltitudeGeometry.rotateX(-Math.PI / 2)
    this.missionHoverAltitudeRing = new THREE.Mesh(hoverAltitudeGeometry, this.missionHoverMaterial)
    this.missionHoverGroup.add(this.missionHoverAltitudeRing)

    this.disposables.push(
      activeGroundGeometry,
      activeAltitudeGeometry,
      selectGroundGeometry,
      selectAltitudeGeometry,
      hoverGroundGeometry,
      hoverAltitudeGeometry,
      this.missionPillarMaterial,
      this.missionRingMaterial,
      this.missionActiveMaterial,
      this.missionSelectMaterial,
      this.missionHoverMaterial,
      this.missionPickMaterial,
    )
    this.missionActiveGroup.visible = false
    this.missionSelectGroup.visible = false
    this.missionHoverGroup.visible = false

    this.missionGroup.add(this.missionMarkerGroup)
    this.missionGroup.add(this.missionPathGroup)
    this.group.add(this.missionGroup)
    this.group.add(this.missionActiveGroup)
    this.group.add(this.missionSelectGroup)
    this.group.add(this.missionHoverGroup)

    scene.add(this.group)
  }

  private tintGrid(grid: THREE.GridHelper, opacity: number): void {
    const material = grid.material as THREE.Material | THREE.Material[]
    const list = Array.isArray(material) ? material : [material]
    list.forEach((item) => {
      item.transparent = true
      item.opacity = opacity
      item.depthWrite = false
      this.disposables.push(item)
    })
  }

  /** 记录航迹:每移动 0.25 米落一个点,避免长航线把缓冲撑爆 */
  pushTrail(x: number, y: number, z: number): void {
    if (Number.isNaN(this.lastTrailPoint.x)) {
      this.lastTrailPoint.set(x, y, z)
    }
    const moved = Math.hypot(
      x - this.lastTrailPoint.x,
      y - this.lastTrailPoint.y,
      z - this.lastTrailPoint.z,
    )
    if (moved < 0.25) return
    if (this.trailCount >= TRAIL_MAX_POINTS) return
    this.trailPositions[this.trailCount * 3] = x
    this.trailPositions[this.trailCount * 3 + 1] = y
    this.trailPositions[this.trailCount * 3 + 2] = z
    this.trailCount += 1
    this.lastTrailPoint.set(x, y, z)
    if (this.trailLine) {
      const attribute = this.trailLine.geometry.getAttribute('position') as THREE.BufferAttribute
      attribute.needsUpdate = true
      this.trailLine.geometry.setDrawRange(0, this.trailCount)
      this.trailLine.geometry.computeBoundingSphere()
    }
  }

  clearTrail(): void {
    this.trailCount = 0
    this.lastTrailPoint.set(Number.NaN, 0, 0)
    if (this.trailLine) {
      this.trailLine.geometry.setDrawRange(0, 0)
    }
  }

  setObstaclesVisible(visible: boolean): void {
    this.obstacles.forEach((obstacle) => {
      obstacle.visible = visible
    })
  }

  /**
   * 锥形视场检测(雷达/视觉传感器用):传感器是一台有视场的相机,不是一条无粗细的射线。
   *
   * 以 origin 为锥顶、axis 为瞄准轴、两个正交轴 u1/u2 上的半张角为 halfU1/halfU2,
   * 判断量程内哪些障碍物落在视场里,返回最近的距离与标签。
   * 判定方式:障碍 AABB 在锥坐标系里用"支撑半径"(Σ|d·axisᵢ|·halfᵢ)近似成盒,
   * 再做椭圆锥内部测试 (e1/(a·tanU1))² + (e2/(a·tanU2))² ≤ 1 —— 连续判定,
   * 于是不存在"两条采样射线之间漏掉细柱"的盲区。
   * 说明:只对障碍物 AABB 判定,不含地面(真机前视也不会把地面当成前方障碍)。
   * 与仿真内核的 AABB 避障相互独立:这里是"传感器测量",那里是"飞控保护"。
   */
  coneCast(
    origin: THREE.Vector3,
    axis: THREE.Vector3,
    u1: THREE.Vector3,
    u2: THREE.Vector3,
    tanU1: number,
    tanU2: number,
    maxDistance: number,
  ): { distance: number; label: string } | null {
    let best: { distance: number; label: string } | null = null
    for (const box of this.collisionBoxes) {
      const cx = (box.minX + box.maxX) / 2
      const cy = (box.minY + box.maxY) / 2
      const cz = (box.minZ + box.maxZ) / 2
      const hx = (box.maxX - box.minX) / 2
      const hy = (box.maxY - box.minY) / 2
      const hz = (box.maxZ - box.minZ) / 2
      // 盒沿任意方向的支撑半宽
      const projHalf = (dir: THREE.Vector3): number =>
        Math.abs(dir.x) * hx + Math.abs(dir.y) * hy + Math.abs(dir.z) * hz

      const vx = cx - origin.x
      const vy = cy - origin.y
      const vz = cz - origin.z
      const along = vx * axis.x + vy * axis.y + vz * axis.z
      const radiusAxis = projHalf(axis)
      const near = along - radiusAxis
      if (near > maxDistance) continue // 太远
      if (along + radiusAxis < 0) continue // 在锥顶后方

      const t1 = Math.abs(vx * u1.x + vy * u1.y + vz * u1.z) - projHalf(u1)
      const t2 = Math.abs(vx * u2.x + vy * u2.y + vz * u2.z) - projHalf(u2)
      const e1 = Math.max(0, t1)
      const e2 = Math.max(0, t2)
      const reference = Math.max(near, 0.05) // 下限防止靠近锥顶时除以极小值、把阈值放大成误判
      if ((e1 / (reference * tanU1)) ** 2 + (e2 / (reference * tanU2)) ** 2 > 1) continue

      // 距离:取盒上距锥顶最近的一点,再沿瞄准轴投影 ——
      // ⚠️ 不能用支撑半径算距离:对"宽扁"的盒(天桥 18×2 m)会把沿轴厚度夸大好几米
      const qx = Math.min(Math.max(origin.x, box.minX), box.maxX)
      const qy = Math.min(Math.max(origin.y, box.minY), box.maxY)
      const qz = Math.min(Math.max(origin.z, box.minZ), box.maxZ)
      const distance = Math.max(
        0,
        (qx - origin.x) * axis.x + (qy - origin.y) * axis.y + (qz - origin.z) * axis.z,
      )
      if (!best || distance < best.distance) best = { distance, label: box.name }
    }
    return best
  }

  // ————————————————————————————— 航线任务可视化 —————————————————————————————

  /**
   * 重建航点标记与航线折线(只在航线内容变化时调用,内部先清掉旧对象)。
   *
   * 每个航点画三样东西,缺一不可:
   * - **地面环**:告诉你在平面上的什么位置;
   * - **竖直光柱**:把平面位置"抬"到天上,一眼看出航点高度;
   * - **高度环 + 序号牌**:真正的三维航点位置(飞机要飞到那儿),以及第几个点。
   */
  setMissionWaypoints(waypoints: MissionMarker[], origin: { x: number; z: number }): void {
    this.clearMissionWaypoints()
    this.missionOrigin = { x: origin.x, z: origin.z }
    for (const waypoint of waypoints) {
      this.missionMarkers.push({ x: waypoint.x, z: waypoint.z, altitude: waypoint.altitude })
    }
    if (waypoints.length === 0) {
      this.applyMissionVisibility()
      return
    }

    for (let index = 0; index < waypoints.length; index += 1) {
      const waypoint = waypoints[index]
      if (!waypoint) continue
      const altitude = Math.max(1, waypoint.altitude)
      const group = new THREE.Group()
      group.position.set(waypoint.x, 0, waypoint.z)

      const groundGeometry = new THREE.RingGeometry(1.7, 2.05, 36)
      groundGeometry.rotateX(-Math.PI / 2)
      const groundRing = new THREE.Mesh(groundGeometry, this.missionRingMaterial)
      groundRing.position.y = 0.03
      group.add(groundRing)

      // ⚠️ 光柱几何按"单位高度、底部对齐"建,高度改用 scale.y 表达 ——
      // 场景里拖动改高度时只需改 scale,不必重建几何(每帧重建会掉帧 + 显存抖动)
      const pillarGeometry = new THREE.CylinderGeometry(0.07, 0.07, 1, 6, 1, true)
      pillarGeometry.translate(0, 0.5, 0)
      const pillar = new THREE.Mesh(pillarGeometry, this.missionPillarMaterial)
      pillar.scale.y = altitude
      group.add(pillar)

      const altitudeGeometry = new THREE.RingGeometry(0.8, 1.1, 28)
      altitudeGeometry.rotateX(-Math.PI / 2)
      const altitudeRing = new THREE.Mesh(altitudeGeometry, this.missionRingMaterial)
      altitudeRing.position.y = altitude
      group.add(altitudeRing)

      const label = this.createMissionLabel(`${index + 1}`, altitude + 2)
      group.add(label)

      // 拾取体:套在光柱外面的不可见粗管(0 高度也行,但飞行中不许编辑,所以无所谓)
      const pickGeometry = new THREE.CylinderGeometry(
        MISSION_PICK_RADIUS,
        MISSION_PICK_RADIUS,
        1,
        10,
        1,
        true,
      )
      const pick = new THREE.Mesh(pickGeometry, this.missionPickMaterial)
      pick.scale.y = altitude
      pick.position.y = altitude / 2
      group.add(pick)

      this.missionDisposables.push(groundGeometry, pillarGeometry, altitudeGeometry, pickGeometry)
      this.missionMarkerGroup.add(group)
      this.missionMarkerNodes.push({ group, pillar, altitudeRing, label, pick })
    }

    this.buildMissionPath()
    this.applyMissionVisibility()
  }

  /**
   * 原位更新一个航点(场景里拖拽时每帧调用)。
   *
   * 只改这一根标记的位姿与折线顶点,不动其他航点 —— 因此拖动过程不会有整层重建的闪烁,
   * 也不会让"当前目标/选中/悬停"三套高亮错位。
   */
  updateMissionWaypoint(index: number, waypoint: MissionMarker): void {
    const node = this.missionMarkerNodes[index]
    const stored = this.missionMarkers[index]
    if (!node || !stored) return
    stored.x = waypoint.x
    stored.z = waypoint.z
    stored.altitude = waypoint.altitude

    const altitude = Math.max(1, waypoint.altitude)
    node.group.position.set(waypoint.x, 0, waypoint.z)
    node.pillar.scale.y = altitude
    node.altitudeRing.position.y = altitude
    node.label.position.y = altitude + 2
    node.pick.scale.y = altitude
    node.pick.position.y = altitude / 2

    this.refreshMissionPath()
    if (this.missionActiveIndex === index) this.setMissionActive(index, null)
    if (this.missionSelectIndex === index) this.setMissionSelection(index, null)
    if (this.missionHoverIndex === index) this.setMissionHover(index, null)
  }

  /** 高亮当前执行目标航点(传 null 取消高亮;waypoint 省略时按索引取当前数据) */
  setMissionActive(index: number, waypoint: MissionMarker | null): void {
    this.missionActiveIndex = index >= 0 ? index : -1
    this.placeHighlightGroup(
      this.missionActiveGroup,
      this.missionActiveAltitudeRing,
      index,
      waypoint,
    )
  }

  /** 场景编辑:选中高亮 */
  setMissionSelection(index: number, waypoint: MissionMarker | null = null): void {
    this.missionSelectIndex = index >= 0 ? index : -1
    this.placeHighlightGroup(
      this.missionSelectGroup,
      this.missionSelectAltitudeRing,
      index,
      waypoint,
    )
  }

  /** 场景编辑:悬停高亮 */
  setMissionHover(index: number, waypoint: MissionMarker | null = null): void {
    this.missionHoverIndex = index >= 0 ? index : -1
    this.placeHighlightGroup(this.missionHoverGroup, this.missionHoverAltitudeRing, index, waypoint)
  }

  /** 把一组"地面环 + 高度环"高亮挪到某个航点上(索引/数据非法就藏起来) */
  private placeHighlightGroup(
    group: THREE.Group,
    altitudeRing: THREE.Mesh | null,
    index: number,
    waypoint: MissionMarker | null,
  ): void {
    const target = index >= 0 ? (waypoint ?? this.missionMarkers[index] ?? null) : null
    if (!target) {
      group.visible = false
      return
    }
    group.position.set(target.x, 0, target.z)
    if (altitudeRing) altitudeRing.position.y = Math.max(1, target.altitude)
    group.visible = this.missionVisible
  }

  /** 拾取航点:返回命中的航点索引,没命中返回 -1(看不见的图层不参与拾取) */
  pickMissionWaypoint(raycaster: THREE.Raycaster): number {
    if (!this.missionVisible || !this.missionMarkersVisible) return -1
    if (this.missionMarkerNodes.length === 0) return -1
    const targets = this.missionMarkerNodes.map((node) => node.pick)
    const hit = raycaster.intersectObjects(targets, false)[0]
    if (!hit) return -1
    const index = this.missionMarkerNodes.findIndex((node) => node.pick === hit.object)
    return index
  }

  /**
   * 拾取地面(水平面 y=0):场景里双击地面新增航点用。
   * 射线几乎平行于地面时会打到很远的地方,由调用方按限距夹紧。
   */
  pickMissionGround(raycaster: THREE.Raycaster): { x: number; z: number } | null {
    const hit = raycaster.ray.intersectPlane(this.groundPlane, this.groundHit)
    if (!hit) return null
    return { x: hit.x, z: hit.z }
  }

  /** 图层总开关(航点 + 航线 + 三套高亮) */
  setMissionVisible(visible: boolean): void {
    this.missionVisible = visible
    this.applyMissionVisibility()
  }

  isMissionVisible(): boolean {
    return this.missionVisible
  }

  /** 只开关航点标记(不影响航线折线) */
  setMissionWaypointsVisible(visible: boolean): void {
    this.missionMarkersVisible = visible
    this.applyMissionVisibility()
  }

  isMissionWaypointsVisible(): boolean {
    return this.missionMarkersVisible
  }

  /** 只开关航线折线(不影响航点标记) */
  setMissionPathVisible(visible: boolean): void {
    this.missionPathVisible = visible
    this.applyMissionVisibility()
  }

  isMissionPathVisible(): boolean {
    return this.missionPathVisible
  }

  private applyMissionVisibility(): void {
    this.missionGroup.visible = this.missionVisible
    this.missionMarkerGroup.visible = this.missionVisible && this.missionMarkersVisible
    this.missionPathGroup.visible = this.missionVisible && this.missionPathVisible
    this.missionActiveGroup.visible = this.missionVisible && this.missionActiveIndex >= 0
    this.missionSelectGroup.visible = this.missionVisible && this.missionSelectIndex >= 0
    this.missionHoverGroup.visible = this.missionVisible && this.missionHoverIndex >= 0
  }

  /** 建航线折线:起点从返航点按首点高度拉起,再依次连过各航点 */
  private buildMissionPath(): void {
    if (this.missionMarkers.length === 0) return
    const count = this.missionMarkers.length + 1
    this.missionPathPositions = new Float32Array(count * 3)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(this.missionPathPositions, 3))
    const material = new THREE.LineDashedMaterial({
      color: MISSION_COLOR,
      transparent: true,
      opacity: 0.55,
      dashSize: 1.6,
      gapSize: 1.1,
      toneMapped: false,
    })
    const line = new THREE.Line(geometry, material)
    line.frustumCulled = false
    this.writeMissionPathPositions()
    line.computeLineDistances()
    this.missionPathLine = line
    this.missionPathGroup.add(line)
    this.missionDisposables.push(geometry, material)
  }

  /** 顶点改完重算一次(拖动时每帧走这里:只写 Float32Array,不重建几何) */
  private refreshMissionPath(): void {
    const line = this.missionPathLine
    if (!line) return
    this.writeMissionPathPositions()
    const attribute = line.geometry.getAttribute('position')
    attribute.needsUpdate = true
    line.geometry.computeBoundingSphere()
    line.computeLineDistances()
  }

  private writeMissionPathPositions(): void {
    const positions = this.missionPathPositions
    if (!positions) return
    const first = this.missionMarkers[0]
    if (!first) return
    positions[0] = this.missionOrigin.x
    positions[1] = Math.max(1, first.altitude)
    positions[2] = this.missionOrigin.z
    for (let index = 0; index < this.missionMarkers.length; index += 1) {
      const waypoint = this.missionMarkers[index]
      if (!waypoint) continue
      const offset = (index + 1) * 3
      positions[offset] = waypoint.x
      positions[offset + 1] = Math.max(1, waypoint.altitude)
      positions[offset + 2] = waypoint.z
    }
  }

  private clearMissionWaypoints(): void {
    this.missionMarkerGroup.clear()
    this.missionPathGroup.clear()
    this.missionMarkerNodes.length = 0
    this.missionMarkers.length = 0
    this.missionPathLine = null
    this.missionPathPositions = null
    this.missionDisposables.forEach((item) => item.dispose())
    this.missionDisposables.length = 0
  }

  /** 序号牌:用面向屏幕的 Sprite,飞机在哪个角度看牌子都是正的 */
  private createMissionLabel(text: string, y: number): THREE.Sprite {
    const size = 96
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const texture = new THREE.CanvasTexture(canvas)
    const context = canvas.getContext('2d')
    if (context) {
      context.fillStyle = 'rgba(7, 26, 30, 0.84)'
      context.beginPath()
      context.arc(size / 2, size / 2, size / 2 - 5, 0, Math.PI * 2)
      context.fill()
      context.lineWidth = 4
      context.strokeStyle = '#39d0b0'
      context.stroke()
      context.fillStyle = '#d8fff5'
      context.font = 'bold 46px ui-sans-serif, system-ui, sans-serif'
      context.textAlign = 'center'
      context.textBaseline = 'middle'
      context.fillText(text, size / 2, size / 2 + 2)
      texture.needsUpdate = true
    }
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    const sprite = new THREE.Sprite(material)
    sprite.position.y = y
    sprite.scale.setScalar(2.4)
    this.missionDisposables.push(texture, material)
    return sprite
  }

  /** 把"起飞点"标记挪到指定位置(重新起飞时会更新返航点) */
  setHome(x: number, z: number): void {
    this.homeMarker.position.set(x, 0, z)
  }

  destroy(): void {
    this.scene.remove(this.group)
    this.clearMissionWaypoints()
    this.disposables.forEach((item) => item.dispose())
    this.disposables.length = 0
    this.obstacles.length = 0
    this.collisionBoxes.length = 0
    this.trailLine = null
    this.missionActiveAltitudeRing = null
    this.missionSelectAltitudeRing = null
    this.missionHoverAltitudeRing = null
    this.missionGroup.clear()
    this.missionSelectGroup.clear()
    this.missionHoverGroup.clear()
  }
}
