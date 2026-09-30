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
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(400)
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
