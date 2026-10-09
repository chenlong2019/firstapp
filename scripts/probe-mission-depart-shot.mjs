/**
 * 截取「启航四步」的分段画面:垂直爬升 → 水平飞向首航点 → 收高度 → 对准航线。
 * 用法:先起 dev server,再 `node scripts/probe-mission-depart-shot.mjs [url]`
 * 产物:.verify-shots/depart-0*.png
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
const SHOT_DIR = join(process.cwd(), '.verify-shots')
mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (error) => console.log('[pageerror]', error.message))

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })

// 站到侧面看整条航线(默认机位贴着飞机,看不到垂直爬升)
await page.evaluate(() => {
  const fly = window.__djiDebug.fly
  fly.setCameraMode('orbit')
  fly.frameMission()
})
await page.waitForTimeout(1200)
await page.screenshot({ path: join(SHOT_DIR, 'depart-00-before.png') })

await page.click('[data-testid="btn-power"]')
await page.waitForFunction("window.__djiDebug.fly.sim.phase === 'standby'", undefined, { timeout: 60000 })
// 钩住阶段序列:对准段只有 1.5 秒左右,单靠 rAF 轮询容易漏掉
await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  window.__seenStages = [sim.missionStage]
  const original = sim.step.bind(sim)
  sim.step = (delta) => {
    original(delta)
    const stages = window.__seenStages
    if (stages[stages.length - 1] !== sim.missionStage) stages.push(sim.missionStage)
  }
})
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)
await page.click('[data-testid="mission-start"]')

const waitStage = (stage, label) =>
  page
    .waitForFunction(`window.__seenStages.includes('${stage}')`, undefined, {
      timeout: 180000,
      polling: 100,
    })
    .then(() => console.log(`已进入 ${stage} (${label})`))
    .catch(() => console.log(`等待 ${stage} 超时`))

// 垂直段爬到一半
await waitStage('depart-climb', '垂直调整到首航点高度')
// 用位置阈值(y>16,单位场景米)判定垂直段已过半,而不是计时——阶段时长随倍速变化
await page.waitForFunction('window.__djiDebug.fly.sim.position.y > 16', undefined, { timeout: 120000 })
await page.waitForTimeout(800)
await page.screenshot({ path: join(SHOT_DIR, 'depart-01-climb.png') })

// 水平段
await waitStage('depart-cruise', '水平飞向首个航点')
// 同理用 z 阈值(-14,单位场景米)判定水平段已推进到停机区外
await page.waitForFunction('window.__djiDebug.fly.sim.position.z < -14', undefined, { timeout: 120000 })
await page.waitForTimeout(800)
await page.screenshot({ path: join(SHOT_DIR, 'depart-02-cruise.png') })

// 对准段
await waitStage('depart-align', '对准航线方向')
await page.waitForTimeout(600)
await page.screenshot({ path: join(SHOT_DIR, 'depart-03-align.png') })

// 航线开始推进
await waitStage('goto', '开始执行航线')
await page.waitForTimeout(1200)
await page.screenshot({ path: join(SHOT_DIR, 'depart-04-goto.png') })

const summary = await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  return {
    stage: sim.missionStage,
    index: sim.missionIndex,
    heading: Number(sim.heading.toFixed(1)),
    position: {
      x: Number(sim.position.x.toFixed(2)),
      y: Number(sim.position.y.toFixed(2)),
      z: Number(sim.position.z.toFixed(2)),
    },
  }
})
console.log('终态:', JSON.stringify(summary))

await browser.close()
