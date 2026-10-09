/**
 * 竞速场景的静态配置:地图参数、车辆清单,以及车辆/相机物理参数。
 *
 * 本文件只放“常量与查找”,不含行为;main.ts 读取这些值来装配地图、车辆与相机。
 * 几何量分两类来源:上游标定的常量用 `fromLegacyUnits()` 由旧单位换算成米,
 * 本来就按米写的量用 `metres()`(两者数值相同、语义不同,不要混用,见 ./units)。
 * 对外导出:地图与可行驶区间(TRACK_OPTIONS / DRIVABLE)、车辆定义(CAR / CARS / carById)、
 * 车辆物理(VEHICLE)、追车相机(CAMERA),并转发 `UNITS_PER_METRE`、`metres`。
 */
import type { BridgeOptions } from '../water-sky/bridge'
import {
  defineCar,
  doors,
  fallbackWheelRadius,
  foldMirrors,
  lamps,
  matteMirrors,
  mirrorGlass,
  powerWindows,
  seat,
  sunroof,
  wheelsFrom,
  type CarDefinition,
} from './car/definition'
import { metres, UNITS_PER_METRE, fromLegacyUnits, LEGACY_UNITS_PER_METRE } from './units'

/** 转发 ./units 的单位常量与换算函数,方便本目录内一处导入。 */
export { UNITS_PER_METRE, metres }

/** Map definition. Swapping this object swaps the map. */
export const TRACK_OPTIONS: BridgeOptions & { position: [number, number, number] } = {
  position: [0, 0, fromLegacyUnits(-600)],
  length: fromLegacyUnits(2600),
  turn: 42,
  deckWidth: fromLegacyUnits(96),
  laneCount: 4,
  medianWidth: fromLegacyUnits(6),
  plantedMedian: true,
  towerHeight: fromLegacyUnits(200),
  cableCount: 5,
  railingHeight: fromLegacyUnits(7),
}

/** Right hand carriageway: clear of the median barrier and the outer kerb. */
export const DRIVABLE = {
  lateralMin: fromLegacyUnits(6),
  lateralMax: fromLegacyUnits(43.4),
  startDistanceFraction: 0.06,
}

/** 默认车辆(宝马 X1)的资源地址与真实车长;模型会被归一化到这个车长。 */
export const CAR = {
  url: '/models/bmw_x1.glb',
  /** Real BMW X1 (U11) length; the model is normalised to this. */
  lengthMetres: 4.5,
  fallbackWheelRadius: metres(0.33),
}

/**
 * The cars that can be driven.
 *
 * Each one is the same factory call plus a chain of decorators: the factory
 * fixes the things every car has (a model, a real length, a place in the link),
 * and each decorator adds one fact this particular model has - its wheel names,
 * its lamps, its fallback wheel size, or a fix for something the loader cannot
 * know. Nothing here is keyed by id, so the loader and the light module cannot
 * grow a per-car branch, and a new model is one more entry rather than edits in
 * three files.
 */
