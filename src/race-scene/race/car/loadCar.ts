import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { CarDefinition, ModelContext } from './definition'

/**
 * 把 GLB 装配成可驾驶的车辆骨架（CarRig）。
 *
 * 在整体里的位置：race/car 的装配层，上游是 definition.ts 的车型定义，
 * 下游供 vehicle.ts 驱动位姿、body/lights/mirrors 挂接部件、boarding 取座椅与车长。
 *
 * 对外导出：loadCar 工厂、CarRig / Wheel / LoadCarOptions 类型与 DEFAULT_WHEEL_PATTERN。
 * 非直觉约定：骨架根节点带归一化缩放，其下的几何一律按模型单位计；
 * 车轮按三角形质心切成四象限并以各自轮心为基准，拆不出来时退回通用圆柱轮。
 */

/** 一个车轮：转向枢轴 steer、自转枢轴 spin，及轮心与半径（rig 局部单位）。 */
export type Wheel = {
  /** Model-space X sign: +1 is the +X side, which is the car's left because the
   * model faces +Z. Steering only cares about `front`, so this is informational. */
  side: -1 | 1
  front: boolean
  /** Yaw pivot: steering. */
  steer: THREE.Group
  /** Roll pivot: wheel spin. */
  spin: THREE.Group
  /** Wheel centre in rig-local units. */
  centre: THREE.Vector3
  radius: number
}

/** 装配完成的车辆骨架：根节点、底盘、四轮与量测出的尺寸。 */
export type CarRig = {
  root: THREE.Group
  chassis: THREE.Group
  wheels: Wheel[]
  /** Dimensions in metres after normalisation. */
  size: THREE.Vector3
  wheelbase: number
  trackWidth: number
  wheelRadius: number
  /** True when the source wheels could not be separated and were replaced. */
  proceduralWheels: boolean
  /** Ratios the wheel split produced; null when the split was abandoned. */
  wheelRatios: { base: number; track: number; radius: number } | null
  /**
   * The split's own account of the model: which meshes it took, which buckets it
   * filled, and the labels it saw. Without this, telling "the wheels are wrong"
   * from "the pattern caught the wrong meshes" means opening the glTF by hand.
   */
  wheelDebug: { matched: string[]; buckets: string[]; labels: string[] }
  /** Rig-space bounding box, used to check the car sits on the road. */
  bounds: { min: number[]; max: number[] }
}

/** loadCar 的配置：要装载的车、目标车长与进度回调。 */
export type LoadCarOptions = {
  /** The car to build: names, length and every model-specific decorator. */
  car: CarDefinition
  /** Desired length in metres; the model is scaled to match. */
  targetLength: number
  onProgress?: (fraction: number) => void
}

type Piece = {
  geometry: THREE.BufferGeometry
  material: THREE.Material
  caliper: boolean
}

/** Default wheel matcher: the BMW's naming, which the others override. */
export const DEFAULT_WHEEL_PATTERN = /koleso|tormoz_disk|box146|tyre|tire|wheel|rim/i
/** 卡钳网格名：卡钳固连在转向节上，只随转向、不随车轮自转。 */
const CALIPER_NAME = /caliper|box146/i
/**
 * Named like a wheel, is not one. Only matters now that a single-quadrant mesh
 * is accepted as a whole wheel: the BMW's interior `steering wheel` mesh would
 * otherwise be welded onto the front left tyre.
 */
const INTERIOR_WHEEL_NAME = /steering|interior|dashboard|pedal/i

/**
 * The Sketchfab model bakes all four wheels into single meshes, so they cannot
 * be steered or spun as nodes. This splits each wheel mesh by triangle centroid
 * into four quadrant buckets and rebases every bucket on its own wheel centre.
 *
 * Triangle centroids are computed in rig space, not mesh space: this export
 * carries a Z-up to Y-up node transform, so splitting on raw local coordinates
 * would cut along the wrong axis. Each bucket becomes a single geometry, never
 * one geometry per triangle.
 */
