/**
 * DJI Mini 4 Pro 飞行仿真内核。
 *
 * 这里只做"飞控 + 电池 + 定位"的确定性逻辑,不引用 three,方便单独调参与验证:
 * - 状态机对齐真机流程:上电自检 → 传感器预热 → 地面待机(搜星) → 电机启动 → 自动起飞 →
 *   手动飞行 → 智能返航 / 自动降落 → 停桨;另含遥控失联失效保护、低电量返航。
 *   ⚠️ 紧急停桨只在飞行器**落地后**可用(空中停桨会坠机,按需求禁用;空中调用会被拒绝并写警告日志);
 *   空中"动力丧失"状态仅由电池耗尽等真实故障触发。
 * - 摇杆在 GPS / 视觉定位下是"速度指令":松杆由飞控刹停并定点悬停;姿态模式下不保持位置,随风漂移。
 * - 电池按 18.96 Wh 真实容量与分项功耗积分(悬停 33 W → 约 34 分钟,与官方标称一致),
 *   低电量返航 / 严重低电量强制降落按百分比触发。
 * - 风按"空气速度 = 指令 − 风"建模:逆风顶得住就顶,顶不住(超过该档最大空速)才被吹跑。
 *
 * 坐标约定:+X 东、-Z 北、+Y 上(与模型一致,机头朝 -Z),航向 0° = 正北。
 */

/** 机型公开规格(Mini 4 Pro) */
export const DRONE_SPEC = {
  name: 'DJI Mini 4 Pro',
  weightKg: 0.249,
  batteryWh: 18.96,
  batteryNominalVoltage: 7.32,
  batteryFullVoltage: 8.4,
  batteryEmptyVoltage: 6.9,
  batteryInternalResistance: 0.09,
  maxWindResistance: 10.7,
  hoverPowerWatts: 33,
  idlePowerWatts: 1.6,
  climbWattsPerMps: 3.6,
  levelSpeedPowerGain: 0.55,
  maxFlightTimeMin: 34,
  takeoffAltitude: 1.2,
  rthAltitudeDefault: 20,
  landingSlowAltitude: 2,
  gimbalPitchMin: -90,
  gimbalPitchMax: 60,
  gimbalYawRange: 5,
} as const

/** 飞行挡位:平稳 C / 普通 N / 运动 S */
export type FlightMode = 'cine' | 'normal' | 'sport'

/** 单个挡位的性能参数:限速(水平/升降)、姿态倾角与加减速、偏航角速度 */
export interface ModeSpec {
  label: string
  horizontalSpeed: number
  climbSpeed: number
  descendSpeed: number
  maxTiltDeg: number
  accel: number
  brakeAccel: number
  yawRateDeg: number
}

/** N / S / C 三档飞行模式(对齐 DJI 飞行挡位参数) */
export const FLIGHT_MODES: Record<FlightMode, ModeSpec> = {
  cine: {
    label: '平稳挡 C',
    horizontalSpeed: 5,
    climbSpeed: 3,
    descendSpeed: 1.5,
    maxTiltDeg: 20,
    accel: 2,
    brakeAccel: 3,
    yawRateDeg: 60,
  },
  normal: {
    label: '普通挡 N',
    horizontalSpeed: 12,
    climbSpeed: 5,
    descendSpeed: 3,
    maxTiltDeg: 30,
    accel: 3.5,
    brakeAccel: 6,
    yawRateDeg: 100,
  },
  sport: {
    label: '运动挡 S',
    horizontalSpeed: 16,
    climbSpeed: 5,
    descendSpeed: 5,
    maxTiltDeg: 35,
    accel: 5,
    brakeAccel: 8,
    yawRateDeg: 150,
  },
}

/** 挡位列表(供下拉框渲染的稳定顺序) */
export const FLIGHT_MODE_LIST: Array<{ key: FlightMode; label: string }> = (
  Object.keys(FLIGHT_MODES) as FlightMode[]
).map((key) => ({ key, label: FLIGHT_MODES[key].label }))

/** 飞行阶段:上电自检 → 预热 → 待机 → 起飞 → 飞行/航线 → 返航/降落 → 停桨/失效 */
export type FlightPhase =
  | 'powerOff'
  | 'selfCheck'
  | 'warmingUp'
  | 'standby'
  | 'motorsOn'
  | 'takingOff'
  | 'flying'
  | 'waypoint'
  | 'rth'
  | 'landing'
  | 'emergency'
  | 'stopped'

/** 阶段的中文标签(界面显示用) */
export const PHASE_LABELS: Record<FlightPhase, string> = {
  powerOff: '未上电',
  selfCheck: '开机自检',
  warmingUp: '传感器预热',
  standby: '地面待机',
  motorsOn: '电机已启动',
  takingOff: '自动起飞',
  flying: '飞行中',
  waypoint: '航线执行',
  rth: '智能返航',
  landing: '自动降落',
  emergency: '动力丧失 · 坠落',
  stopped: '已停桨',
}

/** 定位来源:GNSS / 视觉 / 姿态模式(无定位) */
export type PositionSource = 'gps' | 'vision' | 'atti'

/** 定位来源的中文标签 */
export const POSITION_SOURCE_LABELS: Record<PositionSource, string> = {
  gps: 'GNSS 卫星定位',
  vision: '视觉定位',
  atti: '姿态模式(无定位)',
}

/** 四通道摇杆量,每通道取值 -1~1(松杆为 0) */
export interface StickState {
  /** 左杆上下:升降 -1~1(正 = 上升) */
  throttle: number
  /** 左杆左右:偏航 -1~1(正 = 右转) */
  yaw: number
  /** 右杆上下:俯仰 -1~1(正 = 前进) */
  pitch: number
  /** 右杆左右:横滚 -1~1(正 = 右移) */
  roll: number
}

/** 摇杆回中(全零) */
export const NEUTRAL_STICK: StickState = { throttle: 0, yaw: 0, pitch: 0, roll: 0 }

/** 故障注入:测试沙盒里用来复现各种真机异常 */
export interface FaultFlags {
  /** GNSS 卫星丢失(强制进入视觉/姿态模式) */
  gnssLost: boolean
  /** 指南针受扰(需要校准,否则姿态模式) */
  compassError: boolean
  /** IMU 异常(禁止起飞) */
  imuError: boolean
  /** 电机异常:1 个电机动力衰减,导致偏航漂移 */
  motorFailure: boolean
  /** 遥控器失联(3 秒后触发失效返航) */
  rcLost: boolean
  /** 下视视觉失效(低空无法视觉定位) */
  visionLost: boolean
  /** 避障传感器关闭 */
  obstacleAvoidanceOff: boolean
}

/** 全部故障关闭(正常飞行) */
export const NO_FAULTS: FaultFlags = {
  gnssLost: false,
  compassError: false,
  imuError: false,
  motorFailure: false,
  rcLost: false,
  visionLost: false,
  obstacleAvoidanceOff: false,
}

/** 沙盒可调参数(限高限距、风、电量阈值、失效动作、时间倍速) */
export interface SimConfig {
  /** 限高(AGL,米) */
  maxAltitude: number
  /** 限距(米) */
  maxDistance: number
  /** 返航高度(米) */
  rthAltitude: number
  /** 风速 m/s */
  windSpeed: number
  /** 风"吹向"的罗盘方位角(0=北,90=东) */
  windDirection: number
  /** 低电量返航阈值 % */
  lowBatteryPercent: number
  /** 严重低电量阈值 % */
  criticalBatteryPercent: number
  /** 失效保护:遥控失联后的动作 */
  rcFailsafe: 'rth' | 'hover' | 'land'
  /** 时间倍速(1 = 实时) */
  timeScale: number
}

/** 出厂默认参数:限高 120 m(合规上限)、限距 500 m、无风、实时 */
export const DEFAULT_CONFIG: SimConfig = {
  maxAltitude: 120,
  maxDistance: 500,
  rthAltitude: 20,
  windSpeed: 0,
  windDirection: 0,
  lowBatteryPercent: 20,
  criticalBatteryPercent: 10,
  rcFailsafe: 'rth',
  timeScale: 1,
}

// ————————————————————————————— 航线任务 —————————————————————————————

/**
 * 单个航点(对齐真机航点任务的字段子集)。
 *
 * 坐标与遥测同一套约定:x 向东、z 向南(与模型坐标一致),altitude 是**相对起飞点高度(AGL)**。
 */
export interface MissionWaypoint {
  x: number
  z: number
  /** 目标高度(AGL,米) */
  altitude: number
  /** 过点速度(m/s);0 = 使用任务巡航速度 */
  speed: number
  /** 到点悬停时间(秒);0 = 不停留,直接飞下一个点 */
  hoverSeconds: number
  /** 到点后云台俯仰角(度);null = 不动云台 */
  gimbalPitch: number | null
  /** 到点动作 */
  action: 'none' | 'photo'
}

/** 机头朝向策略:auto = 始终机头指向下一航点;fixed = 保持任务开始时的航向 */
export type MissionHeadingMode = 'auto' | 'fixed'
/** 过点方式:straight = 到点减速后再走;curved = 圆滑过点(不减速) */
export type MissionPathMode = 'straight' | 'curved'
/** 任务结束动作,对齐真机 WaypointMissionFinishedAction */
export type MissionFinishAction = 'hover' | 'rth' | 'land'

/** 航线任务的全局设置 */
export interface MissionConfig {
  /** 巡航速度(m/s):航点未单独指定速度时用它 */
  autoSpeed: number
  headingMode: MissionHeadingMode
  pathMode: MissionPathMode
  /** 全部航点完成后 */
  finishAction: MissionFinishAction
  /** 循环执行:完成后回到第一个航点继续 */
  loop: boolean
}

/** 任务状态:未执行 / 执行中 / 已暂停 */
export type MissionStatus = 'idle' | 'running' | 'paused'

/** 任务状态的中文标签 */
export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  idle: '未执行',
  running: '执行中',
  paused: '已暂停',
}

/** 任务阶段的中文标签 */
export const MISSION_STAGE_LABELS: Record<MissionStage, string> = {
  idle: '待执行',
  'depart-climb': '垂直调整到首航点高度',
  'depart-cruise': '水平飞向首个航点',
  'depart-settle': '调整到航点高度',
  'depart-align': '对准航线方向',
  goto: '飞向航点',
  hover: '航点悬停',
}

/**
 * 任务执行阶段。
 *
 * 飞第一个航点前有一段「启航四步」,和智能返航同款的分段机动:
 * 先把高度调到首航点高度(**垂直段只动高度,不产生水平位移**,否则会斜着冲过去) →
 * 再保持该高度水平飞向首航点 → 到了把高度收干净 → 最后原地把机头转到与航线一致,
 * 之后才进入常规的 goto / hover 推进。
 */
export type MissionStage =
  'idle' | 'depart-climb' | 'depart-cruise' | 'depart-settle' | 'depart-align' | 'goto' | 'hover'

/** 是否为「启航段」阶段(首航点的分段机动) */
export function isMissionDepartStage(stage: MissionStage): boolean {
  return stage.startsWith('depart-')
}

/** 出厂默认任务设置:巡航 6 m/s、机头自动指向下一航点、直线过点、完成后悬停 */
export const DEFAULT_MISSION_CONFIG: MissionConfig = {
  autoSpeed: 6,
  headingMode: 'auto',
  pathMode: 'straight',
  finishAction: 'hover',
  loop: false,
}

/** 出厂示例航线:环绕起飞点一圈(最高 40 m,悬在 13 m 的建筑之上,不会触发避障刹停) */
export const DEFAULT_MISSION: MissionWaypoint[] = [
  { x: 0, z: -32, altitude: 35, speed: 6, hoverSeconds: 2, gimbalPitch: -40, action: 'photo' },
  { x: 32, z: -32, altitude: 40, speed: 6, hoverSeconds: 0, gimbalPitch: null, action: 'none' },
  { x: 32, z: 18, altitude: 40, speed: 6, hoverSeconds: 0, gimbalPitch: null, action: 'none' },
  { x: 0, z: 18, altitude: 30, speed: 6, hoverSeconds: 3, gimbalPitch: -60, action: 'photo' },
  { x: -28, z: 0, altitude: 35, speed: 6, hoverSeconds: 0, gimbalPitch: null, action: 'none' },
]

/** 单个航点字段归一化(手输/外部传入都可能越界) */
export function normalizeMissionWaypoint(source: Partial<MissionWaypoint>): MissionWaypoint {
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const pitch = source.gimbalPitch
  return {
    x: number(source.x, 0),
    z: number(source.z, 0),
    altitude: clamp(number(source.altitude, 30), 1, 500),
    speed: clamp(number(source.speed, 0), 0, 16),
    hoverSeconds: clamp(number(source.hoverSeconds, 0), 0, 60),
    gimbalPitch:
      typeof pitch === 'number' && Number.isFinite(pitch)
        ? clamp(pitch, DRONE_SPEC.gimbalPitchMin, DRONE_SPEC.gimbalPitchMax)
        : null,
    action: source.action === 'photo' ? 'photo' : 'none',
  }
}

