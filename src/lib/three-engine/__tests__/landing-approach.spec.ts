import { describe, expect, it } from 'vitest'
import { DroneSim } from '../drone-sim'

/**
 * 自动降落的三段式:降向 1 米悬停位 → 低位悬停确认 → 缓慢触地。
 *
 * 真机不会从巡航高度一路匀速直插地面:低位那一下停顿既是确认落点,
 * 也是留给飞手接管的时间。这里用高度轨迹把这三段锁住。
 */

const STEP = 1 / 60
/** 与 drone-sim 里的 LANDING_HOLD_ALTITUDE_M 对齐 */
const HOLD_ALTITUDE = 1

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
  if (!runUntil(sim, () => sim.phase === 'standby', 20)) throw new Error(`未能进入地面待机:${sim.phase}`)
  sim.autoTakeOff()
  if (!runUntil(sim, () => sim.airborne, 15)) throw new Error('未能离地')
  return sim
}

describe('自动降落 · 先停 1 米再缓慢触地', () => {
  it('从巡航高度降落时先在 1 米处停住', () => {
    const sim = hoveringSim()
    // 抬到巡航高度,模拟飞完一圈再按降落
    sim.position.y = 10
    expect(sim.startLanding()).toBe(true)

    expect(
      runUntil(sim, () => sim.snapshot().landingStage === 'hold', 30),
      '应当先降到 1 米悬停位再停住',
    ).toBe(true)
    expect(sim.position.y).toBeCloseTo(HOLD_ALTITUDE, 5)
    expect(sim.snapshot().verticalSpeed).toBe(0)

    // 悬停期间高度必须锁住,不能边停边往下溜
    run(sim, 0.5)
    expect(sim.snapshot().landingStage).toBe('hold')
    expect(sim.position.y).toBeCloseTo(HOLD_ALTITUDE, 5)
    expect(sim.airborne).toBe(true)
  })

  it('悬停确认结束后以低速触地并停桨', () => {
    const sim = hoveringSim()
    sim.position.y = 10
    sim.startLanding()

    expect(runUntil(sim, () => sim.snapshot().landingStage === 'settle', 30)).toBe(true)
    const settleStartedAt = sim.snapshot().totalTime
    expect(runUntil(sim, () => sim.phase === 'standby', 20), '应当完成触地').toBe(true)

    // 1 米按 0.3 m/s 缓降:明显慢于常规下降挡(3 m/s 只需 0.3 秒)
    const seconds = sim.snapshot().totalTime - settleStartedAt
    expect(seconds, `最后 1 米花了 ${seconds.toFixed(1)}s,不像缓慢降落`).toBeGreaterThan(2)
    expect(sim.position.y).toBe(0)
    expect(sim.snapshot().motorLoad).toBe(0)
  })

  it('已经贴近地面时不再抬升到悬停位,直接缓降', () => {
    const sim = hoveringSim()
    sim.position.y = 0.6
    expect(sim.startLanding()).toBe(true)
    expect(sim.snapshot().landingStage).toBe('settle')

    run(sim, 0.3)
    expect(sim.position.y, '低于悬停位时不应被抬到 1 米').toBeLessThanOrEqual(0.6)
    expect(runUntil(sim, () => sim.phase === 'standby', 20)).toBe(true)
  })

  it('智能返航的降落段同样在 1 米悬停确认', () => {
    const sim = hoveringSim()
    // 挪到返航点正北 20 米(-Z 是北),机头朝北,返航航向为南
    sim.position.x = 0
    sim.position.z = -20
    sim.heading = 0
    expect(sim.startRth('单元测试')).toBe(true)

    expect(
      runUntil(sim, () => sim.snapshot().landingStage === 'hold', 120),
      '返航下降应当同样停在 1 米悬停位',
    ).toBe(true)
    expect(sim.position.y).toBeCloseTo(HOLD_ALTITUDE, 5)
    expect(runUntil(sim, () => sim.phase === 'standby', 30), '返航后应当完成降落').toBe(true)
  })
})
