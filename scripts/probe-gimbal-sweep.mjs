/**
 * 云台全行程扫描:俯仰 −90..+60 / 偏航 ±5 / 横滚 ±30,
 * 量壳心相对枢轴/安装座的位置变化(甩弧幅度),并拍侧视特写。
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

const measure = () =>
  page.evaluate(() => {
    const d = window.__djiDebug
    const THREE = d.THREE
    const model = d.fly.rig.model
    model.updateMatrixWorld(true)
    const get = (name) => model.getObjectByName(name)
    const boxC = (obj) => new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3())
    const pivot = get('CTRL_Gimbal_Yaw').getWorldPosition(new THREE.Vector3())
    const shell = boxC(get('GIMBAL_BlackCameraShell'))
    const housing = boxC(get('BODY_Fixed_GimbalHousing_Center'))
    const axis = new THREE.Vector3(0, 0, -1).transformDirection(get('GIMBAL_BlackCameraPod').matrixWorld)
    const rel = shell.clone().sub(pivot)
    return {
      gimbalPitch: d.fly.sim.gimbalPitch,
      pivot: pivot.toArray().map((n) => Number(n.toFixed(3))),
      shellC: shell.toArray().map((n) => Number(n.toFixed(3))),
      pivotToShell: rel.toArray().map((n) => Number(n.toFixed(3))),
      dist: Number(rel.length().toFixed(4)),
      shellToHousing: shell.clone().sub(housing).toArray().map((n) => Number(n.toFixed(3))),
      axis: axis.toArray().map((n) => Number(n.toFixed(3))),
    }
  })

const setCmd = (pitch, roll = 0, yaw = 0) =>
  page.evaluate(([p, r, y]) => {
    window.__djiDebug.fly.sim.gimbalPitch = p
    window.__djiDebug.fly.sim.gimbalRoll = r
    window.__djiDebug.fly.sim.gimbalYaw = y
  }, [pitch, roll, yaw])

console.log('— 俯仰扫描(停机展开)—')
for (const p of [0, -20, -45, -90, 30]) {
  await setCmd(p)
  await page.waitForTimeout(500)
  const m = await measure()
  console.log(`pitch=${p}: pivotToShell=${JSON.stringify(m.pivotToShell)} dist=${m.dist} axis=${JSON.stringify(m.axis)} shellHousing差=${JSON.stringify(m.shellToHousing)}`)
}

// 侧视特写
const shot = async (file, pitch) => {
  await setCmd(pitch)
  await page.waitForTimeout(600)
  await page.evaluate(() => {
    const d = window.__djiDebug
    const cam = d.game.camera
    const target = new (d.THREE.Vector3)(0, 0.3, -0.5)
    cam.position.set(0.02, 0.42, 0.25)
    if (d.game.controls) {
      d.game.controls.target.copy(target)
      d.game.controls.update()
    }
    cam.lookAt(target)
  })
  await page.waitForTimeout(1800)
  await page.screenshot({ path: file })
  console.log('saved', file)
}
await shot('.verify-shots/gimbal-pitch-0.png', 0)
await shot('.verify-shots/gimbal-pitch-neg90.png', -90)
await shot('.verify-shots/gimbal-pitch-pos30.png', 30)
await browser.close()
