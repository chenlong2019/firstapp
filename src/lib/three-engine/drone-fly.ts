import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { WebGPURenderer } from 'three/webgpu'
import { DroneLights } from './drone-lights'
import type { AuxLightMode, BatteryLightMode, StatusLightKey } from './drone-lights'
import { DroneRig, type RigPartReport } from './drone-rig'
import { DroneRadar, type RadarAim, type RadarSnapshot } from './drone-radar'
import { DroneWorld } from './drone-world'
import { MissionEditor, type MissionEditState } from './mission-editor'
import {
  DroneSim,
  DRONE_SPEC,
  FLIGHT_MODES,
  NEUTRAL_STICK,
  type DroneSnapshot,
  type FaultFlags,
  type FlightMode,
  type MissionConfig,
  type MissionSnapshot,
  type MissionWaypoint,
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

export type {
  DroneSnapshot,
  FaultFlags,
  FlightMode,
  MissionConfig,
  MissionSnapshot,
  MissionWaypoint,
  SimConfig,
  StickState,
} from './drone-sim'
export type { MissionDragMode, MissionEditState, MissionEditorHost } from './mission-editor'

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
/** 相机镜头位置:沿云台光轴从云台中心前移,避免把云台自身拍进画面 */
const GIMBAL_CAMERA_OFFSET = 0.12
/** 拍照等待渲染的兜底时限(毫秒),超时按失败处理 */
const PHOTO_TIMEOUT_MS = 2000
/** 录像参数:帧率 / 码率 / 分片间隔 */
const RECORD_FPS = 30
const RECORD_BITRATE = 8_000_000
const RECORD_TIMESLICE_MS = 500
/** 录制收尾兜底时限(毫秒):部分环境可能不派发 onstop */
const RECORD_STOP_TIMEOUT_MS = 1500

/** 录像容器候选:优先 VP9,退回 VP8/webm,再交给浏览器默认 */
const RECORD_MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/** 单张照片(云台相机取景) */
export interface PhotoShot {
  /** PNG data URL,可直接用于 <img> 或下载 */
  dataUrl: string
  width: number
  height: number
}

/** 相机位姿快照:取景帧(拍照 / 录像)渲染完必须还回去 */
interface CameraRestore {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  zoom: number
}

function pickRecordMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined
  return RECORD_MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime))
}

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
  /** 观察者视角是否把控制点自动跟到飞机上(框航线 / 场景编辑时关掉,见 frameMission) */
  private cameraAutoFollow = true
  private readonly cameraScratch = new THREE.Object3D()
  private readonly dronePosition = new THREE.Vector3()
  private readonly cameraShift = new THREE.Vector3()
  private readonly followPosition = new THREE.Vector3()
  private readonly followLookAt = new THREE.Vector3()
  private readonly forwardVector = new THREE.Vector3()
  private lightOverride: StatusLightKey | null = null
  /** 机臂目标折叠度:1 = 收纳(出厂收纳状态,起飞前必须先展开) */
  private armFoldTarget = 1
  /** 航线可视化签名:只有航线内容变化时才重建三维标记(每帧重建代价太大) */
  private missionSignature = ''
  /** 航点/航线图层显隐(面板开关,重建标记后要重新贴回) */
  private missionVisible = true
  /** 航点标记 / 航线折线各自的开关(拆开控制,重建标记后要重新贴回) */
  private missionMarkersVisible = true
  private missionPathVisible = true
  /** 场景内航点编辑器(需要画布,headless / 无渲染器时为 null) */
  missionEditor: MissionEditor | null = null
  /** 场景编辑开关(界面意图;编辑器实例可能晚于页面初始化创建,先缓存再补上) */
  private missionEditEnabled = false
  /** 场景编辑选中的航点索引(-1 = 未选中) */
  private missionEditSelected = -1
  /** 待取景的拍照请求:渲染前摆相机、渲染后拷屏并还原(见 onBeforeRender / onAfterRender) */
  private photoRequest: {
    resolve: (shot: PhotoShot | null) => void
    timer: number
    /** 取景前的相机位姿(onBeforeRender 填,onAfterRender 还原) */
    restore: CameraRestore | null
  } | null = null
  /** 云台相机取景用的独立相机(拍照不影响主相机对象本身) */
  private readonly captureCamera = new THREE.PerspectiveCamera()
  /** 屏录:sim.recording 是状态来源,这里负责真正的 MediaRecorder */
  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recordStream: MediaStream | null = null
  /** 手动抓帧轨道(captureStream(0)):录到什么由 captureRecordingFrame 那一帧云台取景决定 */
  private captureTrack: CanvasCaptureMediaStreamTrack | null = null
  /** 录制专用离屏画布的上下文:每帧只往里搬一帧云台取景,主画布上的用户视角永远不会混进录像 */
  private recordContext: CanvasRenderingContext2D | null = null
  /** 进入机载视角前的观察者缩放,退出时归还(变焦只在机载取景下生效) */
  private savedZoom: number | null = null
  /** 录像收尾回调:UI 用它落盘(引擎不直接触发下载) */
  onRecordingReady: ((blob: Blob, seconds: number) => void) | null = null

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

    // 场景内航点编辑:直接抓三维场景里的航点拖动(需要画布与相机,headless 环境下自动跳过)
    const canvas = this.renderer?.domElement
    if (canvas && this.camera) {
      this.missionEditor = new MissionEditor({
        canvas,
        camera: this.camera,
        world: this.world,
        canEdit: () => this.canMissionSceneEdit(),
        getWaypoints: () => this.sim.mission.map((waypoint) => ({ ...waypoint })),
        getSelected: () => this.missionEditSelected,
        setSelected: (index) => this.setMissionSelected(index),
        commitWaypoints: (waypoints, selected) => {
          // ⚠️ 这里故意不刷新 missionSignature:航点数变了必须让 syncPose 整层重建
          // (拖动那种"只改一个航点"的路径走 updateMissionWaypoint,才刷新签名)
          if (!this.sim.setMission(waypoints)) return
          this.setMissionSelected(selected)
        },
        moveWaypoint: (index, patch) => this.updateMissionWaypoint(index, patch),
        setOrbitEnabled: (enabled) => {
          if (this.controls) this.controls.enabled = enabled && this.isOrbitView
        },
        getLimits: () => ({
          maxAltitude: this.sim.config.maxAltitude,
          maxDistance: this.sim.config.maxDistance,
          homeX: this.sim.homePosition.x,
          homeZ: this.sim.homePosition.z,
        }),
        newWaypointTemplate: (index) => this.newWaypointTemplate(index),
        log: (level, text) => this.sim.pushEvent(level, text),
      })
      this.missionEditor.setEnabled(this.missionEditEnabled)
    }

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
    // 仿真侧关掉了录像(重置/降落等):收尾并交出成片
    if (this.recorder && !this.sim.recording) void this.stopRecording()
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
      // 状态灯骨骼绑定:首次在展开态把灯珠挂进机臂折叠节点(记录绑定位姿),
      // 之后每帧按绑定位姿刚体同步 —— 灯珠像焊在机臂末端一样随折叠/展开运动,
      // 即使被热更新重建等外力挪动过也会自动归位
      if (this.rig && this.rig.armFold < 0.005) {
        lights.attachStatusToArms(
          this.rig.getArmFoldNode('RearLeft'),
          this.rig.getArmFoldNode('RearRight'),
        )
      }
      lights.syncStatusToArms()
    }

    const home = sim.homePosition
    this.world?.setHome(home.x, home.z)

    // 航线任务可视化:航点标记 / 航线折线只在航线内容变化时重建,当前目标每帧贴高亮
    const world = this.world
    if (world) {
      const signature = this.buildMissionSignature()
      if (signature !== this.missionSignature) {
        this.missionSignature = signature
        world.setMissionWaypoints(
          sim.mission.map((waypoint) => ({
            x: waypoint.x,
            z: waypoint.z,
            altitude: waypoint.altitude,
          })),
          home,
        )
        // 重建出来的是一整套新对象,显隐与高亮状态得重新贴回去
        world.setMissionVisible(this.missionVisible)
        world.setMissionWaypointsVisible(this.missionMarkersVisible)
        world.setMissionPathVisible(this.missionPathVisible)
        world.setMissionSelection(this.missionEditSelected)
      }
      const active = sim.missionIndex >= 0 ? sim.mission[sim.missionIndex] ?? null : null
      world.setMissionActive(
        active ? sim.missionIndex : -1,
        active ? { x: active.x, z: active.z, altitude: active.altitude } : null,
      )
    }

    // 场景编辑:不可编辑(切到机载视角 / 任务开始执行)时自动收摊
    this.missionEditor?.update()

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
    const previous = this.cameraMode
    this.cameraMode = mode
    if (this.controls) this.controls.enabled = mode === 'orbit'
    // 变焦只在机载取景下生效:进入时记下观察者视角的缩放,离开时归还,
    // 这样轨道视角的滚轮缩放不会被相机变焦覆盖
    if (this.camera && mode === 'fpv' && previous !== 'fpv') this.savedZoom = this.camera.zoom
    if (this.camera && mode !== 'fpv' && previous === 'fpv') {
      this.camera.zoom = this.savedZoom ?? 1
      this.camera.updateProjectionMatrix()
      this.savedZoom = null
    }
    if (mode === 'orbit') {
      // 回到观察者视角时保留当前朝向,只把控制点交还给轨道控制器
      this.cameraTarget.set(this.sim.position.x, this.groundOffsetY + this.sim.position.y, this.sim.position.z)
      this.controls?.target.copy(this.cameraTarget)
    }
  }

  /** 当前是否为观察者(轨道控制)视角;非轨道模式下渲染循环不得调用 controls.update(),否则其每帧 lookAt(target) 会覆盖机载/跟随朝向 */
  get isOrbitView(): boolean {
    return this.cameraMode === 'orbit'
  }

  /**
   * 把相机摆到云台镜片位置并取云台朝向(机载视角与拍照共用):
   * 位置 = 云台中心沿光轴前移 offset,朝向 = 云台光轴。
   */
  private applyGimbalCameraPose(
    camera: THREE.PerspectiveCamera,
    options: { offset?: number; zoom?: number } = {},
  ): boolean {
    const ok = this.rig?.getGimbalCameraTransform(this.cameraScratch) ?? false
    if (!ok) return false
    this.cameraScratch.updateMatrixWorld(true)
    this.forwardVector.set(0, 0, -1).applyQuaternion(this.cameraScratch.quaternion).normalize()
    camera.position
      .copy(this.cameraScratch.position)
      .addScaledVector(this.forwardVector, options.offset ?? GIMBAL_CAMERA_OFFSET)
    camera.quaternion.copy(this.cameraScratch.quaternion)
    if (options.zoom !== undefined && Math.abs(camera.zoom - options.zoom) > 1e-3) {
      camera.zoom = options.zoom
      camera.updateProjectionMatrix()
    }
    return true
  }

  /** 记下当前相机位姿,供取景帧渲染完还原 */
  private snapshotCamera(): CameraRestore | null {
    const camera = this.camera
    if (!camera) return null
    return {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      zoom: camera.zoom,
    }
  }

  /** 把相机位姿还回去 —— 取景帧渲染完必须调用 */
  private restoreCamera(restore: CameraRestore): void {
    const camera = this.camera
    if (!camera) return
    camera.position.copy(restore.position)
    camera.quaternion.copy(restore.quaternion)
    if (Math.abs(camera.zoom - restore.zoom) > 1e-3) {
      camera.zoom = restore.zoom
      camera.updateProjectionMatrix()
    }
    camera.updateMatrixWorld(true)
  }

  // ————————————————————————————— 录制帧 —————————————————————————————

  /**
   * 录制帧 —— 交给录制器的画面恒为云台取景,与用户此刻在哪个视角无关。
   *
   * 真机只有一个云台相机,录制内容就该是它拍的;而用户盯着的画面可能是观察者
   * 视角,两者不是一回事。做法是每帧走一遍**和拍照完全相同**的取景路径
   * (摆相机 → 渲染 → 同一任务内把这一帧搬进录制画布),再还原相机位姿。
   *
   * 录制流挂在独立的离屏画布上而不是主画布:主画布随后还要渲染用户视角,而画布
   * 捕获是按"绘制之后"抓帧的,直接抓主画布会把用户视角录进去。离屏画布的内容
   * 只有云台取景,污染不了。
   *
   * 由渲染循环调用(在 controls.update 之后、onBeforeRender 之前)。未录制时零开销。
   */
  captureRecordingFrame(): void {
    const track = this.captureTrack
    const context = this.recordContext
    const camera = this.camera
    const source = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (!track || !context || !camera || !source || !this.renderer || !this.scene) return
    // 尺寸跟住主画布,窗口变化时录像不留黑边
    if (context.canvas.width !== source.width || context.canvas.height !== source.height) {
      context.canvas.width = source.width
      context.canvas.height = source.height
    }
    if (this.cameraMode === 'fpv') {
      // 相机此刻就在云台上(updateCamera 刚摆好):这一帧渲出来直接搬走
      this.renderer.render(this.scene, camera)
      context.drawImage(source, 0, 0)
      track.requestFrame()
      return
    }
    const restore = this.snapshotCamera()
    if (!this.applyGimbalCameraPose(camera, { offset: GIMBAL_CAMERA_OFFSET, zoom: this.sim.cameraZoom })) {
      // 云台还不可用(模型没载完):这一帧没有可录内容,下一帧再说
      return
    }
    camera.updateMatrixWorld(true)
    this.renderer.render(this.scene, camera)
    context.drawImage(source, 0, 0)
    track.requestFrame()
    if (restore) this.restoreCamera(restore)
  }

  // ————————————————————————————— 拍照 —————————————————————————————

  /**
   * 拍照:用云台相机取景拍一张 PNG。
   *
   * 实现是"渲染前换相机位姿 → 渲染后同一任务内拷屏":不依赖离屏渲染目标
   * (WebGPU/WebGL 后端行为一致),拷屏与渲染在同一个任务里完成,画面不会闪帧。
   * 上一张尚未取回时返回 null,避免连拍踩踏。
   */
  requestPhoto(): Promise<PhotoShot | null> {
    if (!this.renderer || !this.camera || !this.rig) return Promise.resolve(null)
    if (this.photoRequest) return Promise.resolve(null)
    return new Promise<PhotoShot | null>((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.photoRequest) {
          this.photoRequest = null
          resolve(null)
        }
      }, PHOTO_TIMEOUT_MS)
      this.photoRequest = { resolve, timer, restore: null }
    })
  }

  /** 渲染前钩子(渲染循环在 controls.update 之后、render 之前调用):本帧按云台相机取景 */
  onBeforeRender(): void {
    const request = this.photoRequest
    const camera = this.camera
    if (!request || !camera) return
    // 先记下当前位姿:取景帧渲染完立刻还原,轨道视角不会被拽到云台位置
    request.restore = this.snapshotCamera()
    this.applyGimbalCameraPose(camera, { offset: GIMBAL_CAMERA_OFFSET, zoom: this.sim.cameraZoom })
    camera.updateMatrixWorld(true)
  }

  /** 渲染后钩子:与渲染同一任务内拷屏,然后把相机位姿还原 */
  onAfterRender(): void {
    const request = this.photoRequest
    if (!request) return
    this.photoRequest = null
    window.clearTimeout(request.timer)
    const shot = this.grabCanvas()
    if (request.restore) this.restoreCamera(request.restore)
    request.resolve(shot)
  }

  /** 把当前画布内容拷进离屏 canvas(同一任务内执行,拿到的是刚渲染的那一帧) */
  private grabCanvas(): PhotoShot | null {
    const source = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (!source || !source.width || !source.height) return null
    const target = document.createElement('canvas')
    target.width = source.width
    target.height = source.height
    const context = target.getContext('2d')
    if (!context) return null
    context.drawImage(source, 0, 0)
    return { dataUrl: target.toDataURL('image/png'), width: target.width, height: target.height }
  }

  // ————————————————————————————— 录像 —————————————————————————————

  get isRecording(): boolean {
    return this.recorder !== null
  }

  /** 开始屏录(录云台取景,与用户当前视角无关)。返回 false = 当前环境不支持 */
  startRecording(): boolean {
    if (this.recorder) return true
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (!canvas || typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') return false
    // 录制源用独立离屏画布:每帧只往里搬一帧云台取景,主画布上用户视角的渲染
    // 永远不会污染录制流(画布捕获按"绘制之后"抓帧,直接抓主画布会录到用户视角)。
    const recordCanvas = document.createElement('canvas')
    recordCanvas.width = canvas.width || 1
    recordCanvas.height = canvas.height || 1
    const recordContext = recordCanvas.getContext('2d')
    if (!recordContext) return false
    let recorder: MediaRecorder
    let stream: MediaStream
    try {
      // captureStream(0) = 手动抓帧:录到什么由渲染循环里搬进这张画布的云台帧决定。
      stream = recordCanvas.captureStream(0)
      const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
      if (track && typeof track.requestFrame === 'function') {
        this.captureTrack = track
      } else {
        // 少数环境不支持手动抓帧:退回按帧率自动采样这张画布(内容仍是云台取景)
        stream.getTracks().forEach((item) => item.stop())
        stream = recordCanvas.captureStream(RECORD_FPS)
        this.captureTrack = null
      }
      const mime = pickRecordMime()
      recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: RECORD_BITRATE })
        : new MediaRecorder(stream)
    } catch {
      this.captureTrack = null
      return false
    }
    this.recordContext = recordContext
    this.recordChunks = []
    this.recordStream = stream
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.recordChunks.push(event.data)
    }
    recorder.start(RECORD_TIMESLICE_MS)
    this.recorder = recorder
    this.sim.setRecordingState(true)
    return true
  }

  /** 结束屏录:收尾成 Blob 并交给 onRecordingReady(未录制时直接返回 null) */
  stopRecording(): Promise<Blob | null> {
    const recorder = this.recorder
    if (!recorder) {
      this.sim.setRecordingState(false)
      return Promise.resolve(null)
    }
    this.recorder = null
    const seconds = this.sim.recordSeconds
    this.sim.setRecordingState(false)
    return new Promise<Blob | null>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        const chunks = this.recordChunks
        this.recordChunks = []
        this.recordStream?.getTracks().forEach((track) => track.stop())
        this.recordStream = null
        this.captureTrack = null
        this.recordContext = null
        const blob = chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'video/webm' }) : null
        if (blob) this.onRecordingReady?.(blob, seconds)
        resolve(blob)
      }
      // 部分环境可能不派发 onstop,兜底收尾
      const timer = window.setTimeout(finish, RECORD_STOP_TIMEOUT_MS)
      recorder.onstop = finish
      try {
        recorder.stop()
      } catch {
        finish()
      }
    })
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
      // 相机位姿 = 云台光轴(含变焦);取景逻辑与拍照共用同一套
      this.applyGimbalCameraPose(camera, { offset: GIMBAL_CAMERA_OFFSET, zoom: this.sim.cameraZoom })
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
    if (this.cameraAutoFollow) {
      this.cameraTarget.lerp(dronePosition, Math.min(1, delta * 2.2))
      if (this.controls) {
        this.cameraShift.subVectors(this.cameraTarget, this.controls.target)
        this.controls.target.add(this.cameraShift)
        camera.position.add(this.cameraShift)
      }
    } else if (this.controls) {
      // 框住航线 / 场景编辑期间不跟飞机:否则刚摆好的画面会被"跟到飞机"慢慢拖走
      this.cameraTarget.copy(this.controls.target)
    }
  }

  resetCamera(): void {
    if (!this.camera || !this.controls) return
    this.setCameraMode('orbit')
    this.cameraAutoFollow = true
    if (this.camera.zoom !== 1) {
      this.camera.zoom = 1
      this.camera.updateProjectionMatrix()
    }
    const dronePosition = new THREE.Vector3(
      this.sim.position.x,
      this.groundOffsetY + this.sim.position.y,
      this.sim.position.z,
    )
    this.camera.position.set(dronePosition.x + 6, dronePosition.y + 3.5, dronePosition.z + 7)
    this.controls.target.copy(dronePosition)
    this.cameraTarget.copy(dronePosition)
  }

  /**
   * 把观察者相机拉到"一眼看全整条航线"的位置(编辑航线前先框住航线)。
   *
   * 航点动辄 30~40 米高、水平铺开几十米,默认机位贴着飞机,根本看不到航线 ——
   * 所以框住一次比让用户自己滚轮找半天更实际。按包围球的垂直/水平视场双向取距离,
   * 保证竖着铺开的航线也不会被裁掉。
   */
  frameMission(): boolean {
    const camera = this.camera
    const controls = this.controls
    if (!camera || !controls) return false
    const home = this.sim.homePosition
    const first = this.sim.mission[0]
    let minX = home.x
    let maxX = home.x
    let minY = first ? Math.max(1, first.altitude) : DRONE_SPEC.takeoffAltitude
    let maxY = minY
    let minZ = home.z
    let maxZ = home.z
    const include = (x: number, y: number, z: number): void => {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    for (const waypoint of this.sim.mission) {
      include(waypoint.x, waypoint.altitude, waypoint.z)
    }
    // 地面也要进画面:航点的水平位置在地面上是有意义的参照
    include(minX, 0, minZ)
    include(maxX, 0, maxZ)

    const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
    center.y += this.groundOffsetY
    const radius = Math.max(
      12,
      0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ),
    )
    const halfVertical = THREE.MathUtils.degToRad(camera.fov / 2)
    const halfHorizontal = Math.atan(Math.tan(halfVertical) * Math.max(0.2, camera.aspect))
    const distance = Math.max(radius / Math.tan(halfVertical), radius / Math.tan(halfHorizontal)) * 1.35

    this.setCameraMode('orbit')
    // 关掉"控制点跟飞机":否则摆好的画面会在几秒内被拖回飞机身上
    this.cameraAutoFollow = false
    if (camera.zoom !== 1) {
      camera.zoom = 1
      camera.updateProjectionMatrix()
    }
    const direction = new THREE.Vector3(-0.42, 0.55, 0.72).normalize()
    camera.position.copy(center).addScaledVector(direction, distance)
    controls.target.copy(center)
    this.cameraTarget.copy(center)
    camera.lookAt(center)
    camera.updateMatrixWorld(true)
    controls.update()
    return true
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

  // ————————————————————————————— 航线任务 —————————————————————————————

  /** 启动航线任务(地面时先自动起飞,到 1.2 米后自动接上航线) */
  startMission(): boolean {
    return this.sim.startMission()
  }

  pauseMission(reason?: string): boolean {
    return this.sim.pauseMission(reason)
  }

  resumeMission(): boolean {
    return this.sim.resumeMission()
  }

  stopMission(reason?: string): boolean {
    return this.sim.stopMission(reason)
  }

  /** 下发航点列表(执行中会被拒绝,与真机"上传后不可改"一致) */
  setMission(waypoints: Array<Partial<MissionWaypoint>>): boolean {
    return this.sim.setMission(waypoints)
  }

  setMissionConfig(patch: Partial<MissionConfig>): void {
    this.sim.setMissionConfig(patch)
  }

  resetMissionToDefault(): void {
    this.sim.resetMissionToDefault()
  }

  getMissionSnapshot(): MissionSnapshot {
    return this.sim.snapshot().mission
  }

  /** 航点标记 / 航线折线的总显隐(不影响任务执行) */
  setMissionVisible(visible: boolean): void {
    this.missionVisible = visible
    this.world?.setMissionVisible(visible)
  }

  isMissionVisible(): boolean {
    return this.world?.isMissionVisible() ?? this.missionVisible
  }

  /** 只开关航点标记 */
  setMissionWaypointsVisible(visible: boolean): void {
    this.missionMarkersVisible = visible
    this.world?.setMissionWaypointsVisible(visible)
  }

  isMissionWaypointsVisible(): boolean {
    return this.world?.isMissionWaypointsVisible() ?? this.missionMarkersVisible
  }

  /** 只开关航线折线 */
  setMissionPathVisible(visible: boolean): void {
    this.missionPathVisible = visible
    this.world?.setMissionPathVisible(visible)
  }

  isMissionPathVisible(): boolean {
    return this.world?.isMissionPathVisible() ?? this.missionPathVisible
  }

  // ————————————————————————————— 场景内航点编辑 —————————————————————————————

  /** 航点标记 / 航线折线的重建签名(只跟返航点与航点位置有关) */
  private buildMissionSignature(): string {
    const home = this.sim.homePosition
    return `${home.x}|${home.z}#${this.sim.mission
      .map((waypoint) => `${waypoint.x}|${waypoint.z}|${waypoint.altitude}`)
      .join(';')}`
  }

  /** 场景编辑的硬门槛:观察者视角 + 航线未在执行(含"已下发等待起飞到位") */
  private canMissionSceneEdit(): boolean {
    return this.isOrbitView && this.sim.missionStatus === 'idle' && !this.sim.missionPendingStart
  }

  /** 开关「场景内编辑航点」 */
  setMissionEditEnabled(enabled: boolean): void {
    this.missionEditEnabled = enabled
    this.missionEditor?.setEnabled(enabled)
    if (!enabled) {
      this.setMissionSelected(-1)
    } else if (!this.canMissionSceneEdit()) {
      this.sim.pushEvent('warn', '场景编辑需要先切到观察者视角,且航线未在执行')
    } else if (this.sim.mission.length > 0) {
      // 默认机位贴着飞机,航点全在画面外 —— 开编辑时先把整条航线框进画面
      this.frameMission()
    }
  }

  isMissionEditEnabled(): boolean {
    return this.missionEditEnabled
  }

  /** 场景编辑:选中某个航点(-1 取消选中) */
  setMissionSelected(index: number): void {
    this.missionEditSelected = index
    this.world?.setMissionSelection(index)
  }

  getMissionSelected(): number {
    return this.missionEditSelected
  }

  /** 场景编辑的实时状态(界面 100ms 轮询) */
  getMissionEditState(): MissionEditState {
    const editor = this.missionEditor
    if (!editor) {
      return {
        enabled: this.missionEditEnabled,
        active: false,
        selectedIndex: this.missionEditSelected,
        hoverIndex: -1,
        dragging: false,
        mode: null,
      }
    }
    const state = editor.getState()
    // 选中态以装配层为准(编辑器只是读)
    return { ...state, selectedIndex: this.missionEditSelected }
  }

  /**
   * 原位更新一个航点(场景拖拽每帧调用):改内核 + 只挪这一根三维标记。
   *
   * 关键在于同步刷新签名 —— 否则下一帧 syncPose 发现"签名变了"会把整层标记重建一遍,
   * 拖动时就会一顿一顿地闪。
   */
  updateMissionWaypoint(index: number, patch: Partial<MissionWaypoint>): MissionWaypoint | null {
    const applied = this.sim.updateMissionWaypoint(index, patch)
    if (!applied) return null
    this.world?.updateMissionWaypoint(index, {
      x: applied.x,
      z: applied.z,
      altitude: applied.altitude,
    })
    this.missionSignature = this.buildMissionSignature()
    return applied
  }

  /** 场景编辑:按索引删除一个航点 */
  deleteMissionWaypoint(index: number): boolean {
    if (!this.canMissionSceneEdit()) return false
    if (!this.sim.removeMissionWaypoint(index)) return false
    this.setMissionSelected(Math.min(index, this.sim.mission.length - 1))
    this.sim.pushEvent('info', `场景编辑:已删除航点 ${index + 1}`)
    return true
  }

  /** 场景编辑:以飞机当前位置新增一个航点(高度取飞机当前高度) */
  addMissionWaypointAtDrone(): number {
    if (!this.canMissionSceneEdit()) return -1
    const position = this.sim.position
    const index = this.sim.addMissionWaypoint({
      x: Math.round(position.x),
      z: Math.round(position.z),
      altitude: Math.max(1, Math.round(position.y)),
      speed: this.sim.missionConfig.autoSpeed,
    })
    if (index < 0) return -1
    this.setMissionSelected(index)
    this.sim.pushEvent('info', `场景编辑:已在飞机当前位置新增航点 ${index + 1}`)
    return index
  }

  /** 新航点的默认参数:高度与速度继承相邻航点,避免插出一个贴地点 */
  private newWaypointTemplate(index: number): Partial<MissionWaypoint> {
    const list = this.sim.mission
    const neighbour = list[Math.min(index, list.length - 1)] ?? list[list.length - 1]
    return {
      altitude: neighbour?.altitude ?? 30,
      speed: neighbour?.speed ?? this.sim.missionConfig.autoSpeed,
      hoverSeconds: neighbour?.hoverSeconds ?? 0,
    }
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
    // 录制中直接收摊(页面卸载不触发下载)
    if (this.recorder) {
      try {
        this.recorder.stop()
      } catch {
        /* 已停止 */
      }
      this.recorder = null
    }
    this.recordStream?.getTracks().forEach((track) => track.stop())
    this.recordStream = null
    this.captureTrack = null
    this.recordContext = null
    this.recordChunks = []
    this.onRecordingReady = null
    this.missionEditor?.destroy()
    this.missionEditor = null
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
