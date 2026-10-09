/**
 * water-sky 的公共类型定义（无运行时逻辑）。
 * 集中描述可序列化的外观参数、相机预设、质量参数，以及宿主接口
 * WaterSkyEnvironment 与 WaterSkyHandle。
 * 单位约定：位置与长度单位为米，fov 为角度，时间单位为秒，纯数值参数无量纲。
 */
import type * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { BridgeOptions } from './bridge'

/** World position in metres (1 Three.js unit = 1 metre). */
export type Vec3Tuple = readonly [number, number, number]

/** Serializable appearance parameters. All time values elsewhere are in seconds. */
export interface WaterSkyParams {
  /** Dimensionless swell amplitude multiplier. */
  intensity: number
  /** Flow: the phase speed of the swell and the heading of the ripple bands. */
  wind: number
  /** Ripple size: bigger means longer, lazier wavelets. */
  ripple: number
  /** 0 is neutral sky, 1 is a low sun with lit clouds: a sunset. */
  sunset: number
  cloudDensity: number
  sunHeight: number
}

/** Positions and clipping distances are metres; fov is degrees. */
export interface WaterSkyCameraPreset {
  position: Vec3Tuple
  target: Vec3Tuple
  fov: number
  near: number
  far: number
}

/** Water size and sky radius are metres; segment counts and pixel ratios are dimensionless. */
export interface WaterSkyQuality {
  maxPixelRatio: number
  waterSize: number
  waterSegments: number
  skyRadius: number
}

/** Spatial options and bridge dimensions are metres. */
export interface WaterSkyEnvironmentOptions {
  params?: Partial<WaterSkyParams>
  waterSize?: number
  waterSegments?: number
  waterPosition?: Vec3Tuple
  skyRadius?: number
  /**
   * Keep the water under the camera. The plane is finite, so a car that drives
   * far enough would otherwise leave it and the background would fall away to
   * bare sky. The wave field is sampled in world space, so following costs
   * nothing and the sea does not slide with the mesh. Off by default: the
   * standalone page frames a fixed vista.
   */
  follow?: boolean
  /** Mirror pass for the water reflection. On by default. */
  reflection?: boolean
  /** Optional reusable bridge; the standalone page enables it by default. */
  bridge?: boolean | BridgeOptions
}

/** Fully owned viewer by default; a supplied renderer always remains host-owned. */
export interface WaterSkyOptions extends WaterSkyEnvironmentOptions {
  container: HTMLElement
  pixelRatio?: number
  autoStart?: boolean
  autoResize?: boolean
  fixedTime?: number
  renderer?: THREE.WebGLRenderer
  camera?: Partial<WaterSkyCameraPreset>
}

export interface WaterSkyEnvironment {
  /** Add this group to an existing scene. Keep its world transform at identity. */
  root: THREE.Group
  materials: { sky: THREE.ShaderMaterial; water: THREE.ShaderMaterial }
  getParams(): WaterSkyParams
  setParams(patch: Partial<WaterSkyParams>): void
  update(timeSeconds: number, camera: THREE.Camera): void
  /**
   * Render the mirror pass the water reflects, from the same camera the host is
   * about to draw with. Call it immediately before the main render. Returns
   * false when the pass is off or the camera sits at or below the water plane.
   */
  renderReflection(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): boolean
  /** Turn the mirror pass on or off; the water falls back to its sky reflection. */
  setReflectionEnabled(enabled: boolean): void
  /**
   * Object drawn into the mirror pass without depth testing, for things the
   * surface they stand on would otherwise hide from below (a car on a deck).
   */
  setReflectionOverlay(object: THREE.Object3D | null): void
  /** Diagnostic: share of the mirror texture that actually carries geometry. */
  reflectionCoverage(renderer: THREE.WebGLRenderer): number
  /** Diagnostic: is an overlay attached, and how many meshes the last pass drew. */
  reflectionOverlayInfo(): { attached: boolean; meshes: number }
  dispose(): void
}

export interface WaterSkyHandle {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  controls: OrbitControls
  environment: WaterSkyEnvironment
  materials: WaterSkyEnvironment['materials']
  getParams(): WaterSkyParams
  setParams(patch: Partial<WaterSkyParams>): void
  getTime(): number
  /** Number freezes shader time; null resumes from that time. */
  setTime(seconds: number | null): void
  setAutoRotate(enabled: boolean): void
  setCamera(preset: Partial<WaterSkyCameraPreset>): void
  resetCamera(): void
  setTopCamera(): void
  /** Resizes only the camera when the renderer belongs to the host. */
  resize(width: number, height: number): void
  update(deltaSeconds: number): void
  render(): void
  start(): void
  stop(): void
  dispose(): void
}
