import type * as THREE from 'three'
import type { Centreline } from '../../track/centreline'

/**
 * A map is data plus its own visual content. The vehicle never sees a map: it
 * drives a `TrackSurface` built from one, so swapping maps is swapping this
 * object and nothing else. All positions, dimensions and arc lengths are metres.
 */
export type RaceMap = {
  id: string
  name: string
  description: string
  /** Closed maps are circuits; open maps are point to point. */
  closed: boolean
  /** Scene content, already placed in world space. */
  visual: THREE.Object3D
  /** Centreline in map local space; `origin` places it in the world. */
  centreline: Centreline
  origin: THREE.Vector3
  /** World height of the driving surface. */
  surfaceY: number
  /** Drivable band measured from the centreline. */
  lateralMin: number
  lateralMax: number
  /** 车辆出生的弧长位置。 */
  startDistance: number
  /** 出生点相对中心线的横向偏移，用来把车放到车道中央。 */
  spawnLateral: number
  /** Maps that build their geometry as the car advances call this each step. */
  update?(distance: number): void
  /** Procedural maps report their seed and generated shape here. */
  generator?: { seed: number; stats: () => unknown }
}
