import * as THREE from 'three'
import type { CarRig } from './loadCar'
import { fromLegacyUnits } from '../units'

/**
 * 车灯：转向灯、刹车灯、倒车灯与大灯。
 *
 * 在整体里的位置：属于 race/car 的装配层，挂在 CarRig 根节点下，输入来自 vehicle 的驾驶命令。
 *
 * 对外导出：createCarLights 工厂、CarLights 接口、LampPatterns 与默认灯名 DEFAULT_LAMPS。
 * 非直觉约定：本模型朝 +Z，故 +X 是车的左侧；rig.root.scale 已带归一化比例，
 * 凡按世界单位量出的长度都要先除以 rig.root.scale.x 才能用作模型单位。
 */

/**
 * Turning, brake, reverse and head lamps.
 *
 * This export has no separate indicator meshes: every lamp is one strip that
 * spans both sides of the car. So the lamps that *are* there are split down the
 * middle at load time - the headlamp glow strip and the tail lamp glow strip -
 * and each half is driven on its own. That is what makes the indicators the
 * car's own lamps instead of shapes stuck onto the bodywork.
 *
 * Coordinate facts about this model, which caused several bugs already:
 *   - it faces +Z, so +X is the car's LEFT and -X is its right;
 *   - every mesh under `rig.root` is parented to a root that already carries the
 *     normalising scale, so anything measured in world units must be divided by
 *     `rig.root.scale.x` before it is used;
 *   - `Box3.setFromObject` and `mesh.matrixWorld` are in world space, which is
 *     only the rig frame while the rig sits at the origin.
 */
/** 灯光模块的输入：转向指令、刹车、倒车与双闪。 */
export type CarLightInput = {
  /** -1 is a left turn, +1 a right turn: the driver's command, not the wheels. */
  steer: number
  brake: boolean
  reversing: boolean
  /** Hazard lights blink both sides. */
  hazards?: boolean
}

/** 灯光模块对外汇报的状态。 */
export type CarLightState = {
  leftIndicator: boolean
  rightIndicator: boolean
  brake: boolean
  reverse: boolean
  blink: boolean
  headlights: boolean
}

/**
 * Where a car's lamps are. Every model names them differently - the BMW by
 * purpose, the others by whatever the exporter left behind - so the mapping is
 * data, one entry per car, exactly like the wheel pattern.
 *
 * `frontLens` and `rearLens` are the lenses that get cut into left and right
 * halves and then serve two jobs: the running lamp, and the indicator. That is
 * what makes a flashing light come out of the car's own lamp instead of a shape
 * stuck on the bodywork. `headlamp` and `tail` are extra meshes that share the
 * glow, `reverseLens` is the white one, and `mirror` is the repeater housing.
 */
export type LampPatterns = {
  frontLens?: RegExp
  rearLens?: RegExp
  reverseLens?: RegExp
  headlamp?: RegExp
  tail?: RegExp
  mirror?: RegExp
}

/**
 * The BMW X1 mapping, which is what this module was written against. Exported
 * because a car definition is built by decorating these defaults: a model only
 * names the lamps it does not share with this one.
 */
export const DEFAULT_LAMPS: Required<LampPatterns> = {
  frontLens: /^Front_lights_glass_/i,
  rearLens: /^Back_lights_glass_red_glass_0/i,
  reverseLens: /back_lights_glass_2/i,
  headlamp: /(front_lights_(glass|emmisive)|ligh_lt)/i,
  tail: /back_lights|red_glass|emiss_red/i,
  mirror: /^Mirrors_/i,
}

/** 车灯控制器接口。 */
export type CarLights = {
  readonly group: THREE.Group
  update(input: CarLightInput, dt: number): void
  setHeadlights(on: boolean): void
  /** Night makes the running lights brighter; the exposure drop needs it. */
  setNight(on: boolean): void
  state(): CarLightState
  dispose(): void
}

/** Seconds for one on-off cycle. Real indicators are about 1.5 Hz. */
const BLINK_PERIOD = 0.68
/**
 * Lamp names live on the parent node in several of these models: the
 * Lamborghini's meshes are all called `Object_123` and only the group above them
 * says `LensLHL_HeadLights_449`. Match the pair, the same way the wheel split
 * does.
 */
