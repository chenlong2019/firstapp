import { describe, expect, it } from 'vitest'
import { DroneSim } from '../drone-sim'

/**
 * 智能返航的姿态控制。
 *
 * 真机返航是「先对准、再前进」:机头没转到返航航向之前是原地悬停转向的,
 * 不会带着水平位移一起转 —— 否则会飞出一条弧线,航迹也对不上返航点。
 *
 * 坐标约定:+X 东、-Z 北、航向 0° = 正北。
 */

const STEP = 1 / 60

/** 推进仿真指定的秒数 */
function run(sim: DroneSim, seconds: number): void {
  const steps = Math.round(seconds / STEP)
  for (let index = 0; index < steps; index += 1) sim.step(STEP)
}

/** 推进到条件成立,返回是否在预算内成立 */
function runUntil(sim: DroneSim, predicate: () => boolean, maxSeconds: number): boolean {
  const budget = Math.round(maxSeconds / STEP)
  for (let index = 0; index < budget; index += 1) {
    if (predicate()) return true
    sim.step(STEP)
  }
  return predicate()
}

/** 上电 → 自检 → 预热 → 起飞,返回一架悬停中的飞机 */
function hoveringSim(): DroneSim {
  const sim = new DroneSim()
  sim.powerOn()
  if (!runUntil(sim, () => sim.phase === 'standby', 20))
    throw new Error(`未能进入地面待机:${sim.phase}`)
  sim.autoTakeOff()
  if (!runUntil(sim, () => sim.airborne, 15)) throw new Error('未能离地')
  return sim
}

/** 两个航向之间的夹角(度,0~180) */
function headingGap(from: number, to: number): number {
  return Math.abs(((to - from + 540) % 360) - 180)
}

// 验证返航姿态控制:机头未对准返航航向之前原地转向,不产生水平位移;对准后再沿机头飞回返航点
describe('智能返航 · 先对准再前进', () => {
  // 进入 cruise 后 2 秒内:航向明显改变(>45°),但水平位移很小(<1.5m),证明是原地转向而非弧线
  it('机头没对准返航航向时原地转向,不带着位移一起转', () => {
    const sim = hoveringSim()
    // 挪到返航点正北 30 米(-Z 是北),机头仍朝北 0°
    // 返航航向是正南 180° —— 差了整整半圈,足够暴露「边飞边转」
    sim.position.x = 0
    sim.position.z = -30
    sim.heading = 0
    expect(sim.startRth('单元测试')).toBe(true)

    // 先等爬升段走完(升到返航高度)
    expect(
      runUntil(sim, () => sim.snapshot().rthStage === 'cruise', 30),
      '返航应当先从爬升段进入巡航段',
    ).toBe(true)

    const headingAtCruise = sim.heading
    const zAtCruise = sim.position.z
    run(sim, 2)

    const turned = headingGap(headingAtCruise, sim.heading)
    const drifted = Math.abs(sim.position.z - zAtCruise)
    expect(turned, `进入巡航后两秒应当明显在转向(实际 ${turned.toFixed(1)}°)`).toBeGreaterThan(45)
    expect(drifted, `机头对准之前不应当明显位移(实际 ${drifted.toFixed(2)} m)`).toBeLessThan(1.5)
  })

  // 对准后应走完 巡航→下降→降落,最终落在返航点附近(偏差<1.5m)且已落地
  it('对准之后沿机头方向飞回返航点并自动降落', () => {
    const sim = hoveringSim()
    sim.position.x = 0
    sim.position.z = -30
    sim.heading = 0
    sim.startRth('单元测试')

    expect(
      runUntil(sim, () => sim.phase === 'standby', 90),
      '返航应当走完 巡航 → 下降 → 降落',
    ).toBe(true)

    const distanceToHome = Math.hypot(sim.position.x, sim.position.z)
    expect(
      distanceToHome,
      `应当落在返航点附近(实际偏离 ${distanceToHome.toFixed(2)} m)`,
    ).toBeLessThan(1.5)
    expect(sim.airborne).toBe(false)
  })
})
