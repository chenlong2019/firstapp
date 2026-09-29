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

export type FlightMode = 'cine' | 'normal' | 'sport'

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

export const FLIGHT_MODE_LIST: Array<{ key: FlightMode; label: string }> = (
  Object.keys(FLIGHT_MODES) as FlightMode[]
).map((key) => ({ key, label: FLIGHT_MODES[key].label }))

export type FlightPhase =
  | 'powerOff'
  | 'selfCheck'
  | 'warmingUp'
  | 'standby'
  | 'motorsOn'
  | 'takingOff'
  | 'flying'
  | 'rth'
  | 'landing'
  | 'emergency'
  | 'stopped'

export const PHASE_LABELS: Record<FlightPhase, string> = {
  powerOff: '未上电',
  selfCheck: '开机自检',
  warmingUp: '传感器预热',
  standby: '地面待机',
  motorsOn: '电机已启动',
  takingOff: '自动起飞',
  flying: '飞行中',
  rth: '智能返航',
  landing: '自动降落',
  emergency: '动力丧失 · 坠落',
  stopped: '已停桨',
}

export type PositionSource = 'gps' | 'vision' | 'atti'

export const POSITION_SOURCE_LABELS: Record<PositionSource, string> = {
  gps: 'GNSS 卫星定位',
  vision: '视觉定位',
  atti: '姿态模式(无定位)',
}

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

export const NO_FAULTS: FaultFlags = {
  gnssLost: false,
  compassError: false,
  imuError: false,
  motorFailure: false,
  rcLost: false,
  visionLost: false,
  obstacleAvoidanceOff: false,
}

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

export type EventLevel = 'info' | 'warn' | 'error' | 'success'

export interface SimEvent {
  id: number
  time: number
  level: EventLevel
  text: string
}

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

export interface ChecklistItem {
  id: string
  label: string
  ok: boolean
  detail: string
  /** 不通过是否阻止起飞 */
  blocking: boolean
}

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
  rthReason: string
  warnings: string[]
  events: SimEvent[]
  checklist: ChecklistItem[]
  obstacle: ObstacleReport
  recording: boolean
  recordSeconds: number
  photoCount: number
  cameraZoom: number
}

const GRAVITY = 9.81
const SELF_CHECK_SECONDS = 2.6
const WARMUP_SECONDS = 2.4
const RC_FAILSAFE_DELAY = 3
const LOW_BATTERY_COUNTDOWN = 10
const GNSS_ACQUIRE_RATE = 1.6
const VISION_MAX_ALTITUDE = 12

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const lerp = (from: number, to: number, t: number): number => from + (to - from) * t
const degToRad = (deg: number): number => (deg * Math.PI) / 180
const radToDeg = (rad: number): number => (rad * 180) / Math.PI

