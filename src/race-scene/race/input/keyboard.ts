// 本文件把键盘按键翻译成车辆输入结构 VehicleInput：WASD 与方向键都生效。
// 位置：race-scene/race/input，产出的输入对象由上层（车辆控制器）消费。
// 对外导出：createKeyboardInput 工厂，以及 KeyboardInput 类型。
// 非直觉约定：throttle/brake 只输出 0/1，steer 输出 -1/0/+1；到连续量的斜坡化由上层完成。
import type { VehicleInput } from '../car/vehicle'

/** 键盘输入句柄：暴露合并后的输入对象，dispose 时解除所有事件监听。 */
export type KeyboardInput = { readonly input: VehicleInput; dispose(): void }

/** WASD and the arrow keys both drive; the vehicle only sees the merged axes. */
export function createKeyboardInput(target: Window = window): KeyboardInput {
  const input: VehicleInput = { throttle: 0, brake: 0, steer: 0 }
  const pressed = new Set<string>()
  const apply = () => {
    const forward = pressed.has('KeyW') || pressed.has('ArrowUp')
    const back = pressed.has('KeyS') || pressed.has('ArrowDown')
    const left = pressed.has('KeyA') || pressed.has('ArrowLeft')
    const right = pressed.has('KeyD') || pressed.has('ArrowRight')
    input.throttle = forward ? 1 : 0
    input.brake = back ? 1 : 0
    input.steer = (right ? 1 : 0) - (left ? 1 : 0)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    pressed.add(event.code)
    apply()
    // 方向键会滚动页面，必须阻止默认行为；WASD 不需要。
    if (event.code.startsWith('Arrow')) event.preventDefault()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    pressed.delete(event.code)
    apply()
  }
  // 失焦（切标签 / 点到别处）时清空按键，避免留下"卡住的油门"。
  const onBlur = () => {
    pressed.clear()
    apply()
  }
  target.addEventListener('keydown', onKeyDown)
  target.addEventListener('keyup', onKeyUp)
  target.addEventListener('blur', onBlur)
  return {
    input,
    dispose() {
      target.removeEventListener('keydown', onKeyDown)
      target.removeEventListener('keyup', onKeyUp)
      target.removeEventListener('blur', onBlur)
    },
  }
}
