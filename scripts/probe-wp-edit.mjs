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
await page.waitForTimeout(1500)
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(500)
const input = page.locator('[data-testid="waypoint-0"] .wp-row').first().locator('input').first()
console.log('input count:', await input.count(), 'value:', await input.inputValue(), 'disabled:', await input.isDisabled())
await page.evaluate(() => {
  window.__log = []
  const el = document.querySelector('[data-testid="waypoint-0"] .wp-row input')
  el.addEventListener('input', () => window.__log.push('input:' + el.value))
  el.addEventListener('change', () => window.__log.push('change:' + el.value))
  el.addEventListener('blur', () => window.__log.push('blur:' + el.value))
})
await input.fill('5')
await page.waitForTimeout(200)
console.log('after fill sim x =', await page.evaluate(() => window.__djiDebug.fly.sim.mission[0].x))
await input.press('Enter')
await page.waitForTimeout(400)
console.log('after enter sim x =', await page.evaluate(() => window.__djiDebug.fly.sim.mission[0].x))
await input.press('Tab')
await page.waitForTimeout(400)
console.log('after tab sim x =', await page.evaluate(() => window.__djiDebug.fly.sim.mission[0].x))
console.log('events =', await page.evaluate(() => window.__log))
await page.evaluate(() => {
  const el = document.querySelector('[data-testid="waypoint-0"] .wp-row input')
  el.value = '7'
  el.dispatchEvent(new Event('change', { bubbles: true }))
})
await page.waitForTimeout(400)
console.log('after manual dispatch sim x =', await page.evaluate(() => window.__djiDebug.fly.sim.mission[0].x))
await page.waitForTimeout(400)
console.log('ui value =', await input.inputValue())
console.log('remove btn testids =', await page.locator('[data-testid^="waypoint-remove-"]').count())
await browser.close()
