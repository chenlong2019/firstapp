import * as THREE from 'three'
import type { DroneWorld } from './drone-world'

/**
 * 测距雷达(简化版 DJI 全向视觉避障感知):
 *
 * 真机 Mini 4 Pro 的视觉系统是"机身四角 + 下视 + 上视"的多目布局,这里做两组:
 *  - 前视:机头前脸、云台左右两侧的一对镜头(官方精密测距 0.5~18 m,FOV 90°×72°);
 *  - 上视:机背顶部、电池前方的一对视觉孔(官方精密测距 0.5~15 m,FOV 左右 90°/前后 72°),
 *    用来判断机体上方有没有障碍物。
 *
 * ⚠️ 关键设计:视觉传感器是"有视场的相机",不是一条无粗细的射线,而且镜头可以转向 ——
 *
 *  1. **可转瞄准(aim)**:默认 `forward` —— 前视镜头转向机体【正前方】、上视镜头转向
 *     【正上方】(带平滑转动过渡,启动时能看到镜头"转过去"的过程);
 *     另有 `sensor` 模式 = 沿玻璃面法线(与画面里的镜头/孔面完全一致)。
 *     ⚠️ 玻璃面法线 ≠ 摄像头光轴:机背孔贴在斜坡上,若直接沿法线看,上视会变成
 *     "朝后上方仰 35°",正上方反而是盲区 —— 所以默认用 forward。
 *
 *  2. **锥形视场检测(coneCast)**:判定在椭圆锥内做(不是打几条采样射线),
 *     同侧两条镜头的视场在中线上重叠(各外张 20°、半张角 22.5°,合起来正好官方
 *     水平/左右 90°),因此正前方、正上方中线上的细柱不会被"两条射线之间的缝"漏掉。
 *
 *  起点仍逐帧取自模型玻璃网格的几何中心(与画面里的镜头/孔重合)。
 *  可视化:主射线(亮)+ 视场锥边界(淡),命中点标记球;近红 → 中黄 → 远距组色
 *  (前视绿 / 上视蓝)。未上电时整组隐藏。
 *
 * 注意:这里只做"传感器测量 + 可视化",刹停保护仍由仿真内核的
 * AABB 避障(drone-sim.applyObstacleBrake)负责,两层互不干扰。
 */

export interface RadarHit {
  /** 传感器到命中物的距离(米,沿瞄准轴量到障碍物近端) */
  distance: number
  /** 命中物标签(建筑 A / 灯杆 / 天桥…) */
  label: string
}

/** 瞄准模式:forward = 镜头转去看正前方/正上方;sensor = 沿玻璃面法线(镜头本体朝向) */
export type RadarAim = 'forward' | 'sensor'

export interface RadarSnapshot {
  /** 雷达是否在工作(上电后可用) */
  detecting: boolean
  /** 前视·左传感器命中,null = 视场内无障碍物 */
  left: RadarHit | null
  /** 前视·右传感器命中 */
  right: RadarHit | null
  /** 前视量程(米),按官方 0.5~18 m */
  range: number
  /** 上视·左传感器命中(机背左孔) */
  upLeft: RadarHit | null
  /** 上视·右传感器命中(机背右孔) */
  upRight: RadarHit | null
  /** 上视量程(米),按官方 0.5~15 m */
  upRange: number
  /** 当前瞄准模式 */
  aim: RadarAim
}

/** 视觉玻璃节点:顺序与 UI 的左/右一致(左 = -X) */
const FRONT_NODES = ['SENSOR_Glass_Front_Left', 'SENSOR_Glass_Front_Right'] as const
/**
 * 上视节点:模型把这对上视孔命名为 Side(实际位于机背顶部、全机最高件),
 * 对应真机 Mini 4 Pro 机体上方的视觉传感器。
 */
const UP_NODES = ['SENSOR_Glass_Side_Left', 'SENSOR_Glass_Side_Right'] as const

const FRONT_RANGE = 18
const UP_RANGE = 15

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z)

/** 距离分档阈值(米):近距红 / 中距黄 / 远距组色 */
const NEAR_M = 3
const MID_M = 9

const COLOR_NEAR = 0xff4d4d
const COLOR_MID = 0xffc14d
/** 远距组色:前视绿 / 上视蓝,一眼区分是哪一组在测 */
const COLOR_FRONT_FAR = 0x35e08a
const COLOR_UP_FAR = 0x4dc3ff

