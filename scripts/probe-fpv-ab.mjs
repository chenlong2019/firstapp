/**
 * FPV 决定性对照:世界系相机位姿 + 父级链 + 手动翻转 180° 的 A/B 截图。
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.waitForFunction('window.__djiDebug.fly.rig.armFold > 0.999', undefined, { timeout: 30000 })
await page.waitForTimeout(800)

const dump = (tag) =>
  page.evaluate((t) => {
    const d = window.__djiDebug
    const THREE = d.THREE
    const cam = d.game.camera
    cam.updateWorldMatrix(true, false)
    const wp = cam.getWorldPosition(new THREE.Vector3()).toArray().map((n) => Number(n.toFixed(3)))
    const wq = cam.getWorldQuaternion(new THREE.Quaternion())
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(wq).toArray().map((n) => Number(n.toFixed(3)))
    // 同时记局部位姿与父级链:机载相机多挂在机体节点下,须区分局部/世界坐标
    const lp = cam.position.toArray().map((n) => Number(n.toFixed(3)))
    // 记录相机父级链:判断 FPV 是否挂在机体节点下(区分局部/世界朝向)
    const parents = []
    let cur = cam.parent
    while (cur) {
      parents.push(cur.name || cur.type)
      cur = cur.parent
    }
    return { tag: t, localPos: lp, worldPos: wp, worldFwd: fwd, parents, fov: cam.fov, zoom: cam.zoom ?? 1 }
  }, tag).then((m) => console.log(JSON.stringify(m)))

await page.evaluate(() => window.__djiDebug.fly.setCameraMode('fpv'))
await page.waitForTimeout(1200)
await dump('A-原样')
await page.screenshot({ path: '.verify-shots/fpv-A.png' })
console.log('saved fpv-A.png')

// 翻转 180°(绕相机局部 Y)
await page.evaluate(() => {
  const cam = window.__djiDebug.game.camera
  cam.rotateY(Math.PI)
})
await page.waitForTimeout(1200)
await dump('B-手动翻转180(rotateY后立即读,下一帧可能被updateCamera改回)')
await page.screenshot({ path: '.verify-shots/fpv-B.png' })
console.log('saved fpv-B.png')
await browser.close()
