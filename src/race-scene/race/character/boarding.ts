import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { CarRig } from '../car/loadCar'
import { UNITS_PER_METRE } from '../units'

/**
 * 上车 / 下车的角色动画：把未带动画的骨骼模型逐帧摆成预定姿势并沿轨道走位。
 *
 * 在整体里的位置：race/character 的角色层。模型是 74 骨的 Mixamo 骨架但没有动画片段，
 * 因此动作全靠手摆骨骼角度；角色贴着车放置（不挂在 rig 上），坐标统一用米，
 * 再由 toRigLocal 折回车辆源模型单位、经 localToWorld 落位。
 *
 * 对外导出：createBoarding 工厂与 Boarding / BoardingOptions / SeatSpec 类型。
 * 非直觉约定：时间轴、座位与地板都用米，世界空间本身已是米制；车顶高度决定坐姿与地板的取舍。
 */

/**
 * Getting into the car.
 *
 * The model is rigged - a 74-bone Mixamo skeleton - but ships no animation clips,
 * so the motion is posed bone by bone. Every angle below was measured against the
 * model rather than guessed: `LeftArm_013` about its local X drops the hand out of
 * the T-pose to the side, `LeftUpLeg_063` about X swings the leg forward (the
 * character faces +z: the toes sit in front of the ankles), `LeftLeg_064` about X
 * is the knee, and the forearms bend forward on Z, mirrored left to right.
 *
 * The character is placed against the car rather than parented to the rig, whose own
 * frame remains in the imported model's units. World coordinates, the timeline,
 * the seat and the floor all use metres; `toRigLocal` converts those metres back
 * into the car's source frame before `localToWorld` places the character.
 */
type Pose = Record<string, [number, number, number]>

/** Standing at the kerb: the arms come down out of the T-pose. */
const STAND: Pose = {
  LeftArm_013: [76, 0, 8],
  RightArm_039: [76, 0, -8],
  LeftForeArm_014: [0, 0, 12],
  RightForeArm_040: [0, 0, -12],
  Spine_02: [2, 0, 0],
}

/**
 * Walking forwards, caught mid-stride: the left leg reaches, the right trails, and
 * the arms swing against the legs. The other half of the cycle is the mirror of it,
 * and the two alternate so the walk reads as walking rather than as one long step.
 * (He faces +z, so a leg swings forward on +X and the arms swing on Z.)
 */
const WALK_A: Pose = {
  LeftArm_013: [74, 0, -16],
  RightArm_039: [74, 0, 20],
  LeftForeArm_014: [0, 0, 16],
  RightForeArm_040: [0, 0, -26],
  LeftUpLeg_063: [26, 0, -2],
  RightUpLeg_068: [-20, 0, 2],
  LeftLeg_064: [-14, 0, 0],
  RightLeg_069: [-28, 0, 0],
  LeftFoot_065: [-8, 0, 0],
  RightFoot_070: [18, 0, 0],
  Spine_02: [5, 0, 0],
  Spine1_03: [2, 0, 0],
}

const WALK_B: Pose = {
  LeftArm_013: [74, 0, 20],
  RightArm_039: [74, 0, -16],
  LeftForeArm_014: [0, 0, 26],
  RightForeArm_040: [0, 0, -16],
  LeftUpLeg_063: [-20, 0, -2],
  RightUpLeg_068: [26, 0, 2],
  LeftLeg_064: [-28, 0, 0],
  RightLeg_069: [-14, 0, 0],
  LeftFoot_065: [18, 0, 0],
  RightFoot_070: [-8, 0, 0],
  Spine_02: [5, 0, 0],
  Spine1_03: [2, 0, 0],
}

/**
 * Standing at the door with the left hand out on the handle, then with the arm
 * drawn back as the door swings towards him. The hand is what opens the door, so
 * the two sit either side of the door's own cue in the timeline.
 */
