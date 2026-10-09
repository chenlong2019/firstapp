import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DroneSim, type DroneSnapshot, type StickState } from '../../lib/three-engine/drone-sim'
import { DroneRig } from '../../lib/three-engine/drone-rig'

/**
 * 场景内的可操控无人机。
 *
 * 上游 `scenery/drone.ts` 只是一个随车悬停的展示道具(桨叶静止、无飞控)。
 * 这里把它换成 firstapp 的 DJI 飞控内核 + 机械装配层的组合:
 *
 * - `DroneSim`(纯逻辑、零渲染依赖)负责飞行状态机:自检、预热、起飞、降落、
 *   智能返航、姿态倾斜、电池与失效保护。坐标是米制,y 为相对起飞点的高度。
 * - `DroneRig` 负责模型机械:机臂展开/收纳、桨叶自转、整机刚体位姿、
 *   机头朝向与俯仰横滚。
 *
 * 两种模式:
 * - **跟随**(默认,与上游一致):无人机锚定在车辆右前方,叠一点悬停起伏。
 * - **接管**:飞控接管,键盘可操控;退出接管时从当前位置平滑飞回车旁。
 *
 * 坐标约定(容易搞错,集中写在这里):
 * - 场景是米制世界坐标,`x` 向东、`z` 向南。
 * - `DroneSim.heading` 是度,0 = 正北,顺时针增加;对应方向 (sin, 0, -cos)。
 * - 赛车的 `heading` 是弧度,+Z 起转向 +X;对应方向 (sin, 0, +cos)。
 *   两者相差 180°,所以换算就是 `droneDeg = 180 - radToDeg(raceRad)`。
 */

export type RaceDroneAnchor = { position: THREE.Vector3; heading: number }

/**
 * 镜头看谁(与"谁在被操控"完全解耦):
 * `car` 车辆 / `drone` 无人机跟拍 / `fpv` 机载视角(相机架在云台镜片上)
 */
export type DroneCameraFocus = 'car' | 'drone' | 'fpv'

export type RaceDroneStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 接管飞行时给 HUD 用的精简读数(全量快照留在飞控里) */
export interface RaceDroneFlight {
  phase: string
  phaseLabel: string
  modeLabel: string
  airborne: boolean
  motorsOn: boolean
  batteryPercent: number
  altitude: number
  horizontalSpeed: number
  verticalSpeed: number
  /** 机头方位角(度,0 = 正北,顺时针) */
  heading: number
  tiltPitch: number
  tiltRoll: number
  distanceToHome: number
  positionSourceLabel: string
  satelliteCount: number
  warning: string
  /** 当前下发给飞控的摇杆量(-1..1):HUD 靠它证明"按键真的进来了" */
  stick: { throttle: number; yaw: number; pitch: number; roll: number }
  /** 云台俯仰(度,0 = 水平,负 = 俯视) */
  gimbalPitch: number
  /** 当前按住的飞行键(诊断用) */
  keys: string[]
}

export interface RaceDroneState {
  status: RaceDroneStatus
  error: string
  meshes: number
  triangles: number
  /** 载入那一瞬的包围盒(归一化就是按它缩放的) */
  size: number[]
  /** 机臂展开后的包围盒(米):无人机在场景里实际占多大看这个 */
  flightSize: number[]
  enabled: boolean
  visible: boolean
  position: number[]
  heading: number
  /** 是否已接管(人工操控中) */
  piloting: boolean
  /** 机臂折叠度:0 = 完全展开,1 = 收纳 */
  armFold: number
}

export interface RaceDroneOptions {
  url: string
  /** 归一化后的最大尺寸(米):模型按此等比缩放 */
  size: number
  /** 跟随模式下的偏移(米,车体坐标系:右为 -x,前为 +z) */
  offset: THREE.Vector3
  /** 键盘监听信号:随页面卸载统一注销 */
  signal?: AbortSignal
  /**
   * 未接管时按到了飞行摇杆键(说明用户以为已经在操控它了)。
   * 调用方用这个提示"先接管",否则按键没反应会看起来像坏了。
   */
  onIdleFlightKey?: (code: string) => void
}

