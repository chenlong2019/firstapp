/**
 * 机载(FPV)视角专项回归:
 *  核心断言 = 非观察者模式下渲染循环不得调用 OrbitControls.update()
 *  ——它每帧强制 lookAt(target),会把"从云台往外看"变成"停在云台位置回头看飞机"
 *  (渲染发生在 droneFly.animate 写云台位姿之前,所以画面会一直是回头的)。
 * 同时校验:机载相机世界朝向 == 云台光轴、位置 == 云台 + 沿光轴 0.12m。
 *
 * 用法:node scripts/verify-fpv-camera.mjs [url](默认 http://127.0.0.1:15186/dji)
 * 前置:先构建并用 vite preview 起产物服务。
 * 手法:给 controls.update 打桩计数,对比两种相机模式下每帧被调用的次数。
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`PASS │ ${name}${detail ? ' │ ' + detail : ''}`)
  } else {
    fail += 1
    console.log(`FAIL │ ${name}${detail ? ' │ ' + detail : ''}`)
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
// 展开机臂(armFold→0 为展开)
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(600)

// 埋点:统计 controls.update 调用次数
await page.evaluate(() => {
  const controls = window.__djiDebug.game.controls
  window.__ctrlCount = 0
  const original = controls.update.bind(controls)
  controls.update = (...args) => {
    window.__ctrlCount += 1
    return original(...args)
  }
})

const countFor = async (ms) => {
  await page.evaluate(() => {
    window.__ctrlCount = 0
  })
  await page.waitForTimeout(ms)
  return page.evaluate(() => window.__ctrlCount)
}

// ① 观察者模式:控制器应被驱动
const orbitCount = await countFor(1200)
check('观察者模式下轨道控制器每帧驱动', orbitCount > 0, `1.2s 内 ${orbitCount} 次`)

// ② 切机载:控制器必须停摆
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('fpv'))
// 切模式后等一拍,让渲染循环在新相机模式下跑起来再计数
await page.waitForTimeout(600)
const fpvCount = await countFor(1200)
check('机载视角下轨道控制器停止驱动(修复点)', fpvCount === 0, `1.2s 内 ${fpvCount} 次`)

// ③ 机载相机位姿 = 云台光轴
const pose = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const model = d.fly.rig.model
  model.updateMatrixWorld(true)
  const pod = model.getObjectByName('GIMBAL_BlackCameraPod')
  const cam = d.game.camera
  cam.updateWorldMatrix(true, false)
  const podPos = pod.getWorldPosition(new THREE.Vector3())
  const podDir = new THREE.Vector3(0, 0, -1).transformDirection(pod.matrixWorld)
  const camPos = cam.getWorldPosition(new THREE.Vector3())
  const camDir = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()))
    .normalize()
  // 机载相机挂在云台镜片沿光轴前方 0.12m 处(常量,断言按此计算期望位置)
  const expectPos = podPos.clone().addScaledVector(podDir, 0.12)
  return {
    dirDot: Number(camDir.dot(podDir).toFixed(4)),
    posErr: Number(camPos.distanceTo(expectPos).toFixed(4)),
    camDir: camDir.toArray().map((n) => Number(n.toFixed(3))),
    podDir: podDir.toArray().map((n) => Number(n.toFixed(3))),
  }
})
// 容差:方向点积 >0.999 视为同向(排除反向),位置偏差 <1cm 视为重合
check('机载相机朝向 == 云台光轴(同一方向,非反向)', pose.dirDot > 0.999, `dot=${pose.dirDot}`)
check('机载相机位于云台镜片前方 0.12m', pose.posErr < 0.01, `偏差 ${pose.posErr}m`)
check('机载视角朝机头方向(−z)', pose.camDir[2] < -0.9, `dir=${JSON.stringify(pose.camDir)}`)

// ④ 切回观察者:控制器恢复驱动
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('orbit'))
await page.waitForTimeout(400)
const backCount = await countFor(1200)
check('切回观察者后轨道控制器恢复', backCount > 0, `1.2s 内 ${backCount} 次`)

// ⑤ 机载视角渲染画面不得出现本机(与观察者视角画面差异显著)
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('fpv'))
await page.waitForTimeout(1500)
const fpvShot = await page.locator('canvas').screenshot()
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('orbit'))
await page.waitForTimeout(1500)
const orbitShot = await page.locator('canvas').screenshot()
const diff = Buffer.compare(fpvShot, orbitShot) !== 0
check('机载与观察者画面不同(相机未被强制回头)', diff, `fpv=${fpvShot.length}B orbit=${orbitShot.length}B`)

console.log(`\n════════ 结果:${pass}/${pass + fail} 通过 ════════`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