function splitWheelMesh(mesh: THREE.Mesh, splitZ: number): Map<string, Piece[]> | null {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  if (!position) return null
  const attributes = Object.keys(geometry.attributes).filter((name) => {
    const attribute = geometry.getAttribute(name) as THREE.BufferAttribute
    return attribute.array instanceof Float32Array
  })
  const index = geometry.getIndex()
  const triangles = Math.floor((index ? index.count : position.count) / 3)
  const matrix = mesh.matrixWorld
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
  const buckets = new Map<string, Record<string, number[]>>()
  const vertex = new THREE.Vector3()
  const normal = new THREE.Vector3()
  for (let triangle = 0; triangle < triangles; triangle++) {
    const a = index ? index.getX(triangle * 3) : triangle * 3
    const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
    const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
    let centreX = 0
    let centreZ = 0
    for (const index3 of [a, b, c]) {
      vertex
        .set(position.getX(index3), position.getY(index3), position.getZ(index3))
        .applyMatrix4(matrix)
      centreX += vertex.x / 3
      centreZ += vertex.z / 3
    }
    const key = `${centreX < 0 ? 'L' : 'R'}${centreZ < splitZ ? '0' : '1'}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = {}
      for (const name of attributes) bucket[name] = []
      buckets.set(key, bucket)
    }
    for (const name of attributes) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute
      const target = bucket[name]
      for (const index3 of [a, b, c]) {
        if (name === 'position') {
          vertex
            .set(attribute.getX(index3), attribute.getY(index3), attribute.getZ(index3))
            .applyMatrix4(matrix)
          target.push(vertex.x, vertex.y, vertex.z)
        } else if (name === 'normal') {
          normal
            .set(attribute.getX(index3), attribute.getY(index3), attribute.getZ(index3))
            .applyMatrix3(normalMatrix)
            .normalize()
          target.push(normal.x, normal.y, normal.z)
        } else {
          for (let component = 0; component < attribute.itemSize; component++)
            target.push(attribute.getComponent(index3, component))
        }
      }
    }
  }
  // A mesh that lies entirely inside one quadrant is one wheel of a model that
  // already ships its wheels as separate meshes - the Lamborghini and the
  // Volkswagen both do. Returning null for those (the old rule, which wanted at
  // least two quadrants per mesh) left such a car with no split wheels at all.
  if (buckets.size === 0) return null
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const caliper = CALIPER_NAME.test(mesh.name)
  const result = new Map<string, Piece[]>()
  for (const [key, bucket] of buckets) {
    const piece = new THREE.BufferGeometry()
    for (const name of attributes) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute
      // Vertices are already in rig space; the caller rebases them on the wheel centre.
      piece.setAttribute(
        name,
        new THREE.BufferAttribute(
          new Float32Array(bucket[name]),
          attribute.itemSize,
          attribute.normalized,
        ),
      )
    }
    result.set(key, [{ geometry: piece, material, caliper }])
  }
  return result
}

/**
 * 用圆柱体搭一组通用车轮，供车轮无法拆分、或拆分结果不可信时兜底。
 *
 * @param root 挂载的父节点
 * @param size 模型尺寸（模型单位）
 * @param radius 轮胎半径（模型单位）
 * @returns 四个车轮
 */
function makeProceduralWheels(root: THREE.Group, size: THREE.Vector3, radius: number): Wheel[] {
  const wheels: Wheel[] = []
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.92, metalness: 0 })
  const rim = new THREE.MeshStandardMaterial({ color: 0x9aa2a8, roughness: 0.35, metalness: 0.75 })
  // 兜底布局比例：轴距约取车长的 62%，轮距约取车宽的 86%。
  const wheelbase = size.z * 0.62
  const track = size.x * 0.86
  for (const side of [-1, 1] as const) {
    for (const front of [true, false]) {
      const centre = new THREE.Vector3(
        (side * track) / 2,
        radius,
        front ? wheelbase / 2 : -wheelbase / 2,
      )
      const steer = new THREE.Group()
      steer.position.copy(centre)
      steer.name = `wheel-${front ? 'front' : 'rear'}-${side < 0 ? 'left' : 'right'}`
      const spin = new THREE.Group()
      steer.add(spin)
      const tyre = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, radius * 0.8, 20),
        rubber,
      )
      tyre.rotation.z = Math.PI / 2
      spin.add(tyre)
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, radius * 0.84, 16),
        rim,
      )
      hub.rotation.z = Math.PI / 2
      spin.add(hub)
      root.add(steer)
      wheels.push({ side, front, steer, spin, centre, radius })
    }
  }
  return wheels
}

/**
 * Loads the car, separates its wheels and normalises it to `targetLength`.
 * The result is a rig whose root can be driven directly: place it, yaw it, and
 * drive `wheels[i].steer.rotation.y` and `wheels[i].spin.rotation.x`.
 */
export async function loadCar(options: LoadCarOptions): Promise<CarRig> {
  const car = options.car
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(car.url, (event) => {
    if (!options.onProgress || !event.total) return
    options.onProgress(Math.min(1, event.loaded / event.total))
  })
  const model = gltf.scene

  const holder = new THREE.Group()
  holder.add(model)
  holder.updateMatrixWorld(true)
  const modelBox = new THREE.Box3().setFromObject(holder)
  const modelSize = modelBox.getSize(new THREE.Vector3())
  const splitZ = (modelBox.min.z + modelBox.max.z) / 2
  // First pass of the car's decorators: they see the raw scene and may hide
  // meshes, force procedural wheels, or otherwise pre-empt the generic path.
  const context: ModelContext = {
    phase: 'measure',
    model,
    holder,
    size: modelSize,
    box: modelBox,
    forceProceduralWheels: false,
  }
  for (const adapter of car.adapters) adapter(context)

  const wheelMeshes: THREE.Mesh[] = []
  const labels: string[] = []
  const bodyMeshes: THREE.Mesh[] = []
  model.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return
    const mesh = object as THREE.Mesh
    const label = `${mesh.name} ${mesh.parent?.name ?? ''}`
    // 诊断用标签只保留前 60 条，避免遍历开销。
    if (labels.length < 60) labels.push(label)
    if (INTERIOR_WHEEL_NAME.test(label)) {
      bodyMeshes.push(mesh)
      return
    }
    ;(car.wheelPattern.test(label) ? wheelMeshes : bodyMeshes).push(mesh)
  })

  const buckets = new Map<string, Piece[]>()
  const matched: string[] = []
  for (const mesh of wheelMeshes) {
    matched.push(`${mesh.name} <${mesh.parent?.name ?? ''}>`)
    const split = splitWheelMesh(mesh, splitZ)
    if (!split) continue
    for (const [key, pieces] of split) buckets.set(key, [...(buckets.get(key) ?? []), ...pieces])
  }
  for (const mesh of wheelMeshes) mesh.removeFromParent()

  const root = new THREE.Group()
  root.name = 'car-rig'
  const chassis = new THREE.Group()
  chassis.name = 'car-chassis'
  chassis.add(model)
  root.add(chassis)

  const wheels: Wheel[] = []
  let broken = buckets.size !== 4
  for (const [key, pieces] of buckets) {
    const box = new THREE.Box3()
    for (const piece of pieces) {
      piece.geometry.computeBoundingBox()
      box.union(piece.geometry.boundingBox!)
    }
    const centre = box.getCenter(new THREE.Vector3())
    const radius = (box.max.y - box.min.y) / 2
    if (!Number.isFinite(radius) || radius <= 0) broken = true
    const side: -1 | 1 = key.startsWith('L') ? -1 : 1
    const front = key.endsWith('1')
    const steer = new THREE.Group()
    steer.name = `wheel-${front ? 'front' : 'rear'}-${side < 0 ? 'left' : 'right'}`
    steer.position.copy(centre)
    const spin = new THREE.Group()
    steer.add(spin)
    for (const piece of pieces) {
      piece.geometry.translate(-centre.x, -centre.y, -centre.z)
      const mesh = new THREE.Mesh(piece.geometry, piece.material)
      mesh.name = `${steer.name}-mesh`
      // Calipers are bolted to the upright: they steer but never spin.
      ;(piece.caliper ? steer : spin).add(mesh)
    }
    root.add(steer)
    wheels.push({ side, front, steer, spin, centre, radius })
  }

  let proceduralWheels = false
  // The rig is scaled at the end, so anything built inside it has to be given in
  // model units - including the fallback radius, which arrives in world units.
  // 归一化比例：目标车长除以模型 Z 向长度（模型朝 +Z，长轴即 Z）。
  const scale = options.targetLength / modelSize.z
  // Sanity check the split before trusting it: a matcher that also caught a
  // wheel-arch liner or a brake disc still produces four buckets, just four
  // buckets in the wrong places. Compare the result against what the car has to
  // be - wheelbase about 0.6 of the length, track about 0.75 of the width, tyre
  // radius about 0.075 of the length - and build procedural wheels otherwise.
  const geometry = (() => {
    const front = wheels.filter((wheel) => wheel.front)
    const rear = wheels.filter((wheel) => !wheel.front)
    const left = wheels.filter((wheel) => wheel.side < 0)
    const right = wheels.filter((wheel) => wheel.side > 0)
    if (front.length !== 2 || rear.length !== 2 || left.length !== 2 || right.length !== 2)
      return null
    const base =
      Math.abs(
        front.reduce((sum, wheel) => sum + wheel.centre.z, 0) / 2 -
          rear.reduce((sum, wheel) => sum + wheel.centre.z, 0) / 2,
      ) / modelSize.z
    const track =
      Math.abs(
        right.reduce((sum, wheel) => sum + wheel.centre.x, 0) / 2 -
          left.reduce((sum, wheel) => sum + wheel.centre.x, 0) / 2,
      ) / modelSize.x
    const radius = wheels.reduce((sum, wheel) => sum + wheel.radius, 0) / 4 / modelSize.z
    return { base, track, radius }
  })()
  const plausible =
    geometry !== null &&
    geometry.base > 0.42 &&
    geometry.base < 0.72 &&
    geometry.track > 0.5 &&
    geometry.track < 1.05 &&
    geometry.radius > 0.045 &&
    geometry.radius < 0.13
  if (broken || wheels.length !== 4 || !plausible || context.forceProceduralWheels) {
    proceduralWheels = true
    for (const wheel of wheels) wheel.steer.removeFromParent()
    wheels.length = 0
    wheels.push(...makeProceduralWheels(root, modelSize, car.fallbackWheelRadius / scale))
  }

  root.scale.setScalar(scale)
  // The model's own origin is wherever the exporter left it, so the rig has to
  // report where it actually ends up: a car whose lowest point is below the
  // track surface sinks into the road.
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)

  const size = modelSize.clone().multiplyScalar(scale)
  const front = wheels.filter((wheel) => wheel.front)
  const rear = wheels.filter((wheel) => !wheel.front)
  const wheelbase =
    front.length && rear.length
      ? Math.abs(
          front.reduce((sum, wheel) => sum + wheel.centre.z, 0) / front.length -
            rear.reduce((sum, wheel) => sum + wheel.centre.z, 0) / rear.length,
        ) * scale
      : size.z * 0.62
  const left = wheels.filter((wheel) => wheel.side < 0)
  const right = wheels.filter((wheel) => wheel.side > 0)
  const trackWidth =
    left.length && right.length
      ? Math.abs(
          right.reduce((sum, wheel) => sum + wheel.centre.x, 0) / right.length -
            left.reduce((sum, wheel) => sum + wheel.centre.x, 0) / left.length,
        ) * scale
      : size.x * 0.86

  // Sketchfab glass ships with alpha 0.25 and no blend mode; without this the
  // windows render opaque black. 0.25 is also too clear: the cabin is only
  // partly modelled, so from behind you could see straight through the car to
  // the nose and the front wheels. Tint the window glass instead - it still
  // reads as glass and the car is solid from any angle.
  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return
    const materials = Array.isArray((object as THREE.Mesh).material)
      ? ((object as THREE.Mesh).material as THREE.Material[])
      : [(object as THREE.Mesh).material as THREE.Material]
    for (const material of materials) {
      // Cabin glass: windscreen, side and rear windows, panoramic roof. Keep it
      // transparent - that is what glass is for. It was briefly made opaque while
      // chasing the car being see-through, but the real cause was a depth test
      // leak in the mirror pass, not the glass. A dark tint reads as tinted glass
      // and still transmits, and the low roughness gives it the environment
      // reflection that makes it look like glass rather than a hole.
      const cabinGlass =
        /^(glass|panorama)/i.test(material.name ?? '') && !/lights/i.test(material.name ?? '')
      if (cabinGlass) {
        const surface = material as THREE.MeshStandardMaterial
        material.transparent = true
        material.depthWrite = false
        material.opacity = 0.62
        if (typeof surface.roughness === 'number') surface.roughness = 0.08
        if (typeof surface.metalness === 'number') surface.metalness = 0.25
        if (surface.color) surface.color.setHex(0x121a22)
        material.needsUpdate = true
        continue
      }
      // Depth testing is a property of the material, so a pass that forgets to
      // restore it corrupts the car for the rest of the session. Start every
      // material with it on; only the transparent branch turns depth writes off.
      material.depthTest = true
      if (material.transparent) continue
      const opacity = (material as THREE.MeshStandardMaterial).opacity
      if (opacity < 1) {
        material.transparent = true
        material.depthWrite = false
      }
    }
  })

  // Second pass of the car's decorators: the rig exists now, so an adapter can
  // still fix the ride height or re-parent a part before anyone drives it.
  for (const adapter of car.adapters) {
    adapter({ ...context, phase: 'build', rig: { chassis, wheels, root, bounds } })
  }

  return {
    root,
    chassis,
    wheels,
    size,
    wheelbase: wheelbase || size.z * 0.62,
    trackWidth: trackWidth || size.x * 0.86,
    wheelRadius: wheels[0]?.radius ? wheels[0].radius * scale : car.fallbackWheelRadius,
    proceduralWheels,
    // Kept for the model-triage probe: the ratios the split produced, which is
    // what says whether a newly added model needs a `wheelPattern`.
    wheelRatios: geometry,
    wheelDebug: { matched, buckets: [...buckets.keys()], labels },
    bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
  }
}
