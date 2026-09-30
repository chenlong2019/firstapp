import * as THREE from 'three'

/**
 * DJI Mini 4 Pro 灯光模拟。
 *
 * 依据《DJI Mini 4 Pro 灯光/灯语说明手册 v1.0》实现三类灯光:
 * 1. 尾部状态指示灯(左右各一颗,常规灯语左右同色;电机启动后按国内固件左红右绿)
 * 2. 智能飞行电池电量指示灯(4 颗 LED)
 * 3. 底部辅助照明灯(Mini 4 Pro 独有:地面上电无法点亮,必须起飞后才能开启)
 *
 * 安装位置(依据手册与实机):
 * 1. 飞行器状态指示灯(Remote ID 识别灯):机尾左右两个机臂末端,左右各 1 颗
 * 2. 电池电量指示灯:机身尾部电池模块的尾面,电源按键旁,横向 4 颗
 * 3. 底部辅助照明灯:机身正下方,紧贴下视视觉传感器,朝下照射
 *
 * 坐标约定:模型局部 -Z 为机头(云台),+Z 为机尾(电池),-X 为左侧、+X 为右侧。
 * 锚点全部取自模型自带语义节点(LED_Status_Tail_* / SENSOR_Glass_Downward / LIGHT_*),
 * 灯组 rig 挂在模型节点下,随模型一起移动旋转;模型自带的 LIGHT_* 点光源也由本模块驱动。
 */

export type StatusLightKey =
  | 'selfCheck'
  | 'sensorWarmup'
  | 'gnssNormal'
  | 'gnssWeak'
  | 'attiMode'
  | 'rcLost'
  | 'lowBattery'
  | 'criticalBattery'
  | 'tilted'
  | 'fcError'
  | 'compassError'
  | 'motorRunning'
  | 'off'

export type BatteryLightMode = 'level' | 'charging' | 'full' | 'fault' | 'off'
export type AuxLightMode = 'auto' | 'on' | 'off'

/** 灯语的一个时间片段:colors 依次对应 [左灯, 右灯](只给一个颜色时左右同色) */
export interface LightStep {
  colors: number[]
  onMs: number
  offMs: number
}

export interface StatusPatternMeta {
  key: StatusLightKey
  label: string
  meaning: string
  uiColor: string
  steps: LightStep[]
}

const RED = 0xff3b30
const GREEN = 0x30ff70
const YELLOW = 0xffc53d
const BATTERY_COLOR = 0x9fffcb

const step = (colors: number[], onMs: number, offMs = 0): LightStep => ({ colors, onMs, offMs })
const repeat = (s: LightStep, n: number): LightStep[] => Array.from({ length: n }, () => ({ ...s }))

/** 尾部状态灯语库(与手册第 1 节一一对应) */
export const STATUS_PATTERNS: Record<StatusLightKey, Omit<StatusPatternMeta, 'key'>> = {
  selfCheck: {
    label: '开机系统自检',
    meaning: '红绿黄交替闪烁',
    uiColor: '#ff3b30',
    steps: [step([RED], 150, 110), step([GREEN], 150, 110), step([YELLOW], 150, 110)],
  },
  sensorWarmup: {
    label: '传感器预热中',
    meaning: '黄灯连续闪 4 次',
    uiColor: '#ffc53d',
    steps: [...repeat(step([YELLOW], 140, 130), 4), step([YELLOW], 0, 1000)],
  },
  gnssNormal: {
    label: 'GNSS 定位正常',
    meaning: '绿灯慢闪 · 可以起飞',
    uiColor: '#30ff70',
    steps: [step([GREEN], 450, 1250)],
  },
  gnssWeak: {
    label: 'GNSS 信号弱',
    meaning: '绿灯双闪 · 依靠视觉定位',
    uiColor: '#30ff70',
    steps: [step([GREEN], 130, 160), step([GREEN], 130, 1150)],
  },
  attiMode: {
    label: '姿态模式',
    meaning: '黄灯慢闪 · 无 GPS 无视觉定位,谨慎飞行',
    uiColor: '#ffc53d',
    steps: [step([YELLOW], 450, 1250)],
  },
  rcLost: {
    label: '遥控器信号丢失',
    meaning: '黄灯快闪',
    uiColor: '#ffc53d',
    steps: [step([YELLOW], 110, 110)],
  },
  lowBattery: {
    label: '低电量预警',
    meaning: '红灯慢闪 · 准备自动返航',
    uiColor: '#ff3b30',
    steps: [step([RED], 450, 1250)],
  },
  criticalBattery: {
    label: '严重低电量',
    meaning: '红灯快闪 · 强制返航',
    uiColor: '#ff3b30',
    steps: [step([RED], 110, 110)],
  },
  tilted: {
    label: '机身放置不平',
    meaning: '红灯间隔闪烁 · 传感器误差大',
    uiColor: '#ff3b30',
    steps: [step([RED], 220, 1700)],
  },
  fcError: {
    label: '飞控严重故障',
    meaning: '红灯常亮 · 禁止起飞',
    uiColor: '#ff3b30',
    steps: [step([RED], 1200, 0)],
  },
  compassError: {
    label: '指南针异常',
    meaning: '红黄灯交替闪烁 · 需要校准',
    uiColor: '#ff8c1a',
    steps: [step([RED], 330, 140), step([YELLOW], 330, 140)],
  },
  motorRunning: {
    label: '电机启动 · Remote ID',
    meaning: '国内固件规则:左侧红灯闪烁、右侧绿灯闪烁',
    uiColor: '#ff3b30',
    steps: [step([RED, GREEN], 500, 500)],
  },
  off: {
    label: '未上电 / 关闭',
    meaning: '状态灯熄灭',
    uiColor: '#5a6b70',
    steps: [step([0x000000], 1200, 0)],
  },
}

