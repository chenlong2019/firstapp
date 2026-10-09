/**
 * FPV 运行时诊断:机载视角下真实渲染相机的世界朝向 vs 云台光轴,
 * 覆盖 heading=0 / 90 / 180 三种航向;并打印云台链的父级挂载路径。
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
await page.waitForTimeout(800)

const chain = await page.evaluate(() => {
  const model = window.__djiDebug.fly.rig.model
  const node = model.getObjectByName('CTRL_Gimbal_Yaw')
  const names = []
  let cur = node
  while (cur) {
    names.push(cur.name || '(root)')
    cur = cur.parent
  }
  return names.join(' ← ')
})
console.log('云台链父级路径:', chain)

const measure = (label) =>
  page.evaluate((tag) => {
    const d = window.__djiDebug
    const THREE = d.THREE
    d.fly.rig.model.updateMatrixWorld(true)
    const pod = d.fly.rig.model.getObjectByName('GIMBAL_BlackCameraPod')
    // 相机与云台光轴都取各自局部 -Z(Three.js 相机前向)在世界系的指向,对比是否一致
    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(d.game.camera.quaternion).toArray().map((n) => Number(n.toFixed(4)))
    const podDir = new THREE.Vector3(0, 0, -1).transformDirection(pod.matrixWorld).toArray().map((n) => Number(n.toFixed(4)))
    return {
      tag,
      heading: Number(d.fly.sim.heading.toFixed(1)),
      camPos: d.game.camera.position.toArray().map((n) => Number(n.toFixed(3))),
      camDir,
      podDir,
    }
  }, label).then((m) => {
    console.log(`[${m.tag}] heading=${m.heading} camPos=${JSON.stringify(m.camPos)} camDir=${JSON.stringify(m.camDir)} podDir=${JSON.stringify(m.podDir)}`)
  })

await page.evaluate(() => window.__djiDebug.fly.setCameraMode('fpv'))
await page.waitForTimeout(600)
await measure('fpv heading=0')

for (const h of [90, 180]) {
  await page.evaluate((deg) => {
    const sim = window.__djiDebug.fly.sim
    // 直接改 sim.heading 扫 0/90/180,验证光轴随航向跟随(不必等 UI 转向动画)
    sim.heading = deg
  }, h)
  await page.waitForTimeout(600)
  await measure(`fpv heading=${h}`)
}

// 切回 orbit 对照,确认相机没被其他逻辑改写
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('orbit'))
await page.waitForTimeout(400)
await measure('orbit 对照')
await browser.close()
