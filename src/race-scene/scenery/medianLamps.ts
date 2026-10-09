/**
 * 中央隔离带路灯（scenery）：加载单臂 GLB 路灯，沿中心线成对布置在隔离带两侧、
 * 分别朝向两侧车道，并附带偏暖的路面照明与灯串装饰。
 * 对外导出 createMedianLamps，以及 MedianLampOptions、LampTimeOfDay、MedianLampGroup。
 * 约定：位置/高度/桩距单位为米；加载报告挂在 group.userData.lamps；
 * 白天/夜晚通过切换自发光与一个固定光线池实现，不重建光照着色器。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { Centreline } from '../track/centreline'
import { createLampKnots } from './lampKnots'
import { fromLegacyUnits as legacy, LEGACY_UNITS_PER_METRE } from '../units'

/** All positions, heights and planting distances are metres. */
export type MedianLampOptions = {
  centreline: Centreline
  groundY: number
  height: number
  /** Match the planting rhythm; lamps occupy every second gap between trees. */
  treeSpacing: number
  endInset: number
  exclusions?: { distance: number; radius: number }[]
}

/** 一天中的时段：白天不点亮，黄昏与夜晚点亮。 */
export type LampTimeOfDay = 'day' | 'dusk' | 'night'
/** 路灯组：在 THREE.Group 上附加“切换时段”和“按观察者更新照明”两个方法。 */
export type MedianLampGroup = THREE.Group & {
  setTimeOfDay(time: LampTimeOfDay): void
  updateLighting(viewerWorldPosition: THREE.Vector3): void
}

// 同时点亮的路灯对数上限为 4（按与观察者的距离排序选出），灯色为暖白。
const LIT_PAIRS = 4
const WARM_WHITE = 0xffdda6

