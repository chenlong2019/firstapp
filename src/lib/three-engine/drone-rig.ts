import * as THREE from 'three'

/**
 * 无人机模型的机械驱动。
 *
 * 全部通过语义节点名操作(见《DJI Mini 4 Pro 模型 ID 与名称对应表》),不做索引假设:
 * - 桨叶:CTRL_Prop_<位置>_Spin 绕自身局部 Y 轴自转(导出到 Three.js 后 Blender 的局部 Z 即局部 Y),
 *   对角两个电机同向。桨叶桨距已由模型出厂烘进几何(实测 ~15°,与自转方向配对),
 *   这里不做任何几何补烘,尊重出厂状态。
 * - 机臂:CTRL_Arm_<位置>_Fold,折叠轴是机体竖轴;折叠角度不是猜的,而是载入时用
 *   "铰链 → 桨心"向量与该机臂应有的收纳方向(前臂朝机尾、后臂朝机头)算出来的。
 * - 云台:CTRL_Gimbal_Yaw / Pitch / Roll 三轴。真机云台是增稳平台,
 *   所以这里做反向补偿:机体倾斜多少,云台就往回摆多少(超出机械行程才让画面跟着歪)。
 * - 机体姿态:整体倾斜施加在 CTRL_DJI_Root(模型内部根节点,原点≈机身重心)上。
 */

export type ArmPosition = 'FrontLeft' | 'FrontRight' | 'RearLeft' | 'RearRight'

export const ARM_POSITIONS: ArmPosition[] = ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']

const degToRad = (deg: number): number => (deg * Math.PI) / 180

/**
 * 对角反转:前左/后右 一组,前右/后左 一组,旋转方向相反。
 * 符号不是猜的:实测出厂桨叶法线与自转轴的桨距角 φ(前左/后右 ≈ +15°,
 * 前右/后左 ≈ −15°)。要产生向上拉力,φ>0 的桨必须俯视顺时针转(自转角递减),
 * φ<0 的桨必须俯视逆时针转(自转角递增)——据此取反。
 */
const PROP_SPIN_SIGN: Record<ArmPosition, number> = {
  FrontLeft: -1,
  RearRight: -1,
  FrontRight: 1,
  RearLeft: 1,
}

const ARM_LABELS: Record<ArmPosition, string> = {
  FrontLeft: '前左机臂',
  FrontRight: '前右机臂',
  RearLeft: '后左机臂',
  RearRight: '后右机臂',
}

/** 云台机械行程 */
export const GIMBAL_LIMITS = {
  pitchMin: -90,
  pitchMax: 60,
  rollLimit: 35,
  yawLimit: 5,
} as const

/** 模型自检结果(测试沙盒里逐项显示) */
export interface RigPartReport {
  id: string
  label: string
  found: boolean
  /** 该部件是否可被驱动 */
  drivable: boolean
}

/** 单片桨叶:折叠 = 绕电机轴(自转局部 Y)偏航叠拢到机臂方向 */
interface BladeUnit {
  mesh: THREE.Mesh
  bindPosition: THREE.Vector3
  bindQuaternion: THREE.Quaternion
  /** 叠拢偏航(弧度):0 = 自然张开位置,施加 stackYaw 后桨叶指向机臂方向 */
  stackYaw: number
}

interface PropUnit {
  position: ArmPosition
  node: THREE.Object3D
  bindPosition: THREE.Vector3
  spinSign: number
  angle: number
  /** 出厂装配姿态(自转控制器的静态装配倾角,电机轴方向) */
  bindQuaternion: THREE.Quaternion
  blades: BladeUnit[]
  /**
   * 收纳抬升量(米,几何实测):叠拢后桨叶与机身的最大侵入 + 余量。
   * 折叠时转子沿电机轴抬起这么多,模拟真机"桨叶架在机身上"的收纳效果。
   */
  foldLift: number
  /** 桨叶/自转节点局部系 1 单位 = 多少米(GLB 内部坐标可能带缩放) */
  localUnits: number
}

interface ArmUnit {
  position: ArmPosition
  node: THREE.Object3D
  /** 收纳方向对应的旋转角(弧度),折叠度 1 时施加 */
  foldAngle: number
}

/** 自转四元数复用对象(避免每帧分配) */
const spinQuat = new THREE.Quaternion()
const foldQuat = new THREE.Quaternion()
const liftAxis = new THREE.Vector3()
const UP_AXIS = new THREE.Vector3(0, 1, 0)

/** 高度场网格间距(米)与键值 */
const HEIGHTFIELD_CELL = 0.01
/** 顶点低于实体下沿多少米以内仍视为接触(桨叶有厚度,留一点擦碰余量) */
const SOLID_GRAZE = 0.004
const heightfieldKey = (x: number, z: number): string => `${Math.round(x / HEIGHTFIELD_CELL)},${Math.round(z / HEIGHTFIELD_CELL)}`

