import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { WebGPURenderer } from 'three/webgpu'
import { DroneLights } from './drone-lights'
import type { AuxLightMode, BatteryLightMode, StatusLightKey } from './drone-lights'
import { DroneRig, type RigPartReport } from './drone-rig'
import { DroneRadar, type RadarAim, type RadarSnapshot } from './drone-radar'
import { DroneWorld } from './drone-world'
import {
  DroneSim,
  FLIGHT_MODES,
  NEUTRAL_STICK,
  type DroneSnapshot,
  type FaultFlags,
  type FlightMode,
  type SimConfig,
  type StickState,
} from './drone-sim'

const DRONE_MODEL_URL = '/models/djiair_renamed.glb'
const DRONE_SIZE_METERS = 2.4
/** 机型最快档位速度,用于界面提示 */
export const DRONE_MAX_SPEED_METERS_PER_SECOND = FLIGHT_MODES.sport.horizontalSpeed

/** 旧版方向键 API(仅保留给外部复用) */
export type DroneDirection = 'up' | 'down' | 'left' | 'right'
export type DroneVerticalDirection = 'up' | 'down'
export type DroneRotationDirection = 'left' | 'right'

export type { DroneSnapshot, FaultFlags, FlightMode, SimConfig, StickState } from './drone-sim'

export type CameraMode = 'orbit' | 'follow' | 'fpv'

export const CAMERA_MODE_LIST: Array<{ key: CameraMode; label: string }> = [
  { key: 'orbit', label: '观察者' },
  { key: 'follow', label: '跟随' },
  { key: 'fpv', label: '机载' },
]

const FIXED_STEP = 1 / 60
const MAX_STEPS_PER_FRAME = 240
const FOLLOW_DISTANCE = 7.5
const FOLLOW_HEIGHT = 2.8

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 飞行沙盒的装配层:把飞行仿真内核、模型机械、场景辅助与灯光接到一起。
 *
 * 每帧固定步长推进仿真(与渲染帧率解耦,时间倍速下也能保持稳定),
 * 然后只做"把仿真状态映射到三维场景"这一件事,保证画面与遥测显示的永远是同一份状态。
 */
export class DroneFly {
  camera: THREE.PerspectiveCamera | null
  scene: THREE.Scene<THREE.Object3DEventMap> | null
  renderer: WebGPURenderer | null
  controls: OrbitControls<THREE.Camera> | null
  model: THREE.Group | null = null
  lights: DroneLights | null = null
  rig: DroneRig | null = null
  world: DroneWorld | null = null
  radar: DroneRadar | null = null
  /** 雷达射线可视化开关(雷达实例可能晚于页面初始化创建,先缓存再补上);默认不显示 */
  private radarBeamsVisible = false
  /** 辅助灯锥形光束开关;默认不显示 */
  private auxBeamVisible = false
  readonly sim = new DroneSim()
  cameraMode: CameraMode = 'orbit'

  private readonly loader = new GLTFLoader()
  private groundOffsetY = 0
  private accumulator = 0
  private destroyed = false
  private cameraTarget = new THREE.Vector3(0, 0, 0)
  private readonly cameraScratch = new THREE.Object3D()
  private readonly dronePosition = new THREE.Vector3()
  private readonly cameraShift = new THREE.Vector3()
  private readonly followPosition = new THREE.Vector3()
  private readonly followLookAt = new THREE.Vector3()
  private readonly forwardVector = new THREE.Vector3()
  private lightOverride: StatusLightKey | null = null
  /** 机臂目标折叠度:1 = 收纳(出厂收纳状态,起飞前必须先展开) */
  private armFoldTarget = 1

  constructor(
    scene: THREE.Scene<THREE.Object3DEventMap> | null,
    camera: THREE.PerspectiveCamera | null,
    renderer: WebGPURenderer | null,
    controls: OrbitControls<THREE.Camera> | null,
  ) {
    this.scene = scene
    this.camera = camera
    this.renderer = renderer
    this.controls = controls
  }

