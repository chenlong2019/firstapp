/**
 * FPV 目视诊断:切机载视角拍实际渲染画面;同时量机身前/后电机、
 * 机头、云台枢轴的世界 z 坐标,确认机头方向与云台是否贴着机鼻。
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
// 等机臂完全展开再量:收纳态下桨叶收起,电机/机头的 z 坐标不具代表性
await page.waitForFunction('window.__djiDebug.fly.rig.armFold > 0.999', undefined, { timeout: 30000 })
await page.waitForTimeout(800)

const geo = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const model = d.fly.rig.model
  model.updateMatrixWorld(true)
  const wz = (name) => {
    const n = model.getObjectByName(name)
    return n ? Number(n.getWorldPosition(new THREE.Vector3()).z.toFixed(3)) : null
  }
  const wx = (name) => {
    const n = model.getObjectByName(name)
    return n ? Number(n.getWorldPosition(new THREE.Vector3()).x.toFixed(3)) : null
  }
  // 机身包围盒按网格名前缀(BODY/GEAR/ARM)聚合;世界系 -Z 为机头(与电机 z 对照)
  const bodyBox = new THREE.Box3()
  model.traverse((o) => {
    if (o.isMesh && /BODY|GEAR|ARM/.test(o.name)) bodyBox.expandByObject(o)
  })
  const min = bodyBox.min.toArray().map((n) => Number(n.toFixed(3)))
  const max = bodyBox.max.toArray().map((n) => Number(n.toFixed(3)))
  return {
    bodyBox: { min, max },
    frontL_z: wz('CTRL_Prop_FrontLeft_Spin'),
    frontR_z: wz('CTRL_Prop_FrontRight_Spin'),
    rearL_z: wz('CTRL_Prop_RearLeft_Spin'),
    rearR_z: wz('CTRL_Prop_RearRight_Spin'),
    gimbalPivot_z: wz('CTRL_Gimbal_Yaw'),
    gimbalPivot_x: wx('CTRL_Gimbal_Yaw'),
  }
})
console.log(JSON.stringify(geo, null, 2))

// 机载视角截图(默认俯仰 -10)
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('fpv'))
await page.waitForTimeout(1500)
await page.screenshot({ path: '.verify-shots/fpv-check.png' })
console.log('saved .verify-shots/fpv-check.png')

// 对照:orbit 视角看整机(确认模型机头朝向)
await page.evaluate(() => {
  const d = window.__djiDebug
  d.fly.setCameraMode('orbit')
  const cam = d.game.camera
  cam.position.set(1.2, 0.8, 1.2)
  if (d.game.controls) {
    d.game.controls.target.set(0, 0.2, 0)
    d.game.controls.update()
  }
  cam.lookAt(0, 0.2, 0)
})
await page.waitForTimeout(1800)
await page.screenshot({ path: '.verify-shots/fpv-orbit-ref.png' })
console.log('saved .verify-shots/fpv-orbit-ref.png')
await browser.close()