/** 航向角(罗盘 0=北 90=东)对应的机头方向单位向量 */
function headingVector(headingDeg: number): { x: number; z: number } {
  const rad = degToRad(headingDeg)
  return { x: Math.sin(rad), z: -Math.cos(rad) }
}

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

  // ————————————————————————————— 状态查询 —————————————————————————————

  get airborne(): boolean {
    return this.position.y > 0.05 && this.phase !== 'powerOff'
  }

  get motorsOn(): boolean {
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
      (DRONE_SPEC.batteryFullVoltage - DRONE_SPEC.batteryEmptyVoltage) * Math.pow(stateOfCharge, 0.55)
    )
  }

  /** 放电电流:按当前功率 / 近似电压估算 */
  get batteryCurrent(): number {
    return this.currentPowerWatts / Math.max(6.4, this.openCircuitVoltage)
  }

  /** 端电压 = 开路电压 − 内阻压降 */
  get batteryVoltage(): number {
    return Math.max(6, this.openCircuitVoltage - this.batteryCurrent * DRONE_SPEC.batteryInternalResistance)
  }

  get positionSource(): PositionSource {
    if (this.faults.gnssLost) {
      return this.visionAvailable ? 'vision' : 'atti'
    }
    if (this.satellites >= 6 && !this.faults.compassError) return 'gps'
    if (this.visionAvailable) return 'vision'
    return 'atti'
  }

  get currentPowerWatts(): number {
    if (this.phase === 'powerOff') return 0
    const airSpeed = Math.hypot(this.velocity.x, this.velocity.z)
    const speedRatio = clamp(airSpeed / 16, 0, 1.2)
    const spinning = this.motorLoad > 0.02
    let watts =
      DRONE_SPEC.idlePowerWatts +
      DRONE_SPEC.hoverPowerWatts *
        (spinning ? 1 : 0.05) *
        (1 + DRONE_SPEC.levelSpeedPowerGain * speedRatio * speedRatio)
    watts += Math.max(0, this.velocity.y) * DRONE_SPEC.climbWattsPerMps
    if (spinning) watts = Math.max(watts, 12)
    // 逆风要保持位置需要更大的空气速度,额外耗电
    const windFactor = 1 + clamp(this.config.windSpeed / 30, 0, 1) * 0.35
    return watts * windFactor
  }

  /** 剩余可飞时间(分钟) */
  get remainingMinutes(): number {
    const watts = Math.max(this.currentPowerWatts, 12)
    return ((this.batteryPercent / 100) * DRONE_SPEC.batteryWh * 60) / watts
  }

  // ————————————————————————————— 操作指令 —————————————————————————————

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
    this.satellites = this.faults.gnssLost ? 0 : 1
    this.flightTime = 0
    this.altitudeMax = 0
    this.damaged = false
    this.pushEvent('info', '飞行器上电,开始系统自检')
  }

  powerOff(): void {
    if (this.airborne || this.phase === 'powerOff') return
    this.phase = 'powerOff'
    this.motorLoad = 0
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

  startLanding(): boolean {
    if (!this.airborne && this.phase !== 'takingOff') return false
    if (this.phase === 'landing' || this.phase === 'emergency') return false
    this.phase = 'landing'
    this.phaseTime = 0
    this.pushEvent('info', '开始自动降落')
    return true
  }

  startRth(reason: string): boolean {
    if (!this.airborne) return false
    if (this.phase === 'rth') return false
    this.phase = 'rth'
    this.phaseTime = 0
    this.rthStage = this.position.y < this.config.rthAltitude - 0.5 ? 'ascend' : 'cruise'
    this.rthReason = reason
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
    this.pushEvent('info', '沙盒已重置')
  }

  // ————————————————————————————— 每帧推进 —————————————————————————————

  step(dtSeconds: number): void {
    const delta = clamp(dtSeconds, 0, 0.1)
    if (delta <= 0) return
    this.time += delta
    this.phaseTime += delta

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
        this.position.y = Math.min(DRONE_SPEC.takeoffAltitude, this.position.y + 1.5 * delta)
        this.velocity.y = 1.5
        this.settleHorizontal(delta)
        if (this.position.y >= DRONE_SPEC.takeoffAltitude - 0.01) {
          this.position.y = DRONE_SPEC.takeoffAltitude
          this.phase = 'flying'
          this.velocity.y = 0
          this.pushEvent('success', '已到达 1.2 米,进入悬停')
        }
        break
      }
      case 'landing':
        this.descendToGround(delta, this.landingDescentRate())
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

  private landingDescentRate(): number {
    return this.position.y <= DRONE_SPEC.landingSlowAltitude ? 0.6 : this.modeSpec.descendSpeed
  }

  /** 返航与降落的下降段:接触地面后停桨 */
  private descendToGround(delta: number, rate: number): void {
    this.motorLoad = lerp(this.motorLoad, 0.55, Math.min(1, delta * 3))
    this.velocity.y = -rate
    this.position.y -= rate * delta
    this.settleHorizontal(delta)
    if (this.position.y <= 0.02) {
      this.position.y = 0
      this.velocity.y = 0
      this.landingTimer += delta
      if (this.landingTimer >= 1.2) {
        this.finishLanding()
      }
    } else {
      this.landingTimer = 0
    }
  }

  private finishLanding(): void {
    this.phase = 'standby'
    this.landingTimer = 0
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
    this.velocity.x *= 1 - Math.min(1, delta * 0.4)
    this.velocity.z *= 1 - Math.min(1, delta * 0.4)
    this.position.x += this.velocity.x * delta
    this.position.y += this.velocity.y * delta
    this.position.z += this.velocity.z * delta
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
    if (this.phase === 'flying' || this.phase === 'rth') {
      this.updateGnssPositionFlight(delta)
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
      const rate = verticalInput > 0 ? verticalInput * spec.climbSpeed : verticalInput * spec.descendSpeed
      this.velocity.y += clamp(rate - this.velocity.y, -3 * delta, 3 * delta)
    } else {
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
    const smoothing = this.phase === 'standby' ? 8 : 3.2
    this.tiltPitch = lerp(this.tiltPitch, pitch, Math.min(1, delta * smoothing))
    this.tiltRoll = lerp(this.tiltRoll, roll, Math.min(1, delta * smoothing))
  }

  private updateMotorLoad(delta: number): void {
    if (this.phase === 'emergency' || this.phase === 'powerOff') {
      this.motorLoad = lerp(this.motorLoad, 0, Math.min(1, delta * 8))
      return
    }
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
        const cruiseSpeed = Math.min(spec.horizontalSpeed, Math.max(2, distance * 0.5))
        const dirX = dx / distance
        const dirZ = dz / distance
        this.velocity.x = lerp(this.velocity.x, dirX * cruiseSpeed, Math.min(1, delta * 1.6))
        this.velocity.z = lerp(this.velocity.z, dirZ * cruiseSpeed, Math.min(1, delta * 1.6))
        // 返航时机头对准航向
        this.heading = this.turnToward(this.heading, radToDeg(Math.atan2(dirX, -dirZ)), 45 * delta)
        this.velocity.y = lerp(this.velocity.y, 0, Math.min(1, delta * 2))
      }
    } else if (this.rthStage === 'descend') {
      this.velocity.x = lerp(this.velocity.x, 0, Math.min(1, delta * 3))
      this.velocity.z = lerp(this.velocity.z, 0, Math.min(1, delta * 3))
      this.velocity.y = -spec.descendSpeed
      this.integratePosition(delta)
      if (this.position.y <= 0.02) {
        this.rthStage = 'landing'
        this.phase = 'landing'
        this.landingTimer = 0
        this.position.y = 0
        this.velocity.y = 0
      }
      return
    } else {
      this.phase = 'landing'
      return
    }
    this.integratePosition(delta)
  }

  private turnToward(current: number, target: number, maxDelta: number): number {
    let difference = ((target - current + 540) % 360) - 180
    difference = clamp(difference, -maxDelta, maxDelta)
    return (current + difference + 360) % 360
  }

  // ————————————————————————————— GNSS / 视觉定位 —————————————————————————————

  private updateGnss(delta: number): void {
    const electrified = this.phase !== 'powerOff'
    let target = 0
    if (electrified && !this.faults.gnssLost) {
      target = this.faults.compassError ? 12 : 18
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
      const distancePenalty = clamp(this.distanceToHome / 2000, 0, 0.6)
      this.rcLinkQuality = clamp(1 - distancePenalty, 0.35, 1)
    }
  }

  get hdop(): number {
    if (this.satellites <= 0) return 99
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
      this.batteryTemp = lerp(this.batteryTemp, 24, Math.min(1, delta * 0.02))
      return
    }
    const watts = this.currentPowerWatts
    this.batteryUsedWh += (watts * delta) / 3600
    const loadHeat = clamp(watts / 60, 0, 1)
    const targetTemp = this.airborne ? 28 + loadHeat * 22 : 24 + loadHeat * 6
    this.batteryTemp = lerp(this.batteryTemp, targetTemp, Math.min(1, delta * 0.02))
    if (this.airborne) this.flightTime += delta
    if (this.recording) this.recordSeconds += delta
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
        this.pushEvent('warn', `电量低于 ${this.config.lowBatteryPercent}%,${LOW_BATTERY_COUNTDOWN} 秒后自动返航`)
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
      if (closing <= 0.15) continue
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

  setGimbalPitch(pitch: number): void {
    this.gimbalPitch = clamp(pitch, DRONE_SPEC.gimbalPitchMin, DRONE_SPEC.gimbalPitchMax)
  }

  private updateCamera(delta: number): void {
    // 云台横滚由 updateTilt 增稳,偏航缓慢回中
    this.gimbalYaw = lerp(this.gimbalYaw, 0, Math.min(1, delta * 1.2))
  }

  toggleRecording(): void {
    if (this.recording) {
      this.stopRecording()
    } else {
      this.recording = true
      this.recordSeconds = 0
      this.pushEvent('info', '开始录像')
    }
  }

  stopRecording(): void {
    if (!this.recording) return
    this.recording = false
    this.pushEvent('info', `录像结束,时长 ${this.formatDuration(this.recordSeconds)}`)
  }

  takePhoto(): void {
    this.photoCount += 1
    this.pushEvent('info', `拍照(第 ${this.photoCount} 张)`)
  }

  setZoom(zoom: number): void {
    this.cameraZoom = clamp(zoom, 1, 4)
  }

  // ————————————————————————————— 起飞前检查 —————————————————————————————

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

  get canTakeOff(): boolean {
    return (
      (this.phase === 'standby' || this.phase === 'motorsOn') &&
      this.checklist.every((item) => !item.blocking || item.ok)
    )
  }

  // ————————————————————————————— 警告 / 事件 —————————————————————————————

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

  snapshot(): DroneSnapshot {
    return {
      phase: this.phase,
      phaseLabel: PHASE_LABELS[this.phase],
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
      rthReason: this.rthReason,
      warnings: this.warnings,
      events: this.events.slice(0, 12),
      checklist: this.checklist,
      obstacle: { ...this.obstacleReport },
      recording: this.recording,
      recordSeconds: this.recordSeconds,
      photoCount: this.photoCount,
      cameraZoom: this.cameraZoom,
    }
  }

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
