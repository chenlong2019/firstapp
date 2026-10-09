/**
 * 拍照/录像功能演示图:机载视角下拍一张照片 + 正在录像的 HUD 状态。
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1520, height: 920 }, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1000)

// 上电 + 取景:机载视角、云台 −25°(俯瞰地面)
await page.evaluate(() => {
  // 云台俯到 -25° 俯瞰地面,再切机载视角,画面里才有可拍的地景
  window.__djiDebug.fly.sim.setGimbalPitch(-25)
  // 切机载视角取景,后续用 photo-button / record-toggle 演示拍照与录制
  window.__djiDebug.fly.setCameraMode('fpv')
})
await page.waitForTimeout(1600)

// 拍两张照片
await page.click('[data-testid="photo-button"]')
await page.waitForTimeout(1600)
await page.click('[data-testid="photo-button"]')
await page.waitForTimeout(1600)

// 开始录像
await page.click('[data-testid="record-toggle"]')
await page.waitForTimeout(2600)

await page.screenshot({ path: '.verify-shots/capture-demo.png' })
console.log('saved .verify-shots/capture-demo.png')
await page.click('[data-testid="record-toggle"]')
await page.waitForTimeout(1200)
await page.screenshot({ path: '.verify-shots/capture-demo-saved.png' })
console.log('saved .verify-shots/capture-demo-saved.png')
await browser.close()
