import * as THREE from 'three'
import type { TrackSurface } from '../track/trackSurface'
import type { Vehicle, VehicleInput } from './vehicle'
import { fromLegacyUnits } from '../units'

/**
 * 车辆的循迹控制器：只依赖赛道已知的两件事——中心线走向与下一弯的可达速度。
 *
 * 在整体里的位置：race/car 的自动驾驶层。它只读 vehicle.state 与 vehicle.cornerLimit()，
 * 返回一个 VehicleInput，绝不直接碰车轮、灯光或相机，因此换车辆或换赛道只需提供同样的两个读数。
 *
 * 对外导出：createAutopilot 工厂与 Autopilot / AutopilotPlan / AutopilotOptions 类型。
 * 非直觉约定：转向为前视追踪，前视距离随车速增大——固定短目标会让车在 200 km/h 时“追着自己的车头打摆”。
 */

/**
 * A track follower for the car, built from the two things the road already
 * knows: where the centreline goes, and how fast the next corner can be taken.
 *
 * It is a pure controller - it reads `vehicle.state` and `vehicle.cornerLimit()`
 * and returns a `VehicleInput`; it never touches the wheel, the lamps or the
 * camera. That keeps it swappable: a different vehicle, or a different track,
 * only has to provide the same two readings.
 *
 * Steering is a look-ahead pursuit: aim at a point on the centreline some
 * distance in front of the car and steer towards it. The look-ahead grows with
 * speed, which is what stops the car from sawing at the wheel at 200 km/h - a
 * fixed short target would make it chase its own nose.
 */
/** 一帧的驾驶输入，与 VehicleInput 相同。 */
export type AutopilotCommand = VehicleInput

/** 控制器当前的目标点与限速，供 HUD 与自检读取。 */
export type AutopilotPlan = {
  /** Distance in front of the car the controller is aiming at, in metres. */
  lookAhead: number
  /** Where that target sits, metres either side of the centreline. */
  targetLateral: number
  /** Distance along the track the target sits at. */
  targetDistance: number
  /** Radians between the car's nose and the target. Positive is a right turn. */
  headingError: number
  /** Speed the corner profile allows right now, in metres per second. */
  speedLimit: number
}

/** createAutopilot 的配置：赛道、车辆与各项控制增益。 */
export type AutopilotOptions = {
  track: TrackSurface
  vehicle: Vehicle
  /**
   * How far the car cuts the inside of a corner, as a share of the half width
   * of the carriageway. Zero drives the centreline exactly.
   */
  apexShare?: number
  /** Look-ahead time in seconds; its minimum and maximum distances are metres. */
  lookAheadSeconds?: number
  minLookAhead?: number
  maxLookAhead?: number
  /** Steering command per radian of heading error. */
  steerGain?: number
  /** Share of the corner limit the car drives to on a straight or in a bend. */
  speedMargin?: number
  /**
   * Braking the controller plans with when the road runs out, in metres per
   * second squared. An open map ends; arriving at 200 km/h would end it against
   * the scenery.
   */
  brakeDeceleration?: number
}

/** 循迹控制器接口。 */
export type Autopilot = {
  /** One frame of driver input. Advances nothing: `vehicle.step` still does. */
  command(): AutopilotCommand
  /** What the controller is aiming at, for the HUD and for the checks. */
  plan(): AutopilotPlan
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const wrapAngle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value))

/**
 * 构建循迹控制器。
 *
 * @param options 赛道、车辆与各项控制增益
 * @returns Autopilot 实例；command() 只计算输入，推进仍由 vehicle.step 负责
 */
export function createAutopilot(options: AutopilotOptions): Autopilot {
  const { track, vehicle } = options
  // 默认参数：切弯量占半车道宽的 34%；前视 0.95 秒车速，限幅约 6.4..34.4 米；
  // 转向增益 2.4 /弧度，巡航取限速的 93%，计划停车制动约 16 m/s²。
  const apexShare = options.apexShare ?? 0.34
  const lookAheadSeconds = options.lookAheadSeconds ?? 0.95
  const minLookAhead = options.minLookAhead ?? fromLegacyUnits(28)
  const maxLookAhead = options.maxLookAhead ?? fromLegacyUnits(150)
  const steerGain = options.steerGain ?? 2.4
  const speedMargin = options.speedMargin ?? 0.93
  const brakeDeceleration = options.brakeDeceleration ?? fromLegacyUnits(70)
  const laneHalf = (track.lateralMax - track.lateralMin) * 0.5
  // The lane is not always centred on the deck: the bridge carriageway sits to
  // one side of its centreline, so everything here is measured from the lane
  // centre, not from lateral zero.
  const laneCentre = (track.lateralMin + track.lateralMax) * 0.5
  const target = new THREE.Vector3()

  const plan = (): AutopilotPlan => {
    const state = vehicle.state
    const speed = Math.abs(state.speed)
    const lookAhead = clamp(speed * lookAheadSeconds, minLookAhead, maxLookAhead)
    // Reversing aims behind the car, so the same controller can back out of a
    // mess instead of steering into it.
    const direction = state.speed < -fromLegacyUnits(0.2) ? -1 : 1
    const ahead = state.distance + lookAhead * direction
    const near = track.frameAtDistance(ahead)
    const far = track.frameAtDistance(ahead + lookAhead * 0.8 * direction)
    const bend = wrapAngle(far.heading - near.heading)
    // Positive lateral is the car's right, and a right-hand bend is a negative
    // heading change, so the apex sits on the far side of the sign.
    const cut = -Math.sign(bend) * apexShare * laneHalf * Math.min(1, Math.abs(bend) / 0.05)
    const targetLateral = clamp(
      laneCentre + cut,
      track.lateralMin + laneHalf * 0.2,
      track.lateralMax - laneHalf * 0.2,
    )
    track.pointAt(ahead, targetLateral, target)
    // Past the finish the target point stops moving and ends up under the car,
    // where atan2 is meaningless; hold the track direction instead.
    const dx = target.x - state.position.x
    const dz = target.z - state.position.z
    const headingError =
      dx * dx + dz * dz < fromLegacyUnits(2) ** 2
        ? wrapAngle(near.heading - state.heading)
        : wrapAngle(Math.atan2(dx, dz) - state.heading)
    // An open map has an end. Plan a stop for it with the same v^2 = 2as the
    // corner profile uses, so the car rolls to a halt at the finish instead of
    // driving past the last sample and trying to turn around.
    const remaining = track.length - state.distance - fromLegacyUnits(4)
    const endLimit = track.closed
      ? Infinity
      : remaining <= 0
        ? 0
        : Math.sqrt(2 * brakeDeceleration * remaining)
    return {
      lookAhead,
      targetLateral,
      targetDistance: ahead,
      headingError,
      speedLimit: Math.min(vehicle.cornerLimit(), endLimit),
    }
  }

  return {
    plan,
    command() {
      const { headingError, speedLimit } = plan()
      const speed = Math.abs(vehicle.state.speed)
      // Throttle to the corner limit, brake over it. On a straight the limit is
      // Infinity, so the car simply pulls to its top speed.
      const cruise = speedLimit * speedMargin
      return {
        // Positive steering input turns the car right, which *decreases* the
        // heading, while a target to the right sits at a smaller heading than
        // the nose. So the command carries the opposite sign to the error.
        steer: clamp(-headingError * steerGain, -1, 1),
        throttle: speed < cruise ? 1 : 0,
        brake: speed > speedLimit ? 1 : 0,
      }
    },
  }
}
