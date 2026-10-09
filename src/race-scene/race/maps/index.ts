// 本文件是地图变体的统一入口：汇总三种地图的工厂、id 列表与展示摘要，并按 id 分发创建。
// 位置：race-scene/race/maps 的门面（barrel），供上层或 URL 参数选择地图。
// 对外导出：三个 createXxxMap、MAP_IDS / MapId、MAP_SUMMARIES，以及分发函数 createMap。
// 非直觉约定：未知 id 一律回退到海湾大桥，保证旧链接仍能运行。
import { createBridgeMap } from './bridgeMap'
import { createCircuitMap } from './circuitMap'
import { createEndlessMap } from './endlessMap'
import type { RaceMap } from './types'

export type { RaceMap } from './types'
export { createBridgeMap } from './bridgeMap'
export { createCircuitMap } from './circuitMap'
export { createEndlessMap } from './endlessMap'

/** Map ids a host or URL may ask for. */
/** 所有可选地图 id 的常量元组；下面的 MapId 类型即由它派生。 */
export const MAP_IDS = ['bridge', 'circuit', 'endless'] as const
/** 地图 id 的联合类型：'bridge' | 'circuit' | 'endless'。 */
export type MapId = (typeof MAP_IDS)[number]

/** 供 UI 展示的地图摘要列表（id、中文名、是否闭合）。 */
export const MAP_SUMMARIES = [
  { id: 'bridge', name: '海湾大桥 · 单程', closed: false },
  { id: 'circuit', name: '海湾环线 · 计时圈', closed: true },
  { id: 'endless', name: '无尽技术赛道', closed: false },
]

/** Unknown ids fall back to the bridge so a stale URL still runs. */
export function createMap(id: string | null | undefined, options: { seed?: number } = {}): RaceMap {
  // 未给种子时默认用 1，保证同一 URL 每次都能生成同一条赛道。
  if (id === 'endless') return createEndlessMap({ seed: options.seed ?? 1 })
  return id === 'circuit' ? createCircuitMap() : createBridgeMap()
}