/** 航线任务的实时进度(界面轮询用) */
export interface MissionSnapshot {
  status: MissionStatus
  statusLabel: string
  stage: MissionStage
  stageLabel: string
  /** 当前目标航点索引(0 基);-1 = 无 */
  index: number
  total: number
  /** 已完成的整圈数 */
  passes: number
  /** 任务已执行时长(秒) */
  elapsed: number
  /** 剩余航程(米,含高度差) */
  distanceLeft: number
  /** 按航程折算的完成度 0~1 */
  progress: number
  /** 预计剩余时间(秒,含悬停) */
  etaSeconds: number
  /** 暂停原因 */
  pauseReason: string
  /** 当前目标航点副本 */
  active: MissionWaypoint | null
  /** 航线航点列表副本(界面据此渲染) */
  waypoints: MissionWaypoint[]
  config: MissionConfig
}

/** 事件日志级别 */
export type EventLevel = 'info' | 'warn' | 'error' | 'success'

/** 一条事件日志 */
export interface SimEvent {
  id: number
  time: number
  level: EventLevel
  text: string
}

/** 轴对齐包围盒(AABB)障碍物,坐标与飞行位置同一套约定 */
export interface ObstacleBox {
  name: string
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
  /** 是否需要绕开(否则只是地面建筑,飞过去即可) */
  solid: boolean
}

/** 当前帧的避障探测结果(机身坐标系六向) */
export interface ObstacleReport {
  /** 六个方向的最近距离(米),null 表示该方向无障碍 */
  forward: number | null
  backward: number | null
  left: number | null
  right: number | null
  up: number | null
  down: number | null
  /** 本帧是否因避障刹停 */
  braking: boolean
  /** 触发方向 */
  brakingDirection: 'forward' | 'backward' | 'left' | 'right' | 'up' | 'down' | null
}

/** 起飞前检查项 */
export interface ChecklistItem {
  id: string
  label: string
  ok: boolean
  detail: string
  /** 不通过是否阻止起飞 */
  blocking: boolean
}

/** 单向快照:界面/回放读取的全部遥测字段(数组字段已复制,改它不影响仿真) */
export interface DroneSnapshot {
  phase: FlightPhase
  phaseLabel: string
  mode: FlightMode
  modeLabel: string
  positionSource: PositionSource
  positionSourceLabel: string
  airborne: boolean
  motorsOn: boolean
  damaged: boolean
  batteryPercent: number
  batteryVoltage: number
  batteryCurrent: number
  batteryTemp: number
  batteryWhLeft: number
  batteryModeText: string
  altitude: number
  altitudeMax: number
  /** 相对起飞点的水平坐标:x 向东,z 向南(与模型坐标一致) */
  positionX: number
  positionZ: number
  horizontalSpeed: number
  verticalSpeed: number
  heading: number
  tiltPitch: number
  tiltRoll: number
  distanceToHome: number
  homeRecorded: boolean
  altitudeLimitReached: boolean
  distanceLimitReached: boolean
  satellites: number
  hdop: number
  gpsBars: number
  rcBars: number
  visionAvailable: boolean
  gimbalPitch: number
  gimbalRoll: number
  gimbalYaw: number
  motorLoad: number
  armFold: number
  stick: StickState
  windSpeed: number
  windDirection: number
  windRelative: string
  flightTime: number
  totalTime: number
  remainingMinutes: number
  lowBattery: boolean
  criticalBattery: boolean
  lowBatteryCountdown: number
  rthStage: string
  /** 自动降落的细分阶段:approach=降向低位悬停位 / hold=低位悬停确认 / settle=缓慢触地 */
  landingStage: string
  rthReason: string
  warnings: string[]
  events: SimEvent[]
  checklist: ChecklistItem[]
  obstacle: ObstacleReport
  recording: boolean
  recordSeconds: number
  photoCount: number
  cameraZoom: number
  /** 航线任务进度 */
  mission: MissionSnapshot
}

const GRAVITY = 9.81
const SELF_CHECK_SECONDS = 2.6
const WARMUP_SECONDS = 2.4
const RC_FAILSAFE_DELAY = 3
const LOW_BATTERY_COUNTDOWN = 10
/** 搜星速度(颗/秒) */
const GNSS_ACQUIRE_RATE = 1.6
/** 下视视觉可用的最高离地高度(米):再高就看不清地面纹理 */
const VISION_MAX_ALTITUDE = 12
/** 智能返航:机头与返航航向的夹角小于这个值才允许前进(度) */
const RTH_ALIGN_TOLERANCE_DEG = 12
/** 智能返航的转向角速度(度/秒):原地对准与巡航段共用 */
const RTH_YAW_RATE_DEG = 45
/** 自动降落的低位悬停高度(米):先降到这个高度稳住,再缓慢触地 */
const LANDING_HOLD_ALTITUDE_M = 1
/** 低位悬停的停顿时间(秒):停一下让飞手看清落点 */
const LANDING_HOLD_SECONDS = 1
/** 悬停确认后的触地速度(米/秒):比常规下降慢得多 */
const LANDING_FINAL_DESCENT_RATE = 0.3
/** 航线任务:判定"已到达航点"的水平半径(米) */
const MISSION_ARRIVE_RADIUS = 0.9
/** 航线任务:到达航点时允许的高度误差(米) */
const MISSION_ARRIVE_ALTITUDE_TOLERANCE = 0.8
/** 航线任务:曲线过点的切角半径(米),距航点这么远就切向下一个点 */
const MISSION_CURVED_TURN_RADIUS = 3
/** 航线任务:机头转向下一航点的角速度(度/秒) */
const MISSION_YAW_RATE_DEG = 60
/** 航线任务:单个航点的最长飞行时限(秒),超时视为不可达并跳过 */
const MISSION_WAYPOINT_TIMEOUT = 90
/** 启航段:水平飞向首航点的到位半径(米)。比常规航点小得多 —— 启航要落到点上,不然对准航线时会有一次肉眼可见的位移 */
const MISSION_DEPART_ARRIVE_RADIUS = 0.25
/** 启航段:垂直调整到首航点高度的到位容差(米) */
const MISSION_DEPART_ALTITUDE_TOLERANCE = 0.3
/** 启航段:到达首航点后高度收尾的到位容差(米) */
const MISSION_DEPART_SETTLE_TOLERANCE = 0.15
/** 启航段:机头对准航线方向的到位容差(度) */
const MISSION_DEPART_ALIGN_TOLERANCE = 2.5

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))
const lerp = (from: number, to: number, t: number): number => from + (to - from) * t
const degToRad = (deg: number): number => (deg * Math.PI) / 180
const radToDeg = (rad: number): number => (rad * 180) / Math.PI

/** 航向角(罗盘 0=北 90=东)对应的机头方向单位向量 */
function headingVector(headingDeg: number): { x: number; z: number } {
  const rad = degToRad(headingDeg)
  return { x: Math.sin(rad), z: -Math.cos(rad) }
}

/**
 * 飞控仿真内核(不依赖 three)。
 *
 * 持有全部飞行状态与可调参数:`step(dt)` 按时间片推进状态机、飞行、电池与失效保护;
 * 外部通过 getter / `snapshot()` 只读遥测,通过 powerOn / autoTakeOff / setStick / startMission 等下达指令。
 * 状态字段虽为 public,但正常路径应只经 step 与上述方法修改。
 */
export class DroneSim {
  config: SimConfig = { ...DEFAULT_CONFIG }
  faults: FaultFlags = { ...NO_FAULTS }
  obstacles: ObstacleBox[] = []

  phase: FlightPhase = 'powerOff'
  mode: FlightMode = 'normal'
  /** 位置:y 为相对起飞点的高度(AGL),x/z 为水平偏移 */
  position = { x: 0, y: 0, z: 0 }
  velocity = { x: 0, y: 0, z: 0 }
  heading = 0
  tiltPitch = 0
  tiltRoll = 0
  motorLoad = 0
  armFold = 0
  damaged = false

  stick: StickState = { ...NEUTRAL_STICK }
  /** 外部(模型侧)提供的检查项,例如机臂是否展开 */
  externalChecks: ChecklistItem[] = []
  /** 相机状态 */
  recording = false
  recordSeconds = 0
  photoCount = 0
  cameraZoom = 1
  gimbalPitch = -10
  gimbalRoll = 0
  gimbalYaw = 0

  /** 航线任务:航点列表(出厂带一条示例航线,方便一键演示) */
  mission: MissionWaypoint[] = DEFAULT_MISSION.map((waypoint) => ({ ...waypoint }))
  missionConfig: MissionConfig = { ...DEFAULT_MISSION_CONFIG }
  missionStatus: MissionStatus = 'idle'
  /** 当前目标航点索引(0 基),-1 表示没有在执行的航点 */
  missionIndex = -1
  /** 当前任务阶段(未执行任务时为 'idle') */
  missionStage: MissionStage = 'idle'

  events: SimEvent[] = []

  private time = 0
  private phaseTime = 0
  private flightTime = 0
  private batteryUsedWh = 0
  private batteryTemp = 25
  private satellites = 0
  private visionAvailable = false
  private rcLinkQuality = 1
  private rcLostTimer = 0
  private lowBatteryCountdown = 0
  private rthStage: 'ascend' | 'cruise' | 'descend' | 'landing' = 'ascend'
  private rthReason = ''
  private rthStickGrace = 0
  private home = { x: 0, z: 0 }
  private homeRecorded = false
  private altitudeMax = 0
  private altitudeLimitReached = false
  private distanceLimitReached = false
  private obstacleReport: ObstacleReport = {
    forward: null,
    backward: null,
    left: null,
    right: null,
    up: null,
    down: null,
    braking: false,
    brakingDirection: null,
  }
  private eventId = 0
  private readonly warnedAt = new Map<string, number>()
  private landingTimer = 0
  /** 降落细分阶段:先降向 1 米悬停位,停一下再缓速触地 */
  private landingStage: 'approach' | 'hold' | 'settle' = 'approach'
  private landingHoldTimer = 0
  /** 航线任务:已下发但等起飞完成后才开始执行 */
  private missionPending = false
  /** 航线任务:起始航向(headingMode='fixed' 时保持不变) */
  private missionStartHeading = 0
  /** 航线任务:起步保护期,避免启动瞬间被残留摇杆指令打断 */
  private missionStickGrace = 0
  private missionHoverTimer = 0
  /** 当前航点已耗时(超时保护) */
  private missionWaypointTimer = 0
  private missionElapsed = 0
  private missionPasses = 0
  private missionPauseReason = ''
  /** 暂停前所处的阶段:继续执行时按它决定是接着走启航段还是直接飞航点 */
  private missionPausedStage: MissionStage = 'idle'
  /** 任务起始时的总航程(米),仅用于进度条 */
  private missionTotalDistance = 0

  // ————————————————————————————— 状态查询 —————————————————————————————

  /** 降落细分标签:低位悬停确认是飞手最关心的一步,单独标出来 */
  private get phaseLabel(): string {
    if (this.phase === 'landing') {
      if (this.landingStage === 'hold') return `降落 · ${LANDING_HOLD_ALTITUDE_M} 米悬停确认`
      if (this.landingStage === 'settle') return '降落 · 缓慢触地'
      if (this.landingStage === 'approach') return '降落 · 下降至悬停位'
    }
    return PHASE_LABELS[this.phase]
  }

  get airborne(): boolean {
    // 离地 5 cm 以上且未断电才算空中(触地/未上电都不算)
    return this.position.y > 0.05 && this.phase !== 'powerOff'
  }

  get motorsOn(): boolean {
    // 电机负载 >2% 视为桨叶已转动(怠速也在转)
    return this.motorLoad > 0.02
  }

  get modeSpec(): ModeSpec {
    return FLIGHT_MODES[this.mode]
  }

  get batteryPercent(): number {
    return clamp(100 - (this.batteryUsedWh / DRONE_SPEC.batteryWh) * 100, 0, 100)
  }

  /** 开路电压(只与电量有关,不依赖电流,避免与电流互为依赖) */
  private get openCircuitVoltage(): number {
    const stateOfCharge = this.batteryPercent / 100
    return (
      DRONE_SPEC.batteryEmptyVoltage +
      (DRONE_SPEC.batteryFullVoltage - DRONE_SPEC.batteryEmptyVoltage) *
        // 0.55:锂电放电曲线的经验指数,让低电量段电压掉得更快,贴近真机表现
        Math.pow(stateOfCharge, 0.55)
    )
  }

  /** 放电电流:按当前功率 / 近似电压估算 */
  get batteryCurrent(): number {
    // 6.4 V:除法的电压下限,防止电量趋零时电流发散
    return this.currentPowerWatts / Math.max(6.4, this.openCircuitVoltage)
  }

