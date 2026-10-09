/**
 * 中央隔离带行道树（scenery）：加载椴树 FBX，沿物理中心线按桩距布置，作为静态地图装饰。
 * 对外导出 createMedianTrees 与 MedianTreeOptions。位置/尺寸/桩距单位为米，
 * 加载报告挂在 group.userData.vegetation。用的是道路物理中心线，而非赛车行驶线。
 * 约定：每个 mesh 每 6 棵合成一批 InstancedMesh，材质与贴图全局共享；树叶用 alphaTest 而非半透明混合。
 */
import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import type { Centreline } from '../track/centreline'

/** 行道树布置参数：中心线、地面高度、树高、桩距、端部内缩与排除区。 */
export type MedianTreeOptions = {
  centreline: Centreline
  /** All dimensions and centreline distances are metres. */
  groundY: number
  height: number
  spacing: number
  endInset: number
  /** Keep bridge portals and other overhead structures free of foliage. */
  exclusions?: { distance: number; radius: number }[]
}

// 椴树 FBX 资源目录；每 6 棵合并为一个 InstancedMesh。
const ASSET_ROOT = '/models/trees/linden/'
const BATCH_SIZE = 6

/** Static map decoration; uses the physical road centreline, not the racing line. */
export function createMedianTrees(options: MedianTreeOptions): THREE.Group {
  const group = new THREE.Group()
  group.name = 'median-trees'
  const report = {
    status: 'loading',
    count: 0,
    batches: 0,
    triangles: 0,
    height: options.height,
    spacing: options.spacing,
    stations: [] as number[],
    error: '',
  }
  group.userData.vegetation = report

  // Loading is shared by every instance on this map. The FBX is Z-up; rotate it
  // once before measuring and bake its full transform into the reusable geometry.
  const manager = new THREE.LoadingManager()
  let textureFailure = ''
  manager.onError = (url) => {
    textureFailure = url
  }
  const texturesReady = new Promise<void>((resolve) => {
    manager.onLoad = resolve
  })
  const loader = new FBXLoader(manager).setResourcePath(ASSET_ROOT)
  void (async () => {
    const source = await loader.loadAsync(`${ASSET_ROOT}Linden.fbx`)
    await texturesReady
    if (textureFailure) throw new Error(`Missing tree texture: ${textureFailure}`)
    source.rotation.x = -Math.PI / 2
    source.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(source)
    const factor = options.height / Math.max(box.max.y - box.min.y, 0.001)
    const normalize = new THREE.Matrix4()
      .makeScale(factor, factor, factor)
      .multiply(new THREE.Matrix4().makeTranslation(0, -box.min.y, 0))
    const stations: number[] = []
    for (
      let d = options.endInset + options.spacing / 2;
      d <= options.centreline.length - options.endInset - options.spacing / 2;
      d += options.spacing
    ) {
      if (options.exclusions?.some((zone) => Math.abs(d - zone.distance) < zone.radius)) continue
      stations.push(d)
    }
    const transform = new THREE.Object3D()
    source.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const geometry = mesh.geometry
        .clone()
        .applyMatrix4(normalize.clone().multiply(mesh.matrixWorld))
      const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const materials = originals.map((original) => {
        const old = original as THREE.MeshPhongMaterial
        const leaves = /branch/i.test(old.name)
        if (old.map) old.map.colorSpace = THREE.SRGBColorSpace
        const material = new THREE.MeshStandardMaterial({
          name: leaves ? 'median-linden-leaves' : 'median-linden-bark',
          color: 0xffffff,
          map: old.map,
          normalMap: old.normalMap,
          roughness: leaves ? 0.85 : 0.95,
          metalness: 0,
          // Cut out each leaf; do not alpha-blend overlapping branches.
          alphaTest: leaves ? 0.45 : 0,
          transparent: false,
          side: leaves ? THREE.DoubleSide : THREE.FrontSide,
        })
        if (leaves) material.normalScale.set(0.45, 0.45)
        return material
      })
      for (let start = 0; start < stations.length; start += BATCH_SIZE) {
        const batch = stations.slice(start, start + BATCH_SIZE)
        const trees = new THREE.InstancedMesh(geometry, materials, batch.length)
        trees.name = `median-linden-${start}`
        trees.castShadow = true
        trees.receiveShadow = true
        trees.userData.controlInstances = []
        batch.forEach((distance, index) => {
          const frame = options.centreline.frameAtDistance(distance)
          // 桩位序号决定缩放抖动（0.92–1.04），让行道树高矮不整齐划一。
          const variation = 0.92 + (((start + index) * 17) % 7) * 0.02
          transform.position.set(frame.position.x, options.groundY, frame.position.z)
          // 2.399963 弧度≈黄金角，使相邻树绕 Y 的朝向均匀错开。
          transform.rotation.set(0, (start + index) * 2.399963, 0)
          transform.scale.setScalar(variation)
          transform.updateMatrix()
          trees.setMatrixAt(index, transform.matrix)
          trees.userData.controlInstances.push({
            id: `tree.station.${start + index}`,
            kind: 'tree',
            matrix: transform.matrix.clone(),
          })
        })
        trees.instanceMatrix.needsUpdate = true
        trees.computeBoundingBox()
        trees.computeBoundingSphere()
        group.add(trees)
        report.batches++
      }
      report.triangles +=
        ((geometry.index?.count ?? geometry.attributes.position.count) / 3) * stations.length
      mesh.geometry.dispose()
      originals.forEach((material) => material.dispose())
    })
    report.count = stations.length
    report.stations = stations
    report.status = 'ready'
  })().catch((error) => {
    report.status = 'error'
    report.error = String(error)
    console.error('[median-trees]', error)
  })
  return group
}