/** 飞控固定步长:与沙盒一致,保证不同帧率下的手感相同 */
const FIXED_STEP = 1 / 60
/** 单帧最多推进的物理步数(低帧率时宁可慢放,也不要一步跳很远) */
const MAX_STEPS_PER_FRAME = 16
/** 退出接管后飞回车旁的过渡时间(秒) */
const REJOIN_SECONDS = 1.4
/** 接管时把飞机重新挂到当前悬停点的最低高度(米) */
const PILOT_MIN_ALTITUDE = 1.5

const UP = new THREE.Vector3(0, 1, 0)

/** 避障触发方向的中文名(与飞控 ObstacleReport.brakingDirection 对应) */
const OBSTACLE_DIRECTIONS: Record<string, string> = {
  forward: '前方',
  backward: '后方',
  left: '左侧',
  right: '右侧',
  up: '上方',
  down: '下方',
}

/**
 * 摇杆按键映射。
 *
 * 无人机**专属键**(任何时候都归它):左手 Z/X 升降、Q/E 偏航,右手 I/K 前后、
 * J/L 左右平移。
 *
 * 驾驶键(W/S/A/D + 方向键)**只在接管期间借给无人机**——"接管操控"的字面含义就是
 * 把操控权交出去,顺着驾驶习惯按键最省事:W/S 前后、A/D 左右转(偏航),方向键同义。
 * 交还的那一刻键盘立刻还给汽车(见 `CAR_KEY_AXES`),所以不存在"接管了却还在开车"
 * 这种状态:任何时刻操控权只有一份,车与飞机的物理则始终互不阻塞。
 */
const KEY_THROTTLE_UP = 'KeyZ'
const KEY_THROTTLE_DOWN = 'KeyX'
const KEY_YAW_LEFT = 'KeyQ'
const KEY_YAW_RIGHT = 'KeyE'
const KEY_PITCH_FORWARD = 'KeyI'
const KEY_PITCH_BACK = 'KeyK'
const KEY_ROLL_LEFT = 'KeyJ'
const KEY_ROLL_RIGHT = 'KeyL'

/**
 * 驾驶键在接管期间的飞行含义(照"加速 / 刹车 / 左转 / 右转"的直觉搬过来)。
 * 车看好的是转向,所以 A/D 给偏航而不是横移;横移仍由 J/L 负责。
 */
const CAR_KEY_AXES: Record<string, { axis: keyof StickState; sign: number }> = {
  KeyW: { axis: 'pitch', sign: 1 },
  ArrowUp: { axis: 'pitch', sign: 1 },
  KeyS: { axis: 'pitch', sign: -1 },
  ArrowDown: { axis: 'pitch', sign: -1 },
  KeyA: { axis: 'yaw', sign: -1 },
  ArrowLeft: { axis: 'yaw', sign: -1 },
  KeyD: { axis: 'yaw', sign: 1 },
  ArrowRight: { axis: 'yaw', sign: 1 },
}
const CAR_KEYS = new Set(Object.keys(CAR_KEY_AXES))

/** 赛车 heading(弧度,+Z 起) → 飞控 heading(度,正北起) */
export const raceHeadingToDroneDeg = (raceRadians: number) =>
  (180 - THREE.MathUtils.radToDeg(raceRadians) + 360) % 360

/** 飞控 heading(度) → 赛车 heading(弧度),接管/退出时对齐用 */
export const droneDegToRaceHeading = (droneDegrees: number) =>
  THREE.MathUtils.degToRad(180 - droneDegrees)