export const CARS: readonly CarDefinition[] = [
  // The BMW is where the defaults came from, so it decorates nothing.
  defineCar({ id: 'bmw', label: '宝马 X1', url: '/models/bmw_x1.glb', lengthMetres: 4.5 })
    .with(
      // No reflection on the BMW's mirrors. The model ships both door mirrors
      // *and* the cabin mirror as one white mesh at metalness 1, roughness 0:
      // a perfect mirror with no separable glass in it. Seen from outside, that
      // shell reads as a sheet of sky stuck to the pod rather than a mirror in a
      // housing, and there is nowhere smaller to put a reflection - so the
      // reflection comes off the shell. `?mirrorReflection=1` and the panel
      // switch bring the model's own material back.
      matteMirrors(/^Mirrors_/),
      // front_seat_front_seat_0 sits at y 0.89 with a 0.89 box: the cushion is
      // around 0.6, and the pair is 1.72 wide, so the driver sits at x 0.42.
      seat(0.42, 0.82, -0.05),
      // No `mirrorGlass` on the BMW either: the screen-space reflection this
      // code adds covers whole pods with a flat wash of sky, and this model has
      // no separable glass to put it on.
      // The cabin is one glass mesh over both sides, so the side panes are cut out
      // of it (the quadrant key rejects the windscreen and the rear window).
      powerWindows(/^Glass_glass_0/, 'quadrants'),
      // No doors on the BMW, and this is measured, not a guess: the model's
      // `doors_doors_0` mesh is inner trim only - while the car is shut it draws
      // 42 to 238 pixels out of the car's 38,000, because the painted skin of
      // each door is part of the one-piece body shell. Cutting the trim out and
      // swinging it makes a strip of interior poke through a closed door, and
      // cutting the body instead means replacing the whole shell with a cut-up
      // copy. The Omoda, the Lamborghini and the Volkswagen ship real per-door
      // meshes (17 to 24% of the car's pixels), so they get the four switches
      // and the BMW's row stays greyed out.
      // No mirror fold on the BMW. Both door mirrors and the cabin mirror live in
      // one mesh, so folding a pod means cutting copies out of it, and those
      // copies read as an extra layer stuck on the mirror. The fold returns if
      // the mesh is ever split properly.
      // Two layers up there; the sliding one is `Panorama` (the front glass), and
      // `Top_glass` stays with the roof. Which of two stacked panes is the moving
      // one is not something geometry alone answers - the eye picks it.
      sunroof(/^Panorama_/),
    )
    .done(),

  defineCar({
    id: 'omoda',
    label: '奇瑞 Omoda 5',
    url: '/models/chery_omoda.glb',
    lengthMetres: 4.4,
  })
    .with(
      fallbackWheelRadius(metres(0.34)),
      // The mirror glass is its own mesh here, so the reflection layer can go on
      // the glass instead of the whole pod. It is off by default - it is drawn
      // by this code, not by the model - and the panel switch turns it on.
      mirrorGlass(/daochejing_mirror|inner_top_map_c_mirror/),
      // Every part of an Omoda door is prefixed with its corner, mirror pod
      // included - the pod is bolted to the door, so it swings with it.
      doors({
        panels: { fl: /^lf_door_/, fr: /^rf_door_/, rl: /^lr_door_/, rr: /^rr_door_/ },
      }),
      // seat_plastic_gaopei_Plastic_0 is the cushion pair: tops at 0.71, 1.64
      // wide, so the driver's cushion is at x 0.41, hips 0.83.
      seat(0.41, 0.83, -0.14),
      powerWindows(/^(lf|rf|lr|rr)_door_glass/),
      // The glass is one mesh and the housing is another (the door's black
      // plastic); folding only the glass left the housing hanging in place.
      foldMirrors(/^(lf|rf)_door_daochejing|^(lf|rf)_door_black_plastic/),
      sunroof(/^glass_top/),
      lamps({
        frontLens: /^front_light_glass_|^wudeng_glass_/i,
        rearLens: /^trunk_light_glass(_A)?_red_glass_0/i,
        reverseLens: /^trunk_light_glass(_A)?_light_glass_0/i,
        headlamp: /^front_light_glass_|^wudeng_glass_/i,
        tail: /trunk_light.*(red_glass|red_light_plastic|Red_L)/i,
      }),
    )
    .done(),

  defineCar({
    id: 'revuelto',
    label: '兰博基尼 Revuelto',
    url: '/models/lamborghini_revuelto.glb',
    lengthMetres: 4.95,
  })
    .with(
      fallbackWheelRadius(metres(0.34)),
      // Only Wheel_FL/FR/RL/RR: the same file has SteeringWheel_* and a wheel
      // arch set that the generic matcher would cut into four pieces.
      wheelsFrom(/Wheel_(FL|FR|RL|RR)/),
      // Same as the Omoda: separate glass meshes, so the layer goes on the glass
      // and stays off until the panel switch asks for it.
      mirrorGlass(/WingMirror.*_Mirror_|RearviewMirror/),
      // A two-door car: the model has DoorLF/DoorRF and no rear doors at all,
      // so the two rear switches stay greyed out. The jamb and the sill carry
      // "Door" in their names but belong to the body, hence the anchors.
      doors({ panels: { fl: /^DoorLF_|^DoorCardLF_/, fr: /^DoorRF_|^DoorCardRF_/ } }),
      // A two-door mid-engined car: the seats are low and well back.
      seat(0.4, 0.7, 0.1),
      powerWindows(/Glass(LF|LR|RF|RR)_GlassSide/),
      foldMirrors(/WingMirror(L|R)_/),
      lamps({
        // The meshes are all called Object_N; the names live on the group above.
        frontLens: /Lens(L|R)HL_HeadLights/i,
        rearLens: /Lens(L|R)TL_EmissionRed/i,
        reverseLens: /Taillight(L|R)_GlassClear/i,
        headlamp: /Headlight(L|R)_Emitter|Lens(L|R)HL_HeadLights/i,
        tail: /Glass(L|R)TL_GlassRed|GlassCHMSL_GlassRed/i,
      }),
    )
    .done(),

  defineCar({ id: 'volkswagen', label: '大众', url: '/models/volkswagen.glb', lengthMetres: 4.4 })
    .with(
      fallbackWheelRadius(metres(0.32)),
      // "ALUMINUM 20 Rim FL#..." is exported as ALUMINUM_20_Rim_FL#..., and the
      // brake discs live in the same naming family and must stay on the body.
      wheelsFrom(/(Rim|Tire)[_\s#]+(FL|FR|RL|RR)/i),
      powerWindows(/Door_(FL|FR|RL|RR)#.*Windows/),
      // The exterior skin and the interior card of each door are separate
      // groups; the check strap (`Ext_Door_Limiter_*`) is body furniture and
      // is deliberately left out.
      // Int_Seats#Main_Body_Seat_0: cushion pair around y 0.7, 2.45 wide, and
      // set back at z -0.65.
      seat(0.5, 0.82, -0.45),
      doors({
        panels: {
          fl: /^EXT_DOOR_FL$|^Ext_Door_FL#|^Int_Door_FL#/,
          fr: /^EXT_DOOR_FR$|^Ext_Door_FR#|^Int_Door_FR#/,
          rl: /^EXT_DOOR_RL$|^Ext_Door_RL#|^Int_Door_RL#/,
          rr: /^EXT_DOOR_RR$|^Ext_Door_RR#|^Int_Door_RR#/,
        },
      }),
      sunroof(/^(Ext_Sun_Roof|Ext_Window_Top)_/),
      lamps({
        frontLens: /Ext_Headlights#Glow_DRL|Ext_Headlights#Reflector_Squares/i,
        rearLens: /Ext_Taillight#Glass_Red|Ext#Glow_Taillight/i,
        reverseLens: /Ext_Taillight#Glass_Clear/i,
        headlamp: /Ext_Headlights#Glow_DRL|Ext_Headlights#Reflector_Squares/i,
        tail: /Ext_Taillight#Glass_Red|Ext#Glow_Taillight/i,
      }),
    )
    .done(),
]

/** 按 id 取车辆定义;id 为空或未知时回退到第一辆(CARS[0])。 */
export function carById(id: string | null | undefined): CarDefinition {
  return CARS.find((car) => car.id === id) ?? CARS[0]
}

/** 车辆物理参数:加速度/速度以 m/s 为单位,角度以度或弧度标注,行内注释说明取值来源。 */
export const VEHICLE = {
  /**
   * Mechanical lock. A real X1 is about 34 degrees, but this car holds 2.65 g
   * of arcade grip, so it reaches full lock at 35 km/h and the front wheels
   * swing far enough into the wheel arches to be seen through the bodywork.
   * The tightest corner on the generated track only asks for 13 degrees, so a
   * 22 degree lock costs nothing and keeps the wheels where they belong.
   */
  maxSteerDegrees: 22,
  /** A held direction key reaches full lock in about a fifth of a second. */
  inputRampPerSecond: 5,
  /** Releasing the key self centres faster than it turned in. */
  inputReturnPerSecond: 9,
  /**
   * Peak lateral grip, about 1.3 g. Higher than a road car on purpose: the
   * generated track's corners are 12-34 m, and at 0.88 g the car could not take
   * even the median corner above 45 km/h, which reads as the car refusing to
   * turn.
   */
  gripAcceleration: metres(26),
  /**
   * Corner assist. The reference player floors the throttle and expects to get
   * round the corner anyway, so the car trims its own speed for a corner the
   * way a driver lifting off would: look at the road ahead, work out the
   * fastest speed that can still be braked to the corner's limit, and hold the
   * car to it. Steering stays entirely the player's.
   */
  cornerAssist: 5,
  cornerAssistBrake: metres(12),
  cornerAssistMargin: 0.8,
  engineAcceleration: metres(8.4),
  brakeDeceleration: metres(16),
  reverseAcceleration: metres(4),
  rollingResistance: metres(1.1),
  /** Chosen so drag caps speed at roughly `maxSpeed`. */
  // Acceleration = coefficient * speed²; coefficient has units of 1/metre.
  dragCoefficient: 0.00028 * LEGACY_UNITS_PER_METRE,
  /** Body roll at full steering and full speed, in radians. */
  bodyRoll: 0.06,
  /** Lowest fraction of the mechanical lock the front wheels still show. */
  visualLockFloor: 0.45,
  /** Top speed: 200 km/h. */
  maxSpeed: metres(200 / 3.6),
  maxReverseSpeed: metres(12),
}

/** 追车相机参数:距离/高度/前视偏移以米计,视场角以度计,刚度是平滑系数。 */
export const CAMERA = {
  baseFov: 58,
  speedFov: 72,
  distance: metres(9.5),
  height: metres(3.6),
  lookAhead: metres(14),
  lookHeight: metres(1.5),
  stiffness: 6.5,
  /**
   * Deliberately slower than `stiffness`: the camera trails the car's heading
   * so the car visibly rotates into a corner instead of staying pinned to the
   * middle of the frame while the world swings around it.
   */
  yawStiffness: 1.7,
}
