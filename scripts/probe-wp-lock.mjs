/**
 * 探针:航线执行期航点编辑区的"锁定"行为——执行中字段组/删除按钮应被禁用,停止后解锁。
 * 用法:先起 dev server,再 `node scripts/probe-wp-lock.mjs`(地址写死 127.0.0.1:15186/dji)。
 * 关键读数:.waypoint-fieldset 的 disabled、字段与 waypoint-remove-0 的 :disabled——
 *   看"初始/执行中/停止后"三段是否按预期翻转;这些是 DOM 稳态,不受 2FPS 渲染影响。
 * 坑:stopMission 后要留一拍再读,锁的解除可能晚于点击。
 */
import { chromium } from 'playwright'
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:15186/dji', { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1200)
// 切到航线页,航点字段组才会出现在 DOM 里
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(400)
// 每次读 missionStatus/phase 与航点字段组/删除按钮的 :disabled(DOM 稳态,不受 2FPS 影响)
const read = async (tag) => {
  const s = await page.evaluate(() => ({
    status: window.__djiDebug.fly.sim.missionStatus,
    phase: window.__djiDebug.fly.sim.phase,
    fs: document.querySelector('.waypoint-fieldset')?.disabled ?? 'no-fieldset',
    inner: document.querySelector('.waypoint-fieldset input')?.matches(':disabled') ?? null,
    rm: document.querySelector('[data-testid="waypoint-remove-0"]')?.matches(':disabled') ?? null,
    tab: document.querySelector('[data-testid="tab-mission"]')?.className,
  }))
  console.log(tag, JSON.stringify(s))
}
await read('初始     ')
await page.click('[data-testid="tab-flight"]')
await page.click('[data-testid="btn-power"]')
await page.waitForFunction('window.__djiDebug.fly.sim.phase === "standby"', undefined, { timeout: 60000 })
await page.evaluate(() => window.__djiDebug.fly.setConfig({ timeScale: 3 }))
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)
await page.click('[data-testid="mission-start"]')
await page.waitForFunction('window.__djiDebug.fly.sim.phase === "waypoint"', undefined, { timeout: 60000 })
await page.waitForTimeout(900)
await read('执行中   ')
await page.evaluate(() => window.__djiDebug.fly.stopMission('probe'))
await page.waitForTimeout(900)
await read('停止后   ')
await page.evaluate(() => window.__djiDebug.fly.startMission())
await page.waitForTimeout(900)
await read('再启动   ')
await browser.close()
