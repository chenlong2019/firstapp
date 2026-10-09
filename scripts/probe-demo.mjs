/** 成品演示截图:展开待命(停放姿态) + 起飞悬停(旋速/无桨盘) */
/**
 * 用法:先起 dev server,再 `node scripts/probe-demo.mjs`;产物 .verify-shots/final-*.png。
 * 三张:ground(展开待命)、motors-on(电机转)、hover(起飞悬停),靠 phase 轮询卡点。
 * 坑:每张前用 camTo 重新摆机位并等一拍——相机受控制器托管,不重置会被拉回。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

mkdirSync('.verify-shots', { recursive: true })
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:15186/dji', { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })

const shot = async (name) => {
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join('.verify-shots', `final-${name}.png`) })
  console.log('shot', name)
}
// 相机手动摆位(同时设 fov/near),每张图前置位一次,否则会被控制器拉回
const camTo = async (px, py, pz, ty = 0.35, fov = 34) => {
  await page.evaluate(([x, y, z, t, f]) => {
    const d = window.__djiDebug
    const cam = d.game.camera
    const controls = d.game.controls
    cam.position.set(x, y, z)
    cam.fov = f
    cam.near = 0.02
    cam.updateProjectionMatrix()
    controls.target.set(0, t, 0)
    controls.update()
  }, [px, py, pz, ty, fov])
}

// 先展开待命:该步才是"停放姿态",电机/起飞都基于展开态
await page.locator('[data-testid="btn-arm"]').click()
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await camTo(2.2, 1.0, 2.6)
await shot('ground')

await page.locator('[data-testid="btn-power"]').click()
await page.waitForFunction("window.__djiDebug.fly.sim.phase === 'standby'", undefined, { timeout: 90000 })
await page.locator('[data-testid="btn-motors"]').click()
await page.waitForFunction('window.__djiDebug.fly.sim.phase === "motorsOn"', undefined, { timeout: 20000 })
await page.waitForTimeout(2500)
await camTo(2.2, 1.0, 2.6)
await shot('motors-on')

await page.locator('[data-testid="btn-takeoff"]').click()
await page.waitForFunction("window.__djiDebug.fly.sim.phase === 'flying'", undefined, { timeout: 60000 })
await page.waitForTimeout(2000)
await camTo(2.4, 1.9, 2.8, 1.5, 36)
await shot('hover')

await browser.close()
console.log('all done')
