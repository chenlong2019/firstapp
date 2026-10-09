/**
 * water-sky 模块的公共入口（barrel 再导出）。
 * 汇总：环境工厂 createWaterSkyEnvironment、独立查看器 createWaterSkyScene、跨海大桥
 * createBridge，以及配置常量与公共类型。本文件不引入任何副作用，供使用方统一引用。
 */
export { createWaterSkyScene } from './scene'
export { createWaterSkyEnvironment } from './environment'
export { createBridge } from './bridge'
export type { BridgeOptions } from './bridge'
export {
  DEFAULT_CAMERA,
  DEFAULT_PARAMS,
  DEFAULT_QUALITY,
  TOP_CAMERA,
  WATER_POSITION,
  PARAM_LIMITS,
} from './config'
export type {
  Vec3Tuple,
  WaterSkyCameraPreset,
  WaterSkyOptions,
  WaterSkyParams,
  WaterSkyQuality,
  WaterSkyEnvironmentOptions,
  WaterSkyEnvironment,
  WaterSkyHandle,
} from './types'
