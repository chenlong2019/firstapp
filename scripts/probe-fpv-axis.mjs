/**
 * 对比云台 roll 节点与 pod 节点的世界朝向:各自局部 -z 的世界方向,
 * 以及 pod 相对 roll 的本地旋转(判断 FPV 方向反转的来源)。
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

const out = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const model = d.fly.rig.model
  model.updateMatrixWorld(true)
  const get = (name) => model.getObjectByName(name)
  const axisOf = (obj) =>
    new THREE.Vector3(0, 0, -1).transformDirection(obj.matrixWorld).toArray().map((n) => Number(n.toFixed(4)))
  const roll = get('CTRL_Gimbal_Roll')
  const pod = get('GIMBAL_BlackCameraPod')
  // pod 相对 roll 的本地四元数(取 roll 系)
  const relQ = roll
    .getWorldQuaternion(new THREE.Quaternion())
    .invert()
    .multiply(pod.getWorldQuaternion(new THREE.Quaternion()))
  const e = new THREE.Euler().setFromQuaternion(relQ)
  return {
    rollNegZ: axisOf(roll),
    podNegZ: axisOf(pod),
    podPosZ: new THREE.Vector3(0, 0, 1).transformDirection(pod.matrixWorld).toArray().map((n) => Number(n.toFixed(4))),
    podLocalQuat: pod.quaternion.toArray().map((n) => Number(n.toFixed(4))),
    relEulerDeg: [e.x, e.y, e.z].map((r) => Number(((r * 180) / Math.PI).toFixed(2))),
    bodyHeading: d.fly.sim.heading,
  }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