/** 镜头转向机构:瞄准方向每帧朝目标方向转动的速率(1/秒) */
const AIM_TURN_RATE = 3.2

const DEG = Math.PI / 180

/**
 * 视场半张角与镜头外张角(照官方 FOV 拆分):
 * 前视 FOV 水平 90° / 垂直 72° → 各镜头外张 20°、半张角 22.5°(水平)/36°(垂直),
 * 两条镜头视场在中线 ±2.5° 处重叠,合起来正好 90°。
 * 上视 FOV 左右 90° / 前后 72° → 同理(左右 22.5°,前后 36°)。
 */
const LENS_SPLAY_DEG = 20
const HALF_SIDE_DEG = 22.5
const HALF_UP_DEG = 36

const EMPTY_SNAPSHOT: RadarSnapshot = {
  detecting: false,
  left: null,
  right: null,
  range: FRONT_RANGE,
  upLeft: null,
  upRight: null,
  upRange: UP_RANGE,
  aim: 'forward',
}

/** 面积加权平均面法线(几何自带顶点法线不可靠时用;叉积长度=2×面积) */
function geometryNormal(mesh: THREE.Mesh): THREE.Vector3 {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const cross = new THREE.Vector3()
  const edgeB = new THREE.Vector3()
  const edgeA = new THREE.Vector3()
  const sum = new THREE.Vector3()
  const count = index ? index.count : position.count
  for (let i = 0; i < count; i += 3) {
    const i0 = index ? index.getX(i) : i
    const i1 = index ? index.getX(i + 1) : i + 1
    const i2 = index ? index.getX(i + 2) : i + 2
    a.fromBufferAttribute(position, i0)
    b.fromBufferAttribute(position, i1)
    c.fromBufferAttribute(position, i2)
    edgeB.subVectors(c, b)
    edgeA.subVectors(a, b)
    cross.crossVectors(edgeB, edgeA)
    sum.add(cross)
  }
  return sum.lengthSq() > 1e-12 ? sum.normalize() : V(0, 1, 0)
}

/** 单个视觉传感器(一台有视场的相机) */
interface SensorUnit {
  group: 'front' | 'up'
  position: 'left' | 'right'
  nodeName: string
  range: number
  farColor: number
  /** 兜底起点(机体系偏移,米) */
  fallbackOffset: THREE.Vector3
  /** sensor 模式方向:玻璃/孔面法线(机体系,兜底用) */
  fallbackDir: THREE.Vector3
  /** forward 模式方向:镜头转向后的瞄准方向(机体系) */
  aimDir: THREE.Vector3
  /** 视场参考轴 1(机体系):halfU1 对应的方向(前视=机体左右,上视=机体左右) */
  refU1: THREE.Vector3
  /** 视场参考轴 2(机体系):halfU2 对应的方向(前视=机体上下,上视=机体前后) */
  refU2: THREE.Vector3
  halfU1: number
  halfU2: number
  /** 绑定的视觉玻璃网格;null = 用兜底常数 */
  mesh: THREE.Mesh | null
  localCenter: THREE.Vector3
  normalGeo: THREE.Vector3
  sign: number
  /** 当前瞄准方向(世界系,平滑转动) */
  aimWorld: THREE.Vector3
  /** 是否已用首帧目标方向初始化(避免开局从 (0,0,0) 转动) */
  aimReady: boolean
}

/** 光束可视化单元(每条传感器:1 条主射线 + 4 条锥边界) */
interface BeamUnit {
  line: THREE.Line
  positions: Float32Array
  material: THREE.LineBasicMaterial
}

const splay = Math.sin(LENS_SPLAY_DEG * DEG)
const splayCos = Math.cos(LENS_SPLAY_DEG * DEG)

