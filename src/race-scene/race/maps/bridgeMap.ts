import * as THREE from 'three'
import { createBridge } from '../../water-sky/bridge'
import { createCentreline } from '../../track/centreline'
import { DRIVABLE, TRACK_OPTIONS } from '../config'
import type { RaceMap } from './types'

/**
 * The bridge as it stands: an approximately 596 metre sweep with four lanes.
 * Open ended, so it is a sprint rather than a circuit.
 */
export function createBridgeMap(): RaceMap {
  const bridge = createBridge(TRACK_OPTIONS)
  // 桥生成器把桥面顶标高放在 userData.bridge.roadTop 里。
  const info = bridge.userData.bridge as { roadTop: number }
  const origin = new THREE.Vector3().fromArray(TRACK_OPTIONS.position)
  return {
    id: 'bridge',
    name: '海湾大桥 · 单程',
    description: `${TRACK_OPTIONS.length!.toFixed(0)} 米四车道桥面，从一端跑到另一端，用来验证车辆与路面。`,
    closed: false,
    visual: bridge,
    centreline: createCentreline(TRACK_OPTIONS.length!, TRACK_OPTIONS.turn!),
    origin,
    surfaceY: info.roadTop + origin.y,
    lateralMin: DRIVABLE.lateralMin,
    lateralMax: DRIVABLE.lateralMax,
    // 出生点取桥长的一个比例处，避免生成在端头。
    startDistance: TRACK_OPTIONS.length! * DRIVABLE.startDistanceFraction,
    // 出生在可行驶带的横向正中。
    spawnLateral: (DRIVABLE.lateralMin + DRIVABLE.lateralMax) / 2,
  }
}
