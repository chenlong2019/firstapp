/**
 * 诊断折叠旋转的实际轴角:
 * 读 rig.arms 内部状态(bindQuaternion/foldAngle),在页内手动施加
 * applyArmFold 等价计算,导出 W = Q_applied ⊗ Q_bind^-1 的轴与角,
 * 并与"绕竖轴转 foldAngle"的预期对比;同时打印骨节父链的世界四元数。
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
await page.waitForTimeout(500)

const report = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const rig = d.fly.rig
  const model = rig.model
  model.updateMatrixWorld(true)
  const arms = rig.arms // 运行时私有字段,诊断用
  const out = []
  for (const arm of arms) {
    const node = arm.node
    // 父链世界四元数
    const chain = []
    let cur = node.parent
    while (cur && cur !== model) {
      const q = cur.getWorldQuaternion(new THREE.Quaternion())
      chain.push({ name: cur.name || cur.type, q: [q.x, q.y, q.z, q.w].map((n) => Number(n.toFixed(4))) })
      cur = cur.parent
    }
    const bindQ = arm.bindQuaternion
    const nowQ = node.quaternion
    // W = nowQ ⊗ bindQ^-1(节点局部空间的增量)
    const inv = bindQ.clone().invert()
    const W = nowQ.clone().multiply(inv)
    // 从增量四元数 W 反解轴角:angle=2·acos|w|,轴=(x,y,z)/sin(angle/2)
    const angle = 2 * Math.acos(Math.min(1, Math.abs(W.w)))
    const s = Math.sin(angle / 2) * Math.sign(W.w || 1)
    const axis = new THREE.Vector3(W.x / (s || 1), W.y / (s || 1), W.z / (s || 1))
    // 预期:绕父系 +Y 转 foldAngle → 局部增量就是 Q(Y, foldAngle)
    const expect = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), arm.foldAngle)
    // 世界增量:parentQ ⊗ W ⊗ parentQ^-1
    const parentQ = node.parent.getWorldQuaternion(new THREE.Quaternion())
    // 共轭变换 parentQ·W·parentQ^-1:把节点局部增量搬到世界系再比较
    const Ww = parentQ.clone().multiply(W).multiply(parentQ.clone().invert())
    const aw = 2 * Math.acos(Math.min(1, Math.abs(Ww.w)))
    const sw = Math.sin(aw / 2) * Math.sign(Ww.w || 1)
    const axisW = new THREE.Vector3(Ww.x / (sw || 1), Ww.y / (sw || 1), Ww.z / (sw || 1))
    out.push({
      position: arm.position,
      foldAngleDeg: Number(((arm.foldAngle * 180) / Math.PI).toFixed(2)),
      bindQ: [bindQ.x, bindQ.y, bindQ.z, bindQ.w].map((n) => Number(n.toFixed(4))),
      nowQ: [nowQ.x, nowQ.y, nowQ.z, nowQ.w].map((n) => Number(n.toFixed(4))),
      localW: { angleDeg: Number(((angle * 180) / Math.PI).toFixed(2)), axis: [axis.x, axis.y, axis.z].map((n) => Number(n.toFixed(3))) },
      expectLocal: [expect.x, expect.y, expect.z, expect.w].map((n) => Number(n.toFixed(4))),
      worldW: { angleDeg: Number(((aw * 180) / Math.PI).toFixed(2)), axis: [axisW.x, axisW.y, axisW.z].map((n) => Number(n.toFixed(3))) },
      parentChain: chain,
    })
  }
  return out
})

for (const arm of report) {
  console.log(`\n=== ${arm.position} ===`)
  console.log(`foldAngle=${arm.foldAngleDeg}°`)
  console.log(`bindQ=${JSON.stringify(arm.bindQ)}`)
  console.log(`nowQ =${JSON.stringify(arm.nowQ)}`)
  console.log(`局部增量 W: ${arm.localW.angleDeg}° 轴=${JSON.stringify(arm.localW.axis)}  预期 Q(Y,θ)=${JSON.stringify(arm.expectLocal)}`)
  console.log(`世界增量:   ${arm.worldW.angleDeg}° 轴=${JSON.stringify(arm.worldW.axis)}`)
  console.log(`父链: ${arm.parentChain.map((c) => `${c.name} q=${JSON.stringify(c.q)}`).join(' <- ')}`)
}
await browser.close()
