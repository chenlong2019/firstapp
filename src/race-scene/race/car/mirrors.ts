import * as THREE from 'three'
import type { CarRig } from './loadCar'
import { splitMesh } from './split'
import { fromLegacyUnits } from '../units'

/**
 * 车辆自带独立后视镜玻璃网格时的实时反射（如 Omoda、兰博基尼）。
 *
 * 在整体里的位置：race/car 的渲染增强层，挂在 CarRig 上；它自建一个立方体相机，
 * 按需刷新镜面反射（水面的平面反射与 scene.environment 两条更省的路都试过、都不可用，原因见上方英文说明）。
 *
 * 对外导出：createCarMirrors 工厂与 CarMirrors / CarMirrorsOptions 类型。
 * 非直觉约定：立方体相机取镜面顶点均值而非网格自身原点——这些模型的原点都在车中线上，
 * 直接用它会把相机塞进车厢里，镜面就只剩黑色。
 */

/**
 * The mirror glass on a car that ships it as its own mesh (the Omoda, the
 * Lamborghini).
 *
 * A mirror has to show the world, and the world here is a bridge over a sea with
 * a sky above it. Two cheaper routes were tried first and both failed the same
 * way - on screen the glass stayed dark from every angle:
 *
 * 1. sampling the reflection the *water* renders. That is a planar projection for
 *    the water's own plane; on a mirror pointing somewhere else it lines up with
 *    nothing and read as a flat wash of sky inside the outline of the glass.
 * 2. `scene.environment`, which three gives every standard material for free. It
 *    is there (the page builds a small PMREM of sky and sea) and the material asks
 *    for it (`envMapIntensity`), but `scene.environmentIntensity` is kept at 0.24
 *    so the car is lit by the sun rather than by a sky box - and measured against
 *    the frame, turning the glass's `envMapIntensity` from 0 to 30 changed nothing
 *    at all.
 *
 * So the glass gets a cube camera of its own, at 64 pixels a side, refreshed twice
 * a second from the middle of the mirror. That is six small scene renders a second,
 * and it is the only one of the three that puts the bridge, the road and the sea in
 * the mirror. The glass itself is hidden while the cube is taken, so the mirror
 * never reflects the mirror.
 */
/** 后视镜玻璃实时反射控制器。 */
export type CarMirrors = {
  state(): {
    meshes: number
    reflection: boolean
    material: string
    centre: number[]
    captures: number
  }
  /** Swap the model's glass material for the mirror, or put it back. */
  setEnabled(enabled: boolean): void
  /** Refresh the reflection if it is due; called once per frame. */
  update(now: number): void
  dispose(): void
}

/** createCarMirrors 的配置。 */
export type CarMirrorsOptions = {
  rig: CarRig
  /** Mesh, parent or material name matching this is mirror glass. */
  pattern: RegExp
  /**
   * Set when the mesh is the whole mirror assembly: the door pods *and* their
   * housings, or the pods and the interior mirror in one mesh (the BMW). The
   * mesh is then cut so only the faces that look back along the car - the actual
   * glass - get the mirror, and the housing keeps the paint it shipped with.
   */
  splitGlass?: boolean
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
}

/** Pixels a side of the reflection cube. A mirror is small on screen. */
const CUBE_SIZE = 64
/** How far the car has to move before the reflection is worth taking again. */
const CAPTURE_TRAVEL = fromLegacyUnits(0.25)
/** ...and how far it has to turn, in radians. */
const CAPTURE_TURN = 0.04
/** A stationary car still gets a fresh cube this often, if anything moved at all. */
const CAPTURE_STALE = 2000

/**
 * 构建后视镜反射控制器。
 *
 * @param options 车辆骨架、镜面匹配、是否拆分镜壳、渲染器与场景
 * @returns CarMirrors 实例；没有匹配到镜面网格时返回 null
 */
