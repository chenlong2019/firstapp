/**
 * 折叠/展开几何验证(机体系,修正版):
 * 把"铰链→桨心"向量用 CTRL_DJI_Root 世界四元数逆变换回机体系,
 * 折叠前后应满足:r_body_folded = Ry(foldAngle) · r_body_open(竖轴折叠),
 * 且模长不变。同时检查展开态电机轴前倾与出厂值一致。
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
// 先量收纳态:等机臂收敛(armFold→1)后再取,否则铰链/桨心位置还在动
await page.waitForFunction('window.__djiDebug.fly.rig.armFold > 0.999', undefined, { timeout: 30000 })
await page.waitForTimeout(500)

const grab = () =>
  page.evaluate(() => {
    const d = window.__djiDebug
    const THREE = d.THREE
    const model = d.fly.rig.model
    model.updateMatrixWorld(true)
    const bodyInv = model.getObjectByName('CTRL_DJI_Root').getWorldQuaternion(new THREE.Quaternion()).invert()
    const out = { fold: d.fly.rig.armFold, bodyQ: null, arms: {} }
    for (const pos of ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']) {
      const hinge = model.getObjectByName(`ARM_${pos}_Fold_Bone`) ?? model.getObjectByName(`CTRL_Arm_${pos}_Fold`)
      const spin = model.getObjectByName(`CTRL_Prop_${pos}_Spin`)
      const h = hinge.getWorldPosition(new THREE.Vector3())
      const p = spin.getWorldPosition(new THREE.Vector3())
      const rel = p.sub(h).applyQuaternion(bodyInv) // 铰链→桨心,机体系
      const axisWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion()))
      const axisBody = axisWorld.clone().applyQuaternion(bodyInv) // 机体系(出厂烘焙值)
      out.arms[pos] = {
        rel: [rel.x, rel.y, rel.z].map((n) => Number(n.toFixed(4))),
        axisWorld: [axisWorld.x, axisWorld.y, axisWorld.z].map((n) => Number(n.toFixed(4))),
        axis: [axisBody.x, axisBody.y, axisBody.z].map((n) => Number(n.toFixed(4))),
      }
    }
    return out
  })

const folded = await grab()
await page.locator('[data-testid="btn-arm"]').click()
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.001', undefined, { timeout: 30000 })
await page.waitForTimeout(800)
const opened = await grab()

const foldAngles = await page.evaluate(() =>
  window.__djiDebug.fly.rig.arms.map((a) => ({ position: a.position, deg: (a.foldAngle * 180) / Math.PI })),
)
console.log('foldAngles:', JSON.stringify(foldAngles))
console.log('folded:', JSON.stringify(folded))
console.log('opened:', JSON.stringify(opened))

let fail = 0
const assert = (name, ok, detail = '') => {
  if (!ok) fail += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} │ ${name}${detail ? ` │ ${detail}` : ''}`)
}
// 容差按量级给:方向分量 0.02、长度 4mm、位置 5mm(见下方各断言)
const close = (a, b, tol) => Math.abs(a - b) <= tol

for (const pos of ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']) {
  const o = opened.arms[pos]
  const f = folded.arms[pos]
  const fa = ((foldAngles.find((x) => x.position === pos)?.deg ?? 0) * Math.PI) / 180
  // 预期折叠向量:Ry(foldAngle) · r_open(绕机体竖轴)
  const c = Math.cos(fa)
  const s = Math.sin(fa)
  const expect = [o.rel[0] * c + o.rel[2] * s, o.rel[1], -o.rel[0] * s + o.rel[2] * c]
  const err = Math.max(...expect.map((v, i) => Math.abs(v - f.rel[i])))
  assert(`${pos} 折叠=竖轴旋转 ${((fa * 180) / Math.PI).toFixed(1)}°(机体系)`, err < 0.005, `maxErr=${(err * 1000).toFixed(1)}mm`)
  // 模长不变
  const lenO = Math.hypot(...o.rel)
  const lenF = Math.hypot(...f.rel)
  assert(`${pos} 铰链→桨心距离不变`, close(lenO, lenF, 0.004), `open=${lenO.toFixed(3)} folded=${lenF.toFixed(3)}`)
  // 展开态电机轴:机体系应≈出厂烘焙值(z≈−0.243,前倾14°),世界系被配平转到近竖直
  assert(`${pos} 展开态电机轴=出厂烘焙值`, Math.abs(o.axis[2] + 0.243) < 0.02, `body=${JSON.stringify(o.axis)}`)
  // 停放配平抵消前向分量(后电机保留出厂外倾 ±12°,不属配平职责)
  assert(`${pos} 停放配平使桨盘近水平`, Math.abs(o.axisWorld[2]) < 0.02 && o.axisWorld[1] > 0.97, `world=${JSON.stringify(o.axisWorld)}`)
}

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