/** 实体区间:同一竖直格内某个实体的下沿/上沿(世界系,米) */
interface SolidInterval {
  lo: number
  hi: number
}

/** 实体场:格子 → 不相交的竖直区间列表。桨叶从实体下方穿过不算侵入。 */
type SolidField = Map<string, SolidInterval[]>

const addSolid = (field: SolidField, key: string, lo: number, hi: number): void => {
  const list = field.get(key)
  if (!list) {
    field.set(key, [{ lo, hi }])
    return
  }
  // 合并相交/相邻区间,保持列表很短
  for (const interval of list) {
    if (lo <= interval.hi + 1e-4 && hi >= interval.lo - 1e-4) {
      interval.lo = Math.min(interval.lo, lo)
      interval.hi = Math.max(interval.hi, hi)
      return
    }
  }
  list.push({ lo, hi })
}

/** 顶点 (x,y,z) 深入实体内部的深度:在某个区间内返回 hi−y,否则 0 */
const solidPenetration = (field: SolidField, x: number, y: number, z: number): number => {
  const list = field.get(heightfieldKey(x, z))
  if (!list) return 0
  let deepest = 0
  for (const interval of list) {
    if (y < interval.hi && y > interval.lo - SOLID_GRAZE) {
      const depth = interval.hi - y
      if (depth > deepest) deepest = depth
    }
  }
  return deepest
}

