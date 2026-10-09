/**
 * 探针:/glb 相机缩放范围是否随模型尺度自适应。
 *
 * 背景:OrbitControls 的 minDistance/maxDistance 默认写死 2.2 / 160(按"米级"场景调的),
 * fitCameraToBox 只按模型半径算取景距离却不同步这两个上限 → 大尺度模型(FBX 常以厘米为单位)
 * 会被夹到 maxDistance 上,表现为"加载完就几乎不能缩放"。
 *
 * 用法: node scripts/probe-camera-zoom.mjs [模型绝对路径] [url]
 * 默认模型 D:/project/animoin/Defeat.fbx,默认 url http://127.0.0.1:15176/glb
 */
import { chromium } from 'playwright'
import { basename, join } from 'node:path'
import { mkdirSync } from 'node:fs'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const MODEL = process.argv[2] ?? 'D:/project/animoin/Defeat.fbx'
const URL = process.argv[3] ?? 'http://127.0.0.1:15176/glb'
const FILE_NAME = basename(MODEL)
// 仅当 SHOTS=1 才落盘截图(默认不产生文件)
const SHOTS = process.env.SHOTS === '1'
const DIR = join(process.cwd(), '.verify-shots')
if (SHOTS) mkdirSync(DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE ' + m.text())
})

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__glbDebug?.viewer), null, { timeout: 90_000 })

console.log(`载入 ${FILE_NAME} …`)
await page.setInputFiles('input.file-input', MODEL)
await page.waitForFunction(
  (name) => window.__glbDebug?.viewer?.getStats()?.fileName === name,
  FILE_NAME,
  { timeout: 180_000 },
)
await page.waitForTimeout(1500)

const measure = await page.evaluate(() => {
  const v = window.__glbDebug.viewer
  const THREE = window.__glbDebug.THREE
  v.model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(v.model)
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  const size = box.getSize(new THREE.Vector3())
  const halfFov = THREE.MathUtils.degToRad(v.camera.fov * 0.5)
  const idealDistance = (Math.max(sphere.radius, 0.0005) * 1.6) / Math.sin(halfFov)
  return {
    radius: sphere.radius,
    size: size.toArray(),
    idealDistance,
    cameraDistance: v.camera.position.distanceTo(v.controls.target),
    min: v.controls.minDistance,
    max: v.controls.maxDistance,
    near: v.camera.near,
    far: v.camera.far,
    bones: v.getStats()?.bones ?? 0,
    clips: v.getAnimationState().names.length,
  }
})

const fmt = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n))
console.log('\n──── 载入后 ────')
console.log('  包围盒尺寸      :', measure.size.map(fmt).join(' × '))
console.log('  包围球半径      :', fmt(measure.radius))
console.log('  取景理想距离    :', fmt(measure.idealDistance))
console.log('  相机实际距离    :', fmt(measure.cameraDistance))
console.log('  controls 范围   : [', fmt(measure.min), ',', fmt(measure.max), ']')
console.log('  near / far      :', fmt(measure.near), '/', fmt(measure.far))
console.log('  骨节 / 动画     :', measure.bones, '/', measure.clips)

const clamped = measure.idealDistance > measure.max + 1e-6
console.log(
  `\n  判断:取景距离 ${fmt(measure.idealDistance)} ${clamped ? '>' : '≤'} maxDistance ${fmt(measure.max)}` +
    ` → 相机${clamped ? '被夹进模型内部(缩放几乎失效)' : '在合理范围'}`,
)

// 真实滚轮验证:先猛拉远,再猛拉近,看距离能不能动
const canvas = page.locator('canvas').first()
await canvas.hover()
const wheel = async (deltaY, times) => {
  for (let i = 0; i < times; i += 1) {
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(500)
  return page.evaluate(() => {
    const v = window.__glbDebug.viewer
    return v.camera.position.distanceTo(v.controls.target)
  })
}
const before = measure.cameraDistance
const afterOut = await wheel(240, 12)
const afterIn = await wheel(-240, 12)
console.log('\n──── 滚轮实测 ────')
console.log('  拉远 12 次:', fmt(before), '→', fmt(afterOut), `(Δ=${fmt(afterOut - before)})`)
console.log('  拉近 12 次:', fmt(afterOut), '→', fmt(afterIn), `(Δ=${fmt(afterIn - afterOut)})`)

console.log('\n  控制台错误:', errors.length ? errors.slice(0, 5) : '无')
if (SHOTS) {
  await page.screenshot({ path: join(DIR, 'zoom-loaded.png') })
  await wheel(240, 12)
  await page.screenshot({ path: join(DIR, 'zoom-out-max.png') })
  await wheel(-240, 24)
  await page.screenshot({ path: join(DIR, 'zoom-in-close.png') })
  console.log('SHOT  zoom-loaded.png / zoom-out-max.png / zoom-in-close.png')
}
await browser.close()
