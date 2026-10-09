import * as THREE from 'three'
import type { Centreline, CentrelineFrame } from '../../track/centreline'

/**
 * A drivable surface derived from a centreline. The vehicle only talks to this
 * interface, so a different map is a different `createTrackSurface` call.
 * Positions, lengths and lateral offsets are all in metres.
 */
export type TrackSurface = {
  readonly length: number
  /** Closed surfaces loop, so a lap has a meaning. */
  readonly closed: boolean
  readonly surfaceY: number
  readonly lateralMin: number
  readonly lateralMax: number
  readonly startDistance: number
  /** World frame at an arc length measured from the start of the centreline. */
  frameAtDistance(distance: number): CentrelineFrame
  /** Nearest point on the track: arc length plus signed lateral offset. */
  project(x: number, z: number): { distance: number; lateral: number }
  /** World position of a point on the surface. */
  pointAt(distance: number, lateral: number, out?: THREE.Vector3): THREE.Vector3
}

/** 构建可行驶表面的输入：中心线、世界原点、路面高度、横向可行驶带，以及起点距离（可覆盖比例）。 */
export type TrackSurfaceOptions = {
  centreline: Centreline
  /** World placement of the centreline, matching the rendered geometry. */
  origin: THREE.Vector3
  surfaceY: number
  lateralMin: number
  lateralMax: number
  startDistanceFraction?: number
  /** Absolute start distance; overrides the fraction when present. */
  startDistance?: number
}

/** 由中心线构建可行驶表面：把局部坐标经 origin 平移到世界，并按横向偏移取表面上的点。 */
export function createTrackSurface(options: TrackSurfaceOptions): TrackSurface {
  const { centreline, origin, surfaceY, lateralMin, lateralMax } = options
  // 起点默认落在中心线全长的 6% 处；显式给出 startDistance 时以它优先。
  const startDistance =
    options.startDistance ?? centreline.length * (options.startDistanceFraction ?? 0.06)

  const frameAtDistance = (distance: number): CentrelineFrame => {
    const frame = centreline.frameAtDistance(distance)
    frame.position.add(origin)
    frame.position.y = surfaceY
    return frame
  }

  const pointAt = (distance: number, lateral: number, out = new THREE.Vector3()) => {
    const frame = frameAtDistance(distance)
    // 表面恒为水平面：y 一律取 surfaceY，只有横向偏移 frame.lateral 参与 x/z。
    return out.set(
      frame.position.x + frame.lateral.x * lateral,
      surfaceY,
      frame.position.z + frame.lateral.z * lateral,
    )
  }

  return {
    // A procedural centreline keeps growing, so the length is read live rather
    // than snapshotted at construction time.
    get length() {
      return centreline.length
    },
    closed: centreline.closed,
    surfaceY,
    lateralMin,
    lateralMax,
    startDistance,
    frameAtDistance,
    pointAt,
    project(x: number, z: number) {
      // 世界坐标先减去 origin 还原到中心线局部坐标系，再交给中心线做投影。
      return centreline.project(x - origin.x, z - origin.z)
    },
  }
}
