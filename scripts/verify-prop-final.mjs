/**
 * 终验:展开机臂 → 上电 → 起飞 → 悬停近景。
 * 验证:1) 无浅白色桨盘 2) 桨叶法线与电机轴夹角 = 出厂桨距 ~15°(对称)
 * 3) 展开态钟罩轴与自转轴同轴
 *
 * 用法:node scripts/verify-prop-final.mjs [url](默认 http://127.0.0.1:15186/dji)
 * 前置:先构建并用 vite preview 起产物服务;断言主要看控制台打印的法线夹角,阈值宽松。
 * 坑:本脚本用 SwiftShader 软件渲染起浏览器(与其它 verify 脚本的 GPU 参数不同)。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
const SHOT_DIR = join(process.cwd(), '.verify-shots')
mkdirSync(SHOT_DIR, { recursive: true })

// 用 ANGLE/SwiftShader 软件渲染跑离屏取景,避开无头环境 GPU 取景异常
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })

const waitSim = async (expr, timeout = 40000) => {
  await page.waitForFunction(expr, undefined, { timeout })
}

// 展开机臂
await page.locator('[data-testid="btn-arm"]').click()
await waitSim('window.__djiDebug.fly.rig.armFold < 0.02', 30000)
await page.waitForTimeout(1500)
console.log('[ok] 机臂已展开')

const expanded = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const model = d.fly.rig.model
  model.updateMatrixWorld(true)
  const fitAxis = (obj) => {
    const attr = obj.geometry.getAttribute('position')
    const pts = []
    // 顶点过多时按 ~800 点抽样,控制 PCA 的取样量与耗时
    const step = Math.max(1, Math.floor(attr.count / 800))
    for (let i = 0; i < attr.count; i += step) {
      pts.push(new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4(obj.matrixWorld))
    }
    const c = new THREE.Vector3()
    pts.forEach((p) => c.add(p))
    c.multiplyScalar(1 / pts.length)
    const m = new Float64Array(9)
    pts.forEach((p) => {
      const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z
      m[0] += x * x; m[1] += x * y; m[2] += x * z
      m[3] += x * y; m[4] += y * y; m[5] += y * z
      m[6] += x * z; m[7] += y * z; m[8] += z * z
    })
    const mul = (v) => {
      const o = new Float64Array(3)
      for (let r = 0; r < 3; r += 1) o[r] = m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]
      return o
    }
    const norm = (v) => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / l, v[1] / l, v[2] / l]
    }
    // 幂迭代求协方差矩阵主特征向量:即桨叶盘面的法线方向(300 次足够收敛)
    let v = [1, 0.3, 0.7]
    for (let i = 0; i < 300; i += 1) v = norm(mul(v))
    const lam1 = v[0] * mul(v)[0] + v[1] * mul(v)[1] + v[2] * mul(v)[2]
    for (let r = 0; r < 3; r += 1) for (let q = 0; q < 3; q += 1) m[r * 3 + q] -= lam1 * v[r] * v[q]
    let w = [0.4, 1, -0.2]
    for (let i = 0; i < 300; i += 1) w = norm(mul(w))
    const lam2 = w[0] * mul(w)[0] + w[1] * mul(w)[1] + w[2] * mul(w)[2]
    const third = [w[1] * v[2] - w[2] * v[1], w[2] * v[0] - w[0] * v[2], w[0] * v[1] - w[1] * v[0]]
    const lam3 = third[0] * mul(third)[0] + third[1] * mul(third)[1] + third[2] * mul(third)[2]
    return new THREE.Vector3(...(lam3 < lam2 ? third : w)).normalize()
  }
  // 取 dot 的绝对值:法线正负视为同向,得到无符号夹角(故断言说"对称")
  const ang = (a, b) => THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(a.dot(b)))))
  const res = { props: [], ringDiscs: 0 }
  for (const pos of ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']) {
    const spin = model.getObjectByName(`CTRL_Prop_${pos}_Spin`)
    const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(spin.getWorldQuaternion(new THREE.Quaternion())).normalize()
    const entry = { pos, blades: [] }
    for (const idx of [1, 2]) {
      const mesh = model.getObjectByName(`PROP_${pos}_Blade_${idx}`)
      const n = fitAxis(mesh)
      if (n.dot(axis) < 0) n.negate()
      entry.blades.push(Number(ang(n, axis).toFixed(2)))
    }
    const bell = model.getObjectByName(`MOTOR_${pos}_RotorBell`)
    if (bell?.isMesh) {
      const bn = fitAxis(bell)
      if (bn.dot(axis) < 0) bn.negate()
      entry.bellVsAxis = Number(ang(bn, axis).toFixed(2))
    }
    spin.traverse((o) => {
      if (o.isMesh && o.geometry?.type === 'RingGeometry') res.ringDiscs += 1
    })
    res.props.push(entry)
  }
  return res
})
console.log(JSON.stringify(expanded, null, 1))

// 上电 → 起飞 → 悬停
await page.locator('[data-testid="btn-power"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'standby'", 90000)
await page.locator('[data-testid="btn-takeoff"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'flying'", 60000)
await page.waitForTimeout(4000)
console.log('[ok] 悬停中')

// 桨盘状态(应在旋转,无 RingGeometry)
const flying = await page.evaluate(() => {
  const d = window.__djiDebug
  const model = d.fly.rig.model
  let ringDiscs = 0
  model.traverse((o) => {
    if (o.isMesh && o.geometry?.type === 'RingGeometry') ringDiscs += 1
  })
  return { ringDiscs, load: d.fly.sim.motorLoad ?? null, y: d.fly.sim.position.y }
})
console.log('[flying]', JSON.stringify(flying))

// 近景截图:侧 3/4 视角看电机
const focus = async (pos, tag) => {
  await page.evaluate((p) => {
    const d = window.__djiDebug
    const THREE = d.THREE
    const node = d.fly.rig.model.getObjectByName(`CTRL_Prop_${p}_Spin`)
    const c = node.getWorldPosition(new THREE.Vector3())
    const cam = d.game.camera
    const controls = d.game.controls
    cam.position.set(c.x + 0.85, c.y + 0.35, c.z + 0.55)
    cam.fov = 40
    cam.near = 0.02
    cam.updateProjectionMatrix()
    controls.target.copy(c)
    controls.update()
  }, pos)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(SHOT_DIR, `hover-${tag}.png`) })
}
await focus('FrontLeft', 'frontleft')
await focus('FrontRight', 'frontright')

await browser.close()
console.log('[done]')
