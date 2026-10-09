import * as THREE from 'three'
import type { CarRig } from './loadCar'
import { quadrantKey, sideKey, splitMesh, splitMeshIslands, type TriangleKey } from './split'
import { DOOR_IDS, type DoorId, type DoorSpec } from './definition'
import { fromLegacyUnits } from '../units'

/**
 * 车身可动件动画：车窗下降、后视镜折叠、车门逐个开合、天窗滑开。
 *
 * 在整体里的位置：属于 race/car 的装配层，建立在 loadCar 产出的 CarRig 之上，
 * 由车型定义（definition.ts 的装饰器）声明本车到底有哪些可动件。
 *
 * 对外导出：createCarBody 工厂与 CarBody / CarBodyOptions 等类型。
 * 非直觉约定：所有测量都落在车自身的坐标系里（+x 为车左、+z 为车头方向），不落在世界轴上；
 * 车窗行程、门的铰点位置都按模型顶点实测，不靠猜测。
 */

/**
 * Body animations: windows down, mirrors folded in, doors opened, sunroof open.
 *
 * All of them are the same trick - take a part, move or rotate it, and animate
 * the amount - but the parts differ wildly between models, so each car names its
 * own in the definition. Three of them need the mesh cut first: the BMW's cabin
 * is one glass mesh covering both sides, its mirrors are one mesh spanning the
 * car, and its four doors arrive as a single mesh as well.
 *
 * The travel of a window is its own height, measured on the model rather than
 * guessed, so a tall SUV window and a low supercar window both end up fully
 * inside their doors.
 */
/** 车身可动件的开关目标：车窗、后视镜、天窗三个开关量。 */
export type BodyTargets = { windows: boolean; mirrors: boolean; sunroof: boolean }
/** 单个可动件的名字，即 BodyTargets 的键。 */
export type BodyPartName = keyof BodyTargets

/** 每扇门当前的开启进度：0 为全关，1 为全开。 */
export type DoorProgress = Record<DoorId, number>
/** 各可动件所驱动网格的世界中心，供自检与调试读取。 */
export type BodyProbe = Record<BodyPartName, number[][]> & { doors: Record<DoorId, number[][]> }

/** 车身动画控制器：按目标值平滑驱动车窗 / 后视镜 / 天窗 / 车门。 */
export type CarBody = {
  set(patch: Partial<BodyTargets>): void
  toggle(part: BodyPartName): void
  /** Doors open and close one at a time: this is not one target but four. */
  setDoors(patch: Partial<Record<DoorId, boolean>>): void
  toggleDoor(id: DoorId): void
  /** The doors this model actually has; the rest are not wired up. */
  doorIds(): DoorId[]
  /**
   * Where a door hangs: its hinge and samples of its leading and trailing
   * vertices, in world space. A door that swings about a point inside the car
   * rather than on its leading edge looks wrong in a way no screenshot check
   * catches, so the geometry is readable from here.
   */
  doorPoints(id: DoorId): {
    hinge: number[]
    bounds: { min: number[]; max: number[] }
    leading: number[][]
    trailing: number[][]
  }
  state(): {
    /** 0 fully closed .. 1 fully open, per part. */
    windows: number
    mirrors: number
    sunroof: number
    targets: BodyTargets
    /** Same, per door. */
    doors: DoorProgress
    doorTargets: Record<DoorId, boolean>
    /** How many meshes each part drives; 0 means this model has none. */
    parts: Record<BodyPartName, number> & { doors: number }
  }
  update(dt: number): void
  /** World centres of the meshes each part drives: for checks and debugging. */
  probe(): BodyProbe
  dispose(): void
}

