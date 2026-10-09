import * as THREE from 'three'
import type { CarRig } from './loadCar'
import type { TrackSurface } from '../track/trackSurface'
import { fromLegacyUnits } from '../units'

/**
 * 纯物理的车辆运动模型（自行车模型），不含任何 three 渲染。
 *
 * 在整体里的位置：race/car 的仿真层，读取 VehicleInput 与赛道面 TrackSurface，
 * 产出 VehicleState；three 侧由 syncRig 把状态写回 CarRig 的位姿。
 *
 * 对外导出：createVehicle 工厂，以及 Vehicle / VehicleInput / VehicleConfig 等类型。
 * 非直觉约定：速度单位为米/秒、角度为弧度；maxSpeed 由 metres(200/3.6) 给出（200 km/h）；
 * 常量里的 fromLegacyUnits 是上游旧单位换算，不是运行时量纲。
 */

/** 驾驶输入：油门、刹车、转向，均为归一化量。 */
export type VehicleInput = {
  /** 0..1 */
  throttle: number
  /** 0..1; doubles as reverse when stopped. */
  brake: number
  /** -1 (left) .. +1 (right) */
  steer: number
}

/** 车辆物理参数（速度米/秒、加速度米/秒²、角度弧度）。 */
export type VehicleConfig = {
  maxSteerDegrees: number
  /** How fast a held steering key ramps in, in input units per second. */
  inputRampPerSecond: number
  /** Faster self centring when the keys are released. */
  inputReturnPerSecond: number
  /** Peak lateral acceleration the tyres hold, in metres per second squared. */
  gripAcceleration: number
  /**
   * Corner assist gain, per second. Above zero the car gives up speed for a
   * corner on its own, the way a driver lifting off would, so a player who
   * simply holds the throttle still makes the corner. Zero disables it.
   */
  cornerAssist: number
  /** Hardest the assist may decelerate, in metres per second squared. */
  cornerAssistBrake: number
  /** Share of the grip limit the assist aims for, leaving the driver a margin. */
  cornerAssistMargin: number
  engineAcceleration: number
  brakeDeceleration: number
  reverseAcceleration: number
  rollingResistance: number
  dragCoefficient: number
  /** Body roll at full steering and full speed, in radians. */
  bodyRoll: number
  /** Lowest fraction of the mechanical lock the front wheels still show. */
  visualLockFloor: number
  maxSpeed: number
  maxReverseSpeed: number
}

/** 车辆运动状态。 */
export type VehicleState = {
  /** World position in metres; heading and steering use radians. */
  position: THREE.Vector3
  heading: number
  /** Signed speed in metres per second. */
  speed: number
  /** Ramped steering command, -1..1. */
  steerInput: number
  /** Effective road wheel angle in radians, after the grip limit is applied. */
  steer: number
  /**
   * Front wheel angle shown on the model, in radians: the driver's input at the
   * mechanical lock. The grip limit is a limit on how fast the car can yaw, not
   * on how far the wheel can turn, so the wheels keep answering the wheel even
   * when the tyres are already at their limit. Showing `steer` instead makes
   * the front wheels look frozen at speed.
   */
  steerAngle: number
  wheelSpin: number
  distance: number
  lateral: number
}

/** createVehicle 的配置：赛道面、几何尺寸与物理参数。 */
export type VehicleOptions = {
  track: TrackSurface
  wheelbase: number
  wheelRadius: number
  config: VehicleConfig
  /** Lateral lane offset the car spawns and resets in. */
  spawnLateral: number
}

/** 车辆模型对外接口：输入、状态、步进与写回模型。 */
export type Vehicle = {
  readonly input: VehicleInput
  readonly state: VehicleState
  setInput(patch: Partial<VehicleInput>): void
  step(dt: number): void
  reset(distance?: number, lateral?: number): void
  syncRig(rig: CarRig): void
  /**
   * Fastest speed the road ahead allows right now, from the corner profile.
   * The corner assist uses it to lift off, and the autopilot uses the same
   * number to decide between throttle and brake, so both agree on what the
   * corner in front is worth.
   */
  cornerLimit(): number
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const moveTowards = (current: number, target: number, maxDelta: number) =>
  current + clamp(target - current, -maxDelta, maxDelta)
const wrapAngle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value))
// 低速/停下阈值（米每秒，经旧单位换算）：低于 LOW_SPEED 不再施加机械转角与转向助力；
// 低于 STOP_SPEED 且无油门时速度直接清零，避免残余蠕动。
const LOW_SPEED = fromLegacyUnits(0.5)
const STOP_SPEED = fromLegacyUnits(0.02)