const labelOf = (mesh: THREE.Mesh) => `${mesh.name} ${mesh.parent?.name ?? ''}`
/** 转向输入绝对值超过该阈值才点亮对应侧转向灯。 */
const INDICATOR_THRESHOLD = 0.3

// 灯具颜色（sRGB 十六进制）：琥珀转向灯、偏暗的尾灯红、暖白大灯、暖白倒车灯。
const AMBER = 0xffa219
const TAIL_RED = 0xd81f0a
const HEADLIGHT = 0xfff2cf
const REVERSE = 0xfff4e2

type Side = 'left' | 'right'

/**
 * Cut a mesh into the car's left (+X) and right (-X) halves. Vertices come out in
 * rig space, so the halves can be parented straight to the rig with no further
 * transform - the same trick `loadCar` uses to separate the wheels.
 */
function splitSides(mesh: THREE.Mesh, scale: number): Record<Side, THREE.BufferGeometry> {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  const normalAttribute = geometry.getAttribute('normal')
  const uvAttribute = geometry.getAttribute('uv')
  const triangles = Math.floor((index ? index.count : position.count) / 3)
  const matrix = mesh.matrixWorld
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
  const point = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const sides: Record<Side, { position: number[]; normal: number[]; uv: number[] }> = {
    left: { position: [], normal: [], uv: [] },
    right: { position: [], normal: [], uv: [] },
  }
  for (let triangle = 0; triangle < triangles; triangle++) {
    const a = index ? index.getX(triangle * 3) : triangle * 3
    const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
    const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
    let centreX = 0
    for (const vertex of [a, b, c]) {
      point
        .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        .applyMatrix4(matrix)
      centreX += point.x / 3
    }
    // +X is the car's left, so a positive centroid belongs to the left lamp.
    const side = centreX >= 0 ? sides.left : sides.right
    for (const vertex of [a, b, c]) {
      // matrixWorld already contains the rig root scale, and the halves are
      // parented under that same root, so fold the scale back out here -
      // otherwise every lit mesh ends up 594x too far out, i.e. in the sky.
      point
        .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        .applyMatrix4(matrix)
        .divideScalar(scale)
      side.position.push(point.x, point.y, point.z)
      if (normalAttribute) {
        normal
          .set(
            normalAttribute.getX(vertex),
            normalAttribute.getY(vertex),
            normalAttribute.getZ(vertex),
          )
          .applyMatrix3(normalMatrix)
          .normalize()
        side.normal.push(normal.x, normal.y, normal.z)
      }
      if (uvAttribute) side.uv.push(uvAttribute.getX(vertex), uvAttribute.getY(vertex))
    }
  }
  const build = (data: { position: number[]; normal: number[]; uv: number[] }) => {
    const result = new THREE.BufferGeometry()
    result.setAttribute('position', new THREE.Float32BufferAttribute(data.position, 3))
    if (data.normal.length)
      result.setAttribute('normal', new THREE.Float32BufferAttribute(data.normal, 3))
    if (data.uv.length) result.setAttribute('uv', new THREE.Float32BufferAttribute(data.uv, 2))
    return result
  }
  return { left: build(sides.left), right: build(sides.right) }
}