  /** 端电压 = 开路电压 − 内阻压降 */
  get batteryVoltage(): number {
    return Math.max(
      6,
      // 下限 6 V:避免低电量时内阻压降把端电压算成负数
      this.openCircuitVoltage - this.batteryCurrent * DRONE_SPEC.batteryInternalResistance,
    )
  }

  /** 当前定位来源:GNSS(≥6 星且指南针正常)→ 视觉 → 姿态模式 */
  get positionSource(): PositionSource {
    if (this.faults.gnssLost) {
      return this.visionAvailable ? 'vision' : 'atti'
    }
    if (this.satellites >= 6 && !this.faults.compassError) return 'gps'
    if (this.visionAvailable) return 'vision'
    return 'atti'
  }

  /** 当前总功耗(W):怠速 + 悬停(含平飞增益)+ 爬升功耗,再乘风速系数 */
  get currentPowerWatts(): number {
    if (this.phase === 'powerOff') return 0
    const airSpeed = Math.hypot(this.velocity.x, this.velocity.z)
    // 16 m/s:平飞满速参考(运动挡极速);>1 表示超速(仅姿态模式可能出现)
    const speedRatio = clamp(airSpeed / 16, 0, 1.2)
    const spinning = this.motorLoad > 0.02
    let watts =
      DRONE_SPEC.idlePowerWatts +
      DRONE_SPEC.hoverPowerWatts *
        (spinning ? 1 : 0.05) *
        (1 + DRONE_SPEC.levelSpeedPowerGain * speedRatio * speedRatio)
    watts += Math.max(0, this.velocity.y) * DRONE_SPEC.climbWattsPerMps
    // 电机转动时的最低功耗下限 12 W
    if (spinning) watts = Math.max(watts, 12)
    // 逆风要保持位置需要更大的空气速度,额外耗电
    // 30 m/s 为风速归一化上限、0.35 为最大额外功耗比例
    const windFactor = 1 + clamp(this.config.windSpeed / 30, 0, 1) * 0.35
    return watts * windFactor
  }

  /** 剩余可飞时间(分钟) */
  get remainingMinutes(): number {
    // 用 12 W 下限兜底,避免待机功耗极小导致剩余时间虚高
    const watts = Math.max(this.currentPowerWatts, 12)
    return ((this.batteryPercent / 100) * DRONE_SPEC.batteryWh * 60) / watts
  }

  // ————————————————————————————— 操作指令 —————————————————————————————

  /** 上电:重置飞行状态与电量并进入自检;受损时拒绝 */
  powerOn(): void {
    if (this.phase !== 'powerOff' && this.phase !== 'stopped') return
    if (this.damaged) {
      this.pushEvent('error', '飞行器受损,需重新上电复位后再次自检')
      return
    }
    this.phase = 'selfCheck'
    this.phaseTime = 0
    this.heading = 0
    this.position = { x: 0, y: 0, z: 0 }
    this.velocity = { x: 0, y: 0, z: 0 }
    this.batteryUsedWh = 0
    this.batteryTemp = 25
    // 上电即有 1 星,随后由 updateGnss 逐步搜星到目标数
    this.satellites = this.faults.gnssLost ? 0 : 1
    this.flightTime = 0
    this.altitudeMax = 0
    this.damaged = false
    this.pushEvent('info', '飞行器上电,开始系统自检')
  }

  /** 关机:仅地面可用;顺带作废未起飞的航线任务 */
  powerOff(): void {
    if (this.airborne || this.phase === 'powerOff') return
    this.phase = 'powerOff'
    this.motorLoad = 0
    // 已下发但尚未起飞的航线随关机一起作废
    if (this.missionPending) {
      this.missionPending = false
      this.missionStatus = 'idle'
      this.missionIndex = -1
    }
    if (this.recording) this.stopRecording()
    this.pushEvent('info', '飞行器已关机')
  }

  setMode(mode: FlightMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.pushEvent('info', `切换至${FLIGHT_MODES[mode].label}`)
  }

  setStick(stick: Partial<StickState>): void {
    this.stick = { ...this.stick, ...stick }
  }

  /** 内八掰杆启动电机(地面待机时可用) */
  startMotors(): boolean {
    if (this.phase !== 'standby') return false
    const blocked = this.checklist.filter((item) => item.blocking && !item.ok)
    if (blocked.length > 0) {
      this.pushEvent('error', `起飞前检查未通过:${blocked.map((item) => item.label).join('、')}`)
      return false
    }
    this.phase = 'motorsOn'
    this.phaseTime = 0
    this.pushEvent('success', '电机已启动(内八掰杆),桨叶开始怠速旋转')
    return true
  }

  /** 停止电机(仅地面已启动电机的状态可用);返回是否真的停下来了 */
  stopMotors(): boolean {
    if (this.phase !== 'motorsOn') return false
    this.phase = 'standby'
    this.pushEvent('info', '电机已停止')
    return true
  }

  /** 起飞:记录返航点并自动爬升到 1.2 米(需已启动电机) */
  takeOff(): boolean {
    if (this.phase !== 'motorsOn') return false
    this.phase = 'takingOff'
    this.phaseTime = 0
    this.home = { x: this.position.x, z: this.position.z }
    this.homeRecorded = true
    this.damageCheck()
    this.pushEvent('success', '起飞:自动上升至 1.2 米')
    return true
  }

  /** 一键起飞(地面待机时自动完成电机启动 + 起飞) */
  autoTakeOff(): boolean {
    if (this.phase === 'standby' && !this.startMotors()) return false
    return this.takeOff()
  }

  /** 触发自动降落(会先中止正在执行的航线任务) */
  startLanding(): boolean {
    if (!this.airborne && this.phase !== 'takingOff') return false
    if (this.phase === 'landing' || this.phase === 'emergency') return false
    this.abortMission('触发自动降落')
    this.phase = 'landing'
    this.phaseTime = 0
    this.landingTimer = 0
    this.beginLandingDescent()
    this.pushEvent('info', '开始自动降落')
    return true
  }

  /** 触发智能返航(reason 用于日志与快照);返航优先级高于航线,会中止任务 */
  startRth(reason: string): boolean {
    if (!this.airborne) return false
    if (this.phase === 'rth') return false
    // 返航优先级高于航线任务:真机触发返航会同时中止未完成的航线
    this.abortMission('触发返航')
    this.phase = 'rth'
    this.phaseTime = 0
    // 已在返航高度附近(差 <0.5 m)就直接巡航,否则先爬升
    this.rthStage = this.position.y < this.config.rthAltitude - 0.5 ? 'ascend' : 'cruise'
    this.rthReason = reason
    // 1.2 s 内忽略摇杆,防止触发返航的那次打杆立刻把返航取消掉
    this.rthStickGrace = 1.2
    this.pushEvent('warn', `触发智能返航(${reason}),返航高度 ${this.config.rthAltitude} 米`)
    return true
  }

  cancelRth(reason = '用户取消'): void {
    if (this.phase !== 'rth') return
    this.phase = 'flying'
    this.pushEvent('info', `返航已中止(${reason})`)
  }

  /**
   * 紧急停桨(停桨保护)。
   * ⚠️ **只在飞行器落地后允许**:空中停桨会直接导致坠机,本沙盒按用户要求禁止,
   * 必须先把飞行器降落下来。空中调用会被拒绝(不改变任何飞行状态),只写一条警告日志。
   */
  emergencyStop(): boolean {
    if (this.airborne) {
      this.pushEvent(
        'warn',
        `飞行器尚未落地(离地 ${this.position.y.toFixed(1)} 米),已拒绝紧急停桨,请先降落`,
      )
      return false
    }
    return this.stopMotors()
  }

  /** 重置到可再次起飞的状态(用于沙盒反复测试) */
  reset(): void {
    this.phase = 'powerOff'
    this.position = { x: 0, y: 0, z: 0 }
    this.velocity = { x: 0, y: 0, z: 0 }
    this.tiltPitch = 0
    this.tiltRoll = 0
    this.heading = 0
    this.motorLoad = 0
    this.damaged = false
    this.batteryUsedWh = 0
    this.flightTime = 0
    this.altitudeMax = 0
    this.stick = { ...NEUTRAL_STICK }
    this.recording = false
    this.recordSeconds = 0
    this.rthReason = ''
    // 航线任务一并复位(静默,不写日志:重置本身就是"回到出厂")
    this.missionStatus = 'idle'
    this.missionIndex = -1
    this.missionStage = 'idle'
    this.missionPending = false
    this.missionHoverTimer = 0
    this.missionWaypointTimer = 0
    this.missionElapsed = 0
    this.missionPasses = 0
    this.missionPauseReason = ''
    this.pushEvent('info', '沙盒已重置')
  }

  // ————————————————————————————— 每帧推进 —————————————————————————————

  /** 推进一个仿真时间片(dtSeconds 秒;负值不推进,过大的值会被夹到单步上限) */
  step(dtSeconds: number): void {
    // 单步上限 0.1 s:后台标签页卡顿后一帧可能攒下很久,夹住避免积分出巨大位移
    const delta = clamp(dtSeconds, 0, 0.1)
    if (delta <= 0) return
    this.time += delta
    this.phaseTime += delta
    // 录像计时与电源状态无关(相机录制本身由引擎层的 MediaRecorder 负责)
    if (this.recording) this.recordSeconds += delta

    if (this.phase === 'powerOff') {
      this.motorLoad = lerp(this.motorLoad, 0, Math.min(1, delta * 6))
      this.updateBattery(delta)
      return
    }

    this.updatePhaseMachine(delta)
    this.updateGnss(delta)
    this.updateFlight(delta)
    this.updateCamera(delta)
    this.updateBattery(delta)
    this.updateFailsafe(delta)
  }

  /** 分阶段推进:自检 → 预热 → 待机;起飞/降落/返航的自动段也在这里 */
  private updatePhaseMachine(delta: number): void {
    switch (this.phase) {
      case 'selfCheck':
        this.motorLoad = lerp(this.motorLoad, 0, Math.min(1, delta * 4))
        if (this.phaseTime >= SELF_CHECK_SECONDS) {
          this.phase = 'warmingUp'
          this.phaseTime = 0
          this.pushEvent('info', '自检通过,开始 IMU / 传感器预热')
        }
        break
      case 'warmingUp':
        if (this.phaseTime >= WARMUP_SECONDS) {
          this.phase = 'standby'
          this.phaseTime = 0
          this.home = { x: this.position.x, z: this.position.z }
          this.homeRecorded = true
          this.pushEvent('success', '预热完成,已记录返航点,等待起飞指令')
        }
        break
      case 'motorsOn':
        this.motorLoad = lerp(this.motorLoad, 0.32, Math.min(1, delta * 3))
        break
      case 'takingOff': {
        this.motorLoad = lerp(this.motorLoad, 0.62, Math.min(1, delta * 3))
        // 起飞爬升率固定 1.5 m/s
        this.position.y = Math.min(DRONE_SPEC.takeoffAltitude, this.position.y + 1.5 * delta)
        this.velocity.y = 1.5
        this.settleHorizontal(delta)
        if (this.position.y >= DRONE_SPEC.takeoffAltitude - 0.01) {
          this.position.y = DRONE_SPEC.takeoffAltitude
          this.velocity.y = 0
          if (this.missionPending) {
            // 航线下发时飞机还在地面:起飞到位后自动接上航线
            this.beginMissionPath()
          } else {
            this.phase = 'flying'
            this.pushEvent('success', '已到达 1.2 米,进入悬停')
          }
        }
        break
      }
      case 'landing':
        this.updateLanding(delta)
        break
      case 'emergency':
        this.applyGravityFall(delta)
        break
      case 'stopped':
      case 'standby':
        this.motorLoad = lerp(this.motorLoad, 0, Math.min(1, delta * 3))
        this.settleHorizontal(delta)
        break
      default:
        break
    }
  }

  /** 按下降落:高于悬停位则先降向 1 米,已经贴地则直接缓降 */
  private beginLandingDescent(): void {
    this.landingHoldTimer = 0
    this.landingStage = this.position.y > LANDING_HOLD_ALTITUDE_M + 0.05 ? 'approach' : 'settle'
  }

