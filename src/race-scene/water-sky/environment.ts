/**
 * water-sky 环境装配：把天空穹顶、海面、日照/半球光与可选跨海大桥组装成一个
 * 自包含的 THREE.Group，并维护水面的镜面反射 pass。
 * 对外导出 createWaterSkyEnvironment；只产出场景对象，不含 DOM、渲染器、控制器、
 * 事件监听或动画循环——反射 pass 需宿主在自身渲染前调用 renderReflection 驱动。
 * 世界位置/长度单位为米，时间单位为秒。
 */
import * as THREE from 'three'
import { createSkyMaterial, sunDirectionFor } from './materials/sky'
import { createWaterMaterial } from './materials/water'
import { createBridge } from './bridge'
import {
  DEFAULT_QUALITY,
  WATER_POSITION,
  finiteVector,
  positiveNumber,
  resolveParams,
} from './config'
import type { WaterSkyEnvironment, WaterSkyEnvironmentOptions, WaterSkyParams } from './types'
import { fromLegacyUnits as legacy } from '../units'

/** Scene objects only: no DOM, renderer, controls, event listeners or animation loop. */
export function createWaterSkyEnvironment(
  options: WaterSkyEnvironmentOptions = {},
): WaterSkyEnvironment {
  let params = resolveParams(options.params ?? {})
  const size = positiveNumber(options.waterSize ?? DEFAULT_QUALITY.waterSize, 'waterSize')
  const radius = positiveNumber(options.skyRadius ?? DEFAULT_QUALITY.skyRadius, 'skyRadius')
  const segments = positiveNumber(
    options.waterSegments ?? DEFAULT_QUALITY.waterSegments,
    'waterSegments',
  )
  // 海面网格是 CPU 端一次性生成的顶点数据，限制到 1024 段以内以免分配过多几何体。
  if (!Number.isInteger(segments) || segments > 1024)
    throw new RangeError('waterSegments must be an integer from 1 to 1024')
  const position = finiteVector(options.waterPosition ?? WATER_POSITION, 'waterPosition')
  const root = new THREE.Group()
  root.name = 'water-sky-environment'
  const skyMaterial = createSkyMaterial()
  const waterMaterial = createWaterMaterial()
  // 天空颜色按方向在着色器里解析求解，球面 96×48 分段只影响穹顶拟合精度。
  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), skyMaterial)
  sky.name = 'sky-dome'
  const waterGeometry = new THREE.PlaneGeometry(size, size, segments, segments)
  waterGeometry.rotateX(-Math.PI / 2)
  const water = new THREE.Mesh(waterGeometry, waterMaterial)
  water.name = 'water-surface'
  water.position.fromArray(position)
  const sun = new THREE.DirectionalLight(0xffe6a8, 2.1)
  sun.name = 'daylight'
  const hemisphere = new THREE.HemisphereLight(0x8fb9d8, 0x193d3b, 0.55)
  hemisphere.name = 'sky-fill'
  root.add(sky, water, sun, sun.target, hemisphere)
  const bridge = options.bridge
    ? createBridge(typeof options.bridge === 'object' ? options.bridge : {})
    : null
  if (bridge) root.add(bridge)
  const eye = new THREE.Vector3()
  // Mirror pass state. The water only knows how to sample a reflection; where
  // it comes from is the host's renderer, which is why the pass lives here and
  // is driven through renderReflection below.
  let reflectionEnabled = options.reflection !== false
  const follow = options.follow === true
  let reflectionOverlay: THREE.Object3D | null = null
  let overlayMeshes = 0
  const reflectionTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    stencilBuffer: false,
  })
  reflectionTarget.texture.name = 'water-reflection'
  // Values stay linear: the water shader mixes them before its own sRGB encode.
  reflectionTarget.texture.colorSpace = THREE.NoColorSpace
  const mirrorCamera = new THREE.PerspectiveCamera()
  const mirrorMatrix = new THREE.Matrix4()
  const mirrorNormal = new THREE.Vector3(0, 1, 0)
  const waterWorld = new THREE.Vector3()
  const cameraWorld = new THREE.Vector3()
  const cameraRotation = new THREE.Matrix4()
  const cameraLook = new THREE.Vector3()
  const mirrorEye = new THREE.Vector3()
  const mirrorTarget = new THREE.Vector3()
  const drawingSize = new THREE.Vector2()
  // 反射纹理上限 1280×720：镜面只需覆盖远景粗糙结构，再大只会徒增每帧开销。
  const REFLECTION_MAX_WIDTH = 1280
  const REFLECTION_MAX_HEIGHT = 720
  let disposed = false

  /**
   * Keeps the finite sea under the eye. Without it a long drive leaves the plane
   * behind and the background falls away to bare sky. The wave field is sampled
   * in world space, so moving the mesh is invisible.
   *
   * Called from both `update` and `renderReflection`: the reflection pass needs
   * the plane where this frame's camera is, even if the host only drives that
   * one call.
   */
  function followCamera(camera: THREE.Camera) {
    if (!follow) return
    camera.getWorldPosition(eye)
    root.worldToLocal(eye)
    water.position.x = eye.x
    water.position.z = eye.z
  }

  function applyParams() {
    waterMaterial.uniforms.intensity.value = params.intensity
    waterMaterial.uniforms.rippleSize.value = params.ripple
    waterMaterial.uniforms.intensity.value = params.intensity
    waterMaterial.uniforms.wind.value = params.wind
    for (const material of [skyMaterial, waterMaterial]) {
      material.uniforms.sunHeight.value = params.sunHeight
      material.uniforms.cloudDensity.value = params.cloudDensity
      material.uniforms.sunset.value = params.sunset
    }
    // 平行光只看方向，乘 100 旧单位仅把它推到足够远处，避免光照计算受距离影响。
    sun.position.copy(sunDirectionFor(params.sunHeight)).multiplyScalar(legacy(100))
  }

  applyParams()
  return {
    root,
    materials: { sky: skyMaterial, water: waterMaterial },
    getParams: () => ({ ...params }),
    setParams(patch: Partial<WaterSkyParams>) {
      if (disposed) return
      params = resolveParams(patch, params)
      applyParams()
    },
    update(timeSeconds, camera) {
      if (disposed) return
      if (!Number.isFinite(timeSeconds) || timeSeconds < 0)
        throw new RangeError('timeSeconds must be finite and non-negative')
      camera.getWorldPosition(eye)
      root.worldToLocal(eye)
      sky.position.copy(eye)
      followCamera(camera)
      skyMaterial.uniforms.time.value = timeSeconds
      waterMaterial.uniforms.time.value = timeSeconds
    },
    renderReflection(renderer, scene, camera) {
      const uniforms = waterMaterial.uniforms
      followCamera(camera)
      if (disposed || !reflectionEnabled) {
        uniforms.reflectionStrength.value = 0
        return false
      }
      // Mirror the camera through the water plane. The mirrored camera is an
      // ordinary camera placed at the reflected eye and aimed at the reflected
      // look point, so triangle winding stays correct and nothing needs to be
      // re-culled or flipped.
      water.getWorldPosition(waterWorld)
      // The host calls this before its own render, and the renderer is what
      // normally refreshes a camera's world matrix. Without this the mirror is
      // built from last frame's pose and the reflection slides against the view.
      camera.updateMatrixWorld()
      camera.getWorldPosition(cameraWorld)
      mirrorEye.subVectors(waterWorld, cameraWorld)
      // 相机贴近或沉入水面（低于水面约 1 旧单位以内）时跳过反射，避免镜像失真。
      if (mirrorEye.dot(mirrorNormal) > legacy(-1)) {
        uniforms.reflectionStrength.value = 0
        return false
      }
      mirrorEye.reflect(mirrorNormal).negate().add(waterWorld)
      cameraRotation.extractRotation(camera.matrixWorld)
      cameraLook.set(0, 0, -1).applyMatrix4(cameraRotation).add(cameraWorld)
      mirrorTarget.subVectors(waterWorld, cameraLook).reflect(mirrorNormal).negate().add(waterWorld)
      mirrorCamera.position.copy(mirrorEye)
      mirrorCamera.up.set(0, 1, 0).applyMatrix4(cameraRotation).reflect(mirrorNormal)
      mirrorCamera.lookAt(mirrorTarget)
      // Match the host camera's frustum by setting the mirror camera's own
      // parameters and recomputing. Copying projectionMatrix alone looks
      // equivalent but is not: anything that recomputes the projection snaps it
      // back to this camera's defaults of 50 degrees and aspect 1, and the
      // mirror image no longer lines up with what the water samples.
      const host = camera as THREE.PerspectiveCamera
      if (host.isPerspectiveCamera) {
        mirrorCamera.fov = host.fov
        mirrorCamera.aspect = host.aspect
        mirrorCamera.near = host.near
        mirrorCamera.far = host.far
        mirrorCamera.updateProjectionMatrix()
      } else {
        mirrorCamera.projectionMatrix.copy(camera.projectionMatrix)
      }
      mirrorCamera.matrixWorldAutoUpdate = true
      mirrorCamera.updateMatrixWorld()
      // 标准偏置矩阵：把裁剪坐标 (-1..1) 映射到纹理 UV (0..1)。
      mirrorMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      mirrorMatrix.multiply(mirrorCamera.projectionMatrix)
      mirrorMatrix.multiply(mirrorCamera.matrixWorldInverse)
      ;(uniforms.reflectionMatrix.value as THREE.Matrix4).copy(mirrorMatrix)

      // 反射纹理取绘制缓冲的一半分辨率，并夹在下限 256×144 与上限之内。
      renderer.getDrawingBufferSize(drawingSize)
      const width = Math.max(256, Math.min(REFLECTION_MAX_WIDTH, Math.round(drawingSize.x * 0.5)))
      const height = Math.max(144, Math.min(REFLECTION_MAX_HEIGHT, Math.round(drawingSize.y * 0.5)))
      if (reflectionTarget.width !== width || reflectionTarget.height !== height)
        reflectionTarget.setSize(width, height)

      const previousTarget = renderer.getRenderTarget()
      const previousAutoClear = renderer.autoClear
      const previousAlpha = renderer.getClearAlpha()
      const previousColor = new THREE.Color()
      renderer.getClearColor(previousColor)
      const skyVisible = sky.visible
      // Water and sky stay out of their own reflection: the sky the water shows
      // is the analytic one in the shader, and this pass only has to supply the
      // geometry standing above the surface.
      water.visible = false
      sky.visible = false
      renderer.setRenderTarget(reflectionTarget)
      renderer.setClearColor(0x000000, 0)
      renderer.autoClear = true
      renderer.render(scene, mirrorCamera)
      if (reflectionOverlay) {
        // The car stands on the deck, and from below the deck hides it — so a
        // physically exact mirror shows the bridge but never the car. Draw the
        // overlay a second time with depth testing off: that is the car's
        // mirror image in the place a reflection would put it, and it is what
        // the scene is meant to read as.
        const hidden: [THREE.Object3D, boolean][] = []
        for (const child of scene.children) {
          if (child === reflectionOverlay || child === sky || child === water) continue
          hidden.push([child, child.visible])
          child.visible = false
        }
        // Keyed by material, not by mesh. Materials are shared between meshes
        // (all four wheels share rim and tyre materials, body panels share
        // paint), so pushing one entry per mesh saved `true` for the first mesh
        // and `false` for the next mesh using the same material. Restoring in
        // order then wrote `false` back and left the whole car without depth
        // testing - which is exactly how the body became see-through.
        const materials = new Map<THREE.Material, boolean>()
        overlayMeshes = 0
        reflectionOverlay.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          overlayMeshes++
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            if (!materials.has(material)) materials.set(material, material.depthTest)
            material.depthTest = false
          }
        })
        renderer.autoClear = false
        // try/finally: an exception thrown by the pass used to leave every car
        // material with depthTest false, which silently disabled depth testing
        // for the whole car and let the body be seen through.
        try {
          renderer.render(scene, mirrorCamera)
        } finally {
          renderer.autoClear = previousAutoClear
          for (const [material, depthTest] of materials) material.depthTest = depthTest
          for (const [child, visible] of hidden) child.visible = visible
        }
      }
      renderer.autoClear = previousAutoClear
      renderer.setClearColor(previousColor, previousAlpha)
      renderer.setRenderTarget(previousTarget)
      water.visible = true
      sky.visible = skyVisible
      uniforms.reflectionMap.value = reflectionTarget.texture
      uniforms.reflectionStrength.value = 1
      return true
    },
    setReflectionEnabled(enabled) {
      reflectionEnabled = Boolean(enabled)
      if (!reflectionEnabled) waterMaterial.uniforms.reflectionStrength.value = 0
    },
    setReflectionOverlay(object) {
      reflectionOverlay = object ?? null
    },
    reflectionOverlayInfo: () => ({ attached: Boolean(reflectionOverlay), meshes: overlayMeshes }),
    reflectionCoverage(renderer) {
      if (disposed) return 0
      const width = reflectionTarget.width
      const height = reflectionTarget.height
      const buffer = new Uint8Array(width * height * 4)
      renderer.readRenderTargetPixels(reflectionTarget, 0, 0, width, height, buffer)
      let covered = 0
      // alpha 超过 8/255 即视为被几何体覆盖，忽略近乎透明的边角像素。
      for (let i = 3; i < buffer.length; i += 4) if (buffer[i] > 8) covered++
      return covered / (width * height)
    },
    dispose() {
      if (disposed) return
      disposed = true
      root.removeFromParent()
      reflectionTarget.dispose()
      waterGeometry.dispose()
      sky.geometry.dispose()
      waterMaterial.dispose()
      skyMaterial.dispose()
      sun.dispose()
      hemisphere.dispose()
      if (bridge) {
        const geometries = new Set<THREE.BufferGeometry>()
        const materials = new Set<THREE.Material>()
        bridge.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return
          geometries.add(object.geometry)
          const ownedMaterials = Array.isArray(object.material)
            ? object.material
            : [object.material]
          ownedMaterials.forEach((material) => materials.add(material))
        })
        geometries.forEach((geometry) => geometry.dispose())
        materials.forEach((material) => material.dispose())
      }
      root.clear()
    },
  }
}
