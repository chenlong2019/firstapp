/**
 * 场景展示用无人机（scenery）：加载一个 GLB 无人机模型，按“世界锚点 + 朝向”跟随飞行。
 * 注意：与页面 HUD/操控逻辑中那套无人机无关，这里只是被动跟随的装饰模型。
 * 对外导出 createDrone 与 DroneAnchor、DroneOptions。尺寸与偏移单位为米，模型加载后按 width 归一化。
 * 约定：root 默认不可见，需外部调用 update() 锚定后才显示；加载状态挂在 root.userData.drone。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

/** 无人机的世界锚点：世界位置与朝向（绕 +Y 的弧度）。 */
export type DroneAnchor = { position: THREE.Vector3; heading: number }
/** 加载配置：模型 URL、归一化后的目标宽度（米）与相对锚点的世界偏移（米）。 */
export type DroneOptions = {
  url: string
  /** Dimensions and world offsets are metres; the GLB is normalized on load. */
  width: number
  offset: THREE.Vector3
}

/** A GLB prop with a world-space flight anchor, independent of the car's scale. */
export function createDrone(options: DroneOptions) {
  const root = new THREE.Group()
  root.name = 'dji-air-drone'
  root.visible = false
  const model = new THREE.Group()
  model.name = 'drone-model'
  root.add(model)
  const report = {
    status: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
    error: '',
    meshes: 0,
    triangles: 0,
    size: [0, 0, 0],
  }
  root.userData.drone = report
  const target = new THREE.Vector3()
  const yaw = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  let enabled = true
  let anchored = false
  let elapsed = 0
  let pending: Promise<boolean> | null = null
  let disposed = false

  const release = (object: THREE.Object3D) => {
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      geometries.add(mesh.geometry)
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value)
        }
      }
    })
    geometries.forEach((geometry) => geometry.dispose())
    materials.forEach((material) => material.dispose())
    textures.forEach((texture) => texture.dispose())
  }

  return {
    root,
    load(): Promise<boolean> {
      if (disposed) return Promise.resolve(false)
      if (pending) return pending
      report.status = 'loading'
      report.error = ''
      pending = new GLTFLoader()
        .loadAsync(options.url)
        .then((gltf) => {
          if (disposed) {
            release(gltf.scene)
            return false
          }
          const source = new THREE.Group()
          source.name = 'drone-forward'
          // This asset's camera faces -Z; the host's flight heading uses +Z.
          source.rotation.y = Math.PI
          source.add(gltf.scene)
          source.updateMatrixWorld(true)
          const box = new THREE.Box3().setFromObject(source)
          const size = box.getSize(new THREE.Vector3())
          const span = Math.max(size.x, size.z)
          if (!Number.isFinite(span) || span <= 0) {
            release(source)
            throw new Error('无人机模型尺寸无效')
          }
          const scale = options.width / span
          model.scale.setScalar(scale)
          // Center outside the imported hierarchy; preserve every GLB transform.
          model.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-scale)
          model.add(source)
          source.traverse((child) => {
            const mesh = child as THREE.Mesh
            if (!mesh.isMesh) return
            mesh.castShadow = true
            mesh.receiveShadow = true
            report.meshes++
            report.triangles +=
              (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3
          })
          report.size = size.multiplyScalar(scale).toArray()
          report.status = 'ready'
          root.visible = enabled && anchored
          return true
        })
        .catch((error) => {
          report.status = 'error'
          report.error = error instanceof Error ? error.message : String(error)
          root.visible = false
          pending = null
          console.warn('[drone] 模型载入失败', error)
          return false
        })
      return pending
    },
    setEnabled(value: boolean) {
      enabled = value
      root.visible = !disposed && enabled && anchored && report.status === 'ready'
    },
    update(dt: number, anchor: DroneAnchor) {
      if (disposed || !enabled) return
      // 单帧步长上限 0.3 秒，避免卡顿后悬停相位一次性跳变。
      const delta = THREE.MathUtils.clamp(dt, 0, 0.3)
      elapsed += delta
      yaw.setFromAxisAngle(up, anchor.heading)
      target.copy(options.offset).applyQuaternion(yaw).add(anchor.position)
      // Small, bounded hover movement; no car roll or imported vehicle scale.
      target.y += Math.sin(elapsed * 1.8) * options.width * 0.055
      root.position.copy(target)
      root.quaternion.copy(yaw)
      anchored = true
      root.visible = report.status === 'ready'
    },
    state() {
      return {
        ...report,
        enabled,
        visible: root.visible,
        position: root.position.toArray(),
        heading: root.rotation.y,
      }
    },
    dispose() {
      disposed = true
      root.visible = false
      root.removeFromParent()
      release(root)
      root.clear()
    },
  }
}