const SENSOR_SPECS: Array<Omit<SensorUnit, 'mesh' | 'localCenter' | 'normalGeo' | 'sign' | 'aimWorld' | 'aimReady'>> = [
  {
    group: 'front',
    position: 'left',
    nodeName: FRONT_NODES[0],
    range: FRONT_RANGE,
    farColor: COLOR_FRONT_FAR,
    fallbackOffset: V(-0.215, 0.161, -0.489),
    fallbackDir: V(-0.683, 0.086, -0.725),
    aimDir: V(-splay, 0, -splayCos),
    refU1: V(1, 0, 0),
    refU2: V(0, 1, 0),
    halfU1: HALF_SIDE_DEG * DEG,
    halfU2: HALF_UP_DEG * DEG,
  },
  {
    group: 'front',
    position: 'right',
    nodeName: FRONT_NODES[1],
    range: FRONT_RANGE,
    farColor: COLOR_FRONT_FAR,
    fallbackOffset: V(0.215, 0.161, -0.489),
    fallbackDir: V(0.683, 0.086, -0.725),
    aimDir: V(splay, 0, -splayCos),
    refU1: V(1, 0, 0),
    refU2: V(0, 1, 0),
    halfU1: HALF_SIDE_DEG * DEG,
    halfU2: HALF_UP_DEG * DEG,
  },
  {
    group: 'up',
    position: 'left',
    nodeName: UP_NODES[0],
    range: UP_RANGE,
    farColor: COLOR_UP_FAR,
    fallbackOffset: V(-0.18, 0.194, -0.207),
    fallbackDir: V(-0.579, 0.697, 0.423),
    aimDir: V(-splay, splayCos, 0),
    refU1: V(1, 0, 0),
    refU2: V(0, 0, -1),
    halfU1: HALF_SIDE_DEG * DEG,
    halfU2: HALF_UP_DEG * DEG,
  },
  {
    group: 'up',
    position: 'right',
    nodeName: UP_NODES[1],
    range: UP_RANGE,
    farColor: COLOR_UP_FAR,
    fallbackOffset: V(0.18, 0.194, -0.207),
    fallbackDir: V(0.579, 0.697, 0.423),
    aimDir: V(splay, splayCos, 0),
    refU1: V(1, 0, 0),
    refU2: V(0, 0, -1),
    halfU1: HALF_SIDE_DEG * DEG,
    halfU2: HALF_UP_DEG * DEG,
  },
]

export class DroneRadar {
  private readonly group = new THREE.Group()
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = []
  /** 每条传感器 5 条线(主射线 + 4 条锥边界),索引 = sensorIndex * 5 + slot */
  private readonly beams: BeamUnit[] = []
  private readonly sensors: SensorUnit[] = SENSOR_SPECS.map((spec) => ({
    ...spec,
    mesh: null,
    localCenter: new THREE.Vector3(),
    normalGeo: spec.fallbackDir.clone(),
    sign: 1,
    aimWorld: spec.aimDir.clone(),
    aimReady: false,
  }))

  private aim: RadarAim = 'forward'
  /**
   * 射线可视化的显示开关(页面"雷达射线"勾选框)。
   * 默认 false = 不显示(读数照常工作),用户勾选后才画。
   * ⚠️ 必须存成状态字段:update() 每帧都会刷新 group.visible,
   * 若直接写死 true,会把 setVisible(false) 覆盖掉,开关就"点了没反应"。
   */
  private beamsVisible = false

  private readonly base = new THREE.Vector3()
  private readonly origin = new THREE.Vector3()
  private readonly targetAxis = new THREE.Vector3()
  private readonly axis = new THREE.Vector3()
  private readonly u1 = new THREE.Vector3()
  private readonly u2 = new THREE.Vector3()
  private readonly refU1World = new THREE.Vector3()
  private readonly refU2World = new THREE.Vector3()
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()
  private readonly rotation = new THREE.Matrix4()

  private snapshot: RadarSnapshot = EMPTY_SNAPSHOT

  constructor(scene: THREE.Scene) {
    for (let index = 0; index < this.sensors.length; index += 1) {
      const sensor = this.sensors[index]
      // slot 0 = 主射线(亮),1~4 = 锥边界(淡)
      for (let slot = 0; slot < 5; slot += 1) {
        const positions = new Float32Array(6)
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        const material = new THREE.LineBasicMaterial({
          color: sensor.farColor,
          transparent: true,
          opacity: slot === 0 ? 0.75 : 0.16,
          toneMapped: false,
        })
        const line = new THREE.Line(geometry, material)
        line.frustumCulled = false
        this.group.add(line)
        this.disposables.push(geometry, material)
        this.beams.push({ line, positions, material })
      }
    }
    this.group.visible = false
    scene.add(this.group)
  }

  get range(): number {
    return FRONT_RANGE
  }

  get upRange(): number {
    return UP_RANGE
  }

  /** 当前读数(每帧刷新;Vue 100ms 轮询取用) */
  getSnapshot(): RadarSnapshot {
    return this.snapshot
  }

