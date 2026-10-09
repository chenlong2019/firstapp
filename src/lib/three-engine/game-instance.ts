/**
 * DJI 飞行沙盒的场景装配层(GameInstance)。
 *
 * 把渲染器(THREEViewer)、飞行仿真与模型机械(DroneFly)、缩放轨道控制器装成一体,
 * 并驱动每帧主循环:更新 FPS → 轨道控制器 → 阴影焦点 → 录像/拍照取景 → render → 仿真推进。
 * 对外导出 GameInstance,向上层暴露快照/遥测/FPS 等只读查询,以及 destroy 释放资源。
 * 约定:构造即触发异步初始化(不能 await),就绪前各查询返回空或默认值。
 */
import * as THREE from 'three'
import { THREEViewer } from './three-viewer'
import type { WebGPURenderer } from 'three/webgpu'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { DroneFly, type DroneSnapshot } from './drone-fly'

/** DJI 飞行沙盒的场景装配:渲染器 + 飞行仿真 + 模型机械 + 灯光 */
export class GameInstance {
  private container: HTMLElement
  private flyViewer: THREEViewer | null = null
  camera?: THREE.PerspectiveCamera | null
  scene?: THREE.Scene<THREE.Object3DEventMap> | null
  renderer?: WebGPURenderer | null
  controls?: OrbitControls<THREE.Camera> | null
  floor?: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial, THREE.Object3DEventMap> | null
  axes?: THREE.AxesHelper | null
  animationFrame = 0
  private fps = 0
  private fpsFrames = 0
  private fpsWindowStart = 0
  private fpsElement: HTMLDivElement | null = null
  private previousFrameTime = 0
  droneFly?: DroneFly

  constructor(container: HTMLElement) {
    this.container = container
    // 构造不能 await:异步初始化 fire-and-forget,就绪与否由 ready 判定
    void this.init()
  }

  async init() {
    this.flyViewer = new THREEViewer(this.container)
    await this.flyViewer.initialize()
    const { camera, scene, renderer, controls, floor, axes } = this.flyViewer.getObject()
    this.camera = camera
    this.scene = scene
    this.renderer = renderer
    this.controls = controls
    this.floor = floor
    this.axes = axes
    this.createFpsDisplay()
    this.droneFly = new DroneFly(scene, camera, renderer, controls)
    this.startLoop()
    try {
      // 模型加载失败不阻断主循环:仍可渲染空场景并留下错误日志
      await this.droneFly.initialize()
    } catch (error) {
      console.error('Failed to load DJI Mini 4 Pro model.', error)
    }
    // 仅开发环境挂调试句柄,生产构建会被摇掉
    if (import.meta.env.DEV) {
      ;(
        window as unknown as {
          __djiDebug?: {
            game: GameInstance
            fly: DroneFly | undefined
            sim: unknown
            THREE: typeof THREE
          }
        }
      ).__djiDebug = {
        game: this,
        fly: this.droneFly,
        sim: this.droneFly?.sim,
        THREE,
      }
    }
  }

  private startLoop(): void {
    const render = (timestamp: number): void => {
      this.animationFrame = window.requestAnimationFrame(render)
      this.updateFps(timestamp)
      // 仅观察者模式驱动轨道控制器:机载/跟随视角下相机的位置与朝向由
      // droneFly.updateCamera 每帧全权写入,controls.update() 的强制
      // lookAt(target) 会把机载画面变成"停在云台位置回头看飞机"。
      if (this.droneFly?.isOrbitView ?? true) this.controls?.update()
      this.syncShadowFocus()
      // 录像:先交一帧云台取景给录制器(屏幕照旧显示用户所在视角),未录制时零开销
      this.droneFly?.captureRecordingFrame()
      // 拍照取景:必须在 render 之前把相机摆到云台视角
      this.droneFly?.onBeforeRender()
      if (this.scene && this.camera) this.renderer?.render(this.scene, this.camera)
      // 拍照拷屏:必须与 render 处于同一任务,否则拿到的是上一帧
      this.droneFly?.onAfterRender()
      // 帧间隔上限 2 s:切回后台标签页时避免仿真一帧推进过多
      const deltaSeconds = this.previousFrameTime
        ? Math.min((timestamp - this.previousFrameTime) / 1000, 2)
        : 1 / 60
      this.previousFrameTime = timestamp
      this.droneFly?.animate(deltaSeconds)
    }
    this.fpsWindowStart = performance.now()
    this.animationFrame = window.requestAnimationFrame(render)
  }

  /** 让太阳/阴影范围跟着飞机走,飞多远都有影子 */
  private syncShadowFocus(): void {
    const sim = this.droneFly?.sim
    if (!sim) return
    this.flyViewer?.setShadowFocus(sim.position.x, sim.position.z)
  }

  private updateFps(timestamp: number): void {
    this.fpsFrames += 1
    const elapsed = timestamp - this.fpsWindowStart
    // 每 500 ms 结算一次 FPS,避免数字跳动过快
    if (elapsed < 500) return

    this.fps = Math.round((this.fpsFrames * 1000) / elapsed)
    this.fpsFrames = 0
    this.fpsWindowStart = timestamp
    if (this.fpsElement) this.fpsElement.textContent = `FPS ${this.fps}`
  }

  private createFpsDisplay(): void {
    const fpsElement = document.createElement('div')
    fpsElement.textContent = 'FPS --'
    fpsElement.setAttribute('aria-label', 'Current frames per second')
    Object.assign(fpsElement.style, {
      position: 'absolute',
      top: '10px',
      left: '10px',
      zIndex: '10',
      padding: '4px 7px',
      color: '#8fd8c6',
      background: 'rgb(7 17 22 / 78%)',
      border: '1px solid rgb(121 230 202 / 26%)',
      borderRadius: '4px',
      font: '600 9px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace',
      letterSpacing: '0.08em',
      pointerEvents: 'none',
      backdropFilter: 'blur(8px)',
    })
    this.container.appendChild(fpsElement)
    this.fpsElement = fpsElement
  }

  getFps(): number {
    return this.fps
  }

  getSnapshot(): DroneSnapshot | null {
    return this.droneFly?.getSnapshot() ?? null
  }

  getDroneLightsSnapshot() {
    return this.droneFly?.getLightsSnapshot() ?? null
  }

  getDroneTelemetry() {
    return (
      this.droneFly?.getTelemetry() ?? {
        speedMetersPerSecond: 0,
        altitudeMeters: 0,
        isFlying: false,
      }
    )
  }

  /** 场景调试开关:坐标轴 */
  setAxesVisible(visible: boolean): void {
    this.flyViewer?.setAxesVisible(visible)
  }

  /** 模型机械件的自检报告 */
  getRigReport() {
    return this.droneFly?.getRigReport() ?? []
  }

  /** 模型已载入且沙盒可用 */
  get ready(): boolean {
    return Boolean(this.droneFly?.rig)
  }

  destroy() {
    window.cancelAnimationFrame(this.animationFrame)
    this.fpsElement?.remove()
    this.fpsElement = null
    this.droneFly?.destroy()
    this.droneFly = undefined
    if (this.flyViewer) {
      this.flyViewer.destroy()
      this.flyViewer = null
    }
  }
}