/** 供面板渲染的模式列表(保持手册顺序) */
export const STATUS_PATTERN_LIST: StatusPatternMeta[] = (
  Object.keys(STATUS_PATTERNS) as StatusLightKey[]
).map((key) => ({ key, ...STATUS_PATTERNS[key] }))

/** 手册第 2 节:电量 -> [常亮数, 闪烁的那一颗索引(从 0 计, null 无)] */
export function batteryLedPlan(levelPercent: number): { lit: number; blinkIndex: number | null } {
  const level = Math.max(0, Math.min(100, levelPercent))
  if (level >= 88) return { lit: 4, blinkIndex: null }
  if (level >= 76) return { lit: 3, blinkIndex: 3 }
  if (level >= 63) return { lit: 3, blinkIndex: null }
  if (level >= 51) return { lit: 2, blinkIndex: 2 }
  if (level >= 38) return { lit: 2, blinkIndex: null }
  if (level >= 26) return { lit: 1, blinkIndex: 1 }
  return { lit: 1, blinkIndex: null }
}

/** 生成电量对应的文字说明,例如 "3 常亮 + 1 闪烁" */
export function describeBatteryLevel(levelPercent: number): string {
  const { lit, blinkIndex } = batteryLedPlan(levelPercent)
  return blinkIndex === null ? `${lit} 灯常亮` : `${lit} 常亮 + 1 闪烁`
}

export interface BatteryLedSnapshot {
  /** 当前帧是否点亮 */
  on: boolean
  /** 该灯是否属于"闪烁"角色(供面板用 CSS 动画镜像) */
  blinking: boolean
}

export interface DroneLightsSnapshot {
  statusKey: StatusLightKey
  statusLabel: string
  statusMeaning: string
  batteryMode: BatteryLightMode
  batteryLevel: number
  batteryLeds: BatteryLedSnapshot[]
  auxMode: AuxLightMode
  /** 辅助灯当前是否真的点亮(受起飞状态门控) */
  auxOn: boolean
  /** 是否处于"地面锁定"(未起飞,辅助灯不可点亮) */
  auxLocked: boolean
}

interface Led {
  /** 发光网格:优先直接复用模型自带的灯珠网格本体 */
  mesh: THREE.Object3D
  material: THREE.MeshStandardMaterial
  /** 模型自带灯珠网格(= mesh 本身;换上的自发光材质只赋给该网格,不动全机共享材质) */
  sourceMesh: THREE.Object3D | null
  /** 灯珠网格出厂时的原材质(全机共享,销毁时必须还原引用) */
  originalMaterial: THREE.Material | null
  /** 模型自带的点光源对象(LIGHT_*),位置由我们摆放、颜色强度由灯语驱动 */
  light: THREE.PointLight | null
  /** 点亮时点光源强度;不填用 LED_LIGHT_INTENSITY(近距离成排的灯珠应调低,溢光会互相叠加) */
  lightIntensity?: number
  /**
   * 挂进机臂折叠节点时的"骨骼绑定位姿"(机臂局部系)。
   * 每帧按它强制同步,灯珠像焊在骨骼上一样跟随机臂折叠/展开 ——
   * 即使中途被热更新重建等外力挪动过,下一帧也会自动归位。
   */
  bindLocal?: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }
  /**
   * 灯珠网格出厂时的父节点。attachStatusToArms 会把灯珠网格移挂进机臂折叠节点，
   * 销毁时必须放回原父节点，否则模型树里永久缺了这盏灯（热更新重建灯组时再也找不到网格）。
   * 为 null 表示灯珠是模型缺网格时我们手工补的兜底球体，销毁直接摘掉即可。
   */
  originalParent: THREE.Object3D | null
  /** 出厂点光源的父节点（点光源同样会被移挂进机臂折叠节点，销毁时一并放回） */
  originalLightParent: THREE.Object3D | null
}

