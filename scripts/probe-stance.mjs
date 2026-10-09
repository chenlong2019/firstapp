/**
 * 停放姿态量测(展开态):找出与地面接触的三个点(前左脚撑/前右脚撑/机尾底部),
 * 算出让它们同时落地的俯仰角;再看四个电机轴在该姿态下离铅垂线还有多少度。
 */
import { chromium } from 'playwright'

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
// 必须先展开机臂:落地脚撑只在展开态到位,收纳态量到的接触点位置会漂
await page.locator('[data-testid="btn-arm"]').click()
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1200)

const report = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const model = d.fly.rig.model
  model.updateMatrixWorld(true)

  // 取网格全部顶点经世界矩阵变换后的最低点,y 越小越贴地;单位场景米
  const lowestVertex = (obj) => {
    if (!obj?.isMesh) return null
    const attr = obj.geometry.getAttribute('position')
    const p = new THREE.Vector3()
    let best = null
    for (let i = 0; i < attr.count; i += 1) {
      p.fromBufferAttribute(attr, i).applyMatrix4(obj.matrixWorld)
      if (!best || p.y < best.y) best = p.clone()
    }
    return best
  }

  const out = { contacts: {}, spinAxes: {}, modelY: model.position.y }

  out.contacts.frontLeftLeg = lowestVertex(model.getObjectByName('GEAR_FrontLeft_LandingLeg'))?.toArray().map((n) => Number(n.toFixed(4)))
  out.contacts.frontRightLeg = lowestVertex(model.getObjectByName('GEAR_FrontRight_LandingLeg'))?.toArray().map((n) => Number(n.toFixed(4)))

  // 机尾底部:取机身主体网格在 z > 0.25(机尾)区域的顶点最低点
  const body = model.getObjectByName('BODY_Main_Fuselage')
  if (body?.isMesh) {
    const attr = body.geometry.getAttribute('position')
    const p = new THREE.Vector3()
    let tailLow = null
    let tailMaxZ = -Infinity
    for (let i = 0; i < attr.count; i += 1) {
      p.fromBufferAttribute(attr, i).applyMatrix4(body.matrixWorld)
      tailMaxZ = Math.max(tailMaxZ, p.z)
    }
    for (let i = 0; i < attr.count; i += 1) {
      p.fromBufferAttribute(attr, i).applyMatrix4(body.matrixWorld)
      if (p.z > tailMaxZ - 0.18) {
        if (!tailLow || p.y < tailLow.y) tailLow = p.clone()
      }
    }
    out.contacts.tailBottom = tailLow?.toArray().map((n) => Number(n.toFixed(4)))
    out.tailMaxZ = Number(tailMaxZ.toFixed(4))
  }

  for (const pos of ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']) {
    const spin = model.getObjectByName(`CTRL_Prop_${pos}_Spin`)
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion())).normalize()
    const center = spin.getWorldPosition(new THREE.Vector3())
    out.spinAxes[pos] = {
      axis: axis.toArray().map((n) => Number(n.toFixed(4))),
      degFromVertical: Number(THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(axis.y)))).toFixed(2)),
      degFromVerticalSignedX: Number(THREE.MathUtils.radToDeg(Math.asin(axis.x)).toFixed(2)),
      degFromVerticalSignedZ: Number(THREE.MathUtils.radToDeg(Math.asin(axis.z)).toFixed(2)),
      center: center.toArray().map((n) => Number(n.toFixed(4))),
    }
  }
  // 机身主体包围盒(粗略姿态参考)
  const box = new THREE.Box3().setFromObject(model)
  out.modelBounds = { min: box.min.toArray().map((n) => Number(n.toFixed(4))), max: box.max.toArray().map((n) => Number(n.toFixed(4))) }
  return out
})

console.log(JSON.stringify(report, null, 2))

// 顺带跑一遍"机身俯仰 vs 电机轴"的几何推算
const c = report.contacts
if (c.frontLeftLeg && c.tailBottom) {
  const dz = c.tailBottom[2] - c.frontLeftLeg[2]
  const dy = c.tailBottom[1] - c.frontLeftLeg[1]
  const stanceDeg = (Math.atan2(dy, dz) * 180) / Math.PI
  console.log(`\n前脚撑 Y=${c.frontLeftLeg[1].toFixed(4)}  Z=${c.frontLeftLeg[2].toFixed(4)}`)
  console.log(`机尾底 Y=${c.tailBottom[1].toFixed(4)}  Z=${c.tailBottom[2].toFixed(4)}`)
  console.log(`前后接触点高差 ${(dy * 1000).toFixed(1)} mm,使三点同时落地需抬头 ${stanceDeg.toFixed(2)}°(机头 -Z)`)
}
await browser.close()