/** createCarBody 的配置：声明本车各可动件的匹配方式与开合时长。 */
export type CarBodyOptions = {
  rig: CarRig
  /** Door glass. `split` cuts a mesh that holds several windows first. */
  windows?: { pattern: RegExp; split?: 'sides' | 'quadrants' }
  /** Mirror housings, hinged at the inner edge. */
  mirrors?: { pattern: RegExp; split?: boolean }
  /** Roof panel, hinged at its front edge. */
  sunroof?: RegExp
  /** Doors, named per corner or arriving as one mesh to cut. */
  doors?: DoorSpec
  /** Seconds for a full open or close. */
  duration?: number
}

/** 车窗下移量占其自身高度的比例；按实测高度取 92%，高窗矮窗都能完全缩进车门。 */
const WINDOW_TRAVEL = 0.92
/** 后视镜向内折叠的角度：78 度。 */
const MIRROR_FOLD = THREE.MathUtils.degToRad(78)
/** Share of its own length the roof panel slides back. */
const SUNROOF_SLIDE = 0.62
/** ...and the most it may travel, so a full-length glass roof cannot hang off. */
const SUNROOF_MAX_TRAVEL = fromLegacyUnits(3.3)
/** Lift so the sliding panel rides over the roof instead of through it. */
const SUNROOF_LIFT = 0.02
/** How far a door swings. Enough to read as open, short of the next car along. */
const DOOR_OPEN = THREE.MathUtils.degToRad(58)
/** How many nodes up a mesh's parents the door patterns are tested. */
const DOOR_ANCESTORS = 8

/**
 * 构建一台车的车身动画控制器。
 *
 * @param options 各可动件的匹配方式与开合时长
 * @returns CarBody 实例，需每帧调用 update(dt) 推进动画
 */
