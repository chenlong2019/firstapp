/**
 * 竞速场景内部约定的单位模块(兼容转发)。
 *
 * 上游这套场景的几何量以“旧单位(legacy units)”标定,换算关系为 1 米 = 4.36 旧单位。
 * 本文件不自己实现换算,只把父级 `../units` 的世界空间契约原样再导出,使 `./units`
 * 与 `../units` 两个导入路径等价。对外导出 `UNITS_PER_METRE`、`metres`、
 * `LEGACY_UNITS_PER_METRE`、`fromLegacyUnits`。
 */
/** Backward-compatible import path; the world-space contract is shared. */
export { UNITS_PER_METRE, metres, LEGACY_UNITS_PER_METRE, fromLegacyUnits } from '../units'
