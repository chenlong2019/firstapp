import type * as THREE from 'three'
import { DEFAULT_LAMPS, type LampPatterns } from './lights'
import { DEFAULT_WHEEL_PATTERN } from './loadCar'
import type { Wheel } from './loadCar'
import { metres } from '../units'

/**
 * 车辆=基础模型 + 一串装饰器：装配给 loader 与灯光模块读取的定义数据结构。
 *
 * 在整体里的位置：race/car 的类型与配置层。defineCar 从默认（宝马）出发，with(...) 逐个叠加
 * 装饰器（车轮名、灯名、门窗、座椅……），done() 交出最终定义。
 *
 * 对外导出：defineCar 建造器、各 CarDecorator 装饰器、DOOR_IDS / DoorId，以及相关类型。
 * 非直觉约定：装饰器只覆盖它显式提到的字段，其余沿用默认；新增车型只加一条定义，
 * 不在 loader 或灯光模块里加分支。
 */

/**
 * A car is a base model plus a chain of decorators.
 *
 * Every model so far arrived with its own ideas about naming: the BMW calls its
 * wheels `Koleso`, the Volkswagen calls them `ALUMINUM_20_Rim_FL`, the
 * Lamborghini calls the mesh `Object_449` and keeps the name on the group above
 * it. That knowledge used to live in parallel tables keyed by car id, which
 * meant adding a car was editing three places and remembering all of them.
 *
 * Here the knowledge is *attached* to the car instead: `defineCar(...)` starts
 * from the defaults and each decorator wraps the definition with one more fact
 * (`wheelsFrom`, `lamps`, ...). Decorators compose in order, so a model that
 * shares the BMW's lamps but not its wheels only says so about the wheels, and a
 * genuinely new problem becomes a new small decorator rather than another
 * branch inside the loader.
 *
 * The loader and the light module read the finished definition and never look
 * at an id again.
 */

/** What the loader hands an adapter while it is building the rig. */
export type ModelContext = {
  /** `measure` runs on the raw scene, `build` on the finished rig. */
  readonly phase: 'measure' | 'build'
  /** The glTF scene, inside a holder that carries the source transform. */
  readonly model: THREE.Group
  readonly holder: THREE.Group
  /** Source size, before normalisation. */
  readonly size: THREE.Vector3
  /** Source bounding box, before normalisation. */
  readonly box: THREE.Box3
  /** Set during `build`: the assembled rig, scaled but not yet returned. */
  readonly rig?: { chassis: THREE.Group; wheels: Wheel[]; root: THREE.Group; bounds: THREE.Box3 }
  /** An adapter sets this to reject the split wheels and get procedural ones. */
  forceProceduralWheels: boolean
}

/**
 * A decorator over the *model*, not over the definition: it gets the model while
 * it is being built and adds whatever this car needs. Same context in, same
 * context out, so adapters stack in any order.
 */
export type ModelAdapter = (context: ModelContext) => void

/** 一台车的完整定义：标识、地址、车长与全部装饰结果。 */
export type CarDefinition = {
  readonly id: string
  readonly label: string
  readonly url: string
  /** The real car's length; the model is scaled so its long axis matches. */
  readonly lengthMetres: number
  readonly wheelPattern: RegExp
  readonly fallbackWheelRadius: number
  readonly lampPatterns: Required<LampPatterns>
  /**
   * Meshes that are mirror glass, matched on the mesh, its parent or its
   * material name. The panel switch can give those a live reflection; by
   * default they keep the material the model shipped with.
   */
  readonly mirrorGlass?: RegExp
  /**
   * Mirror meshes that should show no reflection at all - the environment,
   * the metal and the gloss are taken off them. For a model that ships the
   * whole mirror as one reflective shell (the BMW) this is the only honest
   * way to answer "take the reflection off the mirror". The panel switch
   * puts the model's own material back for comparison.
   */
  readonly matteMirrors?: RegExp
  /** True when the mirror mesh is the whole assembly and needs cutting. */
  readonly mirrorGlassSplit?: boolean
  /** Door glass, mirrors, doors and roof panel, for the body animations. */
  readonly windows?: { pattern: RegExp; split?: 'sides' | 'quadrants' }
  readonly doors?: DoorSpec
  readonly mirrors?: { pattern: RegExp; split?: boolean }
  readonly sunroof?: RegExp
  /** Where the driver sits, in metres in the car's own frame (x = left). */
  readonly seat?: { x: number; y: number; z: number }
  readonly adapters: readonly ModelAdapter[]
}

/** A decorator over the definition: one fact, wrapped around a car. */
export type CarDecorator = (car: CarDefinition) => CarDefinition

/** 指定这台车车轮网格的名字匹配（覆盖默认的宝马命名）。 */
export const wheelsFrom =
  (pattern: RegExp): CarDecorator =>
  (car) => ({ ...car, wheelPattern: pattern })

