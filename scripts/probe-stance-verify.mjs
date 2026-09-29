/** 停放姿态验证:配平角、触地情况、电机轴水平度 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOT_DIR = join(process.cwd(), '.verify-shots')
mkdirSync(SHOT_DIR, { recursive: true })
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:15186/dji', { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.locator('[data-testid="btn-arm"]').click()
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1200)

const r = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const model = d.fly.rig.model
  model.updateMatrixWorld(true)
  const vertex = new THREE.Vector3()
  const report = { stancePitchDeg: null, stanceDrop: null, groundContacts: {}, propAxisDeg: {}, lowestByGroup: {}, cameraNote: '' }

  // rig 私有字段通过试探读不到,这里直接量场景
  let minYAll = Infinity
  let minGear = Infinity
  let minBodyRear = Infinity
  let minProp = Infinity
  model.traverse((o) => {
    if (!o.isMesh) return
    const attr = o.geometry.getAttribute('position')
    for (let i = 0; i < attr.count; i += 1) {
      vertex.fromBufferAttribute(attr, i).applyMatrix4(o.matrixWorld)
      minYAll = Math.min(minYAll, vertex.y)
      if (o.name.startsWith('GEAR_')) minGear = Math.min(minGear, vertex.y)
      if (o.name.startsWith('BODY_') && vertex.z > 0.1) minBodyRear = Math.min(minBodyRear, vertex.y)
      if (o.name.startsWith('PROP_')) minProp = Math.min(minProp, vertex.y)
    }
  })
  report.groundContacts = {
    worldMinAll: Number(minYAll.toFixed(4)),
    frontGearMinY: Number(minGear.toFixed(4)),
    rearBodyMinY: Number(minBodyRear.toFixed(4)),
    propMinY: Number(minProp.toFixed(4)),
  }
  for (const pos of ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']) {
    const spin = model.getObjectByName(`CTRL_Prop_${pos}_Spin`)
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion())).normalize()
    report.propAxisDeg[pos] = Number(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(axis.y)))).toFixed(2))
  }
  const root = model.getObjectByName('CTRL_DJI_Root')
  report.stancePitchDeg = Number(THREE.MathUtils.radToDeg(root.rotation.x).toFixed(2))
  report.stanceDrop = Number((d.fly.rig.model.position.y - (d.fly.sim ? 0 : 0)).toFixed(4))
  return report
})
console.log(JSON.stringify(r, null, 2))

// 侧面全景截图
await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const cam = d.game.camera
  const controls = d.game.controls
  cam.position.set(3.2, 1.6, 3.6)
  cam.fov = 40
  cam.near = 0.02
  cam.updateProjectionMatrix()
  controls.target.set(0, 0.45, 0)
  controls.update()
})
await page.waitForTimeout(1500)
await page.screenshot({ path: join(SHOT_DIR, 'stance-side.png') })
await browser.close()