const REACH: Pose = {
  LeftArm_013: [54, 0, 58],
  LeftForeArm_014: [0, 0, 16],
  LeftHand_017: [0, 0, 8],
  RightArm_039: [74, 0, -10],
  RightForeArm_040: [0, 0, -16],
  LeftUpLeg_063: [6, 0, -2],
  RightUpLeg_068: [-4, 0, 2],
  LeftLeg_064: [-6, 0, 0],
  RightLeg_069: [-6, 0, 0],
  Spine_02: [7, 0, 0],
  Spine1_03: [3, 0, 0],
}

const REACH_PULL: Pose = {
  LeftArm_013: [60, 0, 34],
  LeftForeArm_014: [0, 0, 30],
  LeftHand_017: [0, 0, 12],
  RightArm_039: [74, 0, -8],
  RightForeArm_040: [0, 0, -14],
  LeftUpLeg_063: [4, 0, -2],
  RightUpLeg_068: [-2, 0, 2],
  LeftLeg_064: [-5, 0, 0],
  RightLeg_069: [-5, 0, 0],
  Spine_02: [6, 0, 2],
  Spine1_03: [3, 0, 0],
}

/** Mid-step, outside the door: weight forward, one leg reaching in. */
const STEP: Pose = {
  LeftArm_013: [70, 0, 26],
  RightArm_039: [70, 0, -14],
  LeftForeArm_014: [0, 0, 24],
  RightForeArm_040: [0, 0, -18],
  LeftUpLeg_063: [26, 0, -6],
  RightUpLeg_068: [-8, 0, 4],
  LeftLeg_064: [-30, 0, 0],
  RightLeg_069: [-6, 0, 0],
  LeftFoot_065: [10, 0, 0],
  RightFoot_070: [0, 0, 0],
  Spine_02: [12, 0, 0],
  Spine1_03: [4, 0, 0],
}

/** Sitting on the edge of the seat, legs still outside the sill. */
const SIT_EDGE: Pose = {
  LeftArm_013: [58, 0, 20],
  RightArm_039: [58, 0, -20],
  LeftForeArm_014: [0, 0, 34],
  RightForeArm_040: [0, 0, -34],
  LeftUpLeg_063: [88, 0, -14],
  RightUpLeg_068: [88, 0, 14],
  LeftLeg_064: [-86, 0, 0],
  RightLeg_069: [-86, 0, 0],
  LeftFoot_065: [6, 0, 0],
  RightFoot_070: [6, 0, 0],
  Spine_02: [8, 0, 0],
  Spine1_03: [6, 0, 0],
  Spine2_04: [4, 0, 0],
}

/**
 * Seated properly in a car with headroom: knees in, feet in the footwell, hands
 * on the lap. The knees are bent a right angle, which puts the hips about 0.45 m
 * above the feet - a normal saloon.
 */
const SEATED_UP: Pose = {
  LeftArm_013: [62, 0, 30],
  RightArm_039: [62, 0, -30],
  LeftForeArm_014: [0, 0, 52],
  RightForeArm_040: [0, 0, -52],
  LeftUpLeg_063: [90, 0, -22],
  RightUpLeg_068: [90, 0, 22],
  LeftLeg_064: [-88, 0, 0],
  RightLeg_069: [-88, 0, 0],
  LeftFoot_065: [4, 0, 0],
  RightFoot_070: [4, 0, 0],
  Spine_02: [6, 0, 0],
  Spine1_03: [4, 0, 0],
  Spine2_04: [2, 0, 0],
}

/**
 * Seated in a car that has no headroom: a mid-engined car is barely 1.1 m to the
 * roof, and the roof is the one thing that cannot move. The legs straighten out
 * here - knees nearly open, shins pointing forward instead of down - which drops
 * the hips to about 0.2 m above the feet. The two poses are blended by whichever
 * room the car turns out to have.
 */