  /**
   * 自动降落:降向 1 米悬停位 → 稳住一下 → 缓慢触地。
   * 真机不会从巡航高度一路匀速直插地面;低位那一下停顿既是确认落点,也是留给飞手接管的时间。
   */
  private updateLanding(delta: number): void {
    this.motorLoad = lerp(this.motorLoad, 0.55, Math.min(1, delta * 3))
    this.settleHorizontal(delta)

    if (this.landingStage === 'approach') {
      // 低于 2 m 改用 0.6 m/s 缓降,避免贴地时下冲过猛
      const rate =
        this.position.y <= DRONE_SPEC.landingSlowAltitude ? 0.6 : this.modeSpec.descendSpeed
      this.velocity.y = -rate
      this.position.y -= rate * delta
      if (this.position.y <= LANDING_HOLD_ALTITUDE_M) {
        this.position.y = LANDING_HOLD_ALTITUDE_M
        this.velocity.y = 0
        this.enterLandingHold()
      }
      return
    }

    if (this.landingStage === 'hold') {
      // 低位悬停:高度锁死不动,等停顿走完再缓降
      this.position.y = LANDING_HOLD_ALTITUDE_M
      this.velocity.y = 0
      this.landingHoldTimer += delta
      if (this.landingHoldTimer >= LANDING_HOLD_SECONDS) {
        this.landingStage = 'settle'
        this.pushEvent('info', '悬停确认完成,开始缓慢降落')
      }
      return
    }

    // 缓速触地:接触地面后停桨
    this.velocity.y = -LANDING_FINAL_DESCENT_RATE
    this.position.y -= LANDING_FINAL_DESCENT_RATE * delta
    if (this.position.y <= 0.02) {
      this.position.y = 0
      this.velocity.y = 0
      this.landingTimer += delta
      // 触地后停 1.2 s 再停桨,确认确实落稳
      if (this.landingTimer >= 1.2) {
        this.finishLanding()
      }
    } else {
      this.landingTimer = 0
    }
  }

  /** 进入 1 米悬停位(手动降落与返航下降段共用) */
  private enterLandingHold(): void {
    this.landingStage = 'hold'
    this.landingHoldTimer = 0
    this.pushEvent('info', `已到达 ${LANDING_HOLD_ALTITUDE_M} 米悬停位,确认后缓降`)
  }

  private finishLanding(): void {
    this.phase = 'standby'
    this.landingTimer = 0
    this.landingHoldTimer = 0
    this.landingStage = 'settle'
    this.motorLoad = 0
    this.velocity = { x: 0, y: 0, z: 0 }
    if (this.recording) this.stopRecording()
    this.pushEvent('success', `已安全降落,本次飞行 ${this.formatDuration(this.flightTime)}`)
    if (this.batteryPercent <= this.config.criticalBatteryPercent) {
      this.pushEvent('warn', '严重低电量,建议更换电池后再起飞')
    }
  }

  private applyGravityFall(delta: number): void {
    this.velocity.y -= GRAVITY * delta
    // 近似空气阻力:水平速度按指数衰减(0.4 为衰减系数)
    this.velocity.x *= 1 - Math.min(1, delta * 0.4)
    this.velocity.z *= 1 - Math.min(1, delta * 0.4)
    this.position.x += this.velocity.x * delta
    this.position.y += this.velocity.y * delta
    this.position.z += this.velocity.z * delta
    // 坠落时机头前倾 25°
    this.tiltPitch = lerp(this.tiltPitch, 25, Math.min(1, delta * 2))
    if (this.position.y <= 0) {
      this.position.y = 0
      this.velocity = { x: 0, y: 0, z: 0 }
      this.damaged = true
      this.phase = 'stopped'
      this.pushEvent('error', '飞行器坠地受损,请重新上电复位')
    }
  }

  /** 水平速度归零(GPS/视觉保持位置,姿态模式保留风漂移) */
  private settleHorizontal(delta: number): void {
    if (this.positionSource === 'atti') {
      const wind = this.windVector()
      this.velocity.x = lerp(this.velocity.x, wind.x, Math.min(1, delta * 0.8))
      this.velocity.z = lerp(this.velocity.z, wind.z, Math.min(1, delta * 0.8))
    } else {
      const brake = Math.min(1, delta * 4)
      this.velocity.x = lerp(this.velocity.x, 0, brake)
      this.velocity.z = lerp(this.velocity.z, 0, brake)
    }
    this.position.x += this.velocity.x * delta
    this.position.z += this.velocity.z * delta
  }

  // ————————————————————————————— 手动飞行 —————————————————————————————

  private updateFlight(delta: number): void {
    if (this.phase === 'flying' || this.phase === 'rth' || this.phase === 'waypoint') {
      // 航线任务自己算航迹(不受摇杆指令直接驱动),其余两态走手动/返航通道
      if (this.phase === 'waypoint') {
        this.updateMission(delta)
      } else {
        this.updateGnssPositionFlight(delta)
      }
      this.updateMotorLoad(delta)
    }
    this.updateTilt(delta)
    this.applyObstacleBrake()
    this.altitudeMax = Math.max(this.altitudeMax, this.position.y)
  }

  private updateGnssPositionFlight(delta: number): void {
    const spec = this.modeSpec
    const source = this.positionSource
    const horizontalStick = { pitch: this.stick.pitch, roll: this.stick.roll }
    const stickMagnitude = Math.hypot(horizontalStick.pitch, horizontalStick.roll)

    if (this.phase === 'rth') {
      this.updateRth(delta)
      return
    }

    if (source === 'atti' && !this.faults.gnssLost) {
      // 指南针异常:姿态模式左右漂移,真机表现为航向漂移
      this.heading += Math.sin(this.time * 0.7) * 8 * delta
    }

    // 摇杆幅值超过 1 时按圆行程归一,避免斜向超速
    const scale = stickMagnitude > 1 ? 1 / stickMagnitude : 1
    const forwardSpeed = horizontalStick.pitch * spec.horizontalSpeed * scale
    const rightSpeed = horizontalStick.roll * spec.horizontalSpeed * scale

    const nose = headingVector(this.heading)
    const right = { x: -nose.z, z: nose.x }
    // 机身坐标系下的空气速度指令
    let airX = nose.x * forwardSpeed + right.x * rightSpeed
    let airZ = nose.z * forwardSpeed + right.z * rightSpeed

    const wind = this.windVector()
    if (source !== 'atti') {
      // 定点保持:飞控用 -风 的空气速度顶住风,顶不住的部分变成漂移
      airX -= wind.x
      airZ -= wind.z
    }
    const airMagnitude = Math.hypot(airX, airZ)
    const airLimit = source === 'atti' ? spec.horizontalSpeed : spec.horizontalSpeed + 0.01
    if (airMagnitude > airLimit) {
      const ratio = airLimit / airMagnitude
      airX *= ratio
      airZ *= ratio
    }
    const targetX = airX + wind.x
    const targetZ = airZ + wind.z

    const stickActive = stickMagnitude > 0.06
    const accel = (stickActive ? spec.accel : spec.brakeAccel) * delta
    this.velocity.x += clamp(targetX - this.velocity.x, -accel, accel)
    this.velocity.z += clamp(targetZ - this.velocity.z, -accel, accel)

    // 垂直:GPS/视觉下松杆定高;姿态模式有轻微掉高
    const verticalInput = this.stick.throttle
    if (Math.abs(verticalInput) > 0.06) {
      const rate =
        verticalInput > 0 ? verticalInput * spec.climbSpeed : verticalInput * spec.descendSpeed
      this.velocity.y += clamp(rate - this.velocity.y, -3 * delta, 3 * delta)
    } else {
      // 姿态模式无定高:松杆仍以 -0.35 m/s 缓慢掉高
      const hold = source === 'atti' ? -0.35 : 0
      this.velocity.y += clamp(hold - this.velocity.y, -2 * delta, 2 * delta)
    }

    this.integratePosition(delta)
    this.applyYaw(delta)
  }

  private integratePosition(delta: number): void {
    this.position.x += this.velocity.x * delta
    this.position.z += this.velocity.z * delta
    this.position.y += this.velocity.y * delta

    // 限高 / 限距
    this.altitudeLimitReached = false
    if (this.position.y >= this.config.maxAltitude) {
      this.position.y = this.config.maxAltitude
      if (this.velocity.y > 0) this.velocity.y = 0
      this.altitudeLimitReached = true
      this.warnOnce('altitude', '已达最大飞行高度限制')
    }
    if (this.position.y < 0) {
      this.position.y = 0
      if (this.velocity.y < 0) this.velocity.y = 0
    }
    const distance = this.distanceToHome
    this.distanceLimitReached = false
    if (distance > this.config.maxDistance) {
      // 超距时沿返航点方向等比缩回,精确落到限距圆上
      const ratio = this.config.maxDistance / distance
      this.position.x = this.home.x + (this.position.x - this.home.x) * ratio
      this.position.z = this.home.z + (this.position.z - this.home.z) * ratio
      this.velocity.x = 0
      this.velocity.z = 0
      this.distanceLimitReached = true
      this.warnOnce('distance', '已达最大飞行距离限制')
    }
  }

  private applyYaw(delta: number): void {
    // 电机异常时偏航权限降到 70%,与下面的被动自旋叠加
    const rate = this.stick.yaw * this.modeSpec.yawRateDeg * (this.faults.motorFailure ? 0.7 : 1)
    this.heading = (this.heading + rate * delta + 360) % 360
    if (this.faults.motorFailure) {
      // 单电机动力衰减:机身持续缓慢自旋,需要飞控不断修正
      this.heading = (this.heading + 22 * delta + 360) % 360
    }
  }

  /**
   * 机体倾斜:由空气速度决定(顶风悬停时也会前倾),姿态模式叠加轻微摆动。
   * 采用航空惯例:俯仰正 = 抬头,横滚正 = 右倾 —— 前进时机头下压即为负俯仰。
   */
  private updateTilt(delta: number): void {
    const spec = this.modeSpec
    const wind = this.windVector()
    const airX = this.velocity.x - wind.x
    const airZ = this.velocity.z - wind.z
    const nose = headingVector(this.heading)
    const right = { x: -nose.z, z: nose.x }
    const forwardAir = airX * nose.x + airZ * nose.z
    const rightAir = airX * right.x + airZ * right.z

    let pitch = -clamp(forwardAir / spec.horizontalSpeed, -1, 1) * spec.maxTiltDeg
    let roll = clamp(rightAir / spec.horizontalSpeed, -1, 1) * spec.maxTiltDeg
    if (this.positionSource === 'atti' && this.airborne) {
      pitch += Math.sin(this.time * 2.1) * 1.6
      roll += Math.cos(this.time * 1.7) * 2.2
    }
    // 地面待机时姿态回中更快(8),飞行中柔和些(3.2)
    const smoothing = this.phase === 'standby' ? 8 : 3.2
    this.tiltPitch = lerp(this.tiltPitch, pitch, Math.min(1, delta * smoothing))
    this.tiltRoll = lerp(this.tiltRoll, roll, Math.min(1, delta * smoothing))
  }

  private updateMotorLoad(delta: number): void {
    if (this.phase === 'emergency' || this.phase === 'powerOff') {
      this.motorLoad = lerp(this.motorLoad, 0, Math.min(1, delta * 8))
      return
    }
    // 5 m/s 为爬升归一化参考、16 m/s 为平飞参考;0.42 是悬停基准负载
    const climbFactor = clamp(this.velocity.y / 5, -0.3, 1)
    const speedFactor = clamp(Math.hypot(this.velocity.x, this.velocity.z) / 16, 0, 1)
    const target = clamp(0.42 + climbFactor * 0.45 + speedFactor * 0.28, 0.2, 1)
    const shouldSpin = this.phase !== 'standby' && this.phase !== 'stopped'
    this.motorLoad = lerp(this.motorLoad, shouldSpin ? target : 0, Math.min(1, delta * 4))
  }

  // ————————————————————————————— 智能返航 —————————————————————————————