export function createCarBody(options: CarBodyOptions): CarBody {
  const { rig } = options
  // 未指定时一次全开或全关用 1.1 秒。
  const duration = options.duration ?? 1.1
  rig.root.updateMatrixWorld(true)
  const scale = rig.root.scale.x || 1
  const owned: THREE.BufferGeometry[] = []
  // Pieces cut out of a shared mesh go here, directly under the rig root: their
  // triangles are already in rig space, and the mesh they came from sits under
  // model nodes with their own scale, so re-parenting them there would transform
  // them twice (a window 5 mm across, at the middle of the car).
  const cutParts = new THREE.Group()
  cutParts.name = 'car-body-parts'
  rig.root.add(cutParts)
  // `travel` is the motion in world space; `delta` is the same motion expressed
  // in whatever frame the part's parent happens to be in. A door hinge can take
  // a window over later, and a window glass slid down a hinge that carries the
  // car's axes instead of the model node's would go sideways instead of down -
  // so the delta is worked out again once the parenting has settled.
  type Slider = {
    object: THREE.Object3D
    start: THREE.Vector3
    delta: THREE.Vector3
    travel: THREE.Vector3
  }
  const sliders: Slider[] = []
  const roofSliders: Slider[] = []
  type Hinge = {
    pivot: THREE.Group
    axis: THREE.Vector3
    angle: number
    base: THREE.Quaternion
    attached: THREE.Object3D
  }
  const hinges: Hinge[] = []
  const doorArms: (Hinge & { id: DoorId })[] = []
  const doorParts: Record<DoorId, number> = { fl: 0, fr: 0, rl: 0, rr: 0 }
  /** Each door as built: its hinge and its vertices, in the car's frame. */
  const doorsBuilt: { id: DoorId; hinge: THREE.Vector3; angle: number; points: THREE.Vector3[] }[] =
    []
  const rigQuaternion = new THREE.Quaternion()
  const parentQuaternion = new THREE.Quaternion()
  rig.root.getWorldQuaternion(rigQuaternion)
  const worldUp = new THREE.Vector3(0, 1, 0)
  let windowParts = 0,
    mirrorParts = 0,
    sunroofParts = 0

  /** World-space offset, expressed in the object's parent's local units. */
  const localOffset = (object: THREE.Object3D, world: THREE.Vector3) => {
    const parent = object.parent
    if (!parent) return world.clone()
    parent.updateMatrixWorld(true)
    const from = parent.worldToLocal(object.getWorldPosition(new THREE.Vector3()).clone())
    const to = parent.worldToLocal(object.getWorldPosition(new THREE.Vector3()).clone().add(world))
    return to.sub(from)
  }

  /** A pivot at `hinge` (world space) with `object` parented to it. */
  /**
   * A pivot at `hinge` (world space) with `object` parented to it, oriented so
   * that its axes are the *car's* axes rather than its parent's.
   *
   * That last part is not cosmetic: these models carry baked rotations (the
   * Sketchfab root turns Z-up into Y-up, several nodes are rotated), so the
   * parent's local Y can be the world's Z. Rotating around it folded the mirror
   * through the roof instead of back along the door. The pivot cancels the whole
   * chain between the rig and the parent, keeping the rig's own frame - which is
   * what makes a fold follow the car when the car is facing another way.
   */
  const hingeAt = (
    object: THREE.Object3D,
    hinge: THREE.Vector3,
    axis: THREE.Vector3,
    angle: number,
    into: Hinge[] = hinges,
  ) => {
    const parent = object.parent
    if (!parent) return null
    const pivot = new THREE.Group()
    pivot.name = `car-body-${axis.equals(worldUp) ? 'mirror' : 'sunroof'}-hinge`
    parent.add(pivot)
    pivot.position.copy(parent.worldToLocal(hinge.clone()))
    parent.getWorldQuaternion(parentQuaternion)
    const base = parentQuaternion.clone().invert().multiply(rigQuaternion)
    pivot.quaternion.copy(base)
    pivot.updateMatrixWorld(true)
    pivot.attach(object)
    into.push({ pivot, axis, angle, base, attached: object })
    return pivot
  }

  /**
   * The union box of some pieces, expressed in the rig's own frame.
   *
   * Which corner of a door is its front one cannot be read off world axes: the
   * car is on a track at whatever heading it spawned with. Everything about a
   * door - its side, its hinge, the way it swings - is decided here, in the
   * frame the model was authored in, where +x is the car's left and +z is the
   * way it faces.
   */
  const rigBoxOf = (objects: THREE.Object3D[]) => {
    const box = new THREE.Box3()
    const worldBox = new THREE.Box3()
    const corner = new THREE.Vector3()
    for (const object of objects) {
      worldBox.setFromObject(object)
      for (let index = 0; index < 8; index++) {
        corner.set(
          index & 1 ? worldBox.max.x : worldBox.min.x,
          index & 2 ? worldBox.max.y : worldBox.min.y,
          index & 4 ? worldBox.max.z : worldBox.min.z,
        )
        box.expandByPoint(rig.root.worldToLocal(corner.clone()))
      }
    }
    return box
  }

  /**
   * Which door a point belongs to, judged in the car's own frame: +x is the
   * car's left, +z is the way it faces, and `splitZ` divides front from rear.
   */
  const doorAt = (local: THREE.Vector3, splitZ: number): DoorId =>
    `${local.z < splitZ ? 'r' : 'f'}${local.x > 0 ? 'l' : 'r'}` as DoorId

  /**
   * Every vertex of some pieces, in the car's own frame.
   *
   * A bounding box is not good enough to hang a door on. These models inflate
   * the box of any mesh that carries one stray vertex, and a door carries more
   * than its skin - the mirror pod hangs off the front, the card sits inboard -
   * so a box corner can land a third of a metre inside the cabin. Put the hinge
   * there and the door swings about a point behind the dashboard: its leading
   * edge dives into the body instead of hanging on it.
   */
  const verticesOf = (pieces: THREE.Object3D[]) => {
    const points: THREE.Vector3[] = []
    const point = new THREE.Vector3()
    for (const piece of pieces) {
      piece.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const position = mesh.geometry.getAttribute('position')
        if (!position) return
        mesh.updateWorldMatrix(true, false)
        for (let index = 0; index < position.count; index++) {
          point
            .set(position.getX(index), position.getY(index), position.getZ(index))
            .applyMatrix4(mesh.matrixWorld)
          points.push(rig.root.worldToLocal(point.clone()))
        }
      })
    }
    return points
  }

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? 0
  }

  const collect = (pattern: RegExp, split: 'sides' | 'quadrants' | undefined, label: string) => {
    const found: THREE.Mesh[] = []
    rig.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !mesh.visible) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const text = `${mesh.name} ${mesh.parent?.name ?? ''} ${materials.map((item) => item.name ?? '').join(' ')}`
      if (pattern.test(text)) found.push(mesh)
    })
    const pieces: THREE.Object3D[] = []
    for (const mesh of found) {
      if (!split) {
        pieces.push(mesh)
        continue
      }
      mesh.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(mesh)
      const key: TriangleKey =
        split === 'sides' ? sideKey : quadrantKey((box.min.z + box.max.z) / 2)
      const groups = splitMesh(mesh, scale, key)
      const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      for (const [name, geometry] of groups) {
        owned.push(geometry)
        const piece = new THREE.Mesh(geometry, source)
        piece.name = `${label}-${name}`
        cutParts.add(piece)
        pieces.push(piece)
      }
      mesh.visible = false
    }
    return pieces
  }

  /** Mirror housings, with the car's centre dropped when the mesh holds more. */
  const collectMirrors = (pattern: RegExp, split: boolean) => {
    if (!split) return collect(pattern, undefined, 'car-mirror')
    const found: THREE.Mesh[] = []
    rig.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !mesh.visible) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const text = `${mesh.name} ${mesh.parent?.name ?? ''} ${materials.map((item) => item.name ?? '').join(' ')}`
      if (pattern.test(text)) found.push(mesh)
    })
    const pieces: THREE.Object3D[] = []
    for (const mesh of found) {
      mesh.updateMatrixWorld(true)
      const box = new THREE.Box3().setFromObject(mesh)
      // 中线阈值取网格横向半幅的 45%：|x| 小于它视为车内中央部件（如内后视镜），不参与折叠。
      const limit = Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) * 0.45
      const key: TriangleKey = (centre) =>
        Math.abs(centre.x) < limit ? 'centre' : centre.x < 0 ? 'left' : 'right'
      const groups = splitMesh(mesh, scale, key)
      const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      for (const [name, geometry] of groups) {
        owned.push(geometry)
        const piece = new THREE.Mesh(geometry, source)
        piece.name = `car-mirror-${name}`
        cutParts.add(piece)
        // The middle piece is the interior mirror: it is built and kept, it just
        // does not fold with the door pods.
        if (name !== 'centre') pieces.push(piece)
      }
      mesh.visible = false
    }
    return pieces
  }

  if (options.windows) {
    for (const piece of collect(options.windows.pattern, options.windows.split, 'car-window')) {
      const box = new THREE.Box3().setFromObject(piece)
      const height = box.max.y - box.min.y
      const travel = new THREE.Vector3(0, -height * WINDOW_TRAVEL, 0)
      const delta = localOffset(piece, travel)
      sliders.push({ object: piece, start: piece.position.clone(), delta, travel })
      windowParts++
    }
  }

  if (options.doors) {
    /** Meshes whose own name, or any name up the chain, matches the pattern. */
    const doorMeshes = (pattern: RegExp) => {
      const found: THREE.Mesh[] = []
      rig.root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh || !mesh.visible) return
        let node: THREE.Object3D | null = mesh
        for (let depth = 0; node && depth < DOOR_ANCESTORS; depth++, node = node.parent) {
          if (node.name && pattern.test(node.name)) {
            found.push(mesh)
            return
          }
        }
      })
      return found
    }
    const addDoor = (id: DoorId, pieces: THREE.Object3D[]) => {
      if (!pieces.length) return
      // The hinge of a real door sits in the middle of the door's thickness at
      // its leading edge, so the door hangs on that edge and the trailing edge
      // is what sweeps out. Both numbers come from the door's own vertices: the
      // frontmost tenth says where the leading edge is, and the median x of
      // exactly those vertices is the middle of however thick the door is there
      // - the mirror pod and the door card are further back and do not vote.
      const points = verticesOf(pieces)
      const left = id === 'fl' || id === 'rl'
      const byZ = [...points].sort((a, b) => a.z - b.z)
      const leading = byZ.slice(Math.floor(byZ.length * 0.9))
      // The axis sits on the *outboard* face of that leading slice, not in the
      // middle of it. Whichever face the axis is on is the face that stays put
      // while the door swings, and the outboard face is the painted skin - the
      // only part of a shut door anybody can see. A mid-thickness hinge left the
      // skin's leading corner sweeping a hand's width inwards, into the wing.
      const leadingX = leading.map((point) => point.x)
      const hingeLocal = new THREE.Vector3(
        left ? Math.max(...leadingX) : Math.min(...leadingX),
        median(points.map((point) => point.y)),
        byZ[Math.floor(byZ.length * 0.99)]?.z ?? 0,
      )
      const angle = left ? -DOOR_OPEN : DOOR_OPEN
      // `localToWorld` transforms the vector it is given, so the pivot gets its
      // own copy: the stored hinge has to stay in the car's frame or every
      // measurement taken from it is in a different space than the vertices.
      const hinge = rig.root.localToWorld(hingeLocal.clone())
      doorsBuilt.push({ id, hinge: hingeLocal, angle, points })
      const before = doorArms.length
      for (const piece of pieces) hingeAt(piece, hinge, worldUp, angle, doorArms)
      for (let index = before; index < doorArms.length; index++) doorArms[index].id = id
      doorParts[id] = doorArms.length - before
    }
    if ('split' in options.doors) {
      // One mesh holding all four doors: cut it, and hide the original.
      const sources: THREE.Mesh[] = []
      rig.root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (
          mesh.isMesh &&
          mesh.visible &&
          options.doors &&
          'split' in options.doors &&
          options.doors.split.test(mesh.name)
        )
          sources.push(mesh)
      })
      for (const mesh of sources) {
        mesh.updateMatrixWorld(true)
        const box = rigBoxOf([mesh])
        const splitZ = (box.min.z + box.max.z) / 2
        // Named per island, so a door that straddles the line is still taken
        // whole rather than half of it swinging out with the next door along.
        const groups = splitMeshIslands(mesh, scale, (centre) =>
          doorAt(rig.root.worldToLocal(centre.clone()), splitZ),
        )
        const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        const byDoor: Partial<Record<DoorId, THREE.Object3D[]>> = {}
        for (const [name, geometry] of groups) {
          if (!(DOOR_IDS as readonly string[]).includes(name)) continue
          owned.push(geometry)
          const piece = new THREE.Mesh(geometry, source)
          piece.name = `car-door-${name}`
          cutParts.add(piece)
          ;(byDoor[name as DoorId] ??= []).push(piece)
        }
        mesh.visible = false
        for (const id of DOOR_IDS) addDoor(id, byDoor[id] ?? [])
      }
    } else {
      for (const id of DOOR_IDS) {
        const pattern = options.doors.panels[id]
        if (pattern) addDoor(id, doorMeshes(pattern))
      }
    }
    // A door hinge may have taken over a window: `attach` rewrites the local
    // transform, so both ends of the slider are worked out again in the frame
    // the part now lives in.
    for (const slider of [...sliders, ...roofSliders]) {
      slider.start.copy(slider.object.position)
      slider.delta.copy(localOffset(slider.object, slider.travel))
    }
  }

  if (options.mirrors) {
    // A mirror mesh can hold more than the mirrors: the BMW's one mesh carries
    // both door pods *and* the interior rear-view mirror up by the windscreen
    // (its bounds run from x -0.7 to 4.7 and reach z 5.4). Splitting it by side
    // alone therefore folded the interior mirror too - which is what read as "a
    // layer stuck on the mirror that swings away before the mirror appears".
    // Only the outboard pods belong to the fold, so the split drops anything
    // inside the middle of the car.
    const mirrorPieces = collectMirrors(options.mirrors.pattern, options.mirrors.split === true)
    // One hinge per pod. A pod is several meshes - the housing, the glass in it,
    // the trim - and each has its own bounding box, so boxing them one at a time
    // gave the glass and its housing two parallel axes a third of a metre apart:
    // the whole assembly turned by the same angle and still came apart, because
    // the glass was swinging about a point the housing was not.
    const pods: Record<'left' | 'right', THREE.Object3D[]> = { left: [], right: [] }
    for (const piece of mirrorPieces) {
      const centre = new THREE.Box3().setFromObject(piece).getCenter(new THREE.Vector3())
      pods[centre.x >= 0 ? 'left' : 'right'].push(piece)
    }
    for (const side of ['left', 'right'] as const) {
      const pod = pods[side]
      if (!pod.length) continue
      const box = new THREE.Box3()
      for (const piece of pod) box.union(new THREE.Box3().setFromObject(piece))
      const centre = box.getCenter(new THREE.Vector3())
      // Hinge on the side of the housing that meets the door, so it folds back
      // against the window instead of through it.
      const hinge = new THREE.Vector3(side === 'left' ? box.min.x : box.max.x, centre.y, centre.z)
      const angle = side === 'left' ? MIRROR_FOLD : -MIRROR_FOLD
      for (const piece of pod) if (hingeAt(piece, hinge, worldUp, angle)) mirrorParts++
    }
  }

  if (options.sunroof) {
    for (const piece of collect(options.sunroof, undefined, 'car-sunroof')) {
      const box = new THREE.Box3().setFromObject(piece)
      // The panel's length has to be measured along the *car's* forward axis, not
      // along world Z: the car is usually pointed somewhere else, and a world
      // extent then mixes the panel's length with its width, so the same sunroof
      // opened by a different amount at every point on the track.
      const forwardWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(rigQuaternion).normalize()
      let alongMin = Infinity,
        alongMax = -Infinity
      for (let corner = 0; corner < 8; corner++) {
        const point = new THREE.Vector3(
          corner & 1 ? box.max.x : box.min.x,
          corner & 2 ? box.max.y : box.min.y,
          corner & 4 ? box.max.z : box.min.z,
        )
        const along = point.dot(forwardWorld)
        alongMin = Math.min(alongMin, along)
        alongMax = Math.max(alongMax, along)
      }
      // A sliding roof, not a vent: the panel travels back along the car and a
      // hair upwards, so it rides over the roof it just uncovered.
      const travel = forwardWorld
        .clone()
        .multiplyScalar(-Math.min((alongMax - alongMin) * SUNROOF_SLIDE, SUNROOF_MAX_TRAVEL))
      travel.y += SUNROOF_LIFT
      const delta = localOffset(piece, travel)
      roofSliders.push({ object: piece, start: piece.position.clone(), delta, travel })
      sunroofParts++
    }
  }

  const parts = {
    windows: windowParts,
    mirrors: mirrorParts,
    sunroof: sunroofParts,
    doors: DOOR_IDS.filter((id) => doorParts[id] > 0).length,
  }
  const targets: BodyTargets = { windows: false, mirrors: false, sunroof: false }
  const current = { windows: 0, mirrors: 0, sunroof: 0 }
  const doorTargets: Record<DoorId, boolean> = { fl: false, fr: false, rl: false, rr: false }
  const doorCurrent: Record<DoorId, number> = { fl: 0, fr: 0, rl: 0, rr: 0 }

  const apply = (part: BodyPartName, value: number) => {
    if (part === 'windows') {
      for (const slider of sliders)
        slider.object.position.copy(slider.start).addScaledVector(slider.delta, value)
      return
    }
    if (part === 'sunroof') {
      for (const slider of roofSliders)
        slider.object.position.copy(slider.start).addScaledVector(slider.delta, value)
      return
    }
    const turn = new THREE.Quaternion()
    for (const hinge of hinges) {
      turn.setFromAxisAngle(hinge.axis, hinge.angle * value)
      hinge.pivot.quaternion.copy(hinge.base).multiply(turn)
    }
  }

  const applyDoors = (id: DoorId, value: number) => {
    const turn = new THREE.Quaternion()
    for (const arm of doorArms) {
      if (arm.id !== id) continue
      turn.setFromAxisAngle(arm.axis, arm.angle * value)
      arm.pivot.quaternion.copy(arm.base).multiply(turn)
    }
  }

  return {
    set(patch) {
      for (const key of Object.keys(patch) as BodyPartName[]) {
        if (parts[key] === 0) continue
        targets[key] = patch[key] === true
      }
    },
    toggle(part) {
      if (parts[part] === 0) return
      targets[part] = !targets[part]
    },
    setDoors(patch) {
      for (const key of Object.keys(patch) as DoorId[]) {
        if (doorParts[key] === 0) continue
        doorTargets[key] = patch[key] === true
      }
    },
    toggleDoor(id) {
      if (doorParts[id] === 0) return
      doorTargets[id] = !doorTargets[id]
    },
    doorIds: () => DOOR_IDS.filter((id) => doorParts[id] > 0),
    doorPoints(id) {
      const door = doorsBuilt.find((entry) => entry.id === id)
      if (!door) return { hinge: [], bounds: { min: [], max: [] }, leading: [], trailing: [] }
      rig.root.updateMatrixWorld(true)
      const scale = rig.root.scale.x || 1
      // The stored vertices are the closed door. Rotating them about the hinge
      // by however far this door is open gives where they are now, without
      // needing to keep a handle on every mesh the door carries.
      const turn = new THREE.Quaternion().setFromAxisAngle(worldUp, door.angle * doorCurrent[id])
      // Returned in the car's own frame, not the world's: the car is moving while
      // a door is opened, and a door that looks like it flew four metres down the
      // road is not a measurement of the door.
      const toCarFrame = (point: THREE.Vector3) =>
        point
          .clone()
          .sub(door.hinge)
          .applyQuaternion(turn)
          .add(door.hinge)
          .toArray()
          .map((value) => Number((value * scale).toFixed(3)))
      const sample = (list: THREE.Vector3[]) => {
        const step = Math.max(1, Math.floor(list.length / 8))
        const picked: number[][] = []
        for (let index = 0; index < list.length && picked.length < 8; index += step)
          picked.push(toCarFrame(list[index]))
        return picked
      }
      const byZ = [...door.points].sort((a, b) => a.z - b.z)
      // Where the door is *now*, not where it was built: a door that swings
      // inwards reaches deeper into the car than it did shut, and that number is
      // what says whether the hinge is on the door or buried in the cabin.
      const swung = (point: THREE.Vector3) =>
        point.clone().sub(door.hinge).applyQuaternion(turn).add(door.hinge)
      const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
      for (const point of door.points.map(swung)) {
        for (const axis of [0, 1, 2]) {
          const value = axis === 0 ? point.x : axis === 1 ? point.y : point.z
          bounds.min[axis] = Math.min(bounds.min[axis], value)
          bounds.max[axis] = Math.max(bounds.max[axis], value)
        }
      }
      return {
        hinge: door.hinge.toArray().map((value) => Number((value * scale).toFixed(3))),
        bounds: {
          min: bounds.min.map((value) => Number((value * scale).toFixed(3))),
          max: bounds.max.map((value) => Number((value * scale).toFixed(3))),
        },
        leading: sample(byZ.slice(Math.floor(byZ.length * 0.9))),
        trailing: sample(byZ.slice(0, Math.max(1, Math.floor(byZ.length * 0.1)))),
      }
    },
    probe() {
      rig.root.updateMatrixWorld(true)
      const point = new THREE.Vector3()
      /**
       * Where a part actually is: the mean of its vertices, in world space.
       *
       * `getWorldPosition` answers with the node's own origin, and these models
       * keep every mesh origin on the car's centre line - the answer is the same
       * point for a door, a window and a wheel, which is no use for "did this
       * part move with that one".
       */
      const centreOf = (object: THREE.Object3D) => {
        const sum = new THREE.Vector3()
        let count = 0
        object.traverse((child) => {
          const mesh = child as THREE.Mesh
          if (!mesh.isMesh) return
          const position = mesh.geometry.getAttribute('position')
          if (!position) return
          mesh.updateWorldMatrix(true, false)
          const step = Math.max(1, Math.floor(position.count / 200))
          for (let index = 0; index < position.count; index += step) {
            point
              .set(position.getX(index), position.getY(index), position.getZ(index))
              .applyMatrix4(mesh.matrixWorld)
            sum.add(point)
            count++
          }
        })
        if (!count)
          return object
            .getWorldPosition(point)
            .toArray()
            .map((value) => Number(value.toFixed(3)))
        return sum
          .divideScalar(count)
          .toArray()
          .map((value) => Number(value.toFixed(3)))
      }
      const doors = {} as Record<DoorId, number[][]>
      for (const id of DOOR_IDS) {
        doors[id] = doorArms.filter((arm) => arm.id === id).map((arm) => centreOf(arm.attached))
      }
      return {
        windows: sliders.map((slider) => centreOf(slider.object)),
        mirrors: hinges.map((hinge) => centreOf(hinge.attached)),
        sunroof: roofSliders.map((slider) => centreOf(slider.object)),
        doors,
      }
    },
    state: () => ({
      windows: Number(current.windows.toFixed(3)),
      mirrors: Number(current.mirrors.toFixed(3)),
      sunroof: Number(current.sunroof.toFixed(3)),
      targets: { ...targets },
      doors: {
        fl: Number(doorCurrent.fl.toFixed(3)),
        fr: Number(doorCurrent.fr.toFixed(3)),
        rl: Number(doorCurrent.rl.toFixed(3)),
        rr: Number(doorCurrent.rr.toFixed(3)),
      },
      doorTargets: { ...doorTargets },
      parts: { ...parts },
    }),
    update(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return
      const step = dt / duration
      for (const part of ['windows', 'mirrors', 'sunroof'] as BodyPartName[]) {
        if (parts[part] === 0) continue
        const goal = targets[part] ? 1 : 0
        if (current[part] === goal) continue
        const next =
          goal > current[part]
            ? Math.min(goal, current[part] + step)
            : Math.max(goal, current[part] - step)
        current[part] = next
        apply(part, next)
      }
      for (const id of DOOR_IDS) {
        if (doorParts[id] === 0 || doorCurrent[id] === (doorTargets[id] ? 1 : 0)) continue
        const goal = doorTargets[id] ? 1 : 0
        const next =
          goal > doorCurrent[id]
            ? Math.min(goal, doorCurrent[id] + step)
            : Math.max(goal, doorCurrent[id] - step)
        doorCurrent[id] = next
        applyDoors(id, next)
      }
    },
    dispose() {
      for (const slider of sliders) slider.object.position.copy(slider.start)
      for (const slider of roofSliders) slider.object.position.copy(slider.start)
      for (const hinge of hinges) hinge.pivot.quaternion.copy(hinge.base)
      for (const arm of doorArms) arm.pivot.quaternion.copy(arm.base)
      for (const geometry of owned) geometry.dispose()
    },
  }
}