export function createCarMirrors(options: CarMirrorsOptions): CarMirrors | null {
  const { rig, pattern, renderer, scene } = options
  const glass: THREE.Mesh[] = []
  const owned: THREE.BufferGeometry[] = []
  const bodyParts: THREE.Mesh[] = []
  rig.root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || mesh.name.startsWith('car-mirror-strip')) return
    // The glazing pieces this module owns are not source material.
    if (mesh.name.startsWith('car-mirror-')) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const label = `${mesh.name} ${mesh.parent?.name ?? ''} ${materials.map((item) => item.name ?? '').join(' ')}`
    if (pattern.test(label)) glass.push(mesh)
  })
  if (!glass.length) return null

  const cubeTarget = new THREE.WebGLCubeRenderTarget(CUBE_SIZE, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    colorSpace: THREE.SRGBColorSpace,
  })
  // 立方体相机近 / 远裁剪面约为 0.046 米与 206 米（经旧单位换算）。
  const cubeCamera = new THREE.CubeCamera(fromLegacyUnits(0.2), fromLegacyUnits(900), cubeTarget)
  cubeCamera.name = 'car-mirror-cube'
  scene.add(cubeCamera)

  const first = (
    Array.isArray(glass[0].material) ? glass[0].material[0] : glass[0].material
  ) as THREE.MeshStandardMaterial
  const material = new THREE.MeshStandardMaterial({
    name: 'car-mirror-glass',
    // A mirror is a little darker than the world it reflects, and these models
    // ship the glass as flat white.
    color: first?.color
      ? first.color.clone().lerp(new THREE.Color(0xd8e6ee), 0.5)
      : new THREE.Color(0xd8e6ee),
    metalness: 1,
    // 金属度 1、粗糙度 0.05 近似理想镜面；envMapIntensity 1.1 略高于 1。
    roughness: 0.05,
    envMap: cubeTarget.texture,
    envMapIntensity: 1.1,
    side: first?.side ?? THREE.DoubleSide,
  })

  /**
   * The middle of the glass: where the cube camera looks out from.
   *
   * Measured from the vertices, not from the meshes' own origins. These models
   * keep every mesh origin on the car's centre line, so `getWorldPosition` put
   * the cube camera inside the cabin - and the mirror then reflected the inside
   * of the car, which is to say black.
   */
  const glassCentre = () => {
    const centre = new THREE.Vector3()
    const point = new THREE.Vector3()
    let count = 0
    for (const mesh of glass) {
      const position = mesh.geometry.getAttribute('position')
      if (!position) continue
      mesh.updateWorldMatrix(true, false)
      const step = Math.max(1, Math.floor(position.count / 200))
      for (let index = 0; index < position.count; index += step) {
        point
          .set(position.getX(index), position.getY(index), position.getZ(index))
          .applyMatrix4(mesh.matrixWorld)
        centre.add(point)
        count++
      }
    }
    if (!count) return centre
    return centre.divideScalar(count)
  }

  let enabled = true
  let captures = 0
  let lastCapture = -Infinity
  const lastRigPosition = new THREE.Vector3()
  const lastRigQuaternion = new THREE.Quaternion()

  /** The glass of a mirror looks back along the car: normal pointing -Z. */
  const glassKey = (centre: THREE.Vector3, normal: THREE.Vector3) =>
    normal.z < -0.45 ? 'glass' : 'housing'
  /** What each mesh looked like before this layer was put on it. */
  const replaced: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = []
  let glazing: THREE.Group | null = null
  if (options.splitGlass) {
    const holder = new THREE.Group()
    glazing = holder
    holder.name = 'car-mirror-glazing'
    rig.root.add(holder)
    for (const mesh of glass) {
      mesh.updateMatrixWorld(true)
      const groups = splitMesh(mesh, rig.root.scale.x || 1, glassKey)
      const source = (
        Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      ) as THREE.Material
      for (const [name, geometry] of groups) {
        owned.push(geometry)
        const piece = new THREE.Mesh(geometry, name === 'glass' ? material : source)
        piece.name = `car-mirror-${name}`
        holder.add(piece)
        bodyParts.push(piece)
      }
      // The original is replaced by the two pieces: one reflective, one painted.
      mesh.visible = false
    }
  } else {
    for (const mesh of glass) {
      replaced.push({ mesh, material: mesh.material })
      mesh.material = material
    }
  }
  const apply = () => {
    if (glazing) {
      glazing.visible = enabled
      for (const mesh of glass) mesh.visible = !enabled
      return
    }
    for (const entry of replaced) entry.mesh.material = enabled ? material : entry.material
  }
  apply()

  return {
    state: () => ({
      meshes: glass.length,
      reflection: enabled,
      material: material.name,
      centre: glassCentre()
        .toArray()
        .map((value) => Number(value.toFixed(2))),
      captures,
    }),
    setEnabled(value) {
      enabled = Boolean(value)
      apply()
    },
    update(now) {
      if (!enabled) return
      // The cube has to follow the car, not the camera: what a mirror shows is
      // the world around it, and a camera move does not change that. So it is
      // taken when the car has travelled or turned - and never while the car is
      // sitting still, which is also what keeps a paused scene from paying for
      // six extra renders a second in the middle of a frame-rate measurement.
      const travelled = lastRigPosition.distanceTo(rig.root.position)
      const turned = lastRigQuaternion.angleTo(rig.root.quaternion)
      const fresh =
        captures > 0 &&
        travelled < CAPTURE_TRAVEL &&
        turned < CAPTURE_TURN &&
        !(
          // 极小位移（约 2.3 毫米）或转角（0.002 弧度）才算“动过”，静止时不重拍。
          now - lastCapture > CAPTURE_STALE && (travelled > fromLegacyUnits(0.01) || turned > 0.002)
        )
      if (fresh) return
      lastCapture = now
      lastRigPosition.copy(rig.root.position)
      lastRigQuaternion.copy(rig.root.quaternion)
      cubeCamera.position.copy(glassCentre())
      // The mirror must not reflect the mirror: hide the glass for the capture and
      // put it straight back, whatever the capture does.
      const wasVisible = glass.map((mesh) => mesh.visible)
      for (const mesh of glass) mesh.visible = false
      try {
        cubeCamera.update(renderer, scene)
        captures++
      } finally {
        glass.forEach((mesh, index) => {
          mesh.visible = wasVisible[index]
        })
      }
    },
    dispose() {
      cubeCamera.removeFromParent()
      cubeTarget.dispose()
      material.dispose()
      for (const geometry of owned) geometry.dispose()
    },
  }
}