  private updateRth(delta: number): void {
    const spec = FLIGHT_MODES.normal
    this.rthStickGrace = Math.max(0, this.rthStickGrace - delta)
    const stickMagnitude = Math.hypot(this.stick.pitch, this.stick.roll, this.stick.throttle)
    if (this.rthStickGrace <= 0 && stickMagnitude > 0.15) {
      this.cancelRth('检测到摇杆操作')
      return
    }

    // 返航高度下限 2 m,避免把返航高度设得过低时贴地飞
    const targetAltitude = Math.max(this.config.rthAltitude, 2)
    if (this.rthStage === 'ascend') {
      const delta2 = targetAltitude - this.position.y
      this.velocity.x = lerp(this.velocity.x, 0, Math.min(1, delta * 2))
      this.velocity.z = lerp(this.velocity.z, 0, Math.min(1, delta * 2))
      this.velocity.y = clamp(delta2, -spec.climbSpeed, spec.climbSpeed)
      if (Math.abs(delta2) < 0.3) {
        this.velocity.y = 0
        this.rthStage = 'cruise'
        this.pushEvent('info', `已升至返航高度 ${targetAltitude} 米,开始返航`)
      }
    } else if (this.rthStage === 'cruise') {
      const dx = this.home.x - this.position.x
      const dz = this.home.z - this.position.z
      const distance = Math.hypot(dx, dz)
      if (distance < 0.8) {
        this.velocity.x = 0
        this.velocity.z = 0
        this.rthStage = 'descend'
        this.pushEvent('info', '已到达返航点上方,开始下降')
      } else {
        const dirX = dx / distance
        const dirZ = dz / distance
        // 由方向向量反算罗盘角:atan2(x, -z),0°=北、90°=东
        const targetHeading = radToDeg(Math.atan2(dirX, -dirZ))
        const headingError = Math.abs(((targetHeading - this.heading + 540) % 360) - 180)
        this.velocity.y = lerp(this.velocity.y, 0, Math.min(1, delta * 2))
        if (headingError > RTH_ALIGN_TOLERANCE_DEG) {
          // 真机返航是"先对准、再前进":机头转到返航航向之前原地悬停转向,
          // 不带着位移一起转(否则会飞出一条弧线,航迹也对不上返航点)
          this.velocity.x = lerp(this.velocity.x, 0, Math.min(1, delta * 8))
          this.velocity.z = lerp(this.velocity.z, 0, Math.min(1, delta * 8))
          this.heading = this.turnToward(this.heading, targetHeading, RTH_YAW_RATE_DEG * delta)
        } else {
          // 接近返航点时按距离比例减速,最低 2 m/s
          const cruiseSpeed = Math.min(spec.horizontalSpeed, Math.max(2, distance * 0.5))
          this.velocity.x = lerp(this.velocity.x, dirX * cruiseSpeed, Math.min(1, delta * 1.6))
          this.velocity.z = lerp(this.velocity.z, dirZ * cruiseSpeed, Math.min(1, delta * 1.6))
          // 对准之后机头即航向,前进方向与机头一致
          this.heading = this.turnToward(this.heading, targetHeading, RTH_YAW_RATE_DEG * delta)
        }
      }
    } else if (this.rthStage === 'descend') {
      this.velocity.x = lerp(this.velocity.x, 0, Math.min(1, delta * 3))
      this.velocity.z = lerp(this.velocity.z, 0, Math.min(1, delta * 3))
      this.velocity.y = -spec.descendSpeed
      this.integratePosition(delta)
      if (this.position.y <= LANDING_HOLD_ALTITUDE_M) {
        // 降到 1 米悬停位就交给降落阶段:先稳住,再缓慢触地
        this.rthStage = 'landing'
        this.phase = 'landing'
        this.landingTimer = 0
        this.position.y = LANDING_HOLD_ALTITUDE_M
        this.velocity.y = 0
        this.enterLandingHold()
      }
      return
    } else {
      this.phase = 'landing'
      return
    }
    this.integratePosition(delta)
  }

  private turnToward(current: number, target: number, maxDelta: number): number {
    // 角度差归一到 (-180, 180];+540 是为了让 JS 的 % 对负数也给出正余数
    let difference = ((target - current + 540) % 360) - 180
    difference = clamp(difference, -maxDelta, maxDelta)
    return (current + difference + 360) % 360
  }

  // ————————————————————————————— 航线任务 —————————————————————————————

  /** 设置航点列表(执行中禁止修改,与真机"上传后不可改"一致) */
  setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean {
    if (this.missionStatus !== 'idle' || this.missionPending) {
      this.pushEvent('warn', '航线执行中无法修改航点列表,请先停止任务')
      return false
    }
    this.mission = waypoints.map((waypoint) => normalizeMissionWaypoint(waypoint))
    this.missionIndex = -1
    this.missionStage = 'idle'
    return true
  }

  /**
   * 只改一个航点(列表编辑与场景内拖拽共用)。
   *
   * 与 `setMission` 的区别:不整表替换、不重排,因此执行进度、其他航点的引用都保持原样 ——
   * 场景里拖动航点时每帧都要下发一次,用整表替换会连带重建整套三维标记。
   *
   * 返回值是**归一化并夹紧后**的航点(限高/限距),调用方拿它当权威值,别用自己算的原始值。
   */
  updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null {
    if (this.missionStatus !== 'idle' || this.missionPending) return null
    const current = this.mission[index]
    if (!current) return null
    const next = normalizeMissionWaypoint({ ...current, ...patch })
    this.constrainMissionWaypoint(next)
    this.mission[index] = next
    return next
  }

  /**
   * 插入一个航点(场景内双击地面新增)。index 越界则追加到末尾,返回实际插入位置。
   * 与真机一致:新航点的高度默认取相邻航点,避免插一个 0 米高、撞地的点。
   */
  addMissionWaypoint(waypoint: Partial<MissionWaypoint>, index = this.mission.length): number {
    if (this.missionStatus !== 'idle' || this.missionPending) {
      this.pushEvent('warn', '航线执行中无法新增航点,请先停止任务')
      return -1
    }
    const at = clamp(Math.round(index), 0, this.mission.length)
    const next = normalizeMissionWaypoint(waypoint)
    this.constrainMissionWaypoint(next)
    const list = this.mission.slice()
    list.splice(at, 0, next)
    this.mission = list
    return at
  }

  /** 删除一个航点,返回是否删掉了 */
  removeMissionWaypoint(index: number): boolean {
    if (this.missionStatus !== 'idle' || this.missionPending) {
      this.pushEvent('warn', '航线执行中无法删除航点,请先停止任务')
      return false
    }
    if (index < 0 || index >= this.mission.length) return false
    const list = this.mission.slice()
    list.splice(index, 1)
    this.mission = list
    return true
  }

  /** 把一个航点夹进可执行范围:高度不超限高,水平距离不超限距(超出则沿返航点方向缩回) */
  private constrainMissionWaypoint(waypoint: MissionWaypoint): void {
    waypoint.altitude = clamp(waypoint.altitude, 1, this.config.maxAltitude)
    const offsetX = waypoint.x - this.home.x
    const offsetZ = waypoint.z - this.home.z
    const distance = Math.hypot(offsetX, offsetZ)
    if (distance <= this.config.maxDistance) return
    const scale = this.config.maxDistance / distance
    waypoint.x = this.home.x + offsetX * scale
    waypoint.z = this.home.z + offsetZ * scale
  }

  /** 增量更新航线任务的全局设置(只覆盖传入的字段) */
  setMissionConfig(patch: Partial<MissionConfig>): void {
    this.missionConfig = { ...this.missionConfig, ...patch }
  }

  /** 恢复出厂示例航线 */
  resetMissionToDefault(): void {
    this.setMission(DEFAULT_MISSION.map((waypoint) => ({ ...waypoint })))
  }

  /**
   * 启动航线任务。
   * - 地面待机时先自动起飞,到 1.2 米后自动接上航线(对应 Pilot 里的"执行航线");
   * - 已在空中则直接飞向第一个航点(正在返航会先中止返航);
   * - 姿态模式(无定位)拒绝执行 —— 航点任务依赖 GNSS,真机同样如此。
   */
  startMission(): boolean {
    if (this.missionStatus !== 'idle' || this.missionPending) return false
    if (this.mission.length === 0) {
      this.pushEvent('error', '航线任务启动失败:航点列表为空')
      return false
    }
    const problem = this.validateMission()
    if (problem) {
      this.pushEvent('error', `航线任务启动失败:${problem}`)
      return false
    }
    if (this.positionSource === 'atti') {
      this.pushEvent('error', '航线任务启动失败:当前无定位(姿态模式),航点任务需要 GNSS 定位')
      return false
    }
    if (this.phase === 'standby' || this.phase === 'motorsOn' || this.phase === 'takingOff') {
      const needsTakeOff = this.phase !== 'takingOff'
      this.missionPending = true
      if (needsTakeOff && !this.autoTakeOff()) {
        this.missionPending = false
        return false
      }
      this.pushEvent('info', `航线已下发(${this.mission.length} 个航点),起飞到位后自动开始执行`)
      return true
    }
    if (
      this.phase === 'landing' ||
      this.phase === 'emergency' ||
      this.phase === 'stopped' ||
      this.phase === 'powerOff'
    ) {
      this.pushEvent('error', `航线任务启动失败:当前阶段(${PHASE_LABELS[this.phase]})无法执行`)
      return false
    }
    if (this.phase === 'rth') this.cancelRth('执行航线任务')
    this.beginMissionPath()
    return true
  }

  /** 进入航线执行态(已在空中的入口) */
  /**
   * 进入航线执行态(已在空中 / 起飞到位后的入口)。
   * 无论是地面起飞接上航线还是空中直接下发,都先从「启航四步」走起 ——
   * 垂直调整到首航点高度 → 水平飞过去 → 高度收尾 → 对准航线方向,然后才开始推航点。
   */
  private beginMissionPath(): void {
    this.missionPending = false
    this.missionStatus = 'running'
    this.missionIndex = 0
    this.missionStage = 'depart-climb'
    this.missionHoverTimer = 0
    this.missionWaypointTimer = 0
    this.missionElapsed = 0
    this.missionPasses = 0
    this.missionStickGrace = 1
    this.missionPauseReason = ''
    this.missionStartHeading = this.heading
    this.missionTotalDistance = this.computeMissionDistanceLeft()
    this.phase = 'waypoint'
    this.phaseTime = 0
    const first = this.mission[0]
    this.pushEvent(
      'success',
      `开始执行航线任务(${this.mission.length} 个航点 · 巡航 ${this.missionConfig.autoSpeed} m/s)${
        first ? ` · 先垂直调整到 ${first.altitude} 米` : ''
      }`,
    )
  }

  /** 暂停任务:交回手动控制并原地悬停,航点进度保留 */
  pauseMission(reason = '用户暂停'): boolean {
    if (this.missionStatus !== 'running') return false
    this.missionStatus = 'paused'
    this.missionPauseReason = reason
    this.missionPausedStage = this.missionStage
    this.velocity = { x: 0, y: 0, z: 0 }
    if (this.phase === 'waypoint') this.phase = 'flying'
    this.pushEvent('warn', `航线任务已暂停(${reason}),可手动接管;点「继续」回到当前航点`)
    return true
  }

  /** 继续任务:回到当前目标航点(首航点还没走完启航段的话接着走) */
  resumeMission(): boolean {
    if (this.missionStatus !== 'paused') return false
    this.missionStatus = 'running'
    this.missionPauseReason = ''
    this.missionStickGrace = 1
    this.missionWaypointTimer = 0
    // 暂停期间可能被手动飞走了:按当前位置重新判断启航段走到哪一步(幂等)
    this.missionStage = isMissionDepartStage(this.missionPausedStage)
      ? this.resolveMissionDepartStage()
      : 'goto'
    if (this.airborne) this.phase = 'waypoint'
    this.pushEvent('info', `航线任务继续执行(航点 ${this.missionIndex + 1}/${this.mission.length})`)
    return true
  }

  /** 停止任务:飞机原地悬停,航线归零(真机"停止任务"不返航) */
  stopMission(reason = '用户停止'): boolean {
    if (this.missionStatus === 'idle' && !this.missionPending) return false
    this.missionPending = false
    this.abortMission(reason)
    if (this.phase === 'waypoint') {
      this.phase = 'flying'
      this.velocity = { x: 0, y: 0, z: 0 }
    }
    return true
  }

  /** 中止任务(内部使用:返航/降落等更高优先级动作会走到这里) */
  private abortMission(reason: string): void {
    if (this.missionStatus === 'idle' && !this.missionPending) return
    this.missionStatus = 'idle'
    this.missionIndex = -1
    this.missionStage = 'idle'
    this.missionPending = false
    this.missionHoverTimer = 0
    this.missionWaypointTimer = 0
    this.missionPauseReason = ''
    this.pushEvent('warn', `航线任务已中止(${reason})`)
  }

  /** 航点合法性校验(限高限距):真机在上传航线时就会拦下这类航点 */
  private validateMission(): string | null {
    for (let index = 0; index < this.mission.length; index += 1) {
      const waypoint = this.mission[index]
      if (!waypoint) continue
      if (waypoint.altitude > this.config.maxAltitude) {
        return `航点 ${index + 1} 高度 ${waypoint.altitude} m 超过限高 ${this.config.maxAltitude} m`
      }
      const distance = Math.hypot(waypoint.x - this.home.x, waypoint.z - this.home.z)
      if (distance > this.config.maxDistance) {
        return `航点 ${index + 1} 距返航点 ${distance.toFixed(0)} m,超过限距 ${this.config.maxDistance} m`
      }
    }
    return null
  }

