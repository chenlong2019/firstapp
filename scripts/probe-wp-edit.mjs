/**
 * 探针:航点输入框的编辑到底会不会回写到 sim.mission——分别试 fill / Enter / Tab 与手动 dispatch。
 * 用法:先起 dev server,再 `node scripts/probe-wp-edit.mjs`(地址写死 127.0.0.1:15186/dji)。
 * 关键读数:每步后的 `sim.mission[0].x`(输入框填 5/7,模型是否同步)与事件日志 __log。
 * 坑:ui value 与 sim value 可能不同步,须同时打印两者才能判断是谁没跟上。
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
await page.waitForTimeout(1500)
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(500)
const input = page.locator('[data-testid="waypoint-0"] .wp-row').first().locator('input').first()
console.log('input count:', await input.count(), 'value:', await input.inputValue(), 'disabled:', await input.isDisabled())
await page.evaluate(() => {
  // 挂 input/change/blur 三个监听器,记录输入框到底派发了哪些事件
  window.__log = []
  const el = document.querySelector('[data-testid="waypoint-0"] .wp-row input')
  el.addEventListener('input', () => window.__log.push('input:' + el.value))
  el.addEventListener('change', () => window.__log.push('change:' + el.value))
  el.addEventListener('blur', () => window.__log.push('blur:' + el.value))
})
// 先 fill 再 Enter/Tab,逐步观察派发的事件与 sim 值,定位到底哪一步回写
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
