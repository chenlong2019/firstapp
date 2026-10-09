/**
 * 截图探针:航线执行流程的四个机位照(编辑器 / 标记与航线 / 飞行中 / 机载视角)。
 * 用法:先起 dev server(vite preview 产物),再 `node scripts/probe-waypoint-shot.mjs`(地址写死 15186/dji)。
 * 产物:.verify-shots/waypoint-0*.png;末尾打印 RUNNING STATE(进度/剩余距离/ETA/照片数)。
 * 坑:截图前必须等机臂完全展开,且靠 phase/missionIndex 轮询推进——约 2FPS 下固定 sleep 会抓空。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const DIR = join(process.cwd(), '.verify-shots')
mkdirSync(DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto('http://127.0.0.1:15186/dji', { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
// 先让机臂展开,后续所有截图都基于展开飞行态
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1200)

// 航线编辑器
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(500)
await page.screenshot({ path: join(DIR, 'waypoint-01-editor.png') })

// 上电 → 执行航线
await page.click('[data-testid="tab-flight"]')
await page.click('[data-testid="btn-power"]')
await page.waitForFunction('window.__djiDebug.fly.sim.phase === "standby"', undefined, { timeout: 60000 })
// 拉到 2 倍速缩短等待;卡点仍按 phase/索引轮询,不靠固定 sleep(约 2FPS)
await page.evaluate(() => window.__djiDebug.fly.setConfig({ timeScale: 2 }))
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)
await page.click('[data-testid="mission-start"]')
await page.waitForFunction('window.__djiDebug.fly.sim.phase === "waypoint"', undefined, { timeout: 60000 })
await page.waitForTimeout(1200)

// 把观察者相机拉远,能同时看到飞机与整条航线
await page.evaluate(() => {
  const fly = window.__djiDebug.fly
  fly.setCameraMode('orbit')
  const sim = fly.sim
  fly.camera.position.set(sim.position.x + 52, sim.position.y + 30, sim.position.z + 62)
  fly.controls.target.set(sim.position.x, sim.position.y, sim.position.z)
  fly.controls.update()
})
await page.waitForTimeout(1600)
await page.screenshot({ path: join(DIR, 'waypoint-02-markers.png') })

// 飞到第 2/3 个航点附近再抓一张(此时进度条已推进)
await page.waitForFunction('window.__djiDebug.fly.sim.missionIndex >= 2', undefined, { timeout: 180000 })
await page.evaluate(() => {
  const fly = window.__djiDebug.fly
  const sim = fly.sim
  fly.camera.position.set(sim.position.x - 45, sim.position.y + 26, sim.position.z + 55)
  fly.controls.target.set(sim.position.x, sim.position.y, sim.position.z)
  fly.controls.update()
})
await page.waitForTimeout(1600)
await page.screenshot({ path: join(DIR, 'waypoint-03-inflight.png') })

// 机载视角:从云台往外看,航点标记应在画面里
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('fpv'))
await page.waitForTimeout(1800)
await page.screenshot({ path: join(DIR, 'waypoint-04-fpv.png') })

const state = await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  const snap = sim.snapshot()
  return {
    phase: sim.phase,
    index: snap.mission.index,
    total: snap.mission.total,
    progress: Number(snap.mission.progress.toFixed(3)),
    distanceLeft: Number(snap.mission.distanceLeft.toFixed(1)),
    eta: Number(snap.mission.etaSeconds.toFixed(1)),
    altitude: Number(sim.position.y.toFixed(1)),
    photoCount: sim.photoCount,
  }
})
console.log('RUNNING STATE', JSON.stringify(state))
await browser.close()
