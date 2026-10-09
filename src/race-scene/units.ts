/** Public world-space contract: positions/lengths in metres, time in seconds. */
export const UNITS_PER_METRE = 1

/** Compatibility spelling for configurations already authored in metres. */
export const metres = (value: number) => value

/**
 * Import adapter for the original procedural artwork's calibrated constants.
 * New maps, assets and APIs must use metres directly. Never apply this to an
 * incoming world coordinate or to GLB-local geometry that has its own scale.
 */
export const LEGACY_UNITS_PER_METRE = 4.36
export const fromLegacyUnits = (value: number) => value / LEGACY_UNITS_PER_METRE
