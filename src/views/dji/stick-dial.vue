<template>
  <div class="stick-dial">
    <!-- 顶部名称 -->
    <div class="stick-name">{{ label }}</div>
    <!-- 可拖拽的摇杆盘:指针在盘内拖动生成归一化杆量(圆形行程) -->
    <div
      ref="rootRef"
      class="stick-pad"
      :class="{ active, disabled: props.disabled }"
      role="slider"
      :aria-label="label"
      :aria-valuetext="`横向 ${props.x.toFixed(2)}, 纵向 ${props.y.toFixed(2)}`"
      @pointerdown.prevent="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture="onPointerUp"
    >
      <span class="stick-ring"></span>
      <span class="stick-cross-h"></span>
      <span class="stick-cross-v"></span>
      <span
        class="stick-knob"
        :style="{ '--kx': `${props.x * TRAVEL}px`, '--ky': `${-props.y * TRAVEL}px` }"
      >
        <i></i>
      </span>
    </div>
    <!-- 横 / 纵轴名(右为正 / 上为正) -->
    <div class="stick-axis">
      <span>{{ axisH }}</span>
      <span>{{ axisV }}</span>
    </div>
    <!-- 实时合成杆量数值,有输入时高亮 -->
    <div class="stick-value" :class="{ live: Math.hypot(props.x, props.y) > 0.04 }">
      {{ props.x.toFixed(2) }} / {{ props.y.toFixed(2) }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 虚拟摇杆旋钮子组件(单只)。
 * 负责显示一路摇杆的杆量并接受指针拖拽:父组件传入 label / 两个轴名 / x / y,
 * 拖动时向外派发 'move'(x 右为正、y 上为正,-1~1 归一化);松手自回中并再派发一次归零。
 */
import { ref } from 'vue'

/** 摇杆盘半径(px) − 旋钮半径(px),即旋钮圆心能移动的最大距离 */
const TRAVEL = 48

const props = defineProps<{
  label: string
  /** 横向轴名称(右为正)。注意不能叫 vLabel —— `v-` 前缀会被 Vue 当成自定义指令 */
  axisH: string
  /** 纵向轴名称(上为正) */
  axisV: string
  x: number
  y: number
  disabled?: boolean
}>()

/** 向外报告杆量变化(自回中时也会派发 { x: 0, y: 0 }) */
const emit = defineEmits<{
  (event: 'move', payload: { x: number; y: number }): void
}>()

// 摇杆盘 DOM 引用(用于把指针坐标换算成杆量)与当前是否处于拖拽中
const rootRef = ref<HTMLElement | null>(null)
const active = ref(false)

/** 把任意数值夹到摇杆行程范围 [-1, 1] */
const clamp = (value: number): number => Math.min(1, Math.max(-1, value))

/**
 * 把指针位置换算成归一化摇杆行程。
 * 盘中点 = (0,0),右/上为正,超出圆盘按圆行程归一(真机摇杆是圆形行程,斜推不会超速)。
 */
function applyPointer(event: PointerEvent): void {
  const element = rootRef.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const radius = rect.width / 2
  const centerX = rect.left + radius
  const centerY = rect.top + radius
  let dx = (event.clientX - centerX) / radius
  let dy = (centerY - event.clientY) / radius
  const magnitude = Math.hypot(dx, dy)
  if (magnitude > 1) {
    dx /= magnitude
    dy /= magnitude
  }
  emit('move', { x: clamp(dx), y: clamp(dy) })
}

/** 按下:禁用时忽略;否则捕获指针并立刻按当前落点更新杆量 */
function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  active.value = true
  rootRef.value?.setPointerCapture(event.pointerId)
  applyPointer(event)
}

/** 移动:仅在拖拽中才更新杆量(pointer capture 保证移出盘面仍能收到 move) */
function onPointerMove(event: PointerEvent): void {
  if (!active.value) return
  applyPointer(event)
}

/** DJI 遥控器摇杆是自回中的:松手立刻回中位 */
function onPointerUp(): void {
  if (!active.value) return
  active.value = false
  emit('move', { x: 0, y: 0 })
}
</script>

<style scoped lang="scss">
/* 旋钮整体:竖向排布 名称 / 摇杆盘 / 轴名 / 数值 */
.stick-dial {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  user-select: none;
}
.stick-name {
  color: #9ff1dc;
  font:
    700 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}
/* 摇杆盘:圆形容程底盘;touch-action:none 防止拖动时触发页面滚动 */
.stick-pad {
  position: relative;
  width: 152px;
  height: 152px;
  background: radial-gradient(circle at 50% 45%, rgb(24 52 56 / 92%), rgb(8 20 24 / 96%));
  border: 1px solid rgb(121 230 202 / 28%);
  border-radius: 50%;
  box-shadow:
    inset 0 2px 16px rgb(0 0 0 / 55%),
    0 8px 22px rgb(0 0 0 / 35%);
  cursor: grab;
  touch-action: none;
  transition: border-color 0.15s ease;
}
.stick-pad.active {
  border-color: rgb(121 230 202 / 70%);
  cursor: grabbing;
}
.stick-pad.disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.stick-ring {
  position: absolute;
  inset: 22px;
  border: 1px dashed rgb(121 230 202 / 20%);
  border-radius: 50%;
}
.stick-cross-h,
.stick-cross-v {
  position: absolute;
  background: rgb(121 230 202 / 14%);
}
.stick-cross-h {
  top: 50%;
  right: 12px;
  left: 12px;
  height: 1px;
}
.stick-cross-v {
  top: 12px;
  bottom: 12px;
  left: 50%;
  width: 1px;
}
/* 旋钮本体:由 --kx/--ky 变量驱动位移(只位移,不引起重排) */
.stick-knob {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  width: 56px;
  height: 56px;
  place-items: center;
  background: linear-gradient(160deg, #3d6f74, #1b3b41);
  border: 1px solid rgb(160 250 226 / 45%);
  border-radius: 50%;
  box-shadow:
    0 3px 10px rgb(0 0 0 / 45%),
    inset 0 1px 2px rgb(255 255 255 / 18%);
  transform: translate(-50%, -50%) translate(var(--kx, 0), var(--ky, 0));
  transition: transform 0.09s ease-out;
}
.stick-pad.active .stick-knob {
  transition: none;
}
.stick-knob i {
  width: 18px;
  height: 18px;
  background: rgb(121 230 202 / 22%);
  border-radius: 50%;
}
/* 底部两行:轴名与合成数值(无输入时暗色,有输入时提亮) */
.stick-axis {
  display: flex;
  justify-content: space-between;
  width: 152px;
  color: #557873;
  font:
    600 8px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.04em;
}
.stick-value {
  color: #4d7771;
  font:
    600 9px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.06em;
}
.stick-value.live {
  color: #9ff1dc;
}
</style>