const AUTO_LIGHT_MAX_AGL_METERS = 8 // 自动模式:模拟"夜间低空降落辅助",高于此高度自动熄灭
const AUX_SPOT_ANGLE = 0.42
const AUX_SPOT_INTENSITY = 26
const LED_LIGHT_INTENSITY = 0.35 // 灯珠点光源强度(轻微溢光,保持灯珠可辨)
const LED_LIGHT_DISTANCE = 1.6
const AUX_MODEL_LIGHT_INTENSITY = 1.6 // 模型自带 LIGHT_BottomAssist 的峰值强度

export class DroneLights {
  private rig = new THREE.Group()
  private model: THREE.Group | null = null
  private scene: THREE.Scene | null = null

  private statusLeds: Led[] = []
  private batteryLeds: Led[] = []
  private auxDisc: THREE.Mesh | null = null
  private auxDiscMaterial: THREE.MeshStandardMaterial | null = null
  private auxSpot: THREE.SpotLight | null = null
  private auxGlow: THREE.PointLight | null = null
  private auxBeam: THREE.Mesh | null = null
  /** 模型自带的 LIGHT_BottomAssist,强度随辅助灯淡入淡出 */
  private auxModelLight: THREE.PointLight | null = null

  private statusKey: StatusLightKey = 'gnssNormal'
  private batteryMode: BatteryLightMode = 'level'
  /**
   * 底部辅助照明灯的下向光束锥是否绘制(页面"照明光束"勾选框)。
   * 默认 false:辅助灯本身照常工作(聚光灯/灯面/模型点光源),只是不画那根锥形光柱。
   * ⚠️ 这是"每帧被 applyAux() 刷新的显隐",必须存状态字段,不能只改 auxBeam.visible。
   */
  private beamEnabled = false
  private batteryLevel = 80
  private auxMode: AuxLightMode = 'auto'
  private flying = false
  private auxOn = false
  private auxIntensity = 0
  private timeMs = 0
  /** 状态灯珠是否已挂到后机臂折叠节点下(一次性,须在展开态完成) */
  private statusArmsAttached = false
  /** 机臂折叠节点引用(按 statusLeds 索引对齐:[0]=右臂,[1]=左臂),供每帧骨骼同步 */
  private statusArmFolds: Array<THREE.Object3D | null> = [null, null]
  private batteryLedsUi: BatteryLedSnapshot[] = []
  private readonly tmpVector = new THREE.Vector3()
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = []

