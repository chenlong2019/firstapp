/**
 * 灯串/中国结装饰（scenery）：给中央隔离带路灯加挂中国结与吊穗，作为路灯的附着件。
 * 对外导出 createLampKnots 与 LampKnotGroup。结体按观者距离做三级 LOD：近处高模（含吊穗丝线）、
 * 远处低模、超阈值直接剔除；细丝飘动由 knotMotion 在 GPU 顶点着色器内实现，不上传 CPU 几何。
 * 约定：位置/尺寸单位为米；加载报告与实例描述挂在 group.userData 上。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { MedianLampOptions } from './medianLamps'
import { createKnotMotion } from './knotMotion'
import { fromLegacyUnits as legacy } from '../units'

/** 灯结组：附加 updateDetail，按观察者位置刷新各 LOD 实例（可传入显式时间）。 */
export type LampKnotGroup = THREE.Group & {
  updateDetail(viewerWorldPosition: THREE.Vector3, timeSeconds?: number): void
}

/** Distance-selected instance pools: keep detailed threads only near the camera. */
export function createLampKnots(options: MedianLampOptions, stations: number[]): LampKnotGroup {
  const group = new THREE.Group() as LampKnotGroup
  group.name = 'street-lamp-chinese-knots'
  const report = {
    status: 'loading',
    count: 0,
    height: options.height * 0.25,
    batches: 0,
    error: '',
    lodCounts: [0, 0, 0],
    culled: 0,
    submittedTriangles: 0,
  }
  group.userData.decorations = report
  const motion = createKnotMotion()
  // 无外部时钟时的自启动动画计时基准。
  const started = performance.now()
  const entries: {
    position: THREE.Vector3
    knot: THREE.Matrix4
    bracket: THREE.Matrix4
    lod: number
  }[] = []
  const levels: THREE.InstancedMesh[] = []
  let brackets: THREE.InstancedMesh | undefined
  const lastViewer = new THREE.Vector3(Infinity, Infinity, Infinity)
  const viewer = new THREE.Vector3()
  // LOD 距离阈值：灯高 ×1.3 / ×5.5 / ×19，超出第三个阈值即整棵剔除。
  const thresholds = [options.height * 1.3, options.height * 5.5, options.height * 19]

  group.updateDetail = (worldPosition, timeSeconds = (performance.now() - started) / 1000) => {
    motion.time.value = Math.max(0, timeSeconds)
    if (report.status !== 'ready') return
    group.updateWorldMatrix(true, false)
    viewer.copy(worldPosition)
    group.worldToLocal(viewer)
    // 观察者移动不足 0.5 旧单位时跳过重排，避免每帧重算全部 LOD。
    if (viewer.distanceToSquared(lastViewer) < legacy(0.5) ** 2) return
    lastViewer.copy(viewer)
    const counts = [0, 0, 0]
    let bracketCount = 0
    for (const entry of entries) {
      const distance = entry.position.distanceTo(viewer)
      let level =
        distance < thresholds[0]
          ? 0
          : distance < thresholds[1]
            ? 1
            : distance < thresholds[2]
              ? 2
              : 3
      // Hysteresis prevents repeated switches at the same distance while orbiting.
      if (level > entry.lod && distance < thresholds[entry.lod] * 1.08) level = entry.lod
      if (level < entry.lod && distance > thresholds[level] * 0.92) level = entry.lod
      entry.lod = level
      if (level === 3) continue
      levels[level].setMatrixAt(counts[level]++, entry.knot)
      brackets!.setMatrixAt(bracketCount++, entry.bracket)
    }
    report.lodCounts = counts
    report.culled = entries.length - bracketCount
    report.submittedTriangles = 0
    ;[...levels, brackets!].forEach((batch, index) => {
      batch.count = index < 3 ? counts[index] : bracketCount
      batch.visible = batch.count > 0
      batch.instanceMatrix.needsUpdate = true
      batch.computeBoundingBox()
      batch.computeBoundingSphere()
      // Shader motion does not change CPU geometry: allow its small swing in culling.
      if (index < 3 && batch.count) {
        batch.boundingBox!.expandByScalar(report.height * 0.08)
        batch.boundingSphere!.radius += report.height * 0.08
      }
      report.submittedTriangles +=
        (batch.count * (batch.geometry.index?.count ?? batch.geometry.attributes.position.count)) /
        3
    })
  }

  const loader = new GLTFLoader()
  void Promise.all(
    ['', '-medium', '-far'].map((suffix) =>
      loader.loadAsync(`/models/decorations/chinese-knot${suffix}.glb`),
    ),
  )
    .then((assets) => {
      const meshes = assets.map((gltf) => {
        gltf.scene.updateMatrixWorld(true)
        const mesh = gltf.scene.getObjectByName('red-gold-knot-and-tassels') as THREE.Mesh
        if (!mesh?.isMesh) throw new Error('Prepared Chinese knot mesh is missing')
        return mesh
      })
      const material = (meshes[0].material as THREE.MeshStandardMaterial).clone()
      material.roughness = 0.62
      // Preserve coloured thread beneath nearby spotlights, not glowing tinsel.
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          'float peak = max(max(outgoingLight.r, outgoingLight.g), outgoingLight.b);\n' +
            'outgoingLight /= 1.0 + peak / 2.0;\n#include <opaque_fragment>',
        )
      }
      motion.apply(material, true)
      const capacity = stations.length * 2
      meshes[0].geometry.computeBoundingBox()
      // One common attachment origin across LODs: changing detail cannot move a knot.
      const top = meshes[0].geometry.boundingBox!.max.y
      meshes.forEach((mesh, index) => {
        const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
        geometry.translate(0, -top, 0)
        geometry.computeBoundingBox()
        const batch = new THREE.InstancedMesh(geometry, material, capacity)
        batch.name = `lamp-knot-lod-${index}`
        batch.customDepthMaterial = motion.depth
        batch.castShadow = index === 0
        batch.receiveShadow = index === 0
        batch.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        batch.count = 0
        batch.visible = false
        levels.push(batch)
        group.add(batch)
        mesh.geometry.dispose()
      })

      const reach = options.height * 0.08
      const mountY = options.groundY + options.height * 0.74
      // 连接杆长 = 灯高 ×0.08；几何预先平移使其从挂点沿 +X 伸出、以挂点为原点。
      const bracketGeometry = new THREE.CylinderGeometry(legacy(0.09), legacy(0.09), reach, 6)
      bracketGeometry.rotateZ(-Math.PI / 2)
      bracketGeometry.translate(reach / 2, 0, 0)
      brackets = new THREE.InstancedMesh(
        bracketGeometry,
        new THREE.MeshStandardMaterial({ color: 0x34332c, roughness: 0.7, metalness: 0.6 }),
        capacity,
      )
      brackets.name = 'lamp-knot-brackets'
      brackets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      brackets.count = 0
      brackets.visible = false
      group.add(brackets)
      const transform = new THREE.Object3D()
      for (const distance of stations) {
        const frame = options.centreline.frameAtDistance(distance)
        for (const side of [-1, 1]) {
          transform.position
            .copy(frame.position)
            .addScaledVector(frame.lateral, side * (legacy(0.9) + reach))
          transform.position.y = mountY
          transform.rotation.set(0, frame.heading + (side < 0 ? Math.PI : 0), 0)
          transform.scale.setScalar(report.height)
          transform.updateMatrix()
          const position = transform.position.clone()
          const knot = transform.matrix.clone()
          transform.position.copy(frame.position).addScaledVector(frame.lateral, side * legacy(0.9))
          transform.position.y = mountY
          transform.rotation.set(0, Math.atan2(-side * frame.lateral.z, side * frame.lateral.x), 0)
          transform.scale.setScalar(1)
          transform.updateMatrix()
          entries.push({ position, knot, bracket: transform.matrix.clone(), lod: 3 })
        }
      }
      report.count = capacity
      report.batches = 4
      report.status = 'ready'
      group.userData.controlInstances = entries.map((entry, i) => ({
        id: `station.${Math.floor(i / 2)}.knot.${i % 2 === 0 ? 'left' : 'right'}`,
        kind: 'decoration',
        matrix: entry.knot.clone(),
        bounds: levels[0].geometry.boundingBox!.clone().expandByScalar(0.08),
      }))
    })
    .catch((error) => {
      report.status = 'error'
      report.error = String(error)
      console.error('[lamp-knots]', error)
    })
  return group
}
