/**
 * 一次性标定:同一个 GLB 在"收纳/展开"两态下、去掉整机旋转后的自带包围盒,
 * 用来换算海湾竞速场景里该给的归一化目标尺寸。
 *
 * 背景:归一化是在"出厂收纳态"下量的(和沙盒一致),但无人机在场景里是展开飞行的,
 * 展开后桨叶伸出、外形明显变大,所以要拿两态的比值把目标尺寸换算回去。
 *
 * 用法:先起 dev server,再 `node scripts/probe-race-drone-scale.mjs`
 * 环境变量:URL 覆盖页面地址(默认沙盒页,那里有 __djiDebug)。
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.env.URL ?? 'http://127.0.0.1:15176/dji'

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(URL, { waitUntil: 'domcontentloaded' })

await page.waitForFunction(() => Boolean(window.__djiDebug?.fly?.model), null, { timeout: 120_000 })

/**
 * 量当前模型在"机体系(去掉整机航向/位移)"下的包围盒,单位是场景米。
 * 保留 model.scale —— 归一化的缩放就烘在这一层。
 */
const _unusedMeasure = () =>
  page.evaluate(() => {
    const { fly, THREE } = window.__djiDebug
    const model = fly.model
    const savedQ = model.quaternion.clone()
    const savedP = model.position.clone()
    const savedRotY = model.rotation.y
    model.quaternion.identity()
    model.position.set(0, 0, 0)
    model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(model)
    model.quaternion.copy(savedQ)
    model.position.copy(savedP)
    model.updateMatrixWorld(true)
    const size = box.getSize(new THREE.Vector3())
    return {
      armFold: +fly.rig.armFold.toFixed(4),
      modelRotY: +(savedRotY * 180 / Math.PI).toFixed(2),
      scale: +model.scale.x.toFixed(6),
      size: [+size.x.toFixed(4), +size.y.toFixed(4), +size.z.toFixed(4)],
      largest: +Math.max(size.x, size.y, size.z).toFixed(4),
    }
  })

// armFold:1≈收纳、0≈展开;两态都要等到收敛后再量才有可比性
const waitFold = (wantFolded) =>
  page.waitForFunction(
    (folded) => {
      const fold = window.__djiDebug.fly.rig.armFold
      return folded ? fold > 0.995 : fold < 0.005
    },
    wantFolded,
    { timeout: 120_000 },
  )

/**
 * 在同一个 eval 里把机臂直接写到收纳/展开两态各量一次(中间没有帧插入,
 * DroneFly 的每帧收敛来不及把它拉回去),这样两态可比。
 */
const measureBoth = () =>
  page.evaluate(() => {
    const { fly, THREE } = window.__djiDebug
    const model = fly.model
    const rig = fly.rig
    const saved = { q: model.quaternion.clone(), p: model.position.clone() }
    const box = (fold) => {
      rig.setArmFold(fold)
      model.quaternion.identity()
      model.position.set(0, 0, 0)
      model.updateMatrixWorld(true)
      const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3())
      return [+size.x.toFixed(4), +size.y.toFixed(4), +size.z.toFixed(4)]
    }
    const folded = box(1)
    const open = box(0)
    rig.setArmFold(0)
    model.quaternion.copy(saved.q)
    model.position.copy(saved.p)
    model.updateMatrixWorld(true)
    return { scale: +model.scale.x.toFixed(6), folded, open }
  })

await page.waitForTimeout(1500)
// 打印 {scale, folded, open} 两态尺寸;open/folded 比值即"展开后变大"的换算系数
console.log(JSON.stringify(await measureBoth(), null, 0))
console.log('沙盒归一化目标 DRONE_SIZE_METERS = 2.4(量的是载入那一瞬的包围盒)')

await browser.close()
