/**
 * 截图探针:展开态下从侧/前/等轴三个机位各拍一张,目视核对停放姿态。
 * 用法:先起 dev server,再 `node scripts/probe-shot.mjs`;产物 .verify-shots/stance-*.png。
 * 这三张只做目视参考、不进回归;机位/fov/near 写死以便两次运行直接对比。
 * 坑:必须等机臂完全展开(armFold<0.02)再拍,否则拍到的是收纳态。
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
await page.locator('[data-testid="btn-arm"]').click()
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1000)
// 机位:侧视 +x、前视 -z、等轴;fov=32、near=0.02 固定,三张可直接对比
const shots = [
  ['side-x', [4.2, 0.9, 0]],
  ['front-z', [0, 0.9, -4.2]],
  ['iso', [2.6, 1.4, 2.6]],
]
// 逐个机位:写死相机位置并等一拍让渲染稳定后再截
for (const [name, pos] of shots) {
  await page.evaluate(([n, p]) => {
    const d = window.__djiDebug
    const cam = d.game.camera
    const controls = d.game.controls
    cam.position.set(p[0], p[1], p[2])
    cam.fov = 32
    cam.near = 0.02
    cam.updateProjectionMatrix()
    controls.target.set(0, 0.35, 0)
    controls.update()
  }, [name, pos])
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join('.verify-shots', `stance-${name}.png`) })
}
await browser.close()
console.log('done')