/** 平滑 0-1 曲线(收纳抬升用,起止无突跳) */
const smoothstep01 = (t: number): number => {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

/**
 * ————————————————— 统一坐标系约定(全项目唯一声明) —————————————————
 *
 * 世界系(Three.js 标准):
 *   +X 东, +Y 上, -Z 北。航向 heading 从正北顺时针,0°=北 90°=东。
 *
 * 机体系(模型局部,glTF 导出后):
 *   -Z 机头(云台), +Z 机尾(电池), -X 左 / +X 右, +Y 上。
 *
 * 机体姿态角(相对世界水平面):
 *   pitch 正 = 抬头(绕机体系 X 轴), roll 正 = 右压坡(绕机体系 Z 轴取负)。
 *
 * 整机按「刚体」驱动,变换层级自外向内:
 *   model(世界位置+航向) → CTRL_DJI_Root(俯仰/横滚) → 机臂折叠 → 转子/桨叶自转
 *   云台是挂载载荷,在 CTRL_DJI_Root 内部做增稳补偿,不属于刚体位姿。
 * 整机位姿只有一个写入入口:applyBodyPose()。
 */

/** 整机刚体位姿:位置为世界系(米),角度为度 */
export interface DroneBodyPose {
  /** 世界系 X(东为正) */
  x: number
  /** 世界系 Y(离地高度,米) */
  y: number
  /** 世界系 Z(南为正) */
  z: number
  /** 航向角:正北 0°,顺时针增加 */
  headingDeg: number
  /** 俯仰:正 = 抬头 */
  pitchDeg: number
  /** 横滚:正 = 右压坡 */
  rollDeg: number
}

export class DroneRig {
  readonly model: THREE.Group
  readonly parts: RigPartReport[] = []
  private readonly root: THREE.Object3D | null
  private readonly props: PropUnit[] = []
  private readonly arms: ArmUnit[] = []
  private gimbalYaw: THREE.Object3D | null = null
  private gimbalPitch: THREE.Object3D | null = null
  private gimbalRoll: THREE.Object3D | null = null
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = []
  private fold = 0
  private spinAngle = 0
  private lastLoad = 0
  /**
   * 桨叶张开度(0 = 叠拢,1 = 自然张开):有自己的缓动节奏——
   * 机臂完全展开后才开始缓慢张开(与真机一致),收纳时快速叠拢。
   */
  private bladeOpenState = 1
  /** 展开态停放配平抬头角(度,几何实测):前脚撑与机尾底部同时落地 */
  private stancePitchOpen = 0
  /** 展开态配平整体下沉量(米),保证静止时脚撑恰好贴地 */
  private stanceDropOpen = 0
  /** 收纳态下沉量(米):机身平贴地面(俯仰 0),脚撑随机臂收起不再接地 */
  private stanceDropFolded = 0

  constructor(model: THREE.Group) {
    this.model = model
    model.updateMatrixWorld(true)
    this.root = model.getObjectByName('CTRL_DJI_Root') ?? null
    this.collectParts()
    this.buildProps()
    this.buildArms()
    this.computeBladeFold()
    this.computeStanceTrim()
    this.bindGimbal()
  }

  /** 机臂当前折叠度(0 = 展开,1 = 完全收纳) */
  get armFold(): number {
    return this.fold
  }

  /** 桨叶张开度(0 = 叠拢,1 = 张开):起飞自检要求完全张开 */
  get bladeOpen(): number {
    return this.bladeOpenState
  }

  /** 桨叶是否已开始旋转 */
  get motorsSpinning(): boolean {
    return this.spinAngle > 0
  }

  setArmFold(fold: number): void {
    const next = Math.max(0, Math.min(1, fold))
    if (Math.abs(next - this.fold) < 1e-4) return
    this.fold = next
    this.arms.forEach((arm) => {
      arm.node.rotation.y = arm.foldAngle * next
    })
  }

  /**
   * 桨叶姿态的唯一写入口(每帧调用):
   * - 叠拢/张开:bladeOpen 以自己的节奏缓动。机臂完全展开(fold < 0.02)
   *   且电机未转时目标为张开,以慢速率"缓缓转回原位";收纳时以快速率先叠拢。
   * - 收纳抬升:仅当叠拢姿态求不出零侵入时的兜底(当前几何下四桨均为 0,
   *   桨毂保持坐在电机钟罩内);折叠时转子沿电机轴抬起 foldLift。
   */
  updateBlades(deltaSeconds: number): void {
    // 目标:电机在转或机臂展开 ⇒ 张开;仅"电机停转且机臂收纳"才叠拢
    const spinning = this.lastLoad > 0.01
    const target = spinning || this.fold < 0.02 ? 1 : 0
    const rate = target > this.bladeOpenState ? 0.9 : 3.2
    this.bladeOpenState += (target - this.bladeOpenState) * Math.min(1, deltaSeconds * rate)
    if (Math.abs(target - this.bladeOpenState) < 0.002) this.bladeOpenState = target
    const stackFactor = 1 - this.bladeOpenState
    const liftFactor = smoothstep01(this.fold)
    for (const prop of this.props) {
      this.applyBladeFold(prop, stackFactor)
      // 转子(含桨毂)沿电机轴抬起:位置在机臂系,电机轴 = 出厂姿态 × 局部 Y;
      // foldLift 是米,换算成节点局部单位(GLB 内部坐标可能带 10 倍缩放)
      liftAxis.set(0, 1, 0).applyQuaternion(prop.bindQuaternion)
      prop.node.position
        .copy(prop.bindPosition)
        .addScaledVector(liftAxis, prop.foldLift * prop.localUnits * liftFactor)
    }
  }

  /** 叠拢/张开姿态:绕电机轴(自转局部 Y,即桨叶父系 ROTOR 的 Y)偏航 stackYaw×factor */
  private applyBladeFold(prop: PropUnit, factor: number): void {
    for (const [index, blade] of prop.blades.entries()) {
      foldQuat.setFromAxisAngle(UP_AXIS, blade.stackYaw * factor)
      blade.mesh.position.copy(blade.bindPosition).applyQuaternion(foldQuat)
      blade.mesh.quaternion.copy(foldQuat).multiply(blade.bindQuaternion)
      // 两片桨叶叠拢时沿电机轴错开一点层差,像真机桨夹上下叠放
      if (index === 1) blade.mesh.position.addScaledVector(UP_AXIS, 0.012 * prop.localUnits * factor)
    }
  }

  /**
   * 桨叶自转节点姿态的唯一写入口:
   *   q = 出厂姿态 ⊗ Ry(局部 Y, 自转角)
   * 自转后乘局部 Y = 绕**电机轴**(出厂校准的枢轴)旋转,与钟罩/安装面同轴。
   */
  private applyPropRotation(prop: PropUnit): void {
    spinQuat.setFromAxisAngle(UP_AXIS, prop.angle)
    prop.node.quaternion.copy(prop.bindQuaternion).multiply(spinQuat)
  }

  /** 驱动桨叶:load 为电机负荷 0~1 */
  updateProps(load: number, deltaSeconds: number): void {
    const clamped = Math.max(0, Math.min(1, load))
    this.lastLoad = clamped
    // 目视转速:开机怠速即有明显快转,满载接近视觉走样上限(60fps 下 2 叶桨 ~15 转/秒开始频闪)
    const revolutionsPerSecond = clamped <= 0.01 ? 0 : 3.8 + clamped * 7
    const delta = revolutionsPerSecond * deltaSeconds
    if (clamped > 0.01) {
      for (const prop of this.props) {
        prop.angle = (prop.angle + delta * prop.spinSign * Math.PI * 2) % (Math.PI * 2)
        this.applyPropRotation(prop)
      }
    }
  }

  /**
   * 整机刚体位姿的唯一写入入口:世界位置 + 航向施加在模型根节点,
   * 俯仰/横滚施加在 CTRL_DJI_Root(模型内部重心)。机臂、转子、云台
   * 全部挂在这条变换链下游,自动跟随整机运动,无需单独处理。
   *
   * 停放配平随折叠度过渡:展开态机身上仰 stancePitchOpen(电机轴前倾的
   * 补偿,前脚撑与机尾同时着地);收纳态机身平贴(俯仰 0,像真机收纳
   * 后平放在桌面上)。pose.y 语义是"触地点高度",下沉量在这里内部消化。
   */
  applyBodyPose(pose: DroneBodyPose): void {
    const openFactor = 1 - this.fold
    this.model.position.set(
      pose.x,
      pose.y - this.stanceDropOpen * openFactor - this.stanceDropFolded * this.fold,
      pose.z,
    )
    this.model.rotation.y = -degToRad(pose.headingDeg)
    if (this.root) {
      this.root.rotation.x = degToRad(pose.pitchDeg + this.stancePitchOpen * openFactor)
      this.root.rotation.z = -degToRad(pose.rollDeg)
    }
  }

  /**
   * 云台增稳:传入相对水平面的期望角度,机体倾斜(含停放配平)由这里反向补偿掉。
   * 超出机械行程的部分保留,于是大角度机动时画面会跟着歪——与真机一致。
   */
  setGimbalAttitude(pitchDeg: number, rollDeg: number, yawDeg: number, bodyPitch: number, bodyRoll: number): void {
    const totalPitch = bodyPitch + this.stancePitchOpen * (1 - this.fold)
    if (this.gimbalPitch) {
      this.gimbalPitch.rotation.x = degToRad(
        clamp(pitchDeg - totalPitch, GIMBAL_LIMITS.pitchMin, GIMBAL_LIMITS.pitchMax),
      )
    }
    if (this.gimbalRoll) {
      this.gimbalRoll.rotation.z = degToRad(clamp(-(rollDeg - bodyRoll), -GIMBAL_LIMITS.rollLimit, GIMBAL_LIMITS.rollLimit))
    }
    if (this.gimbalYaw) {
      this.gimbalYaw.rotation.y = degToRad(clamp(yawDeg, -GIMBAL_LIMITS.yawLimit, GIMBAL_LIMITS.yawLimit))
    }
  }

  /** 云台相机的世界位置与朝向(机载视角用) */
  getGimbalCameraTransform(target: THREE.Object3D): boolean {
    if (!this.gimbalRoll) return false
    this.gimbalRoll.updateWorldMatrix(true, false)
    this.gimbalRoll.getWorldPosition(target.position)
    this.gimbalRoll.getWorldQuaternion(target.quaternion)
    return true
  }

  destroy(): void {
    this.disposables.forEach((item) => item.dispose())
    this.disposables.length = 0
    this.props.length = 0
    this.arms.length = 0
  }

  // ————————————————————————————— 初始化 —————————————————————————————

  /** 逐项核对 ID 表里的部件是否存在(缺失的会列进自检报告) */
  private collectParts(): void {
    const entries: Array<{ id: string; label: string; drivable?: boolean }> = [
      { id: 'BODY_Main_Fuselage', label: '机身主体' },
      { id: 'BODY_Black_Underside_SensorHousing', label: '黑色下壳' },
      { id: 'GIMBAL_CameraHousing', label: '云台相机壳体' },
      { id: 'GIMBAL_CameraLensFrame', label: '云台镜头框' },
      { id: 'GIMBAL_Camera_SideRing_Right', label: '云台侧环' },
      { id: 'SENSOR_Glass_GimbalLens', label: '云台主镜片' },
      { id: 'SENSOR_Glass_Front_Left', label: '前视玻璃(左)' },
      { id: 'SENSOR_Glass_Front_Right', label: '前视玻璃(右)' },
      { id: 'SENSOR_Glass_Side_Left', label: '侧视玻璃(左)' },
      { id: 'SENSOR_Glass_Side_Right', label: '侧视玻璃(右)' },
      { id: 'SENSOR_Glass_Downward', label: '下视玻璃' },
      { id: 'SENSOR_FrontHousing_Left', label: '前视壳体(左)' },
      { id: 'SENSOR_FrontHousing_Right', label: '前视壳体(右)' },
      { id: 'LED_Status_Tail_Left', label: '尾灯(左)' },
      { id: 'LED_Status_Tail_Right', label: '尾灯(右)' },
      { id: 'LED_BatteryCharge_01', label: '电池指示灯珠 1' },
      { id: 'LED_BatteryCharge_02', label: '电池指示灯珠 2' },
      { id: 'LED_BatteryCharge_03', label: '电池指示灯珠 3' },
      { id: 'LED_BatteryCharge_04', label: '电池指示灯珠 4' },
      { id: 'BUTTON_Power', label: '电源按键' },
      { id: 'DECAL_Text_Labels', label: '文字贴花' },
      { id: 'SRC_GeometryRoot', label: '几何根节点' },
      { id: 'SRC_TailStatusLED_Group', label: '尾灯几何组' },
      { id: 'SRC_Decals_Group', label: '贴花几何组' },
      { id: 'SRC_BlackHousing_Group', label: '黑色壳体组' },
      { id: 'SRC_SensorGlass_Group', label: '传感器玻璃组' },
      { id: 'CTRL_DJI_Root', label: '整机总控', drivable: true },
      { id: 'CTRL_Gimbal_Yaw', label: '云台偏航', drivable: true },
      { id: 'CTRL_Gimbal_Pitch', label: '云台俯仰', drivable: true },
      { id: 'CTRL_Gimbal_Roll', label: '云台横滚', drivable: true },
    ]
    for (const entry of entries) {
      this.parts.push({
        id: entry.id,
        label: entry.label,
        found: this.model.getObjectByName(entry.id) !== undefined,
        drivable: entry.drivable ?? false,
      })
    }
    for (const position of ARM_POSITIONS) {
      this.parts.push({
        id: `ARM_${position}`,
        label: `${ARM_LABELS[position]}网格`,
        found: this.model.getObjectByName(`ARM_${position}`) !== undefined,
        drivable: false,
      })
      this.parts.push({
        id: `CTRL_Arm_${position}_Fold`,
        label: `${ARM_LABELS[position]}折叠`,
        found: this.model.getObjectByName(`CTRL_Arm_${position}_Fold`) !== undefined,
        drivable: true,
      })
      this.parts.push({
        id: `CTRL_Prop_${position}_Spin`,
        label: `${ARM_LABELS[position]}桨叶自转`,
        found: this.model.getObjectByName(`CTRL_Prop_${position}_Spin`) !== undefined,
        drivable: true,
      })
      this.parts.push({
        id: `ROTOR_${position}`,
        label: `${ARM_LABELS[position]}转子桨毂`,
        // 桨毂是 CTRL_Prop_*_Spin 的子节点,钟罩与桨叶都挂在它下面
        found: this.model.getObjectByName(`ROTOR_${position}`) !== undefined,
        drivable: true,
      })
      this.parts.push({
        id: `MOTOR_${position}_RotorBell`,
        label: `${ARM_LABELS[position]}电机钟罩(固定外壳)`,
        found: this.model.getObjectByName(`MOTOR_${position}_RotorBell`) !== undefined,
        drivable: false,
      })
    }
  }

  private buildProps(): void {
    for (const position of ARM_POSITIONS) {
      const node = this.model.getObjectByName(`CTRL_Prop_${position}_Spin`)
      if (!node) continue
      // 磁钢钟罩 = 电机的固定外壳,不随转子自转:
      // 从自转子树摘出、挂回自转节点的父级(attach 保持世界变换不变),
      // 之后依旧随折叠机臂运动。若模型日后在 Blender 里自行移出
      // Spin 子树,getObjectByName 找不到会自动跳过,无副作用。
      const bell = node.getObjectByName(`MOTOR_${position}_RotorBell`)
      if (bell && node.parent) {
        this.model.updateMatrixWorld(true)
        node.parent.attach(bell)
      }
      // 出厂几何已自洽(实测):ROTOR 桨毂与钟罩的几何轴和自转节点局部 Y
      // 同轴(偏差 <1.5°),桨叶自带 ~15° 桨距且符号与对角反转约定配对。
      // 因此这里不做任何几何补烘,尊重模型出厂状态。
      const blades: BladeUnit[] = []
      for (const index of [1, 2]) {
        const mesh = this.model.getObjectByName(`PROP_${position}_Blade_${index}`) as THREE.Mesh | null
        if (mesh?.isMesh) {
          blades.push({
            mesh,
            bindPosition: mesh.position.clone(),
            bindQuaternion: mesh.quaternion.clone(),
            stackYaw: 0,
          })
        }
      }
      this.props.push({
        position,
        node,
        bindPosition: node.position.clone(),
        spinSign: PROP_SPIN_SIGN[position],
        angle: 0,
        bindQuaternion: node.quaternion.clone(),
        blades,
        foldLift: 0,
        // 局部系 1 单位 = 多少米(沿节点世界矩阵的缩放求逆)
        localUnits: 1 / node.matrixWorld.getMaxScaleOnAxis(),
      })
    }
  }

  /**
   * 实测每个桨的"叠拢偏航角"(与真机一致:收纳时两片桨叶绕桨夹转拢、
   * 叠在一起指向机臂方向)。临时折叠到 1,量出桨叶径向与机臂方向的夹角;
   * 再整圈扫描整体偏航,取对机身/机臂/其他桨叶侵入最小的角度。求不出
   * 零侵入时才用残余侵入量 + 余量作收纳抬升兜底(当前四桨均为 0)。
   */
  private computeBladeFold(): void {
    this.model.updateMatrixWorld(true)
    // 避障场:先定姿的桨叶顶点写入,后续桨扫描时避开(防桨叶互穿)
    const obstacles: SolidField = new Map()
    // 临时折叠机臂 —— ⚠️ 必须先折叠再建高度场:收纳态下机臂/电机扫过机身
    // 两侧上方,展开态建场会漏掉这些表面,桨叶会从折叠臂下方"幽灵穿越"。
    this.arms.forEach((arm) => {
      arm.node.rotation.y = arm.foldAngle
    })
    this.model.updateMatrixWorld(true)
    // 高度场与侵入量一律在世界系(米)量测,避开 GLB 内部坐标缩放
    const heightfield = this.buildBodyHeightfield()
    for (const prop of this.props) {
      const armUnit = this.arms.find((unit) => unit.position === prop.position)
      if (!armUnit || prop.blades.length === 0) continue
      // 机臂方向(世界水平投影)
      const hinge = armUnit.node.getWorldPosition(new THREE.Vector3())
      const motor = prop.node.getWorldPosition(new THREE.Vector3())
      const armDirWorld = motor.clone().sub(hinge)
      armDirWorld.y = 0
      if (armDirWorld.lengthSq() < 1e-6) continue
      armDirWorld.normalize()
      // 转到桨叶父系(ROTOR)局部系:施加旋转用的是父系局部 Y(= 电机轴),
      // 因此对齐角也要在父系里求。注意:本模型 ROTOR 原点即桨毂中心。
      const firstBlade = prop.blades[0]
      if (!firstBlade) continue
      const parentQuat = (firstBlade.mesh.parent ?? prop.node).getWorldQuaternion(new THREE.Quaternion())
      const armDirLocal = armDirWorld.clone().applyQuaternion(parentQuat.clone().invert())
      armDirLocal.y = 0
      if (armDirLocal.lengthSq() < 1e-6) continue
      armDirLocal.normalize()
      for (const blade of prop.blades) {
        // 桨叶径向(父系局部):几何质心 − 桨毂(父系原点)
        const center = new THREE.Box3().setFromObject(blade.mesh).getCenter(new THREE.Vector3())
        const rotorInv = new THREE.Matrix4().copy((blade.mesh.parent ?? prop.node).matrixWorld).invert()
        const radial = center.applyMatrix4(rotorInv)
        radial.y = 0
        if (radial.lengthSq() < 1e-6) continue
        radial.normalize()
        // 绕 +Y 旋转 θ 使方位角减少 θ,故取 atan2(cross, dot)
        blade.stackYaw = Math.atan2(
          radial.z * armDirLocal.x - radial.x * armDirLocal.z,
          radial.x * armDirLocal.x + radial.z * armDirLocal.z,
        )
      }
      // 偏航扫描(整圈):找对机身(含机臂/电机/其他桨叶)侵入最小的整体偏角。
      // 前桨沿机臂方向会被机尾上表面挡住,但向外偏 ~50° 即完全无侵入 ——
      // 转子因此不必抬升,桨毂稳稳坐在电机钟罩里。零侵入的解往往不止一个,
      // 平手时取"桨叶方向最贴近机身纵轴"的 —— 与真机顺机身叠桨一致。
      let bestOffsetDeg = 0
      let bestPen = Infinity
      let bestAxis = -1
      for (let offsetDeg = -180; offsetDeg < 180; offsetDeg += 5) {
        const penetration = this.measureStackPenetration(prop, degToRad(offsetDeg), heightfield, obstacles)
        const axis = this.stackAxisAlignment(prop)
        if (
          penetration < bestPen - 1e-6 ||
          (Math.abs(penetration - bestPen) <= 1e-6 && axis > bestAxis + 1e-6)
        ) {
          bestPen = penetration
          bestAxis = axis
          bestOffsetDeg = offsetDeg
        }
      }
      // 粗扫最优附近再做 1° 细扫,尽量压低残余侵入
      const fineBase = bestOffsetDeg
      for (let fine = fineBase - 4; fine <= fineBase + 4; fine += 1) {
        const penetration = this.measureStackPenetration(prop, degToRad(fine), heightfield, obstacles)
        const axis = this.stackAxisAlignment(prop)
        if (
          penetration < bestPen - 1e-6 ||
          (Math.abs(penetration - bestPen) <= 1e-6 && axis > bestAxis + 1e-6)
        ) {
          bestPen = penetration
          bestAxis = axis
          bestOffsetDeg = fine
        }
      }
      prop.blades.forEach((blade) => {
        blade.stackYaw += degToRad(bestOffsetDeg)
      })
      // 残余侵入 > 4mm 才抬升转子兜底,否则桨毂保持在电机钟罩内
      prop.foldLift = bestPen > 0.004 ? clamp(bestPen + 0.008, 0, 0.2) : 0
      // 把本桨的叠拢姿态 stamp 进避障场,后续桨的扫描会避开它
      this.applyBladeFold(prop, 1)
      this.model.updateMatrixWorld(true)
      const vertex = new THREE.Vector3()
      for (const blade of prop.blades) {
        const attribute = blade.mesh.geometry.getAttribute('position')
        for (let i = 0; i < attribute.count; i += 1) {
          vertex.fromBufferAttribute(attribute, i).applyMatrix4(blade.mesh.matrixWorld)
          addSolid(obstacles, heightfieldKey(vertex.x, vertex.z), vertex.y - 0.004, vertex.y + 0.004)
        }
      }
    }
    // 还原展开
    this.arms.forEach((arm) => {
      arm.node.rotation.y = 0
    })
    this.model.updateMatrixWorld(true)
  }

  /**
   * 当前(已由 measureStackPenetration 摆好的)叠拢姿态下,桨叶 1 相对电机
   * 的水平方向与机身纵轴(世界 Z,载入时机身无旋转)的对齐度:0~1,越大越顺轴。
   */
  private stackAxisAlignment(prop: PropUnit): number {
    const firstBlade = prop.blades[0]
    if (!firstBlade) return 0
    const hub = prop.node.getWorldPosition(new THREE.Vector3())
    const center = new THREE.Box3().setFromObject(firstBlade.mesh).getCenter(new THREE.Vector3())
    const dir = center.sub(hub)
    dir.y = 0
    const length = dir.length()
    if (length < 1e-6) return 0
    return Math.abs(dir.z) / length
  }

  /** 临时施加"叠拢 + 偏移"姿态,量桨叶顶点对实体场(机身 + 已定姿的其他桨叶)的最大侵入(世界系/米) */
  private measureStackPenetration(
    prop: PropUnit,
    offset: number,
    heightfield: SolidField,
    obstacles: SolidField,
  ): number {
    const saved = prop.blades.map((blade) => blade.stackYaw)
    prop.blades.forEach((blade) => {
      blade.stackYaw += offset
    })
    this.applyBladeFold(prop, 1)
    this.model.updateMatrixWorld(true)
    const vertex = new THREE.Vector3()
    let deepest = 0
    for (const blade of prop.blades) {
      const attribute = blade.mesh.geometry.getAttribute('position')
      for (let i = 0; i < attribute.count; i += 1) {
        vertex.fromBufferAttribute(attribute, i).applyMatrix4(blade.mesh.matrixWorld)
        const depth = solidPenetration(heightfield, vertex.x, vertex.y, vertex.z)
        if (depth > deepest) deepest = depth
        const blocked = solidPenetration(obstacles, vertex.x, vertex.y, vertex.z)
        if (blocked > deepest) deepest = blocked
      }
    }
    prop.blades.forEach((blade, index) => {
      const yaw = saved[index]
      if (yaw !== undefined) blade.stackYaw = yaw
    })
    return deepest
  }

  /**
   * 机身实体场:BODY_/ARM_/MOTOR_ 顶点按 (x,z) 0.01m 网格归入竖直区间
   * (下沿~上沿)。只有顶点真正落入区间内部才算侵入 —— 桨叶从折叠臂
   * 下方/上方掠过不算,避免"最高点高度场"把擦边当成穿透。
   */
  private buildBodyHeightfield(): SolidField {
    const grid: SolidField = new Map()
    const vertex = new THREE.Vector3()
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      if (!mesh.name.startsWith('BODY_') && !mesh.name.startsWith('ARM_') && !mesh.name.startsWith('MOTOR_')) return
      const attribute = mesh.geometry.getAttribute('position')
      for (let i = 0; i < attribute.count; i += 1) {
        vertex.fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld)
        addSolid(grid, heightfieldKey(vertex.x, vertex.z), vertex.y, vertex.y)
      }
    })
    return grid
  }

  /**
   * 折叠角由几何推算:取"铰链 → 桨心"在水平面的方向,与收纳方向作差。
   * 前臂收向机尾(+Z),后臂收向机头(-Z) —— 与 Mini 系列的实际收纳姿态一致。
   */
  private buildArms(): void {
    const hingeWorld = new THREE.Vector3()
    const propWorld = new THREE.Vector3()
    for (const position of ARM_POSITIONS) {
      const node = this.model.getObjectByName(`CTRL_Arm_${position}_Fold`)
      const prop = this.model.getObjectByName(`CTRL_Prop_${position}_Spin`)
      if (!node || !prop) continue
      node.getWorldPosition(hingeWorld)
      prop.getWorldPosition(propWorld)
      const dx = propWorld.x - hingeWorld.x
      const dz = propWorld.z - hingeWorld.z
      const current = Math.atan2(dz, dx)
      const target = position.startsWith('Front') ? Math.atan2(1, 0) : Math.atan2(-1, 0)
      let foldAngle = current - target
      // 归一到 (-π, π]:取最短路径,避免绕大半圈
      foldAngle = ((foldAngle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI
      this.arms.push({ position, node, foldAngle })
    }
  }

  /**
   * 实测"停放配平"(分展开/收纳两态,随折叠度过渡):
   * - 展开态:前脚撑(GEAR_* 最低点)与机尾底部(BODY_* 机尾区域最低点)
   *   是两个触地带,机身平放时只有前脚撑着地、机尾悬空。解出让两带同高
   *   的抬头角并整体下沉,静止时"机尾轻触地、机头微抬"地停放。
   * - 收纳态:脚撑随机臂翻起不再接地,真机收纳后是机身平贴桌面 —— 俯仰 0,
   *   下沉量 = 机身系(不含脚撑/桨叶)最低点。
   * 角度按几何解算,不写死数值,模型日后重导出也能自适应。
   */
  private computeStanceTrim(): void {
    this.model.updateMatrixWorld(true)
    const toModelLocal = new THREE.Matrix4().copy(this.model.matrixWorld).invert()
    // —— 展开态 ——
    const contacts = this.scanStanceContacts(toModelLocal)
    if (contacts.front && contacts.rear) {
      const dz = contacts.front.z - contacts.rear.z
      if (Math.abs(dz) > 1e-3) {
        // 旋转任意平行轴不改变"两点同高"的解:tanφ = (y前-y后)/(z前-z后)
        const pitch = clamp(Math.atan((contacts.front.y - contacts.rear.y) / dz), -degToRad(25), degToRad(25))
        this.stancePitchOpen = THREE.MathUtils.radToDeg(pitch)
        // 施加配平后量触地带的世界最低点 → 静止时的整体下沉量
        if (this.root) this.root.rotation.x = pitch
        this.model.updateMatrixWorld(true)
        this.stanceDropOpen = Math.max(0, this.measureLowest(['GEAR_', 'BODY_']))
        if (this.root) this.root.rotation.x = 0
        this.model.updateMatrixWorld(true)
      }
    }
    // —— 收纳态:机身平贴,下沉量 = 机身系最低点相对模型原点的深度
    // (世界系量测;不含脚撑 GEAR_ 与桨叶 PROP_,它们收纳后不接地) ——
    this.stanceDropFolded = Math.max(0, this.model.position.y - this.measureLowest(['BODY_', 'ARM_', 'MOTOR_']))
  }

  /** 所有匹配前缀网格的世界最低点;toModelLocal 提供时返回模型系坐标 */
  private measureLowest(prefixes: string[], toModelLocal?: THREE.Matrix4): number {
    const vertex = new THREE.Vector3()
    let lowest = Infinity
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      if (!prefixes.some((prefix) => mesh.name.startsWith(prefix))) return
      const attribute = mesh.geometry.getAttribute('position')
      for (let i = 0; i < attribute.count; i += 1) {
        vertex.fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld)
        if (toModelLocal) vertex.applyMatrix4(toModelLocal)
        if (vertex.y < lowest) lowest = vertex.y
      }
    })
    return Number.isFinite(lowest) ? lowest : 0
  }

  /** 触地带扫描:前脚撑最低点 + 机尾底部最低点(模型局部系) */
  private scanStanceContacts(toModelLocal: THREE.Matrix4): { front: THREE.Vector3 | null; rear: THREE.Vector3 | null } {
    const vertex = new THREE.Vector3()
    let front: THREE.Vector3 | null = null
    let rear: THREE.Vector3 | null = null
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !mesh.geometry) return
      const isGear = mesh.name.startsWith('GEAR_')
      const isBody = mesh.name.startsWith('BODY_')
      if (!isGear && !isBody) return
      const attribute = mesh.geometry.getAttribute('position')
      for (let i = 0; i < attribute.count; i += 1) {
        vertex.fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(toModelLocal)
        if (isGear && (front === null || vertex.y < front.y)) front = vertex.clone()
        if (isBody && vertex.z > 0.15 && (rear === null || vertex.y < rear.y)) rear = vertex.clone()
      }
    })
    return { front, rear }
  }

  private bindGimbal(): void {
    this.gimbalYaw = this.model.getObjectByName('CTRL_Gimbal_Yaw') ?? null
    this.gimbalPitch = this.model.getObjectByName('CTRL_Gimbal_Pitch') ?? null
    this.gimbalRoll = this.model.getObjectByName('CTRL_Gimbal_Roll') ?? null
  }

  /** 机臂折叠枢轴节点(状态灯等机臂附件挂到它下面即可跟随折叠/展开) */
  getArmFoldNode(position: ArmPosition): THREE.Object3D | null {
    return this.model.getObjectByName(`CTRL_Arm_${position}_Fold`)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
