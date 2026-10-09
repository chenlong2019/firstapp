// 本文件是"无尽赛道"地图变体：中心线按种子逐段实时生成，路面随车流式铺出，开多远都不预烘焙。
// 位置：race-scene/race/maps 之一，组合 track/endlessTrack 与 track/streamingRoad。
// 对外导出：createEndlessMap，以及 EndlessMapOptions。
// 非直觉约定：长度是"活"的（随生成增长），所以 centreline.length 用 getter 实时读取；
// 横向可行驶带在半宽内各留 6（旧单位）作为护栏余量；出生点前需先手动铺一次路面。
import * as THREE from 'three'
import { createEndlessTrack } from '../../track/endlessTrack'
import { createStreamingRoad } from '../track/streamingRoad'
import { fromLegacyUnits as legacy } from '../../units'
import type { RaceMap } from './types'

/** 无尽地图参数：随机种子，以及可选的路面世界高度（默认与桥面一致）。 */
export type EndlessMapOptions = {
  seed: number
  /** World height of the road surface; matches the bridge deck by default. */
  surfaceY?: number
}

// 以下距离原以旧单位给出，这里换算成米：半宽、分块长度、前方保留 1600、后方保留 700。
const HALF_WIDTH = legacy(30)
const CHUNK_LENGTH = legacy(240)
const AHEAD = legacy(1600)
const BEHIND = legacy(700)

/**
 * Endless procedurally generated road: the centreline is produced segment by
 * segment from a seed and the pavement is streamed in chunks around the car, so
 * nothing is pre-baked and memory stays flat however far it drives.
 */
export function createEndlessMap(options: EndlessMapOptions): RaceMap {
  // 默认路面高度取自桥面标高，换算为米。
  const surfaceY = options.surfaceY ?? legacy(52)
  const track = createEndlessTrack({ seed: options.seed })
  const road = createStreamingRoad({
    track,
    origin: new THREE.Vector3(),
    surfaceY,
    halfWidth: HALF_WIDTH,
    chunkLength: CHUNK_LENGTH,
    ahead: AHEAD,
    behind: BEHIND,
  })
  // 出生点选在已生成轨道的中段，并预先铺好该处的路面分块。
  const startDistance = legacy(140)
  road.update(startDistance)

  // length 用 getter 实时读取：无尽轨道会边跑边变长。
  const centreline = {
    get length() {
      return track.length
    },
    closed: false,
    frameAtDistance: (distance: number) => track.frameAtDistance(distance),
    project: (x: number, z: number) => track.project(x, z),
  }
  return {
    id: 'endless',
    name: '无尽技术赛道',
    description: `种子 ${options.seed} 实时生成：低速弯为主，路面按 ${CHUNK_LENGTH.toFixed(2)} 米分块，开到哪铺到哪。`,
    closed: false,
    visual: road.group,
    centreline,
    origin: new THREE.Vector3(),
    surfaceY,
    lateralMin: -(HALF_WIDTH - legacy(6)),
    lateralMax: HALF_WIDTH - legacy(6),
    startDistance,
    spawnLateral: 0,
    update: (distance) => road.update(distance),
    generator: {
      seed: options.seed,
      stats: () => ({ ...track.stats(), road: road.stats(), length: track.length }),
    },
  }
}
