/**
 * water-sky 的独立浏览器查看器：在给定 DOM 容器里创建 renderer、相机、OrbitControls
 * 与主循环，对外导出 createWaterSkyScene。若宿主自带渲染器，则本模块只搭场景与相机、
 * 由宿主驱动 update/render，renderer 始终归宿主所有。
 * 相机位置/裁剪距离单位为米，fov 为角度，时间单位为秒。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { DEFAULT_CAMERA, DEFAULT_QUALITY, TOP_CAMERA, finiteVector, positiveNumber } from './config'
import { createWaterSkyEnvironment } from './environment'
import type { WaterSkyCameraPreset, WaterSkyHandle, WaterSkyOptions } from './types'
import { fromLegacyUnits as legacy } from '../units'

function cameraPreset(
  patch: Partial<WaterSkyCameraPreset>,
  base: WaterSkyCameraPreset,
): WaterSkyCameraPreset {
  const preset = {
    position: finiteVector(patch.position ?? base.position, 'camera.position'),
    target: finiteVector(patch.target ?? base.target, 'camera.target'),
    fov: positiveNumber(patch.fov ?? base.fov, 'camera.fov'),
    near: positiveNumber(patch.near ?? base.near, 'camera.near'),
    far: positiveNumber(patch.far ?? base.far, 'camera.far'),
  }
  if (preset.fov >= 180 || preset.far <= preset.near)
    throw new RangeError('Camera requires fov < 180 and far > near')
  return preset
}

/** Optional browser viewer. Use createWaterSkyEnvironment for an existing scene/loop. */
export function createWaterSkyScene(options: WaterSkyOptions): WaterSkyHandle {
  const ownsRenderer = !options.renderer
  if (!ownsRenderer && options.autoStart === true)
    throw new Error('Use the host render loop with an external renderer')
  let fixedTime = options.fixedTime ?? null
  if (fixedTime !== null && (!Number.isFinite(fixedTime) || fixedTime < 0))
    throw new RangeError('fixedTime must be finite and non-negative')
  const initialCamera = cameraPreset(options.camera ?? {}, DEFAULT_CAMERA)
  const pixelRatio = Math.min(
    positiveNumber(options.pixelRatio ?? globalThis.devicePixelRatio ?? 1, 'pixelRatio'),
    DEFAULT_QUALITY.maxPixelRatio,
  )
  // Validate parameters/geometry before allocating a WebGL context or touching the DOM.
  const environment = createWaterSkyEnvironment(options)
  let renderer: THREE.WebGLRenderer
  try {
    renderer = options.renderer ?? new THREE.WebGLRenderer({ antialias: true, alpha: false })
  } catch (error) {
    environment.dispose()
    throw error
  }
  if (ownsRenderer) {
    renderer.setPixelRatio(pixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.NoToneMapping
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none'
    options.container.appendChild(renderer.domElement)
  }
  const scene = new THREE.Scene()
  scene.add(environment.root)
  const camera = new THREE.PerspectiveCamera(
    initialCamera.fov,
    1,
    initialCamera.near,
    initialCamera.far,
  )
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.045
  // 轨道缩放距离限制（旧单位）：20 为最近贴近，1800 为最远俯瞰。
  controls.minDistance = legacy(20)
  controls.maxDistance = legacy(1800)
  // OrbitControls polar angle is measured from +Y: π/2 is the true horizon,
  // and the top camera preset is allowed to pass through to exactly vertical.
  controls.maxPolarAngle = Math.PI / 2
  let disposed = false
  let running = false
  let frame = 0
  let lastFrame = 0
  let elapsed = fixedTime ?? 0
  let observer: ResizeObserver | undefined

  const setCamera = (patch: Partial<WaterSkyCameraPreset>) => {
    if (disposed) return
    const preset = cameraPreset(patch, {
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
    })
    controls.autoRotate = false
    // Flush residual orbit damping before setting a deterministic camera preset.
    controls.enableDamping = false
    controls.enableDamping = false
    controls.update()
    camera.position.fromArray(preset.position)
    controls.target.fromArray(preset.target)
    camera.fov = preset.fov
    camera.near = preset.near
    camera.far = preset.far
    camera.lookAt(controls.target)
    camera.updateProjectionMatrix()
    controls.update()
    controls.enableDamping = true
    environment.update(elapsed, camera)
  }

  const handle: WaterSkyHandle = {
    scene,
    camera,
    renderer,
    controls,
    environment,
    materials: environment.materials,
    getParams: environment.getParams,
    setParams: environment.setParams,
    getTime: () => elapsed,
    setTime(seconds) {
      if (disposed) return
      if (seconds !== null && (!Number.isFinite(seconds) || seconds < 0))
        throw new RangeError('Time must be finite and non-negative')
      fixedTime = seconds
      if (seconds !== null) elapsed = seconds
      environment.update(elapsed, camera)
    },
    setAutoRotate(enabled) {
      if (!disposed) controls.autoRotate = enabled
    },
    setCamera,
    resetCamera: () => setCamera(initialCamera),
    setTopCamera: () => setCamera(TOP_CAMERA),
    resize(width, height) {
      if (disposed || width <= 0 || height <= 0) return
      positiveNumber(width, 'width')
      positiveNumber(height, 'height')
      if (ownsRenderer) renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    },
    update(deltaSeconds) {
      if (disposed) return
      if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0)
        throw new RangeError('deltaSeconds must be finite and non-negative')
      if (fixedTime === null) elapsed += deltaSeconds
      // OrbitControls' update(delta) is version-sensitive and can reject a
      // host-provided delta; the scene clock is independent of control damping.
      controls.update()
      environment.update(elapsed, camera)
    },
    render() {
      if (disposed) return
      environment.update(elapsed, camera)
      environment.renderReflection(renderer, scene, camera)
      renderer.render(scene, camera)
    },
    start() {
      if (disposed || running) return
      if (!ownsRenderer) throw new Error('External renderer: call update/render from the host loop')
      running = true
      lastFrame = performance.now()
      const tick = () => {
        if (!running || disposed) return
        const now = performance.now()
        // 单帧步长上限 0.1 秒；切换到后台再回来时不至于一次性跳变太多时间。
        handle.update(Math.min((now - lastFrame) / 1000, 0.1))
        lastFrame = now
        handle.render()
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    },
    stop() {
      running = false
      cancelAnimationFrame(frame)
    },
    dispose() {
      if (disposed) return
      handle.stop()
      disposed = true
      observer?.disconnect()
      controls.dispose()
      environment.dispose()
      if (ownsRenderer) {
        renderer.dispose()
        renderer.domElement.remove()
      }
    },
  }

  handle.resetCamera()
  handle.resize(options.container.clientWidth, options.container.clientHeight)
  if (options.autoResize ?? ownsRenderer) {
    observer = new ResizeObserver(() =>
      handle.resize(options.container.clientWidth, options.container.clientHeight),
    )
    observer.observe(options.container)
  }
  if (options.autoStart ?? ownsRenderer) handle.start()
  return handle
}