  /**
   * 航线任务每帧推进。
   *
   * 真机飞航线的三个观感要点都在这里:
   * - **先对准再前进**:headingMode='auto' 时机头没转到航向之前原地悬停转向,否则会飞出一条弧线;
   * - **到点减速**:直线模式下按刹车距离提前收油,过点不甩过头;曲线模式则保持巡航速度、
   *   距航点 3 米就切下一个点,形成圆滑切角;
   * - **打杆即暂停**:执行中拨动摇杆 → 任务暂停并交回手动控制(与 Pilot 行为一致)。
   */
  private updateMission(delta: number): void {
    this.missionStickGrace = Math.max(0, this.missionStickGrace - delta)
    const stickMagnitude = Math.hypot(
      this.stick.pitch,
      this.stick.roll,
      this.stick.throttle,
      this.stick.yaw,
    )
    if (this.missionStickGrace <= 0 && stickMagnitude > 0.15) {
      this.pauseMission('检测到摇杆操作')
      return
    }
    // 航点任务依赖 GNSS:飞着飞着丢了定位,真机会把任务挂起(而不是蒙着眼继续飞)
    if (this.positionSource === 'atti') {
      this.pauseMission('GNSS 失锁,进入姿态模式')
      return
    }
    this.missionElapsed += delta

    const waypoint = this.mission[this.missionIndex]
    if (!waypoint) {
      this.finishMission()
      return
    }

    // 首航点走「启航四步」(垂直 → 水平 → 收高度 → 对准航线),和常规航点推进分开写
    if (isMissionDepartStage(this.missionStage)) {
      this.updateMissionDepart(delta)
      return
    }

    const spec = this.modeSpec
    const dx = waypoint.x - this.position.x
    const dz = waypoint.z - this.position.z
    const distance = Math.hypot(dx, dz)
    const altitudeError = waypoint.altitude - this.position.y
    const curved = this.missionConfig.pathMode === 'curved'

    if (this.missionStage === 'hover') {
      this.position.y = waypoint.altitude
      this.velocity.x = lerp(this.velocity.x, 0, Math.min(1, delta * 4))
      this.velocity.z = lerp(this.velocity.z, 0, Math.min(1, delta * 4))
      this.velocity.y = lerp(this.velocity.y, 0, Math.min(1, delta * 2))
      this.missionHoverTimer += delta
      if (this.missionHoverTimer >= waypoint.hoverSeconds) this.advanceMission()
      if (this.phase !== 'waypoint') return
      this.integratePosition(delta)
      return
    }

    // 机头:auto = 始终指向下一航点;fixed = 保持任务起始航向(相当于常说的"锁定航向")
    const targetHeading = distance > 0.4 ? radToDeg(Math.atan2(dx, -dz)) : this.heading
    const desiredHeading =
      this.missionConfig.headingMode === 'auto' ? targetHeading : this.missionStartHeading
    this.heading = this.turnToward(this.heading, desiredHeading, MISSION_YAW_RATE_DEG * delta)
    const headingError = Math.abs(((desiredHeading - this.heading + 540) % 360) - 180)

    // 高度与水平段同时收敛
    const desiredVertical = clamp(altitudeError, -spec.descendSpeed, spec.climbSpeed)
    this.velocity.y = lerp(this.velocity.y, desiredVertical, Math.min(1, delta * 2))

    const cruise = clamp(
      waypoint.speed > 0 ? waypoint.speed : this.missionConfig.autoSpeed,
      0.5,
      Math.max(0.5, this.missionConfig.autoSpeed),
    )
    const aligned =
      this.missionConfig.headingMode !== 'auto' || headingError <= RTH_ALIGN_TOLERANCE_DEG
    // 刹车距离 = v²/(2a);+0.6 m 是留出的余量
    const brakeDistance = (cruise * cruise) / (2 * spec.brakeAccel) + 0.6
    let targetSpeed = 0
    if (aligned) {
      targetSpeed =
        !curved && distance < brakeDistance
          ? Math.max(0.6, cruise * (distance / brakeDistance))
          : cruise
    }
    const dirX = distance > 0.001 ? dx / distance : 0
    const dirZ = distance > 0.001 ? dz / distance : 0
    // 转向/变速平滑系数:曲线过点更跟手(2.6),直线更稳(1.8)
    const steer = Math.min(1, delta * (curved ? 2.6 : 1.8))
    this.velocity.x = lerp(this.velocity.x, dirX * targetSpeed, steer)
    this.velocity.z = lerp(this.velocity.z, dirZ * targetSpeed, steer)

    const arrived = curved
      ? distance <= MISSION_CURVED_TURN_RADIUS
      : distance <= MISSION_ARRIVE_RADIUS &&
        Math.abs(altitudeError) <= MISSION_ARRIVE_ALTITUDE_TOLERANCE

    if (arrived) {
      this.arriveWaypoint()
      if (this.phase !== 'waypoint') return
      this.integratePosition(delta)
      return
    }

    this.missionWaypointTimer += delta
    if (this.missionWaypointTimer > MISSION_WAYPOINT_TIMEOUT) {
      this.pushEvent('warn', `航点 ${this.missionIndex + 1} 长时间未到达,已跳过`)
      this.advanceMission()
      if (this.phase !== 'waypoint') return
    }
    this.integratePosition(delta)
  }

  /**
   * 启航段:飞往首航点的四步分段机动(与智能返航同款的分段逻辑)。
   *
   * 1. `depart-climb`  垂直调整到首航点高度 —— 这一段**只动高度**,水平速度锁死;
   * 2. `depart-cruise` 保持该高度水平飞向首航点,机头朝行进方向;
   * 3. `depart-settle` 到达后把高度收干净(水平位置锁死);
   * 4. `depart-align`  原地把机头转到与航线一致,然后才交回常规航点推进。
   */
  private updateMissionDepart(delta: number): void {
    const waypoint = this.mission[0]
    if (!waypoint) {
      this.finishMission()
      return
    }
    const spec = this.modeSpec
    const dx = waypoint.x - this.position.x
    const dz = waypoint.z - this.position.z
    const distance = Math.hypot(dx, dz)
    const altitudeError = waypoint.altitude - this.position.y

    this.missionWaypointTimer += delta
    if (this.missionWaypointTimer > MISSION_WAYPOINT_TIMEOUT) {
      this.pushEvent('warn', '首航点长时间未到达,跳过启航段直接执行航线')
      this.missionWaypointTimer = 0
      this.missionStage = 'goto'
      this.integratePosition(delta)
      return
    }

    if (this.missionStage === 'depart-climb') {
      // 垂直段:水平速度归零,只把高度送到首航点高度
      this.velocity.x = lerp(this.velocity.x, 0, Math.min(1, delta * 3))
      this.velocity.z = lerp(this.velocity.z, 0, Math.min(1, delta * 3))
      this.velocity.y = clamp(altitudeError, -spec.descendSpeed, spec.climbSpeed)
      if (Math.abs(altitudeError) <= MISSION_DEPART_ALTITUDE_TOLERANCE) {
        this.position.y = waypoint.altitude
        this.velocity.y = 0
        this.missionStage = 'depart-cruise'
        this.pushEvent('info', `已垂直调整到 ${waypoint.altitude} 米(首航点高度),水平飞向航点 1`)
      }
      this.integratePosition(delta)
      return
    }

    if (this.missionStage === 'depart-cruise') {
      // 水平段:高度锁在首航点高度,机头朝行进方向(auto 航向模式)
      this.velocity.y = clamp(altitudeError, -spec.descendSpeed, spec.climbSpeed)
      const cruise = clamp(
        waypoint.speed > 0 ? waypoint.speed : this.missionConfig.autoSpeed,
        0.5,
        Math.max(0.5, this.missionConfig.autoSpeed),
      )
      // 刹车距离 = v²/(2a);+0.6 m 是留出的余量
      const brakeDistance = (cruise * cruise) / (2 * spec.brakeAccel) + 0.6
      const targetSpeed =
        distance < brakeDistance ? Math.max(0.4, cruise * (distance / brakeDistance)) : cruise
      const dirX = distance > 0.001 ? dx / distance : 0
      const dirZ = distance > 0.001 ? dz / distance : 0
      const desiredHeading =
        this.missionConfig.headingMode === 'auto' && distance > 0.4
          ? radToDeg(Math.atan2(dx, -dz))
          : this.missionStartHeading
      this.heading = this.turnToward(this.heading, desiredHeading, MISSION_YAW_RATE_DEG * delta)
      const steer = Math.min(1, delta * 2.2)
      this.velocity.x = lerp(this.velocity.x, dirX * targetSpeed, steer)
      this.velocity.z = lerp(this.velocity.z, dirZ * targetSpeed, steer)
      if (distance <= MISSION_DEPART_ARRIVE_RADIUS) {
        this.velocity.x = 0
        this.velocity.z = 0
        this.missionStage = 'depart-settle'
      }
      this.integratePosition(delta)
      return
    }

    // 收尾与对准:水平位置已锁死,只动高度 / 只转身
    this.velocity.x = 0
    this.velocity.z = 0
    if (this.missionStage === 'depart-settle') {
      this.velocity.y = clamp(altitudeError, -spec.descendSpeed, spec.climbSpeed)
      if (Math.abs(altitudeError) <= MISSION_DEPART_SETTLE_TOLERANCE) {
        this.position.y = waypoint.altitude
        this.velocity.y = 0
        this.missionStage = 'depart-align'
      }
      this.integratePosition(delta)
      return
    }

    this.velocity.y = lerp(this.velocity.y, 0, Math.min(1, delta * 4))
    const routeHeading = this.missionRouteHeading(0)
    const desiredHeading =
      this.missionConfig.headingMode === 'auto' ? routeHeading : this.missionStartHeading
    this.heading = this.turnToward(this.heading, desiredHeading, MISSION_YAW_RATE_DEG * delta)
    const headingError = Math.abs(((desiredHeading - this.heading + 540) % 360) - 180)
    if (headingError <= MISSION_DEPART_ALIGN_TOLERANCE) {
      this.position.x = waypoint.x
      this.position.z = waypoint.z
      this.position.y = waypoint.altitude
      this.velocity = { x: 0, y: 0, z: 0 }
      this.missionStage = 'goto'
      this.missionWaypointTimer = 0
      this.pushEvent('success', `机头已对准航线方向(${desiredHeading.toFixed(0)}°),开始执行航线`)
      this.arriveWaypoint()
    }
    this.integratePosition(delta)
  }

  /**
   * 暂停后按当前位置反推启航段走到了哪一步(幂等,可反复调用)。
   * 判定顺序与启航四步一致:高度不对 → 先垂直;水平没到 → 再水平;高度没干净 → 收高度;否则对准。
   */
  private resolveMissionDepartStage(): MissionStage {
    const waypoint = this.mission[0]
    if (!waypoint) return 'goto'
    const distance = Math.hypot(waypoint.x - this.position.x, waypoint.z - this.position.z)
    const altitudeError = Math.abs(waypoint.altitude - this.position.y)
    if (altitudeError > MISSION_DEPART_ALTITUDE_TOLERANCE) return 'depart-climb'
    if (distance > MISSION_ARRIVE_RADIUS) return 'depart-cruise'
    if (altitudeError > MISSION_DEPART_SETTLE_TOLERANCE) return 'depart-settle'
    return 'depart-align'
  }

  /**
   * 航线在某个航点处的「出航方向」(罗盘角)。
   * 取该航点 → 下一个航点的方位;末航点没有出航段,退回上一段的方向(末点保持入航向)。
   */
  private missionRouteHeading(index: number): number {
    const current = this.mission[index]
    if (!current) return this.heading
    const next = this.mission[index + 1]
    if (next) return this.bearingBetween(current, next)
    const previous = this.mission[index - 1]
    if (previous) return this.bearingBetween(previous, current)
    return this.bearingBetween({ x: this.home.x, z: this.home.z }, current)
  }

  private bearingBetween(from: { x: number; z: number }, to: { x: number; z: number }): number {
    const dx = to.x - from.x
    const dz = to.z - from.z
    if (Math.hypot(dx, dz) < 0.01) return this.heading
    return radToDeg(Math.atan2(dx, -dz))
  }

  /** 到点:执行航点动作(云台 / 拍照 / 悬停),然后飞下一个点 */
  private arriveWaypoint(): void {
    const waypoint = this.mission[this.missionIndex]
    if (!waypoint) return
    const label = `航点 ${this.missionIndex + 1}/${this.mission.length}`
    this.missionWaypointTimer = 0
    if (waypoint.gimbalPitch !== null) this.setGimbalPitch(waypoint.gimbalPitch)
    if (waypoint.action === 'photo') this.takePhoto()

    // 曲线过点不减速,也就没有"停下来悬停"这回事
    const canHover = this.missionConfig.pathMode !== 'curved' && waypoint.hoverSeconds > 0
    const extras: string[] = []
    if (waypoint.gimbalPitch !== null) extras.push(`云台俯仰 ${waypoint.gimbalPitch}°`)
    if (canHover) extras.push(`悬停 ${waypoint.hoverSeconds} 秒`)
    this.pushEvent('success', `到达${label}${extras.length ? ` · 执行:${extras.join(' · ')}` : ''}`)

    if (!canHover) {
      this.advanceMission()
      return
    }
    this.missionStage = 'hover'
    this.missionHoverTimer = 0
    this.position.y = waypoint.altitude
    this.velocity = { x: 0, y: 0, z: 0 }
  }