const smoothstep = (t: number) => {
  const x = THREE.MathUtils.clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

export function createRaceDrone(options: RaceDroneOptions) {
  const root = new THREE.Group()
  root.name = 'dji-air-drone'
  root.visible = false

  const sim = new DroneSim()
  const report = {
    status: 'idle' as RaceDroneStatus,
    error: '',
    meshes: 0,
    triangles: 0,
    size: [0, 0, 0] as number[],
    flightSize: [0, 0, 0] as number[],
  }

  let rig: DroneRig | null = null
  let model: THREE.Group | null = null
  /** 模型原点相对脚撑接地面的偏移(归一化后读出),飞行高度由它换算 */
  let groundOffsetY = 0
  /**
   * 机臂折叠度与目标值。出厂是收纳态;装配层不做缓动,收敛节奏由调用方给
   * (沙盒里由 DroneFly 驱动,这里由本模块驱动)。
   */
  let armFoldTarget = 1
  let armFoldState = 1
  /** 展开后的飞行外形只量一次 */
  let flightSizeMeasured = false
  let enabled = true
  let disposed = false
  let anchored = false
  let pending: Promise<boolean> | null = null
  let elapsed = 0
  let accumulator = 0

  /** 接管原点:飞控的 x/z = 0 对应这里的水平位置 */
  const origin = new THREE.Vector3()
  /** 接管时的朝向(弧度,赛车约定),退出时用于平滑回位 */
  const rejoinFrom = new THREE.Vector3()
  const targetPosition = new THREE.Vector3()
  const anchorPosition = new THREE.Vector3()
  const yawQuat = new THREE.Quaternion()
  /** 机载视角取景用的临时量 */
  const gimbalForward = new THREE.Vector3()
  /** 当前世界朝向(弧度,赛车约定),供外部相机与 HUD 使用 */
  let worldHeading = 0
  let piloting = false
  let rejoinTime = REJOIN_SECONDS

  const pressed = new Set<string>()

  const stickFromKeys = (): StickState => {
    const stick: StickState = {
      throttle: (pressed.has(KEY_THROTTLE_UP) ? 1 : 0) - (pressed.has(KEY_THROTTLE_DOWN) ? 1 : 0),
      yaw: (pressed.has(KEY_YAW_RIGHT) ? 1 : 0) - (pressed.has(KEY_YAW_LEFT) ? 1 : 0),
      pitch: (pressed.has(KEY_PITCH_FORWARD) ? 1 : 0) - (pressed.has(KEY_PITCH_BACK) ? 1 : 0),
      roll: (pressed.has(KEY_ROLL_RIGHT) ? 1 : 0) - (pressed.has(KEY_ROLL_LEFT) ? 1 : 0),
    }
    // 接管期间借调的驾驶键走同一套轴,和专属键叠加后夹回 ±1(同时按 W 与 I 不该给两倍)
    for (const code of pressed) {
      const axis = CAR_KEY_AXES[code]
      if (axis) stick[axis.axis] += axis.sign
    }
    stick.throttle = THREE.MathUtils.clamp(stick.throttle, -1, 1)
    stick.yaw = THREE.MathUtils.clamp(stick.yaw, -1, 1)
    stick.pitch = THREE.MathUtils.clamp(stick.pitch, -1, 1)
    stick.roll = THREE.MathUtils.clamp(stick.roll, -1, 1)
    return stick
  }

  const flightKeys = new Set([
    KEY_THROTTLE_UP,
    KEY_THROTTLE_DOWN,
    KEY_YAW_LEFT,
    KEY_YAW_RIGHT,
    KEY_PITCH_FORWARD,
    KEY_PITCH_BACK,
    KEY_ROLL_LEFT,
    KEY_ROLL_RIGHT,
  ])

  const signal = options.signal
  window.addEventListener(
    'keydown',
    (event) => {
      const code = event.code
      if (flightKeys.has(code)) {
        if (!piloting) {
          // 没接管时按飞行键不该"静默无效":告诉调用方去提示接管
          options.onIdleFlightKey?.(code)
          return
        }
      } else if (!piloting || !CAR_KEYS.has(code)) {
        // 驾驶键:未接管时它属于汽车(本模块一根手指都不该碰);其余键也与本模块无关
        return
      }
      pressed.add(code)
      event.preventDefault()
    },
    { signal },
  )
  window.addEventListener(
    'keyup',
    (event) => {
      if (!flightKeys.has(event.code) && !CAR_KEYS.has(event.code)) return
      pressed.delete(event.code)
    },
    { signal },
  )
  // 失焦时清空按键,避免"按键卡住"导致飞机一直爬升
  window.addEventListener('blur', () => pressed.clear(), { signal })

  const releaseModel = (object: THREE.Object3D) => {
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.geometry?.dispose()
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose()
        }
        material.dispose()
      }
    })
  }

  /** 等比缩放到目标尺寸,并把水平中心与接地面挪到原点 */
  const normalizeModel = (target: THREE.Group) => {
    const initial = new THREE.Box3().setFromObject(target)
    const size = initial.getSize(new THREE.Vector3())
    const largest = Math.max(size.x, size.y, size.z)
    if (largest > 0) target.scale.setScalar(options.size / largest)
    const bounds = new THREE.Box3().setFromObject(target)
    const center = bounds.getCenter(new THREE.Vector3())
    target.position.x -= center.x
    target.position.z -= center.z
    target.position.y -= bounds.min.y
    groundOffsetY = target.position.y
  }

  const writePose = (
    x: number,
    y: number,
    z: number,
    headingDeg: number,
    pitchDeg: number,
    rollDeg: number,
  ) => {
    rig?.applyBodyPose({ x, y, z, headingDeg, pitchDeg, rollDeg })
    // 云台是挂载载荷,不跟着机身一起倒:把机身姿态交给三轴增稳,镜头始终看地平线
    // (除非飞手自己打俯仰杆)。机载视角读的就是这个节点的世界位姿。
    rig?.setGimbalAttitude(sim.gimbalPitch, sim.gimbalRoll, sim.gimbalYaw, pitchDeg, rollDeg)
  }

  /**
   * 机臂与桨叶每帧驱动。
   * 装配层不做缓动:`setArmFold()` 是直接设值,收敛节奏由调用方给(沙盒里由
   * DroneFly 驱动)。出厂是收纳态,所以先以 1.8/s 展开,展平后桨叶才缓缓张开。
   */
  const updateMechanics = (delta: number) => {
    if (!rig) return
    armFoldState += (armFoldTarget - armFoldState) * Math.min(1, delta * 1.8)
    rig.setArmFold(armFoldState)
    rig.updateBlades(delta)
    sim.armFold = rig.armFold
    // 展开到位后补量一次"飞行外形":归一化是按载入那一瞬的包围盒缩放的,
    // 机臂展开后桨叶伸出,实际占地看这个更准(只量一次,不进每帧热路径)。
    if (!flightSizeMeasured && armFoldState < 0.005 && model) {
      flightSizeMeasured = true
      model.updateMatrixWorld(true)
      report.flightSize = new THREE.Box3()
        .setFromObject(model)
        .getSize(new THREE.Vector3())
        .toArray()
        .map((value) => Number(value.toFixed(3)))
    }
  }

  /** 接管:把飞控挂到当前悬停点,跳过自检/预热直接进入可操控的悬停状态 */
  const engagePilot = (): boolean => {
    if (disposed || report.status !== 'ready' || !rig || !model) return false
    const current = model.position
    origin.set(current.x, 0, current.z)
    // 起飞前检查会看机臂折叠度,所以先把"已展开"写进飞控再走自检流程
    armFoldTarget = 0
    sim.armFold = 0
    sim.reset()
    sim.powerOn()
    let guard = 0
    while (sim.phase !== 'standby' && guard++ < 200) sim.step(0.1)
    if (!sim.autoTakeOff()) {
      sim.reset()
      return false
    }
    guard = 0
    while (sim.phase !== 'flying' && guard++ < 200) sim.step(0.1)
    // 飞控从 1.2 米起飞,这里把它抬到当前实际悬停高度,避免切换瞬间"掉一截"
    sim.position.y = Math.max(current.y - groundOffsetY, PILOT_MIN_ALTITUDE)
    sim.heading = raceHeadingToDroneDeg(worldHeading)
    sim.setStick({ throttle: 0, pitch: 0, roll: 0, yaw: 0 })
    // 机臂保持展开:飞行中真机不会收纳(自检也会查这一项)
    accumulator = 0
    pressed.clear()
    piloting = true
    return true
  }

  const releasePilot = () => {
    if (!piloting) return
    piloting = false
    pressed.clear()
    // 复位摇杆:飞控的 setStick 是合并语义,空对象不会清掉上一次的杆量
    sim.setStick({ throttle: 0, pitch: 0, roll: 0, yaw: 0 })
    // 记下当前位置,跟随模式下从这里平滑飞回车旁
    if (model) rejoinFrom.copy(model.position)
    rejoinTime = 0
  }

  const flightReadout = (snapshot: DroneSnapshot): RaceDroneFlight => ({
    phase: snapshot.phase,
    phaseLabel: snapshot.phaseLabel,
    modeLabel: snapshot.modeLabel,
    airborne: snapshot.airborne,
    motorsOn: snapshot.motorsOn,
    batteryPercent: snapshot.batteryPercent,
    altitude: snapshot.altitude,
    horizontalSpeed: snapshot.horizontalSpeed,
    verticalSpeed: snapshot.verticalSpeed,
    heading: snapshot.heading,
    tiltPitch: snapshot.tiltPitch,
    tiltRoll: snapshot.tiltRoll,
    distanceToHome: snapshot.distanceToHome,
    positionSourceLabel: snapshot.positionSourceLabel,
    satelliteCount: Math.round(snapshot.satellites),
    stick: {
      throttle: sim.stick.throttle,
      yaw: sim.stick.yaw,
      pitch: sim.stick.pitch,
      roll: sim.stick.roll,
    },
    gimbalPitch: sim.gimbalPitch,
    keys: [...pressed],
    warning: [
      snapshot.warnings[0] ?? '',
      snapshot.obstacle.braking
        ? `避障刹停 · ${OBSTACLE_DIRECTIONS[snapshot.obstacle.brakingDirection ?? 'forward']}`
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
  })

  return {
    root,
    sim,

    load(): Promise<boolean> {
      if (disposed) return Promise.resolve(false)
      if (pending) return pending
      report.status = 'loading'
      report.error = ''
      report.flightSize = [0, 0, 0]
      flightSizeMeasured = false
      pending = new GLTFLoader()
        .loadAsync(options.url)
        .then((gltf) => {
          if (disposed) {
            releaseModel(gltf.scene)
            return false
          }
          const source = gltf.scene as THREE.Group
          normalizeModel(source)
          // 装配层会接手这个模型的位姿,必须挂在原点根节点下
          model = source
          rig = new DroneRig(source)
          // 出厂是收纳态(桨叶叠拢、机臂折起),飞起来之前先展开
          armFoldTarget = 0
          source.traverse((child) => {
            const mesh = child as THREE.Mesh
            if (!mesh.isMesh) return
            mesh.castShadow = true
            mesh.receiveShadow = true
            report.meshes += 1
            report.triangles +=
              (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3
          })
          const bounds = new THREE.Box3().setFromObject(source)
          report.size = bounds
            .getSize(new THREE.Vector3())
            .toArray()
            .map((value) => Number(value.toFixed(3)))
          root.add(source)
          report.status = 'ready'
          root.visible = enabled && anchored
          return true
        })
        .catch((error) => {
          report.status = 'error'
          report.error = error instanceof Error ? error.message : String(error)
          root.visible = false
          pending = null
          console.warn('[race-drone] 模型载入失败', error)
          return false
        })
      return pending
    },

    setEnabled(value: boolean) {
      enabled = value
      if (!value) releasePilot()
      root.visible = !disposed && enabled && anchored && report.status === 'ready'
    },

    /** 是否具备接管条件(模型就绪且已启用) */
    canPilot(): boolean {
      return !disposed && enabled && report.status === 'ready' && rig !== null
    },

    setPiloting(value: boolean): boolean {
      if (value) return piloting ? true : engagePilot()
      releasePilot()
      return true
    },

    piloting(): boolean {
      return piloting
    },

    /** 接管中:直接下发摇杆量(外部按钮/摇杆也能驱动) */
    setStick(stick: Partial<StickState>): void {
      sim.setStick(stick)
    },

    autoTakeOff(): boolean {
      if (!piloting) return false
      return sim.autoTakeOff()
    },

    startLanding(): boolean {
      if (!piloting) return false
      return sim.startLanding()
    },

    startRth(): boolean {
      if (!piloting) return false
      return sim.startRth('飞手触发')
    },

    snapshot(): DroneSnapshot {
      return sim.snapshot()
    },

    flight(): RaceDroneFlight | null {
      if (!piloting) return null
      return flightReadout(sim.snapshot())
    },

    /**
     * 每帧推进。`anchor` 是车辆的米制位姿;接管后锚点只用于退出时的回位。
     * `dt` 传 0 表示场景暂停(无人机仍然保持悬停姿势,不推进物理)。
     */
    update(dt: number, anchor: RaceDroneAnchor): void {
      if (disposed || !enabled || report.status !== 'ready' || !rig || !model) return
      const delta = THREE.MathUtils.clamp(dt, 0, 0.3)
      elapsed += delta

      if (piloting) {
        accumulator += delta
        let steps = 0
        while (accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
          sim.setStick(stickFromKeys())
          sim.step(FIXED_STEP)
          accumulator -= FIXED_STEP
          steps += 1
        }
        if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0
        // 飞控的 x 向东、z 向南,与场景世界坐标同向,直接相加
        writePose(
          origin.x + sim.position.x,
          groundOffsetY + sim.position.y,
          origin.z + sim.position.z,
          sim.heading,
          sim.tiltPitch,
          sim.tiltRoll,
        )
        rig.updateProps(sim.motorLoad, delta)
        updateMechanics(delta)
        worldHeading = droneDegToRaceHeading(sim.heading)
        anchored = true
        root.visible = true
        return
      }

      // 跟随:锚定在车辆右前方,叠一点悬停起伏(与上游道具一致的观感)
      yawQuat.setFromAxisAngle(UP, anchor.heading)
      anchorPosition.copy(options.offset).applyQuaternion(yawQuat).add(anchor.position)
      anchorPosition.y += Math.sin(elapsed * 1.8) * options.size * 0.055

      if (rejoinTime < REJOIN_SECONDS) {
        // 刚从接管退出:从离开的位置平滑飞回车旁,避免瞬移
        rejoinTime = Math.min(REJOIN_SECONDS, rejoinTime + delta)
        const blend = smoothstep(rejoinTime / REJOIN_SECONDS)
        targetPosition.lerpVectors(rejoinFrom, anchorPosition, blend)
      } else {
        targetPosition.copy(anchorPosition)
      }

      writePose(
        targetPosition.x,
        targetPosition.y,
        targetPosition.z,
        raceHeadingToDroneDeg(anchor.heading),
        0,
        0,
      )
      // 随车悬停时机臂展开、桨叶以巡航转速空转(真机悬停就是这个样子)
      rig.updateProps(0.32, delta)
      updateMechanics(delta)
      worldHeading = anchor.heading
      anchored = true
      root.visible = true
    },

    /** 供相机跟随使用:世界位置与朝向(弧度,赛车约定) */
    cameraPose(): { position: THREE.Vector3; heading: number } {
      return {
        position: model ? model.position : root.position,
        heading: worldHeading,
      }
    },

    /**
     * 机载视角:把云台镜片的世界位姿写进 `target`(位置 + 光轴朝向)。
     *
     * 位置沿光轴前移 `offset` 米,免得镜头把机身鼻尖拍进画面。云台节点还没
     * 就绪(模型未载入)时返回 false,调用方应退回别的视角。
     */
    gimbalCameraPose(target: THREE.Object3D, offset = 0): boolean {
      if (!rig || !model) return false
      if (!rig.getGimbalCameraTransform(target)) return false
      if (offset !== 0) {
        gimbalForward.set(0, 0, -1).applyQuaternion(target.quaternion).normalize()
        target.position.addScaledVector(gimbalForward, offset)
      }
      target.updateMatrixWorld(true)
      return true
    },

    /** 云台俯仰(度):负 = 俯视,0 = 水平。返回夹紧后的实际角度 */
    setGimbalPitch(pitch: number): number {
      sim.setGimbalPitch(pitch)
      return sim.gimbalPitch
    },

    gimbalPitch(): number {
      return sim.gimbalPitch
    },

    state(): RaceDroneState {
      return {
        ...report,
        enabled,
        visible: root.visible,
        position: (model ? model.position : root.position)
          .toArray()
          .map((value) => Number(value.toFixed(3))),
        heading: worldHeading,
        piloting,
        armFold: rig ? rig.armFold : 1,
      }
    },

    dispose() {
      if (disposed) return
      disposed = true
      releasePilot()
      root.visible = false
      root.removeFromParent()
      if (model) releaseModel(model)
      rig?.destroy()
      rig = null
      model = null
      root.clear()
    },
  }
}

export type RaceDrone = ReturnType<typeof createRaceDrone>