  /** 在模型局部坐标系中构建灯组并挂载到模型节点下 */
  attach(model: THREE.Group, scene: THREE.Scene): void {
    this.model = model
    this.scene = scene

    // 计算模型"自身坐标系"下的包围盒:临时归一模型变换后测量
    const savedPosition = model.position.clone()
    const savedQuaternion = model.quaternion.clone()
    const savedScale = model.scale.clone()
    model.position.set(0, 0, 0)
    model.quaternion.identity()
    model.scale.set(1, 1, 1)
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    model.position.copy(savedPosition)
    model.quaternion.copy(savedQuaternion)
    model.scale.copy(savedScale)
    model.updateMatrixWorld(true)

    const size = box.getSize(new THREE.Vector3())

    // —— 模型自带灯位对象解析(优先使用,避免手写坐标导致悬空) ——
    model.updateMatrixWorld(true)
    const raycaster = new THREE.Raycaster()
    const raycastLocal = (localX: number, localY: number, fromLocalZ: number, dir: THREE.Vector3): THREE.Vector3 => {
      const origin = model.localToWorld(new THREE.Vector3(localX, localY, fromLocalZ))
      raycaster.set(origin, dir.clone().normalize())
      const hits = raycaster.intersectObject(model, true)
      const hit = hits[0]
      return hit ? model.worldToLocal(hit.point.clone()) : new THREE.Vector3(localX, localY, fromLocalZ)
    }
    /** 取命名节点在模型自身坐标系中的中心(网格按几何包围盒中心,灯光按世界位置) */
    const nodeCenterLocal = (name: string): THREE.Vector3 | null => {
      const object = model.getObjectByName(name)
      if (!object) return null
      if (object instanceof THREE.Mesh && object.geometry) {
        object.geometry.computeBoundingBox()
        const geometryBox = object.geometry.boundingBox
        if (geometryBox) {
          const center = geometryBox.getCenter(new THREE.Vector3())
          return model.worldToLocal(object.localToWorld(center.clone()))
        }
      }
      return model.worldToLocal(object.getWorldPosition(new THREE.Vector3()))
    }
    /** 把模型自带的 LIGHT_* 点光源摆到锚点,交给灯语驱动 */
    const takeModelLight = (name: string, anchor: THREE.Vector3): THREE.PointLight | null => {
      const light = model.getObjectByName(name)
      if (!(light instanceof THREE.PointLight)) return null
      const parent = light.parent ?? model
      light.position.copy(parent.worldToLocal(model.localToWorld(anchor.clone())))
      light.intensity = 0
      light.distance = LED_LIGHT_DISTANCE
      light.decay = 2
      return light
    }

    // —— 1. 飞行器状态指示灯(Remote ID 识别灯):机尾左右两个机臂末端(±X, +Z 侧) ——
    // 直接复用模型自带灯珠网格 LED_Status_Tail_Left / Right:保留原几何与朝向,
    // 仅给该网格单独赋自发光材质(全机材质共享,不能改共享材质本身)
    for (const spec of [
      { meshName: 'LED_Status_Tail_Right', lightName: 'LIGHT_StatusLED_Right', fallback: new THREE.Vector3(8.6, 0.95, 9.71) },
      { meshName: 'LED_Status_Tail_Left', lightName: 'LIGHT_StatusLED_Left', fallback: new THREE.Vector3(-8.6, 0.95, 9.71) },
    ]) {
      const sourceMesh = model.getObjectByName(spec.meshName) ?? null
      const anchor = nodeCenterLocal(spec.meshName) ?? spec.fallback
      const material = this.createLedMaterial(2.4, ledShellMap(sourceMesh))
      let mesh: THREE.Object3D
      let originalMaterial: THREE.Material | null = null
      // 此刻 attachStatusToArms 尚未调用,sourceMesh.parent 就是出厂父节点
      let originalParent: THREE.Object3D | null = null
      if (sourceMesh instanceof THREE.Mesh) {
        // 网格本体即发光体:原地换材质,可见性不变,位置先不动(展开后由 attachStatusToArms 挂进机臂)
        originalMaterial = sourceMesh.material
        originalParent = sourceMesh.parent
        sourceMesh.material = material
        mesh = sourceMesh
      } else {
        const geometry = new THREE.SphereGeometry(0.62, 14, 12)
        this.disposables.push(geometry)
        mesh = new THREE.Mesh(geometry, material)
        mesh.position.copy(anchor)
        this.rig.add(mesh)
      }
      const light = takeModelLight(spec.lightName, anchor)
      this.statusLeds.push({
        mesh,
        material,
        sourceMesh,
        originalMaterial,
        originalParent,
        originalLightParent: light?.parent ?? null,
        light,
      })
    }

    // —— 2. 电池电量指示灯:直接复用模型自带灯珠网格 LED_BatteryCharge_01..04(01 左 → 04 右) ——
    // 网格挂在 CTRL_DJI_Root 之下(带停放配平俯仰),原位就是正确位置,无需移挂;
    // 与状态灯一样只给网格单独赋自发光材质(全机材质共享,不能改共享材质本身)
    for (let index = 0; index < 4; index += 1) {
      const meshName = `LED_BatteryCharge_0${index + 1}`
      const sourceMesh = model.getObjectByName(meshName) ?? null
      // 4 颗灯珠连排且离相机近,自发光调低避免 Bloom 过曝糊成一片
      const material = this.createLedMaterial(0.9, ledShellMap(sourceMesh))
      let mesh: THREE.Object3D
      let originalMaterial: THREE.Material | null = null
      let anchor: THREE.Vector3
      let originalParent: THREE.Object3D | null = null
      if (sourceMesh instanceof THREE.Mesh) {
        originalMaterial = sourceMesh.material
        originalParent = sourceMesh.parent
        sourceMesh.material = material
        mesh = sourceMesh
        anchor = nodeCenterLocal(meshName) ?? new THREE.Vector3()
      } else {
        // 兜底:模型缺网格时在电池尾面手放小灯珠
        anchor = new THREE.Vector3(-1.5 + index, 1.4, 6.2 + 0.28)
        const geometry = new THREE.SphereGeometry(0.32, 14, 12)
        this.disposables.push(geometry)
        mesh = new THREE.Mesh(geometry, material)
        mesh.position.copy(anchor)
        this.rig.add(mesh)
      }
      const batteryLight = takeModelLight(`LIGHT_BatteryLED_0${index + 1}`, anchor)
      const led: Led = {
        mesh,
        material,
        sourceMesh,
        originalMaterial,
        originalParent,
        originalLightParent: batteryLight?.parent ?? null,
        light: batteryLight,
        // 真机灯珠嵌在壳体开孔内,光不会打亮外壳;点光源溢光归零,只留灯珠自发光
        lightIntensity: 0,
      }
      this.batteryLeds.push(led)
    }
    this.batteryLedsUi = this.batteryLeds.map(() => ({ on: false, blinking: false }))

    // —— 3. 底部辅助照明灯:机身正下方,紧贴下视视觉传感器(SENSOR_Glass_Downward) ——
    const downSensor = nodeCenterLocal('SENSOR_Glass_Downward') ?? new THREE.Vector3(0, -2.45, -0.93)
    const auxZ = downSensor.z + 1.15 // 下视传感器旁(向机尾侧偏移,避免与玻璃重叠)
    const auxAnchor = raycastLocal(0, box.min.y - size.y, auxZ, new THREE.Vector3(0, 1, 0)) // 从机腹下方往上吸附
    const auxY = auxAnchor.y - 0.06
    this.auxModelLight = takeModelLight('LIGHT_BottomAssist', new THREE.Vector3(0, auxY - 0.25, auxZ))
    const discGeometry = new THREE.CircleGeometry(1.15, 20)
    discGeometry.rotateX(Math.PI / 2) // 面朝下
    this.disposables.push(discGeometry)
    this.auxDiscMaterial = new THREE.MeshStandardMaterial({
      color: 0x1c2126,
      emissive: 0xffe9c0,
      emissiveIntensity: 0,
      roughness: 0.5,
    })
    this.auxDisc = new THREE.Mesh(discGeometry, this.auxDiscMaterial)
    this.auxDisc.position.set(0, auxY, auxZ)
    this.rig.add(this.auxDisc)

    this.auxSpot = new THREE.SpotLight('#ffe9c4', 0, 0, AUX_SPOT_ANGLE, 0.45, 1.4)
    this.auxSpot.position.copy(this.auxDisc.position)
    const spotTarget = new THREE.Object3D()
    spotTarget.position.set(0, auxY - 1.2, auxZ)
    this.rig.add(spotTarget)
    this.auxSpot.target = spotTarget
    this.rig.add(this.auxSpot)

    this.auxGlow = new THREE.PointLight('#ffe9c4', 0, 2.4, 1.8)
    this.auxGlow.position.set(0, auxY - 0.3, auxZ)
    this.rig.add(this.auxGlow)

    // 光束锥体放在场景坐标系中,每帧按"灯到地面"的真实距离拉伸
    const beamGeometry = new THREE.ConeGeometry(1, 1, 24, 1, true)
    beamGeometry.translate(0, -0.5, 0) // 锥顶移到原点,便于从灯位向下缩放
    this.disposables.push(beamGeometry)
    const beamMaterial = new THREE.MeshBasicMaterial({
      color: '#ffe2a8',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.disposables.push(beamMaterial)
    this.auxBeam = new THREE.Mesh(beamGeometry, beamMaterial)
    this.auxBeam.visible = false
    scene.add(this.auxBeam)

    model.add(this.rig)
  }

  /** 每帧驱动:deltaSeconds */
  update(deltaSeconds: number): void {
    const delta = Math.max(0, Math.min(deltaSeconds, 0.1))
    this.timeMs += delta * 1000
    this.applyStatusPattern()
    this.applyBattery()
    this.applyAux(delta)
  }

  setStatusPattern(key: StatusLightKey): void {
    if (key in STATUS_PATTERNS) this.statusKey = key
  }

  setBatteryMode(mode: BatteryLightMode): void {
    this.batteryMode = mode
  }

  setBatteryLevel(levelPercent: number): void {
    this.batteryLevel = Math.max(0, Math.min(100, levelPercent))
  }

  setAuxLightMode(mode: AuxLightMode): void {
    this.auxMode = mode
  }

  /**
   * 底部辅助灯的锥形光束显隐(不影响辅助灯本身的照明)。
   * 立即重算一次,不必等下一帧。
   */
  setBeamVisible(visible: boolean): void {
    this.beamEnabled = visible
    this.applyAux(0)
  }

  /** 当前是否绘制锥形光束(探针用) */
  isBeamVisible(): boolean {
    return this.beamEnabled
  }

  /** 由飞行控制器每帧同步:是否已离地起飞 */
  setFlying(flying: boolean): void {
    this.flying = flying
  }

  /**
   * 把尾部状态灯(模型自带灯珠网格 + 点光源)挂到后机臂折叠节点下,跟随折叠/展开运动。
   *
   * 真机(DJI Mini 4 Pro)状态灯位于"后机臂外端末梢",但模型把灯珠网格静态
   * 烘焙在机身坐标系,折叠时灯珠悬空在机外、展开动画中也不跟随。
   * 必须在机臂【展开态】调用一次:此刻灯珠世界位姿正好落在机臂末端
   * (电机钟罩下方的端板),用 Object3D.attach 保持世界变换移挂进折叠节点,
   * 之后随臂折叠、展开、飞行姿态一起运动。
   *
   * ⚠️ 锚点/移挂对象必须是模型自带灯珠网格本体:它挂在 CTRL_DJI_Root 之下,
   * 带着停放配平俯仰,是真实渲染位置。早期版本用自发光克隆体(rig 挂在模型根,
   * 不吃配平俯仰)导致灯珠恒定浮高 sin13.6°×0.73≈0.175m。
   */
  attachStatusToArms(leftFold: THREE.Object3D | null, rightFold: THREE.Object3D | null): void {
    if (!this.model) return
    if (this.statusArmsAttached) {
      // 已绑定过:只检查父子关系是否仍然成立(热更新重建等外力可能破坏它)
      this.statusArmFolds = [rightFold, leftFold] // 与 statusLeds 对齐:[0]=右,[1]=左
      for (const [index, led] of this.statusLeds.entries()) {
        const fold = this.statusArmFolds[index]
        if (led && fold && led.mesh.parent !== fold) {
          fold.attach(led.mesh) // 父子关系被破坏 → 按当前世界位姿重新收养
          if (led.light) fold.attach(led.light)
        }
      }
      return
    }
    this.model.updateMatrixWorld(true)
    const pairs: Array<{ led: Led | undefined; fold: THREE.Object3D | null }> = [
      { led: this.statusLeds[1], fold: leftFold }, // statusLeds[1] 在 -X(左)
      { led: this.statusLeds[0], fold: rightFold }, // statusLeds[0] 在 +X(右)
    ]
    for (const { led, fold } of pairs) {
      if (!led || !fold) continue
      fold.attach(led.mesh) // 保持世界变换移挂(实测精确;灯珠本体在正确变换链上)
      if (led.light) fold.attach(led.light)
      // 记录骨骼绑定位姿:此后每帧按它强制同步(见 syncStatusToArms)
      led.bindLocal = {
        position: led.mesh.position.clone(),
        quaternion: led.mesh.quaternion.clone(),
        scale: led.mesh.scale.clone(),
      }
    }
    this.statusArmFolds = [rightFold, leftFold]
    this.statusArmsAttached = true
  }

  /**
   * 每帧把状态灯珠按"骨骼绑定位姿"强制同步(骨骼动画式跟随)。
   * 灯珠像焊死在机臂末端一样随折叠/展开运动;任何外力(热更新、调试脚本
   * 挪动、意外重挂)造成的偏移都会在下一帧自动归位。
   */
  syncStatusToArms(): void {
    if (!this.statusArmsAttached) return
    for (const [index, led] of this.statusLeds.entries()) {
      const bind = led?.bindLocal
      const fold = this.statusArmFolds[index]
      if (!bind || !fold || led.mesh.parent !== fold) continue
      led.mesh.position.copy(bind.position)
      led.mesh.quaternion.copy(bind.quaternion)
      led.mesh.scale.copy(bind.scale)
    }
  }

  getSnapshot(): DroneLightsSnapshot {
    const pattern = STATUS_PATTERNS[this.statusKey]
    return {
      statusKey: this.statusKey,
      statusLabel: pattern.label,
      statusMeaning: pattern.meaning,
      batteryMode: this.batteryMode,
      batteryLevel: this.batteryLevel,
      batteryLeds: this.batteryLedsUi,
      auxMode: this.auxMode,
      auxOn: this.auxOn,
      auxLocked: !this.flying,
    }
  }

  destroy(): void {
    this.rig.parent?.remove(this.rig)
    if (this.auxBeam) this.scene?.remove(this.auxBeam)
    for (const led of [...this.statusLeds, ...this.batteryLeds]) {
      // 原生灯珠网格可能已被移挂进机臂折叠节点:先放回出厂父节点。
      // 不能直接 remove —— 那会让模型树里永久缺了这盏灯,热更新重建灯组时再也找不到网格。
      if (led.originalParent) {
        if (led.mesh.parent !== led.originalParent) led.originalParent.attach(led.mesh)
      } else {
        // 兜底自建灯珠(模型缺网格时手工补的球体)不属于模型,直接摘掉
        led.mesh.parent?.remove(led.mesh)
      }
      // 点光源同理:可能被移挂进了机臂折叠节点
      if (led.light && led.originalLightParent && led.light.parent !== led.originalLightParent) {
        led.originalLightParent.attach(led.light)
      }
      // 原材质是全机共享的,必须还原引用
      if (led.originalMaterial && led.sourceMesh instanceof THREE.Mesh) {
        led.sourceMesh.material = led.originalMaterial
      }
    }
    for (const disposable of this.disposables) disposable.dispose()
    this.disposables.length = 0
    this.statusLeds = []
    this.batteryLeds = []
    this.auxDisc = null
    this.auxDiscMaterial = null
    this.auxSpot = null
    this.auxGlow = null
    this.auxBeam = null
    this.auxModelLight = null
    this.statusArmsAttached = false
    this.model = null
    this.scene = null
  }

  /**
   * 灯珠自发光材质。
   *
   * ⚠️ 底色必须跟着模型自带贴图走:灯珠网格用的是全机共享的贴图材质,灯位在贴图上就是
   * "灯罩本色"(机臂末端为绿色)。早期版本把 color 写成深色(0x181d21)且不带 map,
   * 结果灯没亮(emissive=0)时整颗灯珠只剩近黑底色,把原模型的绿色灯罩盖成了黑疙瘩。
   *
   * emissiveIntensity 默认按"远距离可辨"的臂尖状态灯取值;近距离成排的灯珠(电池条)应调低,否则过曝糊成一片。
   */
  private createLedMaterial(
    emissiveIntensity = 2.4,
    shellMap: THREE.Texture | null = null,
  ): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      // 有原贴图 → 白底乘贴图(还原灯罩本色);模型缺网格走手放球兜底时才用暗底
      color: shellMap ? 0xffffff : 0x181d21,
      map: shellMap,
      emissive: 0x000000,
      emissiveIntensity,
      roughness: 0.4,
      metalness: 0.1,
      // 原共享材质是 doubleSided,灯珠嵌在壳体开孔里,保持双面避免背面缺失
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.disposables.push(material)
    return material
  }

  /** 点亮/熄灭一颗灯珠:同时驱动自发光材质与模型自带的点光源 */
  private setLed(led: Led, color: number, on: boolean): void {
    led.material.emissive.setHex(on ? color : 0x000000)
    if (led.light) {
      led.light.intensity = on ? (led.lightIntensity ?? LED_LIGHT_INTENSITY) : 0
      if (on) led.light.color.setHex(color)
    }
  }

  /** 手册第 1 节:尾部状态灯语(左右两颗;常规灯语左右同色,电机启动后左红右绿) */
  private applyStatusPattern(): void {
    const pattern = STATUS_PATTERNS[this.statusKey]
    const loopMs = pattern.steps.reduce((sum, s) => sum + s.onMs + s.offMs, 0)
    let t = loopMs > 0 ? this.timeMs % loopMs : 0
    let colors = pattern.steps[0]?.colors ?? [0x000000]
    let on = false
    for (const s of pattern.steps) {
      if (t < s.onMs) {
        colors = s.colors
        on = true
        break
      }
      if (t < s.onMs + s.offMs) {
        colors = s.colors
        on = false
        break
      }
      t -= s.onMs + s.offMs
    }
    // statusLeds[0] 在 +X(右侧),statusLeds[1] 在 -X(左侧);colors 约定 [左, 右]
    const left = this.statusLeds[1]
    const right = this.statusLeds[0]
    if (!left || !right) return
    this.setLed(left, colors[0] ?? 0x000000, on)
    this.setLed(right, colors[1] ?? colors[0] ?? 0x000000, on)
  }

  /** 手册第 2 节:电池 4 颗 LED */
  private applyBattery(): void {
    if (this.batteryLeds.length === 0) return
    let states: boolean[]
    let blinkFlags: boolean[]

    if (this.batteryMode === 'off') {
      // 关闭:4 颗电量灯全部熄灭
      states = [false, false, false, false]
      blinkFlags = [false, false, false, false]
    } else if (this.batteryMode === 'full') {
      states = [true, true, true, true]
      blinkFlags = [false, false, false, false]
    } else if (this.batteryMode === 'fault') {
      // 异常闪烁:电池保护触发
      states = this.batteryLeds.map(() => blinkPhase(this.timeMs, 110, 110))
      blinkFlags = [true, true, true, true]
    } else if (this.batteryMode === 'charging') {
      // 充电中:LED 依次跑马点亮
      const active = Math.floor(this.timeMs / 240) % 4
      states = this.batteryLeds.map((_, i) => i === active)
      blinkFlags = [false, false, false, false]
    } else {
      const plan = batteryLedPlan(this.batteryLevel)
      states = this.batteryLeds.map((_, i) => {
        if (i < plan.lit) return true
        if (plan.blinkIndex !== null && i === plan.blinkIndex) return blinkPhase(this.timeMs, 240, 240)
        return false
      })
      blinkFlags = this.batteryLeds.map((_, i) => plan.blinkIndex !== null && i === plan.blinkIndex)
    }

    this.batteryLeds.forEach((led, i) => {
      const ui = this.batteryLedsUi[i]
      if (!ui) return
      this.setLed(led, BATTERY_COLOR, states[i] ?? false)
      ui.on = states[i] ?? false
      ui.blinking = blinkFlags[i] ?? false
    })
  }

  /** 手册第 3 节:底部辅助照明灯(地面锁定 + 起飞后才能点亮) */
  private applyAux(delta: number): void {
    if (!this.auxSpot || !this.auxDisc || !this.auxBeam || !this.auxDiscMaterial || !this.auxGlow) return

    let want = false
    if (this.flying) {
      if (this.auxMode === 'on') want = true
      else if (this.auxMode === 'auto') {
        // 自动模式:模拟夜间低空降落辅助,离地过高时熄灭
        this.auxDisc.getWorldPosition(this.tmpVector)
        want = this.tmpVector.y <= AUTO_LIGHT_MAX_AGL_METERS
      }
    }
    this.auxOn = want

    const target = want ? AUX_SPOT_INTENSITY : 0
    this.auxIntensity += (target - this.auxIntensity) * Math.min(1, delta * 9)
    const ratio = this.auxIntensity / AUX_SPOT_INTENSITY

    this.auxSpot.intensity = this.auxIntensity
    this.auxGlow.intensity = this.auxIntensity * 0.06
    this.auxDiscMaterial.emissiveIntensity = 2.6 * ratio
    if (this.auxModelLight) this.auxModelLight.intensity = AUX_MODEL_LIGHT_INTENSITY * ratio

    // 光束锥:从灯位拉伸到地面(场景坐标系);未勾选"照明光束"时不画
    this.auxDisc.getWorldPosition(this.tmpVector)
    const distance = Math.max(0.05, this.tmpVector.y)
    const visible = this.beamEnabled && ratio > 0.03
    this.auxBeam.visible = visible
    if (visible) {
      const slope = Math.tan(AUX_SPOT_ANGLE)
      this.auxBeam.position.copy(this.tmpVector)
      this.auxBeam.scale.set(distance * slope, distance, distance * slope)
      ;(this.auxBeam.material as THREE.MeshBasicMaterial).opacity = 0.12 * ratio
    }
  }
}

function blinkPhase(timeMs: number, onMs: number, offMs: number): boolean {
  return timeMs % (onMs + offMs) < onMs
}

/**
 * 取灯珠网格原材质上的贴图(灯罩本色)。
 * 全机共享同一个贴图材质,这里只是只读引用,不会改动共享材质与贴图本身。
 */
function ledShellMap(mesh: THREE.Object3D | null): THREE.Texture | null {
  if (!(mesh instanceof THREE.Mesh)) return null
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const map = material ? (material as THREE.MeshStandardMaterial).map : null
  return map instanceof THREE.Texture ? map : null
}
