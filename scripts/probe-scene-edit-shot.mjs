/**
 * 截图:场景内航点编辑(面板卡片 / 框住航线 / 选中与拖拽 / 航点与航线分别显隐)。
 * 用法:`node scripts/probe-scene-edit-shot.mjs`,输出到 .verify-shots/
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const SHOT_DIR = join(process.cwd(), '.verify-shots')
mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (error) => console.log('[pageerror]', error.message))

await page.goto('http://127.0.0.1:15186/dji', { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.world', undefined, { timeout: 120000 })
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1500)

await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(400)
await page.screenshot({ path: join(SHOT_DIR, 'scene-edit-01-panel.png') })

await page.click('[data-testid="scene-edit-toggle"]')
await page.waitForTimeout(900)
await page.click('[data-testid="scene-edit-select-first"]')
await page.waitForTimeout(600)
await page.screenshot({ path: join(SHOT_DIR, 'scene-edit-02-selected.png') })

// 拖到半路:顺便看看拖动中的高亮
const target = await page.evaluate(() => {
  const { fly, THREE, game } = window.__djiDebug
  const node = fly.world.missionMarkerNodes[0]
  const waypoint = fly.sim.mission[0]
  const point = new THREE.Vector3()
  node.group.getWorldPosition(point)
  point.y += Math.max(1, waypoint.altitude) * 0.55
  point.project(game.camera)
  return {
    x: ((point.x + 1) / 2) * window.innerWidth,
    y: ((1 - point.y) / 2) * window.innerHeight,
  }
})
await page.mouse.move(target.x, target.y)
await page.waitForTimeout(200)
await page.mouse.down()
await page.mouse.move(target.x + 90, target.y - 40, { steps: 8 })
await page.waitForTimeout(500)
await page.screenshot({ path: join(SHOT_DIR, 'scene-edit-03-drag.png') })
await page.mouse.up()
await page.waitForTimeout(400)

// 只留航点、把航线折线关掉
await page.locator('[data-testid="toggle-mission-path"]').uncheck()
await page.waitForTimeout(600)
await page.screenshot({ path: join(SHOT_DIR, 'scene-edit-04-no-path.png') })
await page.locator('[data-testid="toggle-mission-path"]').check()
await page.waitForTimeout(300)

console.log('截完:', SHOT_DIR)
await browser.close()
