/**
 * water-sky 的默认参数、取值范围、相机与质量预设，并提供参数/几何的校验工具。
 * 对外导出 DEFAULT_PARAMS、PARAM_LIMITS、DEFAULT_CAMERA、TOP_CAMERA、DEFAULT_QUALITY、
 * WATER_POSITION 与 resolveParams/positiveNumber/finiteVector。
 * 单位约定：相机位置与裁剪距离用米（由旧单位换算），几何尺寸用米，数值参数无量纲。
 */
import type { Vec3Tuple, WaterSkyCameraPreset, WaterSkyParams, WaterSkyQuality } from './types'
import { fromLegacyUnits as legacy } from '../units'

/** 默认外观参数（冻结只读）；各字段含义见 types.ts 的 WaterSkyParams。 */
export const DEFAULT_PARAMS: Readonly<WaterSkyParams> = Object.freeze({
  intensity: 0.45,
  wind: 0.35,
  ripple: 1,
  sunset: 0,
  cloudDensity: 0.76,
  sunHeight: 0.58,
})

/** 每个外观参数的合法区间 [min, max]；越界或非有限值会被 resolveParams 抛错。 */
export const PARAM_LIMITS: Readonly<Record<keyof WaterSkyParams, Vec2Range>> = Object.freeze({
  intensity: Object.freeze([0, 1] as const),
  // Raised from 1: the flow is a taste knob, and the old ceiling was barely
  // faster than no wind at all. 4 gives a visibly quick current.
  wind: Object.freeze([-1, 4] as const),
  ripple: Object.freeze([0.4, 2.5] as const),
  sunset: Object.freeze([0, 1] as const),
  cloudDensity: Object.freeze([0, 1] as const),
  // 0.10 lets the sun sit on the horizon, which is what a sunset needs.
  sunHeight: Object.freeze([0.1, 1] as const),
})
type Vec2Range = readonly [number, number]

/** 默认透视相机预设：位置/目标为米，fov 为角度，near/far 为裁剪距离（米）。 */
export const DEFAULT_CAMERA: Readonly<WaterSkyCameraPreset> = Object.freeze({
  position: Object.freeze([0, legacy(35), legacy(120)] as const),
  target: Object.freeze([0, legacy(35), legacy(-900)] as const),
  fov: 100,
  near: legacy(1),
  far: legacy(25000),
})
/** 俯视相机预设：从高处垂直俯瞰桥面，用于总览；单位含义同 DEFAULT_CAMERA。 */
export const TOP_CAMERA: Readonly<WaterSkyCameraPreset> = Object.freeze({
  position: Object.freeze([0, legacy(520), legacy(-9000)] as const),
  target: Object.freeze([0, 0, legacy(-9000)] as const),
  fov: 100,
  near: legacy(1),
  far: legacy(25000),
})
/** 默认质量：像素比上限与网格分段为无量纲，水尺寸与天空半径单位为米。 */
export const DEFAULT_QUALITY: Readonly<WaterSkyQuality> = Object.freeze({
  maxPixelRatio: 2,
  waterSize: legacy(24000),
  waterSegments: 320,
  skyRadius: legacy(24000),
})
/** 海面默认世界位置（米）：位于地平线前方，配合页面固定取景。 */
export const WATER_POSITION: Vec3Tuple = Object.freeze([0, 0, legacy(-9000)] as const)

/**
 * 在 current 基础上应用 patch，逐项校验键名与取值范围后返回合并的新对象。
 * @param patch 要覆盖的参数；未出现的键保持 current 的值
 * @param current 基准参数，默认为 DEFAULT_PARAMS
 */
export function resolveParams(
  patch: Partial<WaterSkyParams>,
  current: Readonly<WaterSkyParams> = DEFAULT_PARAMS,
): WaterSkyParams {
  const result = { ...current }
  for (const key of Object.keys(patch) as (keyof WaterSkyParams)[]) {
    if (!(key in PARAM_LIMITS)) throw new RangeError(`Unknown water-sky parameter: ${key}`)
    const value = patch[key]
    if (value === undefined) continue
    const [min, max] = PARAM_LIMITS[key]
    if (!Number.isFinite(value) || value < min || value > max)
      throw new RangeError(`${key} must be between ${min} and ${max}`)
    result[key] = value
  }
  return result
}

/**
 * 断言 value 为有限正数，否则抛 RangeError。
 * @param name 用于错误信息的字段名
 */
export function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be finite and positive`)
  return value
}

/**
 * 断言 value 是三个有限数构成的向量，并返回其拷贝（新数组）。
 * @param name 用于错误信息的字段名
 */
export function finiteVector(value: Vec3Tuple, name: string): Vec3Tuple {
  if (value.length !== 3 || !value.every(Number.isFinite))
    throw new RangeError(`${name} must have three finite numbers`)
  return [...value]
}
