import * as THREE from 'three'
import { fromLegacyUnits } from '../units'

/**
 * The sun's shadow.
 *
 * The scene has had a directional sun since the water page, but nothing ever
 * cast a shadow: `renderer.shadowMap` was off, the car was not marked as a
 * caster and the deck was not marked as a receiver, so the car floated on the
 * bridge with no contact shadow at all.
 *
 * A directional light's shadow camera is a box, and the box has to sit around
 * the car or the map is spent on empty water. Following the car also means the
 * map has to be snapped to texel-sized steps: a continuously moving shadow
 * camera makes every shadow edge crawl, because the depth comparison lands on
 * different texels each frame.
 */
export type SunShadow = {
  /** Keeps the shadow box on the car. Call once per frame. */
  update(position: THREE.Vector3): void
  /** Turns the shadow pass itself on or off, live. */
  setEnabled(on: boolean): void
  /** The direction the sun shines from, in world space. */
  setDirection(direction: THREE.Vector3): void
  state(): {
    enabled: boolean
    casters: number
    extent: number
    mapSize: number
    hasMap: boolean
    sun: number[]
    target: number[]
    intensity: number
  }
  dispose(): void
}

/** 阳光阴影配置：渲染器、方向光、投影对象列表，以及阴影包围盒半径/光源距离/贴图尺寸。 */
export type SunShadowOptions = {
  renderer: THREE.WebGLRenderer
  light: THREE.DirectionalLight
  /** Everything that throws a shadow: the car, the rails, the towers. */
  casters: THREE.Object3D[]
  /** Half the width of the shadow box, in metres. */
  extent?: number
  /** Distance from the car the sun is placed at, in metres. */
  distance?: number
  mapSize?: number
}

/** 创建阳光阴影管理器：开启阴影贴图、把阴影相机拟合到车周围，并随帧吸附到纹素网格。 */
export function createSunShadow(options: SunShadowOptions): SunShadow {
  const { renderer, light } = options
  // 默认阴影盒半径 70、光源距离 260，原以旧单位给出，这里换算成米。
  const extent = options.extent ?? fromLegacyUnits(70)
  const distance = options.distance ?? fromLegacyUnits(260)
  const mapSize = options.mapSize ?? 2048

  let casters = 0
  for (const root of options.casters) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      // 光环与车灯光晕不投影，否则会在车身周围留下假阴影。
      if (!mesh.isMesh || mesh.name.startsWith('car-halo') || mesh.name.startsWith('car-lamp'))
        return
      mesh.castShadow = true
      casters++
    })
  }

  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // The light is owned by the water-sky environment and already points the right
  // way; only its shadow settings are configured here.
  light.castShadow = true
  light.shadow.mapSize.set(mapSize, mapSize)
  const camera = light.shadow.camera
  camera.left = -extent
  camera.right = extent
  camera.top = extent
  camera.bottom = -extent
  camera.near = fromLegacyUnits(1)
  // 远裁剪面取光源距离的两倍，确保车与周围投影物都落在阴影相机视锥内。
  camera.far = distance * 2
  camera.updateProjectionMatrix()
  // Depth bias is dimensionless; normalBias is a distance in metres. Preserve
  // the calibrated contact offset so shadows still meet the tyres.
  light.shadow.bias = -0.0004
  light.shadow.normalBias = fromLegacyUnits(0.18)
  light.shadow.radius = 2.4

  // Taken from the light as it was set up, then kept by the host: the water-sky
  // environment moves that light to the world origin whenever a sky parameter
  // changes, so reading the direction back from it later reads a stale one.
  const sunDirection = new THREE.Vector3().copy(light.position).sub(light.target.position)
  // 若光源初始方向退化，用这组兜底方向（约自右上前方照下）。
  if (sunDirection.lengthSq() < 1e-6) sunDirection.set(0.3, 0.58, -0.76)
  sunDirection.normalize()
  // 纹素边长（米）：阴影相机跟车时按它取整，是"吸附到纹素网格"的依据。
  const texel = (extent * 2) / mapSize
  let disposed = false

  return {
    update(position) {
      if (disposed) return
      // Snap to the shadow map's texel grid so the edges do not crawl while the
      // car drives.
      const x = Math.round(position.x / texel) * texel
      const z = Math.round(position.z / texel) * texel
      light.target.position.set(x, position.y, z)
      light.position.set(
        x + sunDirection.x * distance,
        position.y + sunDirection.y * distance,
        z + sunDirection.z * distance,
      )
      light.target.updateMatrixWorld()
      light.updateMatrixWorld()
    },
    setDirection(direction) {
      if (direction.lengthSq() < 1e-6) return
      sunDirection.copy(direction).normalize()
    },
    setEnabled(on) {
      if (disposed) return
      light.castShadow = on
      light.shadow.needsUpdate = true
    },
    state: () => ({
      enabled: light.castShadow,
      casters,
      extent,
      mapSize,
      hasMap: Boolean(light.shadow.map),
      sun: light.position.toArray().map((value) => Math.round(value)),
      target: light.target.position.toArray().map((value) => Math.round(value)),
      intensity: light.intensity,
    }),
    dispose() {
      disposed = true
      renderer.shadowMap.enabled = false
      light.castShadow = false
    },
  }
}