  /** 推进到下一个航点;已到末尾则按结束动作收尾或循环 */
  private advanceMission(): void {
    this.missionStage = 'goto'
    this.missionHoverTimer = 0
    this.missionWaypointTimer = 0
    const next = this.missionIndex + 1
    if (next < this.mission.length) {
      this.missionIndex = next
      return
    }
    if (this.missionConfig.loop) {
      this.missionIndex = 0
      this.missionPasses += 1
      this.pushEvent('info', `航线完成第 ${this.missionPasses} 圈,循环执行`)
      return
    }
    this.finishMission()
  }

  /** 全部航点执行完毕:按配置悬停 / 返航 / 降落 */
  private finishMission(): void {
    const count = this.mission.length
    const passes = this.missionPasses + 1
    const elapsed = this.missionElapsed
    this.missionStatus = 'idle'
    this.missionIndex = -1
    this.missionStage = 'idle'
    this.missionHoverTimer = 0
    this.missionWaypointTimer = 0
    this.missionPauseReason = ''
    this.pushEvent(
      'success',
      `航线任务完成(共 ${count} 个航点 · ${passes} 圈 · 用时 ${this.formatDuration(elapsed)})`,
    )
    switch (this.missionConfig.finishAction) {
      case 'rth':
        this.startRth('航线任务完成')
        break
      case 'land':
        this.startLanding()
        break
      default:
        this.phase = 'flying'
        this.velocity = { x: 0, y: 0, z: 0 }
        break
    }
  }

  /**
   * 航线是否处于"已下发、等待起飞到位"状态。
   * 地面点「执行航线」时 missionStatus 仍是 idle,真正的执行要等自动起飞到 1.2 米 ——
   * 这段时间里航点列表同样不许改(改了下发的还是旧航线),所以外部需要这个判据。
   */
  get missionPendingStart(): boolean {
    return this.missionPending
  }

  /** 剩余航程(米):沿剩余航点折线累计,含高度差 */
  get missionDistanceLeft(): number {
    if (this.missionStatus === 'idle' || this.missionIndex < 0) return 0
    return this.computeMissionDistanceLeft()
  }

  private computeMissionDistanceLeft(): number {
    let total = 0
    let previousX = this.position.x
    let previousY = this.position.y
    let previousZ = this.position.z
    for (let index = Math.max(0, this.missionIndex); index < this.mission.length; index += 1) {
      const waypoint = this.mission[index]
      if (!waypoint) continue
      total += Math.hypot(
        waypoint.x - previousX,
        waypoint.z - previousZ,
        waypoint.altitude - previousY,
      )
      previousX = waypoint.x
      previousY = waypoint.altitude
      previousZ = waypoint.z
    }
    return total
  }

  /** 航点完成度 0~1(按航程折算,暂停期间保持不变) */
  get missionProgress(): number {
    if (this.missionStatus === 'idle' || this.missionTotalDistance <= 0) return 0
    const done = 1 - this.computeMissionDistanceLeft() / this.missionTotalDistance
    return clamp(done, 0, 1)
  }

  /** 预计剩余时间(秒):剩余航程 / 巡航速度 + 剩余悬停时间 */
  get missionEtaSeconds(): number {
    if (this.missionStatus === 'idle' || this.missionIndex < 0) return 0
    const speed = Math.max(0.5, this.missionConfig.autoSpeed)
    let hover = 0
    for (let index = this.missionIndex; index < this.mission.length; index += 1) {
      const waypoint = this.mission[index]
      if (waypoint) hover += waypoint.hoverSeconds
    }
    return this.missionDistanceLeft / speed + hover
  }

  // ————————————————————————————— GNSS / 视觉定位 —————————————————————————————

  private updateGnss(delta: number): void {
    const electrified = this.phase !== 'powerOff'
    let target = 0
    if (electrified && !this.faults.gnssLost) {
      target = this.faults.compassError ? 12 : 18
      // 60 m 以上目标星数少 1 颗(真机高空的常见现象)
      if (this.position.y > 60) target -= 1
    }
    if (this.satellites < target) {
      this.satellites = Math.min(target, this.satellites + GNSS_ACQUIRE_RATE * delta)
    } else if (this.satellites > target) {
      this.satellites = Math.max(target, this.satellites - GNSS_ACQUIRE_RATE * 2.5 * delta)
    }

    const visionCapable =
      !this.faults.visionLost && !this.faults.imuError && this.position.y < VISION_MAX_ALTITUDE
    this.visionAvailable = visionCapable && this.phase !== 'powerOff'

    if (this.faults.rcLost) {
      this.rcLinkQuality = Math.max(0, this.rcLinkQuality - delta * 1.6)
    } else {
      // 2000 m 为信号衰减参考距离,最多扣 60% 信号质量
      const distancePenalty = clamp(this.distanceToHome / 2000, 0, 0.6)
      this.rcLinkQuality = clamp(1 - distancePenalty, 0.35, 1)
    }
  }

  /** 水平精度因子(越小越好);无星时返回 99 表示不可用 */
  get hdop(): number {
    if (this.satellites <= 0) return 99
    // 1.6 是基准值,每多一颗星改善 0.06;失锁时 +4 直接变差
    return clamp(1.6 - this.satellites * 0.06 + (this.faults.gnssLost ? 4 : 0), 0.5, 5)
  }

  get gpsBars(): number {
    if (this.satellites <= 0 || this.faults.gnssLost) return 0
    if (this.satellites >= 14) return 5
    if (this.satellites >= 11) return 4
    if (this.satellites >= 8) return 3
    if (this.satellites >= 6) return 2
    return 1
  }

  get rcBars(): number {
    return Math.round(clamp(this.rcLinkQuality, 0, 1) * 5)
  }

  get distanceToHome(): number {
    return Math.hypot(this.position.x - this.home.x, this.position.z - this.home.z)
  }

  /** 返航点(起飞点)水平坐标 */
  get homePosition(): { x: number; z: number } {
    return { ...this.home }
  }

  /** 面板调试用:直接把电量设成某个百分比 */
  forceBatteryLevel(percent: number): void {
    const clamped = clamp(percent, 0, 100)
    this.batteryUsedWh = ((100 - clamped) / 100) * DRONE_SPEC.batteryWh
  }

  // ————————————————————————————— 电池 —————————————————————————————

  private updateBattery(delta: number): void {
    if (this.phase === 'powerOff') {
      // 断电后电池自然降到环境温度 24 ℃(0.02 为很慢的时间常数)
      this.batteryTemp = lerp(this.batteryTemp, 24, Math.min(1, delta * 0.02))
      return
    }
    const watts = this.currentPowerWatts
    // 能耗换算:W·s / 3600 = Wh
    this.batteryUsedWh += (watts * delta) / 3600
    // 60 W 为发热归一化参考;升空后散热差,温升上限更高(28→50 ℃ 区间)
    const loadHeat = clamp(watts / 60, 0, 1)
    const targetTemp = this.airborne ? 28 + loadHeat * 22 : 24 + loadHeat * 6
    this.batteryTemp = lerp(this.batteryTemp, targetTemp, Math.min(1, delta * 0.02))
    if (this.airborne) this.flightTime += delta
  }

  get lowBattery(): boolean {
    return this.batteryPercent <= this.config.lowBatteryPercent
  }

  get criticalBattery(): boolean {
    return this.batteryPercent <= this.config.criticalBatteryPercent
  }

  // ————————————————————————————— 失效保护 —————————————————————————————

  private updateFailsafe(delta: number): void {
    // 遥控失联 → 按配置动作
    if (this.faults.rcLost) {
      this.rcLostTimer += delta
      if (this.rcLostTimer > RC_FAILSAFE_DELAY && this.airborne && this.phase !== 'rth') {
        if (this.config.rcFailsafe === 'rth') {
          this.startRth('遥控信号丢失')
          this.pushEvent('warn', '遥控器失联超过 3 秒,已自动执行返航')
        } else if (this.config.rcFailsafe === 'land') {
          this.startLanding()
          this.pushEvent('warn', '遥控器失联,原地降落')
        } else {
          this.pushEvent('warn', '遥控器失联,保持悬停等待信号恢复')
        }
      }
    } else {
      this.rcLostTimer = 0
    }

    // 低电量:倒计时后自动返航
    if (this.airborne && this.lowBattery && !this.criticalBattery && this.phase === 'flying') {
      if (this.lowBatteryCountdown <= 0) {
        this.lowBatteryCountdown = LOW_BATTERY_COUNTDOWN
        this.pushEvent(
          'warn',
          `电量低于 ${this.config.lowBatteryPercent}%,${LOW_BATTERY_COUNTDOWN} 秒后自动返航`,
        )
        this.warnOnce('lowBattery', '低电量:请尽快返航')
      } else {
        this.lowBatteryCountdown -= delta
        if (this.lowBatteryCountdown <= 0) {
          this.lowBatteryCountdown = 0
          if (!this.startRth('低电量返航')) {
            this.pushEvent('error', '无法触发返航')
          }
        }
      }
    } else if (!this.lowBattery) {
      this.lowBatteryCountdown = 0
    }

    // 严重低电量:强制原地降落
    if (
      this.airborne &&
      this.criticalBattery &&
      this.phase !== 'landing' &&
      this.phase !== 'emergency'
    ) {
      this.warnOnce('criticalBattery', '严重低电量:强制降落')
      this.startLanding()
      this.pushEvent('error', '严重低电量,已强制降落')
    }

    if (this.batteryPercent <= 0 && this.airborne) {
      this.phase = 'emergency'
      this.pushEvent('error', '电池耗尽,动力失效')
    }
  }

  // ————————————————————————————— 避障 —————————————————————————————

  private applyObstacleBrake(): void {
    this.obstacleReport = {
      forward: null,
      backward: null,
      left: null,
      right: null,
      up: null,
      down: null,
      braking: false,
      brakingDirection: null,
    }
    // 下视距离:默认就是离地高度(地面本身也算"下方障碍")
    this.obstacleReport.down = this.position.y
    const enabled = !this.faults.obstacleAvoidanceOff
    if (!enabled || this.obstacles.length === 0) return

    // 1.6 m:把飞行器当成半径 1.6 m 的球,盒子按此半径膨胀后再做射线检测
    const probeRadius = 1.6
    const origin = this.position
    const nose = headingVector(this.heading)
    const right = { x: -nose.z, z: nose.x }
    const directions: Array<{ key: keyof ObstacleReport; x: number; y: number; z: number }> = [
      { key: 'forward', x: nose.x, y: 0, z: nose.z },
      { key: 'backward', x: -nose.x, y: 0, z: -nose.z },
      { key: 'right', x: right.x, y: 0, z: right.z },
      { key: 'left', x: -right.x, y: 0, z: -right.z },
      { key: 'up', x: 0, y: 1, z: 0 },
      { key: 'down', x: 0, y: -1, z: 0 },
    ]

    for (const direction of directions) {
      let nearest: number | null = null
      for (const box of this.obstacles) {
        const distance = rayBoxDistance(origin, direction, box, probeRadius)
        if (distance === null) continue
        if (nearest === null || distance < nearest) nearest = distance
      }
      ;(this.obstacleReport[direction.key] as number | null) = nearest
    }

    // 迎面障碍在刹停距离内 → 直接刹停
    const horizontal: Array<'forward' | 'backward' | 'left' | 'right'> = [
      'forward',
      'backward',
      'left',
      'right',
    ]
    for (const key of horizontal) {
      const distance = this.obstacleReport[key]
      if (distance === null) continue
      const axis = directions.find((item) => item.key === key)
      if (!axis) continue
      const closing = this.velocity.x * axis.x + this.velocity.z * axis.z
      // 只有正在朝障碍物接近(closing > 0.15 m/s)才需要避障
      if (closing <= 0.15) continue
      // 同航线:刹停距离 = v²/(2a) + 余量
      const brakingDistance = (closing * closing) / (2 * this.modeSpec.brakeAccel) + 0.6
      if (distance <= brakingDistance) {
        this.velocity.x -= axis.x * closing
        this.velocity.z -= axis.z * closing
        this.obstacleReport.braking = true
        this.obstacleReport.brakingDirection = key
        this.warnOnce('obstacle', '避障刹停:前方障碍物过近')
      }
    }
  }

  // ————————————————————————————— 云台 / 相机 —————————————————————————————

  /** 手动云台俯仰增量(度),正 = 抬头 */
  nudgeGimbal(deltaPitch: number, deltaYaw = 0): void {
    this.gimbalPitch = clamp(
      this.gimbalPitch + deltaPitch,
      DRONE_SPEC.gimbalPitchMin,
      DRONE_SPEC.gimbalPitchMax,
    )
    this.gimbalYaw = clamp(
      this.gimbalYaw + deltaYaw,
      -DRONE_SPEC.gimbalYawRange,
      DRONE_SPEC.gimbalYawRange,
    )
  }