/** Paired single-arm GLB lamps, rooted in the median and facing each carriageway. */
export function createMedianLamps(options: MedianLampOptions): MedianLampGroup {
  const group = new THREE.Group() as MedianLampGroup
  group.name = 'median-street-lamps'
  const report = {
    status: 'loading',
    pairs: 0,
    count: 0,
    batches: 0,
    height: options.height,
    stations: [] as number[],
    error: '',
    timeOfDay: 'day' as LampTimeOfDay,
    lit: false,
    activeLights: 0,
    emissiveIntensity: 0,
  }
  group.userData.lamps = report

  // The original GLB has a nearly transparent black bulb. Give only that actual
  // mesh an opaque frosted diffuser so emission remains visible from both roads.
  const diffuser = new THREE.MeshStandardMaterial({
    name: 'street-lamp-diffuser',
    color: 0xc4bcaa,
    emissive: WARM_WHITE,
    emissiveIntensity: 0,
    roughness: 0.45,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  const anchors: { position: THREE.Vector3; target: THREE.Vector3 }[][] = []
  let knotDecorations: ReturnType<typeof createLampKnots> | null = null
  // Keep the light count fixed: toggling day/night must not compile a new lighting
  // shader on every material. Only four nearby pairs illuminate the road; all
  // distant diffusers still emit. No per-lamp shadow maps or transparent halos.
  const pool = Array.from({ length: LIT_PAIRS * 2 }, (_, i) => {
    // 每盏灯：作用距离=灯高×3.3，张角 0.85 弧度，半影 0.8，物理衰减指数 2。
    const light = new THREE.SpotLight(WARM_WHITE, 0, options.height * 3.3, 0.85, 0.8, 2)
    light.name = `street-lamp-road-light-${i}`
    light.castShadow = false
    group.add(light, light.target)
    return light
  })
  group.setTimeOfDay = (time) => {
    report.timeOfDay = time
    report.lit = time !== 'day'
    // 自发光强度：白天 0、黄昏 5、夜晚 14，为与天空亮度对齐的经验值。
    diffuser.emissiveIntensity = { day: 0, dusk: 5, night: 14 }[time]
    report.emissiveIntensity = diffuser.emissiveIntensity
    if (!report.lit) {
      pool.forEach((light) => {
        light.intensity = 0
      })
      report.activeLights = 0
    }
  }
  const viewerLocal = new THREE.Vector3()
  group.updateLighting = (viewerWorldPosition) => {
    knotDecorations?.updateDetail(viewerWorldPosition)
    if (!report.lit || !anchors.length) return
    group.updateWorldMatrix(true, false)
    viewerLocal.copy(viewerWorldPosition)
    group.worldToLocal(viewerLocal)
    const nearest = anchors
      .map((pair, index) => ({
        index,
        distance: Math.hypot(
          pair[0].position.x - viewerLocal.x,
          pair[0].position.z - viewerLocal.z,
        ),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, LIT_PAIRS)
    report.activeLights = 0
    pool.forEach((light, index) => {
      const entry = nearest[Math.floor(index / 2)]
      if (!entry) {
        light.intensity = 0
        return
      }
      const anchor = anchors[entry.index][index % 2]
      light.position.copy(anchor.position)
      light.target.position.copy(anchor.target)
      // 距离在“灯高×5”到“灯高×7.5”之间用 smoothstep 淡出，避免远处路灯突然熄灭。
      const fade =
        1 - THREE.MathUtils.smoothstep(entry.distance, options.height * 5, options.height * 7.5)
      // Inverse-square falloff: preserve illuminance after expressing distance in metres.
      light.intensity =
        ((report.timeOfDay === 'night' ? 9000 : 4500) / LEGACY_UNITS_PER_METRE ** 2) * fade
      light.target.updateMatrixWorld()
      if (light.intensity > 0) report.activeLights++
    })
  }

  void new GLTFLoader()
    .loadAsync('/models/street_lamp.glb')
    .then((gltf) => {
      const source = gltf.scene
      source.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(source)
      const scale = options.height / (bounds.max.y - bounds.min.y)
      // This asset is Y-up, its pole foot is at x=z=0, and its arm extends along
      // -X. Retain that foot as the pivot instead of centering the whole arm's box.
      const normalize = new THREE.Matrix4()
        .makeScale(scale, scale, scale)
        .multiply(new THREE.Matrix4().makeTranslation(0, -bounds.min.y, 0))
      for (
        let d = options.endInset + options.treeSpacing;
        d <= options.centreline.length - options.endInset - options.treeSpacing;
        d += options.treeSpacing * 2
      ) {
        if (options.exclusions?.some((zone) => Math.abs(d - zone.distance) < zone.radius)) continue
        report.stations.push(d)
      }
      const transform = new THREE.Object3D()
      source.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const geometry = mesh.geometry
          .clone()
          .applyMatrix4(normalize.clone().multiply(mesh.matrixWorld))
        const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        const isDiffuser = originals.some((material) => material.name === 'light')
        const material = isDiffuser ? diffuser : mesh.material
        if (isDiffuser) {
          geometry.computeBoundingBox()
          const head = geometry.boundingBox!.getCenter(new THREE.Vector3())
          for (const distance of report.stations) {
            const frame = options.centreline.frameAtDistance(distance)
            anchors.push(
              [-1, 1].map((side) => {
                transform.position
                  .copy(frame.position)
                  .addScaledVector(frame.lateral, side * legacy(0.9))
                transform.position.y = options.groundY
                transform.rotation.set(
                  0,
                  Math.atan2(side * frame.lateral.z, -side * frame.lateral.x),
                  0,
                )
                transform.updateMatrix()
                const position = head.clone().applyMatrix4(transform.matrix)
                position.y -= legacy(0.35) // Source just below the real diffuser.
                const target = position
                  .clone()
                  .addScaledVector(frame.lateral, side * options.height * 0.35)
                target.y = options.groundY - legacy(1.58)
                return { position, target }
              }),
            )
          }
        }
        // Share original GLB textures/materials across all instances.
        // 每 4 个桩位合并成一批 InstancedMesh，以控制绘制批次数。
        for (let start = 0; start < report.stations.length; start += 4) {
          const stations = report.stations.slice(start, start + 4)
          const batch = new THREE.InstancedMesh(geometry, material, stations.length * 2)
          batch.name = `median-lamp-${mesh.name}-${start}`
          batch.castShadow = !isDiffuser
          batch.receiveShadow = true
          if (!isDiffuser) batch.userData.controlInstances = []
          stations.forEach((distance, index) => {
            const frame = options.centreline.frameAtDistance(distance)
            for (const [sideIndex, side] of [-1, 1].entries()) {
              transform.position
                .copy(frame.position)
                .addScaledVector(frame.lateral, side * legacy(0.9))
              transform.position.y = options.groundY
              // A rotation maps the model's -X arm onto the outward lateral vector.
              transform.rotation.set(
                0,
                Math.atan2(side * frame.lateral.z, -side * frame.lateral.x),
                0,
              )
              transform.updateMatrix()
              batch.setMatrixAt(index * 2 + sideIndex, transform.matrix)
              if (!isDiffuser)
                batch.userData.controlInstances.push({
                  id: `station.${start + index}.lamp.${side < 0 ? 'left' : 'right'}`,
                  kind: 'lamp',
                  matrix: transform.matrix.clone(),
                })
            }
          })
          batch.instanceMatrix.needsUpdate = true
          batch.computeBoundingBox()
          batch.computeBoundingSphere()
          group.add(batch)
          report.batches++
        }
        mesh.geometry.dispose()
      })
      report.pairs = report.stations.length
      report.count = report.pairs * 2
      const knots = createLampKnots(options, report.stations)
      knotDecorations = knots
      group.add(knots)
      Object.assign(report, { decorations: knots.userData.decorations })
      report.status = 'ready'
    })
    .catch((error) => {
      report.status = 'error'
      report.error = String(error)
      console.error('[median-lamps]', error)
    })
  return group
}