  /**
   * 瞄准模式:forward = 镜头转去看正前方(上视 = 正上方);sensor = 沿玻璃面法线。
   * 切换后镜头会平滑转过去(不是瞬移)。
   */
  setAim(aim: RadarAim): void {
    this.aim = aim
    this.snapshot = { ...this.snapshot, aim }
  }

  getAim(): RadarAim {
    return this.aim
  }

  /**
   * 从模型里读出两组视觉玻璃网格(前视双摄 + 机背上视双孔),
   * 记录其几何中心与镜面法线。开机时调用一次即可。
   */
  bindSensors(model: THREE.Object3D): void {
    model.updateMatrixWorld(true)
    const rotation = new THREE.Matrix4().extractRotation(model.matrixWorld)
    for (const sensor of this.sensors) {
      const mesh = model.getObjectByName(sensor.nodeName)
      if (!(mesh instanceof THREE.Mesh)) continue
      const geometry = mesh.geometry
      geometry.computeBoundingBox()
      const localCenter = new THREE.Vector3()
      geometry.boundingBox?.getCenter(localCenter) ?? localCenter.set(0, 0, 0)
      const normalGeo = geometryNormal(mesh)
      // 镜面法线可能按玻璃背面朝外的写法:统一取朝"镜头朝外一侧"
      const worldNormal = normalGeo.clone().transformDirection(mesh.matrixWorld).normalize()
      const worldForward = V(0, 0, -1).applyMatrix4(rotation).normalize()
      const worldUp = V(0, 1, 0).applyMatrix4(rotation).normalize()
      const reference = sensor.group === 'front' ? worldForward : worldUp
      sensor.mesh = mesh
      sensor.localCenter.copy(localCenter)
      sensor.normalGeo.copy(normalGeo)
      sensor.sign = worldNormal.dot(reference) < 0 ? -1 : 1
    }
  }

  /** 是否两组都成功绑定到模型(探针用) */
  isBoundToSensors(): boolean {
    return this.sensors.every((sensor) => sensor.mesh !== null)
  }

  /** 每个传感器的绑定情况(探针用) */
  debugInfo(): Array<{ group: string; position: string; nodeName: string; bound: boolean; aimDeg: number[] }> {
    return this.sensors.map((sensor) => ({
      group: sensor.group,
      position: sensor.position,
      nodeName: sensor.nodeName,
      bound: sensor.mesh !== null,
      aimDeg: sensor.aimWorld.toArray().map((value) => Math.round(value * 1000) / 1000),
    }))
  }

  /**
   * 每帧更新:先让镜头朝目标方向平滑转动,再做锥形视场检测。
   * 起点逐帧取自视觉玻璃网格的世界矩阵(与画面里的镜头/孔完全重合)。
   */
  update(model: THREE.Object3D, world: DroneWorld, delta: number, detecting: boolean): void {
    if (!detecting) {
      if (this.snapshot !== EMPTY_SNAPSHOT) {
        this.snapshot = { ...EMPTY_SNAPSHOT, aim: this.aim }
      }
      this.group.visible = false
      return
    }
    // 上电后按用户开关决定显隐(不要写死 true,否则开关失效)
    this.group.visible = this.beamsVisible

    model.updateMatrixWorld(true)
    this.rotation.extractRotation(model.matrixWorld)
    model.getWorldPosition(this.base)

    const hits: Array<RadarHit | null> = []
    for (let index = 0; index < this.sensors.length; index += 1) {
      const sensor = this.sensors[index]
      // —— 起点:玻璃中心(世界系) ——
      if (sensor.mesh) {
        this.origin.copy(sensor.localCenter).applyMatrix4(sensor.mesh.matrixWorld)
      } else {
        this.origin.copy(sensor.fallbackOffset).applyMatrix4(this.rotation).add(this.base)
      }

      // —— 镜头转向:目标方向 ——
      if (this.aim === 'sensor' && sensor.mesh) {
        this.targetAxis.copy(sensor.normalGeo).transformDirection(sensor.mesh.matrixWorld).normalize().multiplyScalar(sensor.sign)
      } else {
        this.targetAxis.copy(sensor.aimDir).applyMatrix4(this.rotation).normalize()
      }
      if (!sensor.aimReady) {
        sensor.aimWorld.copy(this.targetAxis)
        sensor.aimReady = true
      } else {
        sensor.aimWorld.lerp(this.targetAxis, Math.min(1, Math.max(0, delta) * AIM_TURN_RATE)).normalize()
      }
      this.axis.copy(sensor.aimWorld)

      // —— 视场正交基:参考轴在垂直瞄准轴的平面内正交化 ——
      this.refU1World.copy(sensor.refU1).applyMatrix4(this.rotation)
      this.refU2World.copy(sensor.refU2).applyMatrix4(this.rotation)
      this.u1.copy(this.refU1World).addScaledVector(this.axis, -this.refU1World.dot(this.axis))
      if (this.u1.lengthSq() < 1e-8) this.u1.set(0, 1, 0).addScaledVector(this.axis, -this.axis.y)
      this.u1.normalize()
      this.u2.crossVectors(this.axis, this.u1).normalize()

      // —— 锥形视场检测(不是打几条采样射线,不存在线缝隙) ——
      const hit = world.coneCast(
        this.origin,
        this.axis,
        this.u1,
        this.u2,
        Math.tan(sensor.halfU1),
        Math.tan(sensor.halfU2),
        sensor.range,
      )
      hits.push(hit)
      this.updateSensorVisual(index, sensor, this.origin, this.axis, hit)
    }

    this.snapshot = {
      detecting: true,
      left: hits[0],
      right: hits[1],
      range: FRONT_RANGE,
      upLeft: hits[2],
      upRight: hits[3],
      upRange: UP_RANGE,
      aim: this.aim,
    }
  }