  /** 设置云台俯仰角(度,正 = 抬头),自动夹到机型行程内 */
  setGimbalPitch(pitch: number): void {
    this.gimbalPitch = clamp(pitch, DRONE_SPEC.gimbalPitchMin, DRONE_SPEC.gimbalPitchMax)
  }

  private updateCamera(delta: number): void {
    // 云台横滚由 updateTilt 增稳,偏航缓慢回中
    this.gimbalYaw = lerp(this.gimbalYaw, 0, Math.min(1, delta * 1.2))
  }

  toggleRecording(): void {
    this.setRecordingState(!this.recording)
  }

  /**
   * 录像状态的唯一写入口(UI/引擎都走这里):
   * 只负责状态、计时与事件日志;真正的录制(MediaRecorder)在 drone-fly 层,
   * 由它按本状态启动/收尾,避免两处状态打架。
   */
  setRecordingState(active: boolean): void {
    if (active === this.recording) return
    if (active) {
      this.recording = true
      this.recordSeconds = 0
      this.pushEvent('info', '开始录像')
    } else {
      this.recording = false
      this.pushEvent('info', `录像结束,时长 ${this.formatDuration(this.recordSeconds)}`)
    }
  }

  stopRecording(): void {
    this.setRecordingState(false)
  }

  /** 拍照:计数 +1 并记一条事件(实际成像由引擎层负责) */
  takePhoto(): void {
    this.photoCount += 1
    this.pushEvent('info', `拍照(第 ${this.photoCount} 张)`)
  }

  /** 设置变焦倍数,夹在 1~4 倍之间 */
  setZoom(zoom: number): void {
    this.cameraZoom = clamp(zoom, 1, 4)
  }

  // ————————————————————————————— 起飞前检查 —————————————————————————————

  /** 起飞前检查项列表(外部注入项 + 内置项),每次读取即时构造 */
  get checklist(): ChecklistItem[] {
    const items: ChecklistItem[] = []
    for (const external of this.externalChecks) items.push(external)
    items.push({
      id: 'imu',
      label: 'IMU 惯性测量单元',
      ok: !this.faults.imuError,
      detail: this.faults.imuError ? 'IMU 异常,禁止起飞' : '正常',
      blocking: true,
    })
    items.push({
      id: 'compass',
      label: '指南针',
      ok: !this.faults.compassError,
      detail: this.faults.compassError ? '受磁干扰,请重新校准' : '正常',
      blocking: true,
    })
    const positioning = this.satellites >= 6
    items.push({
      id: 'gnss',
      label: '定位系统',
      ok: positioning || this.visionAvailable,
      detail: positioning
        ? `GNSS ${Math.round(this.satellites)} 星 · HDOP ${this.hdop.toFixed(1)}`
        : this.visionAvailable
          ? '仅视觉定位(建议等待搜星完成)'
          : '无 GNSS 无视觉定位',
      blocking: !positioning && !this.visionAvailable,
    })
    items.push({
      id: 'home',
      label: '返航点',
      ok: this.homeRecorded,
      detail: this.homeRecorded ? '已记录' : '等待记录',
      blocking: true,
    })
    items.push({
      id: 'battery',
      label: '电池电量',
      ok: this.batteryPercent > this.config.criticalBatteryPercent + 3,
      detail: `${this.batteryPercent.toFixed(0)}% · ${this.batteryVoltage.toFixed(1)} V · ${this.batteryTemp.toFixed(0)} ℃`,
      blocking: this.batteryPercent <= this.config.criticalBatteryPercent,
    })
    items.push({
      id: 'wind',
      label: '风速',
      ok: this.config.windSpeed <= DRONE_SPEC.maxWindResistance,
      detail: `${this.config.windSpeed.toFixed(1)} m/s(抗风上限 ${DRONE_SPEC.maxWindResistance} m/s)`,
      blocking: false,
    })
    const airborneReady = this.phase === 'standby' || this.phase === 'motorsOn'
    items.push({
      id: 'phase',
      label: '飞行器状态',
      ok: airborneReady,
      detail: PHASE_LABELS[this.phase],
      blocking: !airborneReady,
    })
    return items
  }

  /** 是否满足起飞条件:阶段为待机/电机已启动,且所有阻塞项都通过 */
  get canTakeOff(): boolean {
    return (
      (this.phase === 'standby' || this.phase === 'motorsOn') &&
      this.checklist.every((item) => !item.blocking || item.ok)
    )
  }

  // ————————————————————————————— 警告 / 事件 —————————————————————————————

  /** 当前生效的警告文案列表(界面红条用) */
  get warnings(): string[] {
    const list: string[] = []
    if (this.faults.imuError) list.push('IMU 异常')
    if (this.faults.compassError) list.push('指南针受扰')
    if (this.faults.gnssLost) list.push('GNSS 失锁')
    if (this.faults.rcLost) list.push('遥控信号丢失')
    if (this.faults.visionLost) list.push('下视视觉失效')
    if (this.faults.motorFailure) list.push('电机异常')
    if (this.faults.obstacleAvoidanceOff) list.push('避障已关闭')
    if (this.positionSource === 'atti') list.push('姿态模式 · 无定位')
    else if (this.positionSource === 'vision') list.push('视觉定位')
    if (this.config.windSpeed > DRONE_SPEC.maxWindResistance) list.push('风速超过抗风上限')
    if (this.altitudeLimitReached) list.push('已达限高')
    if (this.distanceLimitReached) list.push('已达限距')
    if (this.obstacleReport.braking) list.push('避障刹停')
    if (this.lowBattery && !this.criticalBattery) list.push('低电量')
    if (this.criticalBattery) list.push('严重低电量')
    return list
  }

  private warnOnce(key: string, text: string): void {
    const last = this.warnedAt.get(key) ?? -Infinity
    // 同一 key 的警告 6 s 内只记一次,防止每帧刷屏
    if (this.time - last < 6) return
    this.warnedAt.set(key, this.time)
    this.pushEventInternal('warn', text)
  }

  private damageCheck(): void {
    if (this.config.windSpeed > DRONE_SPEC.maxWindResistance) {
      this.pushEvent('warn', '风速超过最大抗风能力,谨慎飞行')
    }
  }

  pushEvent(level: EventLevel, text: string): void {
    this.pushEventInternal(level, text)
  }

  private pushEventInternal(level: EventLevel, text: string): void {
    this.eventId += 1
    // unshift:最新事件在数组头部 events[0];超出上限则从尾部丢最旧的
    this.events.unshift({ id: this.eventId, time: this.time, level, text })
    if (this.events.length > 200) this.events.pop()
  }

  private formatDuration(seconds: number): string {
    const total = Math.max(0, Math.round(seconds))
    const minutes = Math.floor(total / 60)
    const rest = total % 60
    return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`
  }

  private windVector(): { x: number; z: number } {
    const speed = this.config.windSpeed
    if (speed <= 0) return { x: 0, z: 0 }
    const dir = headingVector(this.config.windDirection)
    return { x: dir.x * speed, z: dir.z * speed }
  }

  /** 风向相对机头的描述,例如"正逆风" */
  get windRelative(): string {
    if (this.config.windSpeed < 0.3) return '静风'
    // windDirection 记录的是"风吹向"的方位;+180° 换成风的来向再与机头比
    const fromDrone = this.config.windDirection + 180
    const diff = ((fromDrone - this.heading + 540) % 360) - 180
    const abs = Math.abs(diff)
    const side = diff >= 0 ? '右' : '左'
    if (abs < 20) return '正逆风'
    if (abs > 160) return '正顺风'
    if (abs <= 60) return `逆风偏${side} ${Math.round(abs)}°`
    if (abs >= 120) return `顺风偏${side} ${Math.round(180 - abs)}°`
    return `侧风偏${side} ${Math.round(abs)}°`
  }

  // ————————————————————————————— 快照 —————————————————————————————

  /** 生成完整遥测快照(数组字段已复制,见 DroneSnapshot) */
  snapshot(): DroneSnapshot {
    return {
      phase: this.phase,
      phaseLabel: this.phaseLabel,
      mode: this.mode,
      modeLabel: this.modeSpec.label,
      positionSource: this.positionSource,
      positionSourceLabel: POSITION_SOURCE_LABELS[this.positionSource],
      airborne: this.airborne,
      motorsOn: this.motorLoad > 0.02,
      damaged: this.damaged,
      batteryPercent: this.batteryPercent,
      batteryVoltage: this.batteryVoltage,
      batteryCurrent: this.batteryCurrent,
      batteryTemp: this.batteryTemp,
      batteryWhLeft: (this.batteryPercent / 100) * DRONE_SPEC.batteryWh,
      batteryModeText: this.criticalBattery ? '严重低电量' : this.lowBattery ? '低电量' : '正常',
      altitude: this.position.y,
      altitudeMax: this.altitudeMax,
      positionX: this.position.x,
      positionZ: this.position.z,
      horizontalSpeed: Math.hypot(this.velocity.x, this.velocity.z),
      verticalSpeed: this.velocity.y,
      heading: this.heading,
      tiltPitch: this.tiltPitch,
      tiltRoll: this.tiltRoll,
      distanceToHome: this.distanceToHome,
      homeRecorded: this.homeRecorded,
      altitudeLimitReached: this.altitudeLimitReached,
      distanceLimitReached: this.distanceLimitReached,
      satellites: this.satellites,
      hdop: this.hdop,
      gpsBars: this.gpsBars,
      rcBars: this.rcBars,
      visionAvailable: this.visionAvailable,
      gimbalPitch: this.gimbalPitch,
      gimbalRoll: this.gimbalRoll,
      gimbalYaw: this.gimbalYaw,
      motorLoad: this.motorLoad,
      armFold: this.armFold,
      stick: { ...this.stick },
      windSpeed: this.config.windSpeed,
      windDirection: this.config.windDirection,
      windRelative: this.windRelative,
      flightTime: this.flightTime,
      totalTime: this.time,
      remainingMinutes: this.remainingMinutes,
      lowBattery: this.lowBattery,
      criticalBattery: this.criticalBattery,
      lowBatteryCountdown: this.lowBatteryCountdown,
      rthStage: this.phase === 'rth' ? this.rthStage : '',
      landingStage: this.phase === 'landing' ? this.landingStage : '',
      rthReason: this.rthReason,
      warnings: this.warnings,
      // 快照只带最近 12 条,避免每帧复制整段日志
      events: this.events.slice(0, 12),
      checklist: this.checklist,
      obstacle: { ...this.obstacleReport },
      recording: this.recording,
      recordSeconds: this.recordSeconds,
      photoCount: this.photoCount,
      cameraZoom: this.cameraZoom,
      mission: {
        status: this.missionStatus,
        statusLabel: MISSION_STATUS_LABELS[this.missionStatus],
        stage: this.missionStage,
        stageLabel: MISSION_STAGE_LABELS[this.missionStage],
        index: this.missionIndex,
        total: this.mission.length,
        passes: this.missionPasses,
        elapsed: this.missionElapsed,
        distanceLeft: this.missionDistanceLeft,
        progress: this.missionProgress,
        etaSeconds: this.missionEtaSeconds,
        pauseReason: this.missionPauseReason,
        active: this.mission[this.missionIndex]
          ? { ...(this.mission[this.missionIndex] as MissionWaypoint) }
          : null,
        waypoints: this.mission.map((waypoint) => ({ ...waypoint })),
        config: { ...this.missionConfig },
      },
    }
  }

  /** 仿真累计时长(秒):含地面上电时间,与飞行时长 flightTime 不同 */
  get elapsed(): number {
    return this.time
  }
}

/** 从 origin 沿 direction 到 AABB 表面的距离(null = 射线不与盒体相交) */
function rayBoxDistance(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  box: ObstacleBox,
  radius: number,
): number | null {
  const minX = box.minX - radius
  const maxX = box.maxX + radius
  const minY = box.minY - radius
  const maxY = box.maxY + radius
  const minZ = box.minZ - radius
  const maxZ = box.maxZ + radius

  // 标准 slab 法:逐轴求射线进入/离开盒体的参数 t,取各轴交集
  let tMin = 0
  let tMax = Number.POSITIVE_INFINITY
  const axes: Array<[number, number, number, number]> = [
    [origin.x, direction.x, minX, maxX],
    [origin.y, direction.y, minY, maxY],
    [origin.z, direction.z, minZ, maxZ],
  ]
  for (const [start, dir, low, high] of axes) {
    if (Math.abs(dir) < 1e-6) {
      if (start < low || start > high) return null
      continue
    }
    let t1 = (low - start) / dir
    let t2 = (high - start) / dir
    if (t1 > t2) [t1, t2] = [t2, t1]
    tMin = Math.max(tMin, t1)
    tMax = Math.min(tMax, t2)
    if (tMin > tMax) return null
  }
  // 起点在盒内时视为 0
  return tMin >= 0 ? tMin : null
}
