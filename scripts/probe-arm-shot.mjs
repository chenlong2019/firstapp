/** 折叠/展开特写截图:近距离目视确认机臂姿态 */
/**
 * 用法:先起 dev server,再 `node scripts/probe-arm-shot.mjs`;产物 .verify-shots/armfix-*.png。
 * 两张:armfix-folded(收纳)、armfix-open(展开),用 zoom 按球坐标摆近景机位。
 * 坑:展开那张要等 armFold→0 且 bladeOpen→1 再拍,否则桨叶还处于收拢中间态。
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.waitForFunction('window.__djiDebug.fly.rig.armFold > 0.999', undefined, { timeout: 30000 })
await page.waitForTimeout(1000)

const zoom = (radius, phiDeg, thetaDeg) =>
  page.evaluate(([r, phi, theta]) => {
    const d = window.__djiDebug
    const cam = d.game.camera
    const target = new (d.THREE.Vector3)(0, 0.35, 0)
    const phiR = (phi * Math.PI) / 180
    const thetaR = (theta * Math.PI) / 180
    cam.position.set(
      target.x + r * Math.sin(phiR) * Math.sin(thetaR),
      target.y + r * Math.cos(phiR),
      target.z + r * Math.sin(phiR) * Math.cos(thetaR),
    )
    if (d.game.controls) {
      d.game.controls.target.copy(target)
      d.game.controls.update()
    }
    cam.lookAt(target)
  }, [radius, phiDeg, thetaDeg])

// 收纳态特写:半径 1.6、俯仰 55°、方位 20° 摆近景机位
await zoom(1.6, 55, 20)
await page.waitForTimeout(2500)
await page.screenshot({ path: '.verify-shots/armfix-folded.png' })
console.log('saved armfix-folded.png')

await page.locator('[data-testid="btn-arm"]').click()
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.001', undefined, { timeout: 30000 })
// 展开后还要等桨叶张开(bladeOpen→1)再拍,否则特写里桨叶仍是收拢中间态
await page.waitForFunction('window.__djiDebug.fly.rig.bladeOpen > 0.98', undefined, { timeout: 30000 })
await page.waitForTimeout(1500)
await zoom(1.9, 55, 20)
await page.waitForTimeout(2000)
await page.screenshot({ path: '.verify-shots/armfix-open.png' })
console.log('saved armfix-open.png')
await browser.close()
