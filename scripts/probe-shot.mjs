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
const shots = [
  ['side-x', [4.2, 0.9, 0]],
  ['front-z', [0, 0.9, -4.2]],
  ['iso', [2.6, 1.4, 2.6]],
]
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
