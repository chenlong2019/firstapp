/**
 * 云台运行时诊断:
 * 1. 停机坪状态:pod 中心/安装座中心相对位置、光轴方向;
 * 2. 云台俯仰打杆:观察 pod 移动轨迹是否绕枢轴、有无异常甩出;
 * 3. 特写截图目视。
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

const measure = (label) =>
  page.evaluate((lab) => {
    const d = window.__djiDebug
    const THREE = d.THREE
    const model = d.fly.rig.model
    model.updateMatrixWorld(true)
    const get = (name) => model.getObjectByName(name)
    const pod = get('GIMBAL_BlackCameraPod')
    const lens = get('SENSOR_Glass_GimbalLens')
    const housing = get('BODY_Fixed_GimbalHousing_Center')
    const shell = get('GIMBAL_BlackCameraShell')
    const yaw = get('CTRL_Gimbal_Yaw')
    const pitch = get('CTRL_Gimbal_Pitch')
    const roll = get('CTRL_Gimbal_Roll')
    const assembly = get('GIMBAL_Assembly')
    const boxOf = (obj) => {
      const b = new THREE.Box3().setFromObject(obj)
      return { min: b.min.toArray().map((n) => Number(n.toFixed(3))), max: b.max.toArray().map((n) => Number(n.toFixed(3))), c: b.getCenter(new THREE.Vector3()).toArray().map((n) => Number(n.toFixed(3))) }
    }
    const axisOf = (obj) => {
      const a = new THREE.Vector3(0, 0, -1).transformDirection(obj.matrixWorld)
      return [a.x, a.y, a.z].map((n) => Number(n.toFixed(3)))
    }
    // 各云台关节的世界位置与局部欧拉
    const info = (obj) => {
      const p = obj.getWorldPosition(new THREE.Vector3())
      return { world: [p.x, p.y, p.z].map((n) => Number(n.toFixed(3))), euler: { x: Number(((obj.rotation.x * 180) / Math.PI).toFixed(2)), y: Number(((obj.rotation.y * 180) / Math.PI).toFixed(2)), z: Number(((obj.rotation.z * 180) / Math.PI).toFixed(2)) } }
    }
    return {
      label: lab,
      bodyEuler: info(get('CTRL_DJI_Root')),
      rigRootEuler: info(get('RIG_DJI_Arms_Props')),
      yaw: info(yaw),
      assembly: info(assembly),
      pitch: info(pitch),
      roll: info(roll),
      podAxis: axisOf(pod),
      lensBounds: boxOf(lens),
      shellBounds: boxOf(shell),
      housingBounds: boxOf(housing),
    }
  }, label)

const zoomShot = async (file) => {
  await page.evaluate(() => {
    const d = window.__djiDebug
    const cam = d.game.camera
    const target = new (d.THREE.Vector3)(0, 0.28, -0.62)
    cam.position.set(0.55, 0.42, -0.05)
    if (d.game.controls) {
      d.game.controls.target.copy(target)
      d.game.controls.update()
    }
    cam.lookAt(target)
  })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: file })
}

console.log(JSON.stringify(await measure('停机(收纳)'), null, 1))

await page.locator('[data-testid="btn-arm"]').click()
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.001', undefined, { timeout: 30000 })
await page.waitForTimeout(800)
console.log(JSON.stringify(await measure('停机(展开)'), null, 1))

await zoomShot('.verify-shots/gimbalfix-parked.png')
console.log('saved gimbalfix-parked.png')

// 云台俯仰打杆:通过 sim 的云台指令接口(UI 同源)
const cmd = await page.evaluate(() => {
  const d = window.__djiDebug
  // 找 sim 的云台俯仰写入入口
  const sim = d.sim ?? d.fly.sim
  const keys = Object.keys(sim)
  return keys.filter((k) => /gimbal|camera|pitch/i.test(k)).map((k) => `${k}=${typeof sim[k] === 'object' ? JSON.stringify(sim[k]) : sim[k]}`)
})
console.log('sim 云台相关字段:', cmd)

await browser.close()
