/**
 * 探针:场景内航点编辑 —— 先把"航点投影到屏幕的哪个位置、那个位置点得到画布吗"摸清楚。
 * 不参与回归,只是排查用。
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (error) => console.log('[pageerror]', error.message))
page.on('console', (message) => {
  if (message.type() === 'error') console.log('[console.error]', message.text())
})

await page.goto('http://127.0.0.1:15186/dji', { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.world', undefined, { timeout: 120000 })
await page.waitForTimeout(1500)

await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(400)

console.log('编辑器实例:', await page.evaluate(() => Boolean(window.__djiDebug.fly.missionEditor)))
console.log('编辑状态:', JSON.stringify(await page.evaluate(() => window.__djiDebug.fly.getMissionEditState())))

// 打开场景编辑
await page.click('[data-testid="scene-edit-toggle"]')
await page.waitForTimeout(400)
console.log('开关后状态:', JSON.stringify(await page.evaluate(() => window.__djiDebug.fly.getMissionEditState())))

const projections = await page.evaluate(() => {
  const { fly, THREE } = window.__djiDebug
  const camera = window.__djiDebug.game.camera
  const world = fly.world
  const out = []
  world.missionMarkerNodes.forEach((node, index) => {
    const waypoint = fly.sim.mission[index]
    const point = new THREE.Vector3()
    node.group.getWorldPosition(point)
    point.y += Math.max(1, waypoint.altitude) * 0.6
    point.project(camera)
    const x = ((point.x + 1) / 2) * window.innerWidth
    const y = ((1 - point.y) / 2) * window.innerHeight
    out.push({
      index,
      x: Math.round(x),
      y: Math.round(y),
      ndcZ: Number(point.z.toFixed(3)),
      element: document.elementFromPoint(x, y)?.tagName ?? 'none',
      inside: point.z < 1 && x > 0 && x < window.innerWidth && y > 0 && y < window.innerHeight,
    })
  })
  return out
})
console.log('航点屏幕投影:', JSON.stringify(projections, null, 1))

await browser.close()