/** Soft radial falloff used by the lamp halos. */
function createGlowTexture(): THREE.Texture | null {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')
  if (!context) return null
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.32, 'rgba(255,255,255,.5)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * 构建一台车的灯光控制器：拆分左右灯罩、生成光晕，并按输入驱动发光。
 *
 * @param rig 已装配的车辆骨架
 * @param patterns 本车的灯名匹配；未给出的沿用 DEFAULT_LAMPS
 * @returns CarLights 实例，需每帧调用 update(input, dt)
 */
export function createCarLights(rig: CarRig, patterns: LampPatterns = {}): CarLights {
  const { size, trackWidth } = rig
  // Only the keys this car overrides are replaced; anything left out keeps the
  // BMW default, so a model that shares a name with the BMW still works.
  const lamps: Required<LampPatterns> = {
    frontLens: patterns.frontLens ?? DEFAULT_LAMPS.frontLens,
    rearLens: patterns.rearLens ?? DEFAULT_LAMPS.rearLens,
    reverseLens: patterns.reverseLens ?? DEFAULT_LAMPS.reverseLens,
    headlamp: patterns.headlamp ?? DEFAULT_LAMPS.headlamp,
    tail: patterns.tail ?? DEFAULT_LAMPS.tail,
    mirror: patterns.mirror ?? DEFAULT_LAMPS.mirror,
  }
  // World units to model units: the lamps hang off the scaled rig root.
  const scale = rig.root.scale.x || 1
  const unit = (value: number) => value / scale
  rig.root.updateMatrixWorld(true)

  const group = new THREE.Group()
  group.name = 'car-lights'
  rig.root.add(group)
  const owned: THREE.BufferGeometry[] = []
  const ownedMaterials: THREE.Material[] = []

  const ownGlow = (mesh: THREE.Mesh, color: number, intensity: number, opaque = false) => {
    const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const surface = (source as THREE.MeshStandardMaterial).clone()
    surface.emissive = new THREE.Color(color)
    surface.emissiveIntensity = intensity
    if (opaque) {
      surface.transparent = false
      surface.opacity = 1
      if (surface.color) surface.color.setHex(color)
    }
    mesh.material = surface
    ownedMaterials.push(surface)
    return surface
  }

  // Split the two glow strips into per-side halves and drive those.
  const indicatorHalves: Record<
    Side,
    {
      material: THREE.MeshStandardMaterial
      kind: 'front' | 'rear'
      centre: THREE.Vector3
      size: number
    }[]
  > = { left: [], right: [] }
  /**
   * The mirror indicator is a strip along the outboard edge of the housing. This
   * keeps the housing itself and adds one thin additive sliver per side, sitting
   * a centimetre proud of the surface so it cannot z-fight with it.
   */
  const buildMirrorStrips = () => {
    let mirror: THREE.Mesh | null = null
    rig.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh && lamps.mirror.test(labelOf(mesh))) mirror = mesh
    })
    if (!mirror) return
    const source = mirror as THREE.Mesh
    const geometry = source.geometry
    const position = geometry.getAttribute('position')
    const index = geometry.getIndex()
    const triangles = Math.floor((index ? index.count : position.count) / 3)
    const matrix = source.matrixWorld
    const point = new THREE.Vector3()
    // The threshold has to be per side. Measured against the whole mesh's width,
    // the BMW's mirror - whose two pods sit at |x| 3.6 to 4.6 while the mesh also
    // spans the cabin - passed every triangle, so the "sliver" was a full copy of
    // the pod. Per side, the outer fifth of that side's own extent is the strip.
    const sideMax: Record<Side, number> = { left: 0, right: 0 }
    for (let vertex = 0; vertex < position.count; vertex++) {
      point
        .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        .applyMatrix4(matrix)
        .divideScalar(scale)
      const side: Side = point.x >= 0 ? 'left' : 'right'
      sideMax[side] = Math.max(sideMax[side], Math.abs(point.x))
    }
    const threshold: Record<Side, number> = { left: sideMax.left * 0.9, right: sideMax.right * 0.9 }
    const sides: Record<Side, number[]> = { left: [], right: [] }
    for (let triangle = 0; triangle < triangles; triangle++) {
      const a = index ? index.getX(triangle * 3) : triangle * 3
      const b = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
      const c = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
      let centreX = 0
      let outer = true
      for (const vertex of [a, b, c]) {
        point
          .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
          .applyMatrix4(matrix)
          .divideScalar(scale)
        centreX += point.x / 3
        const limit = centreX >= 0 ? threshold.left : threshold.right
        if (Math.abs(point.x) < limit) outer = false
      }
      if (!outer) continue
      const side: Side = centreX >= 0 ? 'left' : 'right'
      for (const vertex of [a, b, c]) {
        point
          .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
          .applyMatrix4(matrix)
          .divideScalar(scale)
        // Keep the calibrated 2.3 cm separation, then convert metres to model units.
        point.x += Math.sign(centreX) * unit(fromLegacyUnits(0.1))
        sides[side].push(point.x, point.y, point.z)
      }
    }
    for (const side of ['left', 'right'] as const) {
      if (!sides[side].length) continue
      const strip = new THREE.BufferGeometry()
      strip.setAttribute('position', new THREE.Float32BufferAttribute(sides[side], 3))
      // additive and unlit: a glowing sliver that cannot z-fight the housing
      const material = new THREE.MeshBasicMaterial({
        color: AMBER,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      })
      owned.push(strip)
      ownedMaterials.push(material)
      const mesh = new THREE.Mesh(strip, material)
      mesh.name = `car-mirror-strip-${side}`
      group.add(mesh)
      mirrorStrips[side] = material
    }
  }

  const replaceWithHalves = (matcher: RegExp, kind: 'front' | 'rear') => {
    const targets: THREE.Mesh[] = []
    rig.root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || mesh.name === 'car-lamp') return
      if (matcher.test(labelOf(mesh))) targets.push(mesh)
    })
    for (const mesh of targets) {
      const halves = splitSides(mesh, scale)
      const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
      for (const side of ['left', 'right'] as const) {
        const material = (source as THREE.MeshStandardMaterial).clone()
        material.emissive = new THREE.Color(AMBER)
        // A tail lens is a deep red, not a fire-engine one: the model ships it as
        // 0.9/0/0, which reads far too hot on a sunset-lit deck.
        if (kind === 'rear' && material.color) material.color.setHex(0x6d1109)
        material.emissiveIntensity = 0
        ownedMaterials.push(material)
        owned.push(halves[side])
        const half = new THREE.Mesh(halves[side], material)
        half.name = `car-lamp-${side}`
        group.add(half)
        halves[side].computeBoundingBox()
        const box = halves[side].boundingBox!
        const centre = box.getCenter(new THREE.Vector3())
        const radius = Math.max(
          box.getSize(new THREE.Vector3()).length() * 0.5,
          // 光晕半径下限约 0.23 米，避免小型灯珠的光晕缩到看不见。
          unit(fromLegacyUnits(1)),
        )
        indicatorHalves[side].push({ material, kind, centre, size: radius })
      }
      mesh.visible = false
    }
    return targets.length
  }
  replaceWithHalves(lamps.frontLens, 'front')
  replaceWithHalves(lamps.rearLens, 'rear')
  // Mirrors: only the outboard strip lights on a real BMW, so keep the housing
  // and add a thin glowing sliver on its outer edge.
  const mirrorStrips: Record<Side, THREE.MeshBasicMaterial | null> = { left: null, right: null }
  buildMirrorStrips()

  // Headlamps: the lens meshes are lit whenever the car is running.
  const headlights: THREE.MeshStandardMaterial[] = []
  let reverseLens: THREE.MeshStandardMaterial | null = null
  const tail: THREE.MeshStandardMaterial[] = []
  rig.root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || mesh.name.startsWith('car-lamp')) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const names = materials.map((material) => material.name ?? '').join(',')
    const label = `${labelOf(mesh)} ${names}`
    if (lamps.headlamp.test(label)) headlights.push(ownGlow(mesh, HEADLIGHT, 1.7, true))
    else if (lamps.reverseLens.test(label)) reverseLens = ownGlow(mesh, REVERSE, 0, true)
    else if (lamps.tail.test(label)) {
      for (const material of materials) {
        const surface = material as THREE.MeshStandardMaterial
        if (!surface.emissive || tail.includes(surface)) continue
        if (surface.emissive.getHex() === 0) surface.emissive.setHex(TAIL_RED)
        tail.push(surface)
      }
    }
  })
  const tailBase = tail.map((material) => material.emissiveIntensity ?? 1)

  // Halo sprites: a lamp with no spill around it never reads as lit, however
  // bright the emissive is. One soft additive sprite per lamp does the job
  // cheaply and needs no post processing.
  const glowTexture = createGlowTexture()
  const halos: {
    material: THREE.SpriteMaterial
    lamp: {
      material: THREE.MeshStandardMaterial
      kind: 'front' | 'rear'
      centre: THREE.Vector3
      size: number
    }
  }[] = []
  const haloFor = (lamp: {
    material: THREE.MeshStandardMaterial
    kind: 'front' | 'rear'
    centre: THREE.Vector3
    size: number
  }) => {
    if (!glowTexture) return
    const material = new THREE.SpriteMaterial({
      map: glowTexture,
      color: AMBER,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    ownedMaterials.push(material)
    const sprite = new THREE.Sprite(material)
    sprite.position.copy(lamp.centre)
    // 光晕缩放比灯具略小（0.85 倍），避免盖过灯罩本身。
    sprite.scale.setScalar(lamp.size * 0.85)
    sprite.name = `car-halo-${lamp.kind}`
    group.add(sprite)
    halos.push({ material, lamp })
  }
  for (const side of ['left', 'right'] as const)
    for (const lamp of indicatorHalves[side]) haloFor(lamp)

  let headlightsOn = true
  let night = false
  const runningLight = () => (night ? 3.6 : 1.2)
  let elapsed = 0
  const state: CarLightState = {
    leftIndicator: false,
    rightIndicator: false,
    brake: false,
    reverse: false,
    blink: false,
    headlights: true,
  }

  /**
   * Drives one lens. Two rules matter for the look:
   *
   *  - A lit lens is nearly opaque. The model ships these lenses at alpha 0.25,
   *    which blends the emissive down to a quarter and makes a lit lamp look
   *    like tinted glass rather than a light source.
   *  - The core stays just inside clipping where it can. A lamp whose emissive
   *    is 10x a treated white is a flat white sticker; the colour has to survive
   *    in the core and the bloom pass spreads what is left.
   */
  const drive = (
    material: THREE.MeshStandardMaterial,
    hex: number,
    intensity: number,
    opacity: number,
  ) => {
    material.emissive.setHex(hex)
    material.emissiveIntensity = intensity
    material.opacity = opacity
  }

  return {
    group,
    update(input, dt) {
      elapsed += Math.max(dt, 0)
      const blinkOn = elapsed % BLINK_PERIOD < BLINK_PERIOD * 0.44 // 占空比 44%：一周期内亮的时间略少于一半。
      const hazards = input.hazards === true
      const left = (input.steer < -INDICATOR_THRESHOLD || hazards) && blinkOn
      const right = (input.steer > INDICATOR_THRESHOLD || hazards) && blinkOn
      for (const side of ['left', 'right'] as const) {
        const on = side === 'left' ? left : right
        const strip = mirrorStrips[side]
        if (strip) strip.opacity = on ? 0.9 : 0
        for (const { material, kind } of indicatorHalves[side]) {
          if (on) {
            // Classic indicator amber: the strongest lamp on the car after the
            // headlamps, so the flashing bloom has something to work with.
            drive(material, AMBER, night ? 6.5 : 5, 0.92)
          } else if (kind === 'rear') {
            // Day: unlit, so the red housing does not shout. Night: a dim tail
            // lamp. Braking: bright, day or night.
            if (input.brake) drive(material, TAIL_RED, night ? 4.2 : 3.4, 0.9)
            else if (night) drive(material, TAIL_RED, 1.1, 0.6)
            else drive(material, TAIL_RED, 0, 0.25)
          } else if (headlightsOn) {
            // The lamps the car drives on: bright at night, still a running
            // light in daylight. The lens alpha is what made these read as off.
            drive(material, HEADLIGHT, night ? 5.2 : 1.6, night ? 0.9 : 0.55)
          } else {
            drive(material, HEADLIGHT, 0, 0.25)
          }
        }
      }
      for (const halo of halos) {
        const lamp = halo.lamp
        const lit = lamp.material.emissiveIntensity > 0.01
        halo.material.color.copy(lamp.material.emissive)
        const flashing = lamp.material.emissive.getHex() === AMBER && lit
        halo.material.opacity = lit
          ? flashing
            ? 0.5
            : lamp.kind === 'front'
              ? night
                ? 0.3
                : 0.2
              : 0.22
          : 0
      }
      tail.forEach((material, index) => {
        // Same rule as the lens halves: no tail glow in daylight, dim at night,
        // bright under braking. Leaving these on all day is what made the rear
        // of the car read as one big red lamp.
        material.emissiveIntensity = input.brake
          ? tailBase[index] * 6 + 2.4
          : headlightsOn
            ? tailBase[index] * (night ? 2.4 : 1)
            : 0
      })
      if (reverseLens) reverseLens.emissiveIntensity = input.reversing ? (night ? 4.2 : 3.2) : 0
      for (const material of headlights)
        material.emissiveIntensity = headlightsOn ? runningLight() : 0
      state.leftIndicator = left
      state.rightIndicator = right
      state.brake = input.brake
      state.reverse = input.reversing
      state.blink = blinkOn
      state.headlights = headlightsOn
    },
    setHeadlights(on) {
      headlightsOn = on
    },
    setNight(on) {
      night = on
    },
    state: () => ({ ...state }),
    dispose() {
      group.removeFromParent()
      for (const geometry of owned) geometry.dispose()
      for (const material of ownedMaterials) material.dispose()
    },
  }
}