/**
 * 构建车辆运动模型。
 *
 * @param options 赛道面、轴距、轮半径、物理参数与出生横向偏移
 * @returns Vehicle 实例；创建时已完成一次 reset
 */
export function createVehicle(options: VehicleOptions): Vehicle {
  const { track, config, wheelbase, wheelRadius, spawnLateral } = options
  const input: VehicleInput = { throttle: 0, brake: 0, steer: 0 }
  const state: VehicleState = {
    position: new THREE.Vector3(),
    heading: 0,
    speed: 0,
    steerInput: 0,
    steer: 0,
    steerAngle: 0,
    wheelSpin: 0,
    distance: 0,
    lateral: 0,
  }

  const reset = (distance = track.startDistance, lateral = spawnLateral) => {
    const frame = track.frameAtDistance(distance)
    state.position.copy(track.pointAt(distance, lateral))
    // Face along the direction of travel: the rig model's forward is +Z.
    state.heading = frame.heading
    state.speed = 0
    state.steerInput = 0
    state.steer = 0
    state.steerAngle = 0
    state.wheelSpin = 0
    state.distance = distance
    state.lateral = lateral
    input.throttle = 0
    input.brake = 0
    input.steer = 0
  }

  /**
   * Fastest the car may be going right now and still make every corner inside
   * the braking window, assuming it brakes at `cornerAssistBrake` from here on.
   *
   * The road ahead is sampled into corner speeds, then the profile is walked
   * backwards with `v² = v_next² + 2as`. That is what puts the braking point in
   * the right place: a naive per-sample limit lets the car arrive at the corner
   * far too fast, because the sample that lands inside the corner is allowed to
   * be quicker than the corner itself.
   */
  const cornerSpeedLimit = (distance: number, speed: number) => {
    // 前视距离约 1.8 秒车速，限幅在约 46..275 米之间，并把前方分 12 段采样。
    const reach = clamp(speed * 1.8, fromLegacyUnits(200), fromLegacyUnits(1200))
    const samples = 12
    const span = reach / samples
    let previous = track.frameAtDistance(distance + span).heading
    const cornerSpeeds: number[] = []
    for (let i = 2; i <= samples; i++) {
      const ahead = span * i
      const heading = track.frameAtDistance(distance + ahead).heading
      const bend = wrapAngle(heading - previous)
      previous = heading
      if (Math.abs(bend) < 1e-4) {
        cornerSpeeds.push(Infinity)
        continue
      }
      const radius = span / Math.abs(bend)
      cornerSpeeds.push(Math.sqrt(config.gripAcceleration * radius) * config.cornerAssistMargin)
    }
    let limit = cornerSpeeds[cornerSpeeds.length - 1]
    for (let i = cornerSpeeds.length - 2; i >= 0; i--) {
      limit = Math.min(
        cornerSpeeds[i],
        Math.sqrt(limit * limit + 2 * config.cornerAssistBrake * span),
      )
    }
    return Math.sqrt(limit * limit + 2 * config.cornerAssistBrake * span)
  }

  const step = (dt: number) => {
    if (!Number.isFinite(dt) || dt <= 0) return
    // A keyboard key is a 0/1 switch, so ramp the command instead of snapping
    // the wheels to full lock the instant a direction key goes down.
    const command = clamp(input.steer, -1, 1)
    const ramp = command === 0 ? config.inputReturnPerSecond : config.inputRampPerSecond
    state.steerInput = moveTowards(state.steerInput, command, ramp * dt)

    // Grip limited steering. A car cornering at radius R holds a = v^2 / R and
    // R = wheelbase / tan(angle), so the angle that saturates the tyres is
    // tan(angle) = grip * wheelbase / v^2. Standstill keeps the mechanical lock.
    const speed = Math.abs(state.speed)
    const maxLock = (config.maxSteerDegrees * Math.PI) / 180
    const gripLock =
      speed > LOW_SPEED
        ? Math.atan((config.gripAcceleration * wheelbase) / (speed * speed))
        : Infinity
    state.steer = state.steerInput * Math.min(maxLock, gripLock)
    // What the player sees: the driver's command at the mechanical lock, only
    // tapered near top speed so a locked wheel does not look absurd at 250 km/h.
    // The floor keeps it obvious: the grip limit alone would show 3 degrees at
    // 70 km/h, which is physically right and visually invisible.
    const taper = clamp(1.25 - speed / config.maxSpeed, config.visualLockFloor, 1)
    state.steerAngle = state.steerInput * maxLock * taper

    // Corner assist. Lifting off is the first thing a driver does for a corner,
    // so when the car is over the speed the road ahead allows the engine is cut
    // entirely; the proportion below only has to fight rolling resistance and
    // drag, which is what keeps it from hanging above the limit.
    const cornerLimit =
      config.cornerAssist > 0 && state.speed > LOW_SPEED
        ? cornerSpeedLimit(state.distance, state.speed)
        : Infinity
    const overLimit = state.speed > cornerLimit

    let acceleration = 0
    if (input.throttle > 0 && !overLimit)
      acceleration += config.engineAcceleration * clamp(input.throttle, 0, 1)
    if (input.brake > 0) {
      const force = config.brakeDeceleration * clamp(input.brake, 0, 1)
      acceleration -=
        state.speed > LOW_SPEED ? force : config.reverseAcceleration * clamp(input.brake, 0, 1)
    }
    if (overLimit)
      acceleration -= Math.min(
        config.cornerAssist * (state.speed - cornerLimit),
        config.cornerAssistBrake,
      )
    acceleration -= Math.sign(state.speed) * config.rollingResistance
    acceleration -= state.speed * Math.abs(state.speed) * config.dragCoefficient
    state.speed = clamp(state.speed + acceleration * dt, -config.maxReverseSpeed, config.maxSpeed)
    if (Math.abs(state.speed) < STOP_SPEED && input.throttle === 0) state.speed = 0

    // Bicycle model: the rear axle follows the front axle's heading. A model
    // facing +Z has its right hand along -X, and heading is measured from +Z
    // towards +X, so steering right (positive input) decreases the heading.
    state.heading -= (state.speed / wheelbase) * Math.tan(state.steer) * dt
    state.position.x += Math.sin(state.heading) * state.speed * dt
    state.position.z += Math.cos(state.heading) * state.speed * dt
    state.wheelSpin += (state.speed / wheelRadius) * dt

    // Keep the car on the carriageway: the kerb and the median act as walls.
    const projection = track.project(state.position.x, state.position.z)
    state.distance = projection.distance
    let lateral = projection.lateral
    const limit =
      lateral < track.lateralMin
        ? track.lateralMin
        : lateral > track.lateralMax
          ? track.lateralMax
          : null
    if (limit !== null) {
      const frame = track.frameAtDistance(projection.distance)
      const correction = limit - lateral
      state.position.x += frame.lateral.x * correction
      state.position.z += frame.lateral.z * correction
      lateral = limit
      // Contact scrub scales with how square the car meets the barrier: sliding
      // along it is nearly free, driving into it bleeds speed fast.
      const misalignment = Math.abs(Math.sin(state.heading - frame.heading))
      state.speed *= Math.exp(-misalignment * 0.8 * dt)
      // A barrier also resists rotation into it, otherwise a held steering key
      // keeps the car angled at the wall and it grinds to a stop. The strength
      // scales with how square the car meets the wall: a shallow scrape must
      // leave the steering free, or the nose stops answering the wheel exactly
      // when the player is turning.
      const square = Math.min(1, (misalignment * misalignment) / 0.12)
      if (square > 0.01) {
        const travel = state.speed >= 0 ? frame.heading : frame.heading + Math.PI
        let delta = travel - state.heading
        delta = Math.atan2(Math.sin(delta), Math.cos(delta))
        state.heading += delta * (1 - Math.exp(-2.5 * square * dt))
      }
    }
    state.lateral = lateral
    state.position.y = track.surfaceY
  }

  const syncRig = (rig: CarRig) => {
    rig.root.position.copy(state.position)
    // The body leans out of the corner. Small, but it is what makes a shallow
    // steering angle read as a turn on screen. Driven by lateral load rather
    // than by speed, so it also shows on a track where corners are taken slowly.
    const lateralLoad = (Math.abs(state.speed) * state.speed * Math.tan(state.steer)) / wheelbase
    const lean = Math.sign(state.steer) * clamp(lateralLoad / config.gripAcceleration, -1, 1)
    rig.root.rotation.set(0, state.heading, lean * config.bodyRoll)
    for (const wheel of rig.wheels) {
      // Positive steer is a right turn, which points the wheels towards -X.
      if (wheel.front) wheel.steer.rotation.y = -state.steerAngle
      wheel.spin.rotation.x = state.wheelSpin
    }
  }

  reset()
  return {
    input,
    state,
    setInput(patch) {
      Object.assign(input, patch)
    },
    step,
    reset,
    syncRig,
    cornerLimit: () => cornerSpeedLimit(state.distance, state.speed),
  }
}