const SEATED_LOW: Pose = {
  LeftArm_013: [62, 0, 34],
  RightArm_039: [62, 0, -34],
  LeftForeArm_014: [0, 0, 46],
  RightForeArm_040: [0, 0, -46],
  LeftUpLeg_063: [97, 0, -16],
  RightUpLeg_068: [97, 0, 16],
  LeftLeg_064: [-24, 0, 0],
  RightLeg_069: [-24, 0, 0],
  LeftFoot_065: [18, 0, 0],
  RightFoot_070: [18, 0, 0],
  Spine_02: [10, 0, 0],
  Spine1_03: [5, 0, 0],
  Spine2_04: [3, 0, 0],
}

/** The gap left under the roof, and the closest the floor pan gets to the road. */
const ROOF_MARGIN = 0.1
const FLOOR_MIN = 0.06
/** How many steps between the two seated poses the fit is allowed to search. */
const CROUCH_STEPS = 4

/** One moment of the sequence: where the feet are, which way, and how posed. */
type Keyframe = {
  t: number
  position: [number, number, number]
  /** Yaw in degrees; 0 faces the way the car faces. */
  yaw: number
  pose: Pose
  /** How high the lower foot has to end up: the road, or the car's floor. */
  floor: number
  door?: boolean
  label: string
}

/** Where a person sits, in the car's frame, in metres: hips above the cushion. */
export type SeatSpec = { x: number; y: number; z: number }

/** createBoarding 的配置：场景、车辆、角色地址、座位、地板高度与回调。 */
export type BoardingOptions = {
  scene: THREE.Scene
  rig: CarRig
  url: string
  seat: SeatSpec
  /** Height of the car's floor above the road, in metres, for the feet inside. */
  floor: number
  onDoor?: (open: boolean) => void
  onProgress?: (fraction: number) => void
}

/** 上下车动画控制器接口。 */
export type Boarding = {
  load(): Promise<boolean>
  loaded(): boolean
  start(): boolean
  update(dt: number): void
  state(): {
    loaded: boolean
    running: boolean
    seated: boolean
    label: string
    progress: number
    joints: Record<string, number[]>
    /** The character's own origin in world space, and the seat it aims for. */
    group: number[]
    seat: SeatSpec
    /** World units in a metre; always 1 under the scene's metre contract. */
    unitsPerMetre: number
    /**
     * What the car's roof made of the seat: the floor he ends up sitting over, how
     * far into the low pose he had to go, and the height he ends up sitting at -
     * hips off the lower foot, crown off the same foot, both in metres.
     */
    fit: { floor: number; crouch: number; roof: number; drop: number; crown: number }
  }
  dispose(): void
}

/** 状态上报时读取世界坐标的关节。 */
const JOINTS = [
  'Hips_01',
  'Head_08',
  'LeftFoot_065',
  'RightFoot_070',
  'LeftHand_017',
  'RightHand_043',
]
/** 用于把角色落到地面 / 车内地板的双脚关节。 */
const FEET = ['LeftFoot_065', 'RightFoot_070']

/**
 * 构建上下车动画控制器。
 *
 * @param options 场景、车辆骨架、角色地址、座位、地板高度与回调
 * @returns Boarding 实例；load() 成功后 start() 播放一次完整上下车
 */
