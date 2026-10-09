// 本文件把海湾大桥当成一条闭合环线来跑：单侧车道去、一端掉头、另一侧车道回、另一端再掉头。
// 位置：race-scene/race/maps 的一种地图变体，复用 water-sky/bridge 的桥面几何。
// 对外导出：createCircuitMap。
// 非直觉约定：无需新铺路面——桥面本就够宽，只要让中央隔离带在两端提前收住即可掉头；
// 采样点用整数索引推进，避免换单位后端点漂移。
import * as THREE from 'three'
import { createBridge } from '../../water-sky/bridge'
import { createCentreline, createPolylineCentreline } from '../../track/centreline'
import { DRIVABLE, TRACK_OPTIONS } from '../config'
import type { RaceMap } from './types'
import { fromLegacyUnits as legacy } from '../../units'

/** Median opened this far from each deck end, leaving room for the U-turn apron. */
const END_MARGIN = legacy(70)
const STRAIGHT_STEP = legacy(10)
// 掉头半圆的折线段数：段数越多弯越圆，代价是多几个控制点。
const TURN_STEPS = 24

/**
 * The same bridge driven as a circuit: out along one carriageway, U-turn on the
 * apron where the median is opened, back along the other carriageway, U-turn
 * again. The deck is already about 22 metres wide, so no new pavement is needed - only
 * the median barrier has to stop short of the ends.
 */
export function createCircuitMap(): RaceMap {
  const length = TRACK_OPTIONS.length!
  const turn = TRACK_OPTIONS.turn!
  const bridge = createBridge({ ...TRACK_OPTIONS, medianGapAtEnds: END_MARGIN })
  const info = bridge.userData.bridge as { roadTop: number }
  const origin = new THREE.Vector3().fromArray(TRACK_OPTIONS.position)
  const arc = createCentreline(length, turn)

  const laneCentre = (DRIVABLE.lateralMin + DRIVABLE.lateralMax) / 2
  const halfBand = (DRIVABLE.lateralMax - DRIVABLE.lateralMin) / 2
  const points: [number, number][] = []
  const leg = (s: number, u: number): [number, number] => {
    const frame = arc.frameAtDistance(s)
    return [frame.position.x + frame.lateral.x * u, frame.position.z + frame.lateral.z * u]
  }
  /** Semicircle joining the two carriageways around a deck end. */
  const uTurn = (s: number, direction: 1 | -1) => {
    const frame = arc.frameAtDistance(s)
    for (let step = 1; step < TURN_STEPS; step++) {
      const angle = (Math.PI * step) / TURN_STEPS
      // 半圆参数：across 走横向、along 走纵向，direction 决定从上游还是下游车道绕行。
      const across = Math.cos(angle) * laneCentre * direction
      const along = Math.sin(angle) * laneCentre * direction * -1
      points.push([
        frame.position.x + frame.lateral.x * across + frame.forward.x * along,
        frame.position.z + frame.lateral.z * across + frame.forward.z * along,
      ])
    }
  }

  // Integer sample indices preserve the end points after changing length units.
  const legSteps = Math.floor((length - END_MARGIN * 2) / STRAIGHT_STEP + 1e-9)
  for (let i = 0; i <= legSteps; i++) points.push(leg(END_MARGIN + i * STRAIGHT_STEP, laneCentre))
  uTurn(length - END_MARGIN, 1)
  for (let i = 0; i <= legSteps; i++)
    points.push(leg(length - END_MARGIN - i * STRAIGHT_STEP, -laneCentre))
  uTurn(END_MARGIN, -1)

  const centreline = createPolylineCentreline(points, true)
  return {
    id: 'circuit',
    name: '海湾环线 · 计时圈',
    description: `闭合回路 ${centreline.length.toFixed(0)} m：两侧车道各跑一趟，两端在隔离带缺口处掉头。`,
    closed: true,
    visual: bridge,
    centreline,
    origin,
    surfaceY: info.roadTop + origin.y, // 桥面顶标高叠加原点高度 = 世界中的路面高度
    lateralMin: -halfBand,
    lateralMax: halfBand,
    startDistance: 0,
    spawnLateral: 0,
  }
}
