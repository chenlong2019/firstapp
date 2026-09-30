/**
 * 探针:观察「启航四步」的分段序列(垂直 → 水平 → 收高度 → 对准航线)。
 * 钩住 sim.step,把每个阶段的进入时刻、位置、航向都记下来。
 * 用法:先起 dev server,再 `node scripts/probe-mission-depart.mjs [url]`
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (error) => console.log('[pageerror]', error.message))

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })

// 钩住 step:每次阶段变化都记一条(含位置与航向),另外逐帧记录垂直段/水平段的位移
await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  const log = []
  const frames = []
  let lastStage = sim.missionStage
  const original = sim.step.bind(sim)
  sim.step = (delta) => {
    const before = { x: sim.position.x, y: sim.position.y, z: sim.position.z, heading: sim.heading }
    original(delta)
    const after = { x: sim.position.x, y: sim.position.y, z: sim.position.z, heading: sim.heading }
    if (sim.phase === 'waypoint' || lastStage !== sim.missionStage) {
      frames.push({
        stage: sim.missionStage,
        dx: Math.hypot(after.x - before.x, after.z - before.z),
        dy: Math.abs(after.y - before.y),
        x: after.x,
        y: after.y,
        z: after.z,
        heading: after.heading,
      })
    }
    if (sim.missionStage !== lastStage) {
      log.push({
        stage: sim.missionStage,
        index: sim.missionIndex,
        t: Number(sim.time.toFixed(2)),
        x: Number(sim.position.x.toFixed(2)),
        y: Number(sim.position.y.toFixed(2)),
        z: Number(sim.position.z.toFixed(2)),
        heading: Number(sim.heading.toFixed(1)),
      })
      lastStage = sim.missionStage
    }
  }
  window.__departDebug = { log, frames }
})

// 上电 → 启动航线
await page.click('[data-testid="btn-power"]')
await page.waitForFunction("window.__djiDebug.fly.sim.phase === 'standby'", undefined, { timeout: 60000 })
await page.evaluate(() => window.__djiDebug.fly.sim.setTimeScale?.(1))
await page.evaluate(() => window.__djiDebug.fly.startMission())

// 等到进入常规航点推进(启航走完)
await page.waitForFunction("window.__djiDebug.fly.sim.missionStage === 'goto'", undefined, {
  timeout: 120000,
})
await page.waitForTimeout(500)

const result = await page.evaluate(() => {
  const { log, frames } = window.__departDebug
  const sim = window.__djiDebug.fly.sim
  const byStage = {}
  for (const frame of frames) {
    const entry = byStage[frame.stage] ?? { steps: 0, maxHorizontal: 0, maxVertical: 0 }
    entry.steps += 1
    entry.maxHorizontal = Math.max(entry.maxHorizontal, frame.dx)
    entry.maxVertical = Math.max(entry.maxVertical, frame.dy)
    byStage[frame.stage] = entry
  }
  return {
    log,
    byStage,
    heading: sim.heading,
    position: { ...sim.position },
    index: sim.missionIndex,
    stage: sim.missionStage,
    first: sim.mission[0],
    second: sim.mission[1],
    events: sim.events.slice(0, 10).map((e) => `${e.level}: ${e.text}`),
  }
})

console.log('\n=== 阶段序列 ===')
for (const entry of result.log) {
  console.log(
    `  ${entry.stage.padEnd(14)} t=${String(entry.t).padStart(6)}s  位置(${entry.x},${entry.y},${entry.z})  航向 ${entry.heading}°  航点#${entry.index + 1}`,
  )
}
console.log('\n=== 各阶段逐帧位移 ===')
for (const [stage, entry] of Object.entries(result.byStage)) {
  console.log(
    `  ${stage.padEnd(14)} 帧数 ${String(entry.steps).padStart(5)}  单帧最大水平位移 ${entry.maxHorizontal.toFixed(4)}m  单帧最大垂直位移 ${entry.maxVertical.toFixed(4)}m`,
  )
}
console.log('\n=== 首航点 / 次航点 ===')
console.log('  wp1 =', JSON.stringify(result.first))
console.log('  wp2 =', JSON.stringify(result.second))
console.log(`\n结束状态:stage=${result.stage} index=${result.index} heading=${result.heading.toFixed(1)}°`)
console.log('  位置 =', JSON.stringify(result.position))
console.log('\n=== 事件 ===')
for (const event of result.events) console.log('  ' + event)

await browser.close()