  async initialize(): Promise<void> {
    if (!this.scene || this.destroyed) return

    const gltf = await this.loader.loadAsync(DRONE_MODEL_URL)
    if (this.destroyed) {
      this.disposeModel(gltf.scene)
      return
    }
    const model = gltf.scene
    model.name = 'DJI Mini 4 Pro'
    this.normalizeModel(model)
    this.groundOffsetY = model.position.y
    model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
    })
    this.scene.add(model)
    this.model = model

    // 机械件与灯光
    this.rig = new DroneRig(model)
    this.lights = new DroneLights()
    this.lights.attach(model, this.scene)
    this.lights.setBeamVisible(this.auxBeamVisible)

    // 场景辅助(地面网格 / 返航点 / 障碍物 / 航迹)
    this.world = new DroneWorld(this.scene)
    this.sim.obstacles = this.world.collisionBoxes

    // 前视测距雷达(起点/方向取自模型的前向视觉玻璃节点,上电后工作)
    if (this.scene) {
      this.radar = new DroneRadar(this.scene)
      this.radar.bindSensors(model)
      this.radar.setVisible(this.radarBeamsVisible)
    }

    // 起飞前检查里的"模型侧"项目:模型自检只做提示,不拦起飞(缺几个装饰件不影响飞控)
    const allPartsFound = this.rig.parts.every((part) => part.found)
    this.sim.externalChecks = [
      {
        id: 'model',
        label: '模型部件自检',
        ok: allPartsFound,
        detail: this.modelHealthText(),
        blocking: false,
      },
      {
        id: 'arms',
        label: '机臂已展开',
        ok: this.rig.armFold < 0.02,
        detail: this.rig.armFold < 0.02 ? '已展开' : '机臂处于收纳状态',
        blocking: true,
      },
    ]
    this.syncPose(0)
  }

  private modelHealthText(): string {
    const missing = this.rig?.parts.filter((part) => !part.found) ?? []
    if (missing.length === 0) return `ID 表部件全部就位(${this.rig?.parts.length ?? 0} 项)`
    return `缺失 ${missing.length} 项:${missing.map((item) => item.id).join('、')}`
  }

  /** 每帧推进:渲染帧率下用固定步长跑仿真,再用同一份状态驱动画面 */
  /**
   * 每帧推进:固定步长跑仿真,与渲染帧率解耦。
   * 低帧率机器(或无头环境)不会让仿真变慢 —— 用累加器补帧;挂起后的超长帧直接丢弃积压。
   */
  animate(deltaSeconds?: number): void {
    const delta = Math.max(0, Math.min(deltaSeconds ?? 1 / 60, 2))
    const timeScale = clamp(this.sim.config.timeScale, 1, 20)
    const scaled = delta * timeScale
    this.accumulator = Math.min(this.accumulator + scaled, MAX_STEPS_PER_FRAME * FIXED_STEP)
    let steps = 0
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.sim.step(FIXED_STEP)
      this.accumulator -= FIXED_STEP
      steps += 1
    }

    this.syncPose(delta)
    this.updateCamera(delta)
    this.pushTrail()
  }

  /** 把仿真状态写进三维场景 */
  private syncPose(delta: number): void {
    const sim = this.sim
    const x = sim.position.x
    const y = this.groundOffsetY + sim.position.y
    const z = sim.position.z
    this.rig?.applyBodyPose({
      x,
      y,
      z,
      headingDeg: sim.heading,
      pitchDeg: sim.tiltPitch,
      rollDeg: sim.tiltRoll,
    })
    this.rig?.setGimbalAttitude(
      sim.gimbalPitch,
      sim.gimbalRoll,
      sim.gimbalYaw,
      sim.tiltPitch,
      sim.tiltRoll,
    )
    // 目视转速用真实帧时间,不跟时间倍速走,否则高倍速下桨叶会糊成一片
    this.rig?.updateProps(sim.motorLoad, delta)
    if (this.rig) {
      const fold = this.rig.armFold
      this.rig.setArmFold(fold + (this.armFoldTarget - fold) * Math.min(1, delta * 1.8))
      // 桨叶叠拢/张开:机臂完全展开后才缓缓张开(真机节奏)
      this.rig.updateBlades(delta)
      sim.armFold = this.rig.armFold
      const armCheck = sim.externalChecks.find((item) => item.id === 'arms')
      if (armCheck) {
        const unfolded = this.rig.armFold < 0.02
        if (!unfolded) {
          armCheck.ok = false
          armCheck.detail = '机臂处于收纳状态'
        } else if (this.rig.bladeOpen < 0.98) {
          armCheck.ok = false
          armCheck.detail = '螺旋桨展开中'
        } else {
          armCheck.ok = true
          armCheck.detail = '已展开'
        }
      }
    }

    // 灯光:状态灯语跟随飞行状态,除非面板手动指定
    const lights = this.lights
    if (lights) {
      lights.setFlying(sim.airborne)
      lights.setBatteryLevel(sim.batteryPercent)
      lights.setStatusPattern(this.lightOverride ?? statusPatternFor(sim))
      lights.update(delta)
      // 状态灯挂在后机臂末端(真机位置),展开态下一次性重挂进折叠节点以跟随折叠
      if (this.rig && this.rig.armFold < 0.005) {
        lights.attachStatusToArms(
          this.rig.getArmFoldNode('RearLeft'),
          this.rig.getArmFoldNode('RearRight'),
        )
      }
    }

    const home = sim.homePosition
    this.world?.setHome(home.x, home.z)

    // 测距雷达:上电即工作,镜头可转向(默认看正前方/正上方),视场随机体姿态转动
    if (this.radar && this.world && this.model) {
      this.radar.update(this.model, this.world, delta, sim.phase !== 'powerOff')
    }
  }

  /** 测距雷达最新读数:前视双镜头 + 上视双孔(Vue 面板 100ms 轮询) */
  getRadarSnapshot(): RadarSnapshot {
    return (
      this.radar?.getSnapshot() ?? {
        detecting: false,
        left: null,
        right: null,
        range: 18,
        upLeft: null,
        upRight: null,
        upRange: 15,
        aim: 'forward',
      }
    )
  }

  /** 切换镜头瞄准:forward = 转向正前方/正上方;sensor = 沿镜头(玻璃面)朝向 */
  setRadarAim(aim: RadarAim): void {
    this.radar?.setAim(aim)
  }

  /** 切换雷达射线可视化(前视 + 上视,读数不受影响) */
  setRadarBeamsVisible(visible: boolean): void {
    this.radarBeamsVisible = visible
    this.radar?.setVisible(visible)
  }

  /** 当前雷达射线可视化是否显示(探针用) */
  isRadarBeamsVisible(): boolean {
    return this.radar?.isBeamsVisible() ?? this.radarBeamsVisible
  }

  /** 切换底部辅助灯的锥形光束显隐(不影响辅助灯照明) */
  setAuxBeamVisible(visible: boolean): void {
    this.auxBeamVisible = visible
    this.lights?.setBeamVisible(visible)
  }

  /** 当前辅助灯锥形光束是否绘制(探针用) */
  isAuxBeamVisible(): boolean {
    return this.lights?.isBeamVisible() ?? this.auxBeamVisible
  }

  private pushTrail(): void {
    const sim = this.sim
    if (!this.world) return
    if (sim.airborne) {
      this.world.pushTrail(sim.position.x, this.groundOffsetY + sim.position.y, sim.position.z)
    }
  }

  // ————————————————————————————— 相机 —————————————————————————————

  setCameraMode(mode: CameraMode): void {
    this.cameraMode = mode
    if (this.controls) this.controls.enabled = mode === 'orbit'
    if (mode === 'orbit') {
      // 回到观察者视角时保留当前朝向,只把控制点交还给轨道控制器
      this.cameraTarget.set(this.sim.position.x, this.groundOffsetY + this.sim.position.y, this.sim.position.z)
      this.controls?.target.copy(this.cameraTarget)
    }
  }

  private updateCamera(delta: number): void {
    const camera = this.camera
    if (!camera) return
    const sim = this.sim
    const dronePosition = this.dronePosition.set(
      sim.position.x,
      this.groundOffsetY + sim.position.y,
      sim.position.z,
    )

    if (this.cameraMode === 'fpv') {
      const ok = this.rig?.getGimbalCameraTransform(this.cameraScratch) ?? false
      if (ok) {
        this.cameraScratch.updateMatrixWorld(true)
        this.forwardVector.set(0, 0, -1).applyQuaternion(this.cameraScratch.quaternion).normalize()
        camera.position.copy(this.cameraScratch.position).addScaledVector(this.forwardVector, 0.12)
        camera.quaternion.copy(this.cameraScratch.quaternion)
      }
      return
    }

    if (this.cameraMode === 'follow') {
      const rad = (sim.heading * Math.PI) / 180
      this.forwardVector.set(Math.sin(rad), 0, -Math.cos(rad))
      this.followPosition
        .copy(dronePosition)
        .addScaledVector(this.forwardVector, -FOLLOW_DISTANCE)
      this.followPosition.y += FOLLOW_HEIGHT
      camera.position.lerp(this.followPosition, Math.min(1, delta * 4))
      this.followLookAt.copy(dronePosition)
      this.followLookAt.y += 0.6
      camera.lookAt(this.followLookAt)
      return
    }

    // 观察者:轨道控制器接管,但控制点平滑跟住飞机,避免飞出视野后找不回来
    this.cameraTarget.lerp(dronePosition, Math.min(1, delta * 2.2))
    if (this.controls) {
      this.cameraShift.subVectors(this.cameraTarget, this.controls.target)
      this.controls.target.add(this.cameraShift)
      camera.position.add(this.cameraShift)
    }
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) return
    this.setCameraMode('orbit')
    const dronePosition = new THREE.Vector3(
      this.sim.position.x,
      this.groundOffsetY + this.sim.position.y,
      this.sim.position.z,
    )
    this.camera.position.set(dronePosition.x + 6, dronePosition.y + 3.5, dronePosition.z + 7)
    this.controls.target.copy(dronePosition)
    this.cameraTarget.copy(dronePosition)
  }

  // ————————————————————————————— 操作透传 —————————————————————————————

  setStick(stick: Partial<StickState>): void {
    this.sim.setStick(stick)
  }

  resetStick(): void {
    this.sim.setStick({ ...NEUTRAL_STICK })
  }

  /** 键盘 / 方向键输入直接映射成摇杆行程(美国手 Mode 2) */
  setMoveDirection(direction: DroneDirection | null): void {
    this.sim.setStick({
      pitch: direction === 'up' ? 1 : direction === 'down' ? -1 : 0,
      roll: direction === 'right' ? 1 : direction === 'left' ? -1 : 0,
    })
  }

  setVerticalDirection(direction: DroneVerticalDirection | null): void {
    this.sim.setStick({ throttle: direction === 'up' ? 1 : direction === 'down' ? -1 : 0 })
  }

  setRotationDirection(direction: DroneRotationDirection | null): void {
    this.sim.setStick({ yaw: direction === 'right' ? 1 : direction === 'left' ? -1 : 0 })
  }

  setMode(mode: FlightMode): void {
    this.sim.setMode(mode)
  }

  setConfig(patch: Partial<SimConfig>): void {
    this.sim.config = { ...this.sim.config, ...patch }
  }

  setFaults(patch: Partial<FaultFlags>): void {
    this.sim.faults = { ...this.sim.faults, ...patch }
  }

  setArmFoldTarget(fold: number): void {
    this.armFoldTarget = fold > 0.5 ? 1 : 0
  }

  get armFoldTargetValue(): number {
    return this.armFoldTarget
  }

  setGimbalPitch(pitch: number): void {
    this.sim.setGimbalPitch(pitch)
  }

  nudgeGimbal(deltaPitch: number, deltaYaw = 0): void {
    this.sim.nudgeGimbal(deltaPitch, deltaYaw)
  }

  clearTrail(): void {
    this.world?.clearTrail()
  }

  getRigReport(): RigPartReport[] {
    return this.rig?.parts ?? []
  }

  getSnapshot(): DroneSnapshot {
    return this.sim.snapshot()
  }

  getLightsSnapshot() {
    return this.lights?.getSnapshot() ?? null
  }

  /** 兼容旧接口:直接返回仿真遥测 */
  getTelemetry() {
    return {
      speedMetersPerSecond: Math.hypot(this.sim.velocity.x, this.sim.velocity.z),
      altitudeMeters: this.sim.position.y,
      isFlying: this.sim.airborne,
    }
  }

  // —— 灯光手动覆盖(面板调试用) ——

  setStatusLightPattern(key: StatusLightKey): void {
    this.lightOverride = key
    this.lights?.setStatusPattern(key)
  }

  clearStatusLightOverride(): void {
    this.lightOverride = null
    this.lights?.setStatusPattern(statusPatternFor(this.sim))
  }

  get statusLightOverride(): StatusLightKey | null {
    return this.lightOverride
  }

  setBatteryLightMode(mode: BatteryLightMode): void {
    this.lights?.setBatteryMode(mode)
  }

  setBatteryLightLevel(levelPercent: number): void {
    this.sim.forceBatteryLevel(levelPercent)
    this.lights?.setBatteryLevel(levelPercent)
  }

  setAuxLightMode(mode: AuxLightMode): void {
    this.lights?.setAuxLightMode(mode)
  }

  destroy(): void {
    this.destroyed = true
    this.rig?.destroy()
    this.rig = null
    this.lights?.destroy()
    this.lights = null
    this.world?.destroy()
    this.world = null
    this.radar?.destroy()
    this.radar = null
    if (this.model) {
      this.disposeModel(this.model)
      this.scene?.remove(this.model)
    }
    this.model = null
  }

  private normalizeModel(model: THREE.Group): void {
    const initialBounds = new THREE.Box3().setFromObject(model)
    const size = initialBounds.getSize(new THREE.Vector3())
    const largestDimension = Math.max(size.x, size.y, size.z)
    if (largestDimension > 0) model.scale.setScalar(DRONE_SIZE_METERS / largestDimension)

    const bounds = new THREE.Box3().setFromObject(model)
    const center = bounds.getCenter(new THREE.Vector3())
    model.position.x -= center.x
    model.position.z -= center.z
    model.position.y -= bounds.min.y
  }

  private disposeModel(model: THREE.Group): void {
    model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      materials.forEach((material) => material.dispose())
    })
  }
}

/** 灯语与飞行状态的对应关系(与《Mini 4 Pro 灯光说明》一致) */
export function statusPatternFor(sim: DroneSim): StatusLightKey {
  if (sim.damaged) return 'fcError'
  if (sim.phase === 'powerOff') return 'off'
  switch (sim.phase) {
    case 'selfCheck':
      return 'selfCheck'
    case 'warmingUp':
      return 'sensorWarmup'
    case 'emergency':
      return 'fcError'
    default:
      break
  }
  if (sim.faults.imuError) return 'fcError'
  if (sim.faults.compassError) return 'compassError'
  if (sim.faults.rcLost) return 'rcLost'
  if (sim.criticalBattery) return 'criticalBattery'
  if (sim.lowBattery) return 'lowBattery'
  if (sim.motorsOn) return 'motorRunning'
  const source = sim.positionSource
  if (source === 'gps') return sim.gpsBars >= 3 ? 'gnssNormal' : 'gnssWeak'
  if (source === 'vision') return 'gnssWeak'
  return 'attiMode'
}