export function createBoarding(options: BoardingOptions): Boarding {
  const { scene, rig, url, seat } = options
  const group = new THREE.Group()
  group.name = 'boarding-character'
  group.visible = false
  scene.add(group)
  let model: THREE.Object3D | null = null
  let bones: Record<string, THREE.Bone> = {}
  let rest: Record<string, THREE.Quaternion> = {}
  let loaded = false
  let loading: Promise<boolean> | null = null
  let time = 0
  let running = false
  let lastDoor: boolean | null = null

  /**
   * 按车辆给出的地板高度与最终坐姿，生成整条时间轴（位置为车坐标系中的米）。
   *
   * @param floor 车内地板高度（米）
   * @param seated 已按头顶空间选定的坐姿
   */
  const buildKeyframes = (floor: number, seated: Pose): Keyframe[] => {
    // Shutting the door from the inside: the left hand goes back out to it, the same
    // hand that opened it.
    const seatedReach: Pose = {
      ...seated,
      LeftArm_013: [30, 0, 40],
      LeftForeArm_014: [0, 0, 34],
      LeftHand_017: [0, 0, 10],
    }
    // Four beats, in this order and no other. He walks up the flank facing the way
    // he is going; arrives, turns to face the door and puts a hand on the handle;
    // the door opens from that hand, he steps up and sits; and the door is shut
    // again from the seat. The first version opened the door while he was still
    // three metres behind the car, which no amount of posing can make read as
    // somebody getting in.
    return [
      { t: 0, position: [1.45, 0, -3], yaw: 1, pose: STAND, floor: 0, label: '站定' },
      { t: 0.45, position: [1.45, 0, -2.62], yaw: 1, pose: WALK_A, floor: 0, label: '走向车门' },
      { t: 1.05, position: [1.45, 0, -1.92], yaw: -1, pose: WALK_B, floor: 0, label: '走向车门' },
      { t: 1.65, position: [1.45, 0, -1.22], yaw: 1, pose: WALK_A, floor: 0, label: '走向车门' },
      { t: 2.2, position: [1.45, 0, -0.68], yaw: -1, pose: WALK_B, floor: 0, label: '走到门前' },
      // Turned to the door, weight on both feet, hand going out to the handle.
      {
        t: 2.7,
        position: [1.46, 0, -0.46],
        yaw: -74,
        pose: STAND,
        floor: 0,
        label: '转身面对车门',
      },
      {
        t: 3.15,
        position: [1.46, 0, -0.45],
        yaw: -82,
        pose: REACH,
        floor: 0,
        door: true,
        label: '开门',
      },
      {
        t: 3.65,
        position: [1.46, 0, -0.44],
        yaw: -85,
        pose: REACH_PULL,
        floor: 0,
        label: '拉开车门',
      },
      // In: foot up on the sill, weight over the seat, legs in under the wheel.
      { t: 4.05, position: [1.5, 0, -0.44], yaw: -86, pose: STEP, floor: 0, label: '抬腿上踏板' },
      {
        t: 4.5,
        position: [seat.x + 0.32, 0, seat.z + 0.32],
        yaw: -88,
        pose: SIT_EDGE,
        floor: floor * 0.55,
        label: '坐进去',
      },
      { t: 5.15, position: [seat.x, 0, seat.z], yaw: -8, pose: SIT_EDGE, floor, label: '转身坐正' },
      {
        t: 5.7,
        position: [seat.x, 0, seat.z - 0.04],
        yaw: 0,
        pose: seated,
        floor,
        label: '收腿坐好',
      },
      // And shut, from the inside: the hand goes back out to the door, then comes in.
      {
        t: 6.2,
        position: [seat.x, 0, seat.z - 0.04],
        yaw: 0,
        pose: seatedReach,
        floor,
        door: false,
        label: '关车门',
      },
      { t: 6.75, position: [seat.x, 0, seat.z - 0.04], yaw: 0, pose: seated, floor, label: '坐好' },
    ]
  }

  /**
   * The timeline as it stands, rebuilt once the car has said how much headroom
   * there is - the seated pose and the floor both depend on it.
   */
  let keyframes: Keyframe[] = buildKeyframes(options.floor, SEATED_UP)
  let seatFit = { floor: options.floor, crouch: 0, roof: 0, drop: 0.45, crown: 0.95 }

  /** 把姿势应用到骨骼：未提及的骨骼先回到 rest，随后刷新 group 的世界矩阵。 */
  const applyPose = (pose: Pose) => {
    if (!model) return
    // Every bone starts from rest: a bone this pose does not name must not keep the
    // angle the previous pose gave it.
    for (const [name, bone] of Object.entries(bones)) bone.quaternion.copy(rest[name])
    for (const [name, angles] of Object.entries(pose)) {
      const bone = bones[name]
      if (!bone) continue
      const turn = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          (angles[0] * Math.PI) / 180,
          (angles[1] * Math.PI) / 180,
          (angles[2] * Math.PI) / 180,
          'XYZ',
        ),
      )
      bone.quaternion.copy(rest[name]).multiply(turn)
    }
    // The group's own matrix first, not just the model's: the model's world matrix
    // is built from its parent's, so measuring joints under a stale parent is
    // measuring where the character stood last frame.
    group.updateMatrixWorld(true)
  }

  /**
   * How far the lower foot is from the height this moment asks for.
   *
   * The target is metres above the car's own origin, not above the world's: this
   * bridge stands fifty metres over the water, and comparing a foot at 52 with a
   * floor at 0.36 once dragged the character down to the sea. The group is put
   * through its world matrix first so the measurement is of where it now stands
   * rather than of wherever the last frame left it.
   */
  const footGap = (target: number) => {
    if (!model) return 0
    group.updateMatrixWorld(true)
    let lowest = Infinity
    const point = new THREE.Vector3()
    for (const name of FEET) {
      const bone = bones[name]
      if (bone) lowest = Math.min(lowest, bone.getWorldPosition(point).y)
    }
    if (!Number.isFinite(lowest)) return 0
    return rig.root.getWorldPosition(new THREE.Vector3()).y + target * UNITS_PER_METRE - lowest
  }

  /**
   * How a pose measures up, in metres off the lower foot: where the hips sit and
   * where the top of the head is.
   *
   * The head is measured rather than assumed. A seated person is roughly 0.85 m
   * from the hips to the crown, but "roughly" is how a 1.8 m man ended up standing
   * through the roof of a 1.13 m Lamborghini: the crown is read off the skinned
   * mesh - every vertex, through its own bones - so the fit below is arithmetic on
   * what the pose really does.
   */
  const sitMetrics = (pose: Pose) => {
    applyPose(pose)
    let lowest = Infinity
    let pelvis = 0
    let crown = -Infinity
    const point = new THREE.Vector3()
    for (const name of FEET) {
      const bone = bones[name]
      if (bone) lowest = Math.min(lowest, bone.getWorldPosition(point).y)
    }
    if (bones.Hips_01) pelvis = bones.Hips_01.getWorldPosition(point).y
    group.traverse((object) => {
      const mesh = object as THREE.SkinnedMesh
      if (!mesh.isSkinnedMesh) return
      const positions = mesh.geometry.getAttribute('position')
      if (!positions || !mesh.geometry.getAttribute('skinIndex')) return
      for (let index = 0; index < positions.count; index++) {
        mesh.applyBoneTransform(index, point.fromBufferAttribute(positions, index))
        mesh.localToWorld(point)
        if (point.y > crown) crown = point.y
      }
    })
    if (!Number.isFinite(lowest) || !Number.isFinite(crown)) return { drop: 0.45, crown: 0.95 }
    return {
      drop: (pelvis - lowest) / UNITS_PER_METRE,
      crown: (crown - lowest) / UNITS_PER_METRE,
    }
  }

  /**
   * How tall this car lets a sitting person be.
   *
   * The roof is the one thing that cannot move, so it decides the rest: the floor
   * pan plus however tall the pose is (crown, above the foot) has to come in under
   * it. A saloon has room to spare and keeps the pose and the floor as given. A low
   * car does not, so the floor comes down to the pan first, and the legs straighten
   * after that - the two seated poses are blended by however much room is left.
   */
  const fitSeat = () => {
    const roof = rig.size.y / UNITS_PER_METRE
    const room = roof - ROOF_MARGIN
    const up = sitMetrics(SEATED_UP)
    const low = sitMetrics(SEATED_LOW)
    let crouch = 1
    let floor = FLOOR_MIN
    for (let step = 0; step <= CROUCH_STEPS; step++) {
      const t = step / CROUCH_STEPS
      // The metrics move smoothly between the two poses, so the search can read
      // them off the ends instead of re-skinning the mesh five times.
      const guess = {
        drop: up.drop + (low.drop - up.drop) * t,
        crown: up.crown + (low.crown - up.crown) * t,
      }
      const pan = Math.min(options.floor, room - guess.crown)
      if (pan >= FLOOR_MIN) {
        crouch = t
        floor = pan
        break
      }
    }
    // Then measure the pose that was actually chosen, for the numbers reported.
    const sit = sitMetrics(blendPose(SEATED_UP, SEATED_LOW, crouch))
    floor = Math.max(FLOOR_MIN, Math.min(options.floor, room - sit.crown))
    return {
      floor,
      crouch,
      roof,
      drop: Number(sit.drop.toFixed(3)),
      crown: Number(sit.crown.toFixed(3)),
    }
  }

  /** 在时间轴上取时间 t 所在的相邻关键帧，以及经 smoothstep 缓动后的插值系数。 */
  const sample = (t: number) => {
    let index = 0
    while (index < keyframes.length - 2 && keyframes[index + 1].t < t) index++
    const a = keyframes[index]
    const b = keyframes[index + 1]
    const raw = Math.max(0, Math.min(1, (t - a.t) / Math.max(b.t - a.t, 1e-4)))
    // k 为缓动后的系数（3t²−2t³），raw 为线性系数；1e-4 防止关键帧时间相等时除零。
    return { a, b, k: raw * raw * (3 - 2 * raw), raw }
  }

  /** 按系数 k 在两套姿势间线性混合；两套都未提及的骨骼取零角。 */
  const blendPose = (a: Pose, b: Pose, k: number): Pose => {
    const out: Pose = {}
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const from = a[name] ?? [0, 0, 0]
      const to = b[name] ?? [0, 0, 0]
      out[name] = [0, 1, 2].map((axis) => from[axis] + (to[axis] - from[axis]) * k) as [
        number,
        number,
        number,
      ]
    }
    return out
  }

  /**
   * Metres in the car's frame to the rig's own units.
   *
   * The imported car can still carry any source scale. Divide by its metres per
   * local unit before using localToWorld; world space itself is already metres.
   */
  const toRigLocal = (position: [number, number, number]) => {
    rig.root.updateMatrixWorld(true)
    const origin = rig.root.localToWorld(new THREE.Vector3(0, 0, 0))
    const worldPerUnit = rig.root.localToWorld(new THREE.Vector3(1, 0, 0)).distanceTo(origin)
    return new THREE.Vector3(position[0], position[1], position[2]).multiplyScalar(
      UNITS_PER_METRE / Math.max(worldPerUnit, 1e-6),
    )
  }

  /** Metres in the car's frame to a world transform for the character. */
  const placeGroup = (position: [number, number, number], yawDegrees: number) => {
    rig.root.updateMatrixWorld(true)
    group.position.copy(rig.root.localToWorld(toRigLocal(position)))
    const carYaw = rig.root.getWorldQuaternion(new THREE.Quaternion())
    group.quaternion
      .copy(carYaw)
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          new THREE.Vector3(0, 1, 0),
          (yawDegrees * Math.PI) / 180,
        ),
      )
    group.updateMatrixWorld(true)
  }

  /** 门的开 / 关提示只在变化时回调一次，避免每帧重复触发。 */
  const updateDoor = (open: boolean) => {
    if (lastDoor === open) return
    lastDoor = open
    options.onDoor?.(open)
  }

  const boarding: Boarding = {
    async load() {
      if (loaded) return true
      if (loading) return loading
      loading = (async () => {
        const gltf = await new GLTFLoader().loadAsync(url)
        const root = gltf.scene
        root.updateMatrixWorld(true)
        // Stand it on the ground and size it like a person: the model is 1.82 m as
        // exported, and everything else in this scene is in metres.
        const bounds = new THREE.Box3().setFromObject(root)
        // Normalise the imported character to 1.8 metres, independent of the
        // source model's units. The outer group keeps the scene's unit scale.
        root.scale.setScalar(1.8 / Math.max(bounds.max.y - bounds.min.y, 1e-3))
        root.updateMatrixWorld(true)
        root.position.y -= new THREE.Box3().setFromObject(root).min.y
        group.scale.setScalar(UNITS_PER_METRE)
        root.traverse((object) => {
          const bone = object as THREE.Bone
          if (!bone.isBone) return
          bones[bone.name] = bone
          rest[bone.name] = bone.quaternion.clone()
          root.traverse((object) => {
            const mesh = object as THREE.SkinnedMesh
            if (!mesh.isSkinnedMesh) return
            // A glTF skin keeps the mesh's own node at the origin: where the body
            // actually is comes from the bones. The renderer culls by the mesh's own
            // bounding sphere, which therefore stays at the world origin - and the car
            // is a kilometre away from there, so the character was culled away whole
            // while every joint still reported the right position. That is exactly how
            // the first version of this managed to be invisible.
            mesh.frustumCulled = false
          })
        })
        model = root
        group.add(root)
        group.updateMatrixWorld(true)
        seatFit = fitSeat()
        keyframes = buildKeyframes(seatFit.floor, blendPose(SEATED_UP, SEATED_LOW, seatFit.crouch))
        applyPose(STAND)
        // Standing at the kerb from the moment it is ready: the sequence then
        // starts from where the eye last saw him, instead of teleporting.
        placeGroup(keyframes[0].position, keyframes[0].yaw)
        group.position.y += footGap(0)
        group.visible = true
        loaded = Object.keys(bones).length > 0
        return loaded
      })().catch((error) => {
        console.error('[boarding] character failed to load', error)
        loading = null
        return false
      })
      return loading
    },
    loaded: () => loaded,
    start() {
      if (!loaded) {
        void boarding.load().then((ok) => {
          if (ok) boarding.start()
        })
        return false
      }
      time = 0
      running = true
      lastDoor = null
      group.visible = true
      return true
    },
    update(dt) {
      if (!running || !model) return
      time += Math.max(dt, 0)
      const { a, b, k, raw } = sample(time)
      applyPose(blendPose(a.pose, b.pose, k))
      placeGroup(
        [0, 1, 2].map((axis) => a.position[axis] + (b.position[axis] - a.position[axis]) * k) as [
          number,
          number,
          number,
        ],
        a.yaw + (b.yaw - a.yaw) * k,
      )
      // Feet on the floor: the pose decides how tall the character is, so the group
      // is lifted until the lower foot reaches the height this moment asks for.
      group.position.y += footGap(a.floor + (b.floor - a.floor) * k)
      // 段内进度过 2% 才触发门的开 / 关提示，避开关键帧交界处的抖动。
      if (b.door !== undefined && raw > 0.02) updateDoor(b.door)
      options.onProgress?.(Math.min(time / keyframes[keyframes.length - 1].t, 1))
      if (time >= keyframes[keyframes.length - 1].t) {
        running = false
        const final = keyframes[keyframes.length - 1]
        applyPose(final.pose)
        placeGroup(final.position, final.yaw)
        group.position.y += footGap(final.floor)
        updateDoor(false)
      }
    },
    state() {
      const joints: Record<string, number[]> = {}
      const point = new THREE.Vector3()
      for (const name of JOINTS) {
        const bone = bones[name]
        if (bone)
          joints[name] = bone
            .getWorldPosition(point)
            .toArray()
            .map((value) => Number(value.toFixed(3)))
      }
      const last = keyframes[keyframes.length - 1]
      return {
        loaded,
        running,
        seated: loaded && !running && time >= last.t,
        label: sample(time).a.label,
        progress: Number(Math.min(time / last.t, 1).toFixed(3)),
        joints,
        group: group.position.toArray().map((value) => Number(value.toFixed(3))),
        seat,
        unitsPerMetre: UNITS_PER_METRE,
        fit: {
          floor: Number(seatFit.floor.toFixed(3)),
          crouch: Number(seatFit.crouch.toFixed(3)),
          roof: Number(seatFit.roof.toFixed(3)),
          drop: seatFit.drop,
          crown: seatFit.crown,
        },
      }
    },
    dispose() {
      group.removeFromParent()
      model = null
      bones = {}
      rest = {}
      loaded = false
      loading = null
    },
  }
  return boarding
}