/** 指定后备轮胎半径（拆轮失败时使用），单位为米。 */
export const fallbackWheelRadius =
  (radius: number): CarDecorator =>
  (car) => ({ ...car, fallbackWheelRadius: radius })

/** Name only the lamps this car does not share with the defaults. */
export const lamps =
  (patterns: LampPatterns): CarDecorator =>
  (car) => ({ ...car, lampPatterns: { ...car.lampPatterns, ...patterns } })

/** Door glass; `split` cuts a mesh that holds several windows at once. */
export const powerWindows =
  (pattern: RegExp, split?: 'sides' | 'quadrants'): CarDecorator =>
  (car) => ({ ...car, windows: { pattern, split } })

/**
 * The four doors, for the open/close animation.
 *
 * Two shapes of model show up. Some name every part of a door by its corner
 * (`lf_door_*`, `Ext_Door_FL#*`, `DoorLF_*`), and those can be driven as they
 * are: one pattern per door. Others ship the four doors as one mesh (the BMW's
 * `doors_doors_0`), and that one has to be cut into quadrants first.
 *
 * A pattern is tested against the mesh's own name and every node above it, so
 * naming the group (`EXT_DOOR_FL` for the Volkswagen) is enough.
 */
export type DoorSpec = { panels: Partial<Record<DoorId, RegExp>> } | { split: RegExp }

/** Front/rear left/right. `x > 0` is the car's left in every model here. */
export type DoorId = 'fl' | 'fr' | 'rl' | 'rr'
/** 四个门位的固定顺序：前左 / 前右 / 后左 / 后右。 */
export const DOOR_IDS: readonly DoorId[] = ['fl', 'fr', 'rl', 'rr']

/** Four doors the body module can open and close one at a time. */
export const doors =
  (spec: DoorSpec): CarDecorator =>
  (car) => ({ ...car, doors: spec })

/** Mirror housings that fold in against the windows. */
export const foldMirrors =
  (pattern: RegExp, split = false): CarDecorator =>
  (car) => ({ ...car, mirrors: { pattern, split } })

/**
 * Where the driver sits, in metres in the car's own frame: x to the car's left,
 * y above the road, z forward. Measured off each model's own seat mesh, because
 * guessing it from the geometry does not survive these models' bounding boxes -
 * the first attempt put the seat two metres above the roof.
 */
export const seat =
  (x: number, y: number, z: number): CarDecorator =>
  (car) => ({ ...car, seat: { x, y, z } })

/** Roof panel that lifts at its trailing edge. */
export const sunroof =
  (pattern: RegExp): CarDecorator =>
  (car) => ({ ...car, sunroof: pattern })

/**
 * Take the reflection off a mirror mesh: no environment, no metal, no gloss.
 * Some models ship their mirrors as one reflective shell that picks up the
 * scene environment, and on a car that reads as a sheet of something lying on
 * the mirror rather than as the mirror itself. The panel switch puts the
 * model's own material back, so this is a look that can be compared, not a
 * one-way edit of the file.
 */
export const matteMirrors =
  (pattern: RegExp): CarDecorator =>
  (car) => ({ ...car, matteMirrors: pattern })

/**
 * Name this car's mirror glass. The car module can put a layer on it that
 * samples the reflection the water already rendered; the panel switch turns
 * that layer on, because it is the one piece of the car this code draws
 * instead of the model and it does show.
 */
export const mirrorGlass =
  (pattern: RegExp, splitGlass = false): CarDecorator =>
  (car) => ({ ...car, mirrorGlass: pattern, mirrorGlassSplit: splitGlass })

/** Escape hatch for a model that needs something the named decorators do not cover. */
export const adapt =
  (...adapters: ModelAdapter[]): CarDecorator =>
  (car) => ({ ...car, adapters: [...car.adapters, ...adapters] })

/**
 * Throw the split wheels away and build four cylinders instead. Useful when a
 * model's wheels cannot be separated at all and a wrong split would be worse
 * than an obviously generic wheel.
 */
export const proceduralWheels: ModelAdapter = (context) => {
  context.forceProceduralWheels = true
}

/** 车辆建造器：with 链式叠加装饰器，done 交出最终定义。 */
export type CarBuilder = {
  with(...decorators: CarDecorator[]): CarBuilder
  done(): CarDefinition
}

/**
 * Start a car from the defaults the BMW established. Everything a decorator
 * does not mention stays as it is, which is why the BMW itself needs none.
 */
export function defineCar(spec: {
  id: string
  label: string
  url: string
  lengthMetres: number
}): CarBuilder {
  let car: CarDefinition = {
    ...spec,
    wheelPattern: DEFAULT_WHEEL_PATTERN,
    // 默认后备胎半径 0.33 米。
    fallbackWheelRadius: metres(0.33),
    lampPatterns: DEFAULT_LAMPS,
    adapters: [],
  }
  const builder: CarBuilder = {
    with(...decorators) {
      for (const decorator of decorators) car = decorator(car)
      return builder
    },
    done: () => car,
  }
  return builder
}