  /** 更新一条传感器的可视化:主射线 + 4 条视场锥边界 + 命中标记 */
  private updateSensorVisual(
    index: number,
    sensor: SensorUnit,
    origin: THREE.Vector3,
    axis: THREE.Vector3,
    hit: RadarHit | null,
  ): void {
    const color = this.levelColor(hit?.distance ?? Number.POSITIVE_INFINITY, sensor.farColor)
    const length = hit ? hit.distance : sensor.range

    // 主射线
    const main = this.beams[index * 5]
    this.tmp.copy(origin).addScaledVector(axis, length)
    this.writeBeam(main, origin, this.tmp, color)

    // 锥边界:绕 u1 / u2 各偏 ±半张角,示意视场覆盖范围
    const edges: Array<[THREE.Vector3, number, number]> = [
      [this.u2, sensor.halfU1, 0],
      [this.u2, -sensor.halfU1, 0],
      [this.u1, sensor.halfU2, 0],
      [this.u1, -sensor.halfU2, 0],
    ]
    for (let slot = 0; slot < edges.length; slot += 1) {
      const [rotAxis, angle] = edges[slot]
      this.tmp.copy(axis).applyAxisAngle(rotAxis, angle).normalize()
      this.tmp2.copy(origin).addScaledVector(this.tmp, sensor.range)
      this.writeBeam(this.beams[index * 5 + 1 + slot], origin, this.tmp2, color)
    }
  }

  private writeBeam(beam: BeamUnit, start: THREE.Vector3, end: THREE.Vector3, color: number): void {
    beam.positions[0] = start.x
    beam.positions[1] = start.y
    beam.positions[2] = start.z
    beam.positions[3] = end.x
    beam.positions[4] = end.y
    beam.positions[5] = end.z
    const attribute = beam.line.geometry.getAttribute('position') as THREE.BufferAttribute
    attribute.needsUpdate = true
    beam.material.color.setHex(color)
  }

  /** 距离分档配色:近红 / 中黄 / 远距用组色(未命中按远距) */
  private levelColor(distance: number, farColor: number): number {
    if (distance < NEAR_M) return COLOR_NEAR
    if (distance < MID_M) return COLOR_MID
    return farColor
  }

  /**
   * 页面调试开关:隐藏/显示射线可视化(读数照常)。
   * 只记录状态并立即生效;随后每帧的 update() 会沿用这个状态,不会被覆盖。
   */
  setVisible(visible: boolean): void {
    this.beamsVisible = visible
    this.group.visible = visible && this.snapshot.detecting
  }

  /** 当前射线可视化是否显示(探针用) */
  isBeamsVisible(): boolean {
    return this.beamsVisible
  }

  destroy(): void {
    this.group.parent?.remove(this.group)
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables.length = 0
    this.beams.length = 0
    for (const sensor of this.sensors) {
      sensor.mesh = null
      sensor.aimReady = false
    }
    this.snapshot = EMPTY_SNAPSHOT
  }
}
