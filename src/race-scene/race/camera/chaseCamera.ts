// 本文件实现第三人称"追车相机"：位置与朝向都用指数平滑跟随车辆，并按速度微调 FOV。
// 位置：race-scene/race/camera，输入是上层传入的车辆状态 VehicleState。
// 对外导出：createChaseCamera 工厂，以及 ChaseCamera / ChaseCameraConfig 两个类型。
// 非直觉约定：yawStiffness 刻意远低于位置刚度 stiffness，让车身先转进弯、镜头再跟上，
// 而不是让车钉在画面正中、看起来像世界在旋转；详见下方该字段的英文注释。
import * as THREE from 'three'
import type { VehicleState } from '../car/vehicle'

/** 追车相机参数：FOV 上下限、跟随距离/高度、注视点偏移，以及位置与朝向两套跟随刚度。 */
export type ChaseCameraConfig = {
  baseFov: number
  speedFov: number
  /** Camera distances and heights are in metres. */
  distance: number
  height: number
  lookAhead: number
  lookHeight: number
  /** How fast the camera position follows the car, per second. */
  stiffness: number
  /**
   * How fast the camera swings its aim around to the car's heading. Kept well
   * below `stiffness` on purpose: if the camera matches the heading instantly
   * the car sits frozen in the middle of the frame and a corner reads as the
   * world spinning instead of the car turning.
   */
  yawStiffness: number
}

/** 追车相机句柄：持有底层相机，提供逐帧更新与瞬移到位（生成/重置）两种操作。 */
export type ChaseCamera = {
  camera: THREE.PerspectiveCamera
  update(dt: number, state: VehicleState): void
  /** Jump straight to the ideal pose, for spawns and resets. */
  snap(state: VehicleState): void
}

/** 创建追车相机：每帧按车辆状态平滑更新相机位姿与 FOV。 */
export function createChaseCamera(
  camera: THREE.PerspectiveCamera,
  config: ChaseCameraConfig,
  maxSpeed: number,
): ChaseCamera {
  const forward = new THREE.Vector3()
  const desired = new THREE.Vector3()
  const desiredLook = new THREE.Vector3()
  const lookAt = new THREE.Vector3()
  let initialised = false
  /** Smoothed heading the camera is currently aimed along. */
  let yaw = 0

  const pose = (state: VehicleState) => {
    // yaw 约定：0 朝 +Z，forward = (sin, 0, cos)，与车辆 heading 一致。
    forward.set(Math.sin(yaw), 0, Math.cos(yaw))
    desired.copy(state.position).addScaledVector(forward, -config.distance)
    desired.y += config.height
    desiredLook.copy(state.position).addScaledVector(forward, config.lookAhead)
    desiredLook.y += config.lookHeight
  }

  return {
    camera,
    snap(state) {
      yaw = state.heading
      pose(state)
      camera.position.copy(desired)
      lookAt.copy(desiredLook)
      camera.lookAt(lookAt)
      initialised = true
    },
    update(dt, state) {
      const delta = Math.max(dt, 0)
      if (!initialised) yaw = state.heading
      // 先把角差折算到 -π..π 取最短转向，避免镜头绕远路。
      let error = state.heading - yaw
      error = Math.atan2(Math.sin(error), Math.cos(error))
      yaw += error * (1 - Math.exp(-config.yawStiffness * delta))
      pose(state)
      if (!initialised) {
        camera.position.copy(desired)
        lookAt.copy(desiredLook)
        initialised = true
      } else {
        // 1 - e^(-k·dt) 形式让平滑速度与帧率无关。
        const alpha = 1 - Math.exp(-config.stiffness * delta)
        camera.position.lerp(desired, alpha)
        lookAt.lerp(desiredLook, alpha)
      }
      camera.lookAt(lookAt)
      const ratio = Math.min(Math.abs(state.speed) / maxSpeed, 1)
      camera.fov = config.baseFov + (config.speedFov - config.baseFov) * ratio
      camera.updateProjectionMatrix()
    },
  }
}
