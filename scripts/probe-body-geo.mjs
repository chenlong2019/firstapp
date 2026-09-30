/**
 * 全量几何清点:机身包围盒、前后电机/机臂/云台各节点的世界坐标、
 * 镜头壳与传感器玻璃位置 —— 判定机头到底在 +z 还是 -z、云台装在哪端。
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
await page.waitForFunction('window.__djiDebug.fly.rig.armFold > 0.999', undefined, { timeout: 30000 })
await page.waitForTimeout(800)

const out = await page.evaluate(() => {
  const d = window.__djiDebug
  const THREE = d.THREE
  const model = d.fly.rig.model
  model.updateMatrixWorld(true)
  const p = (name) => {
    const n = model.getObjectByName(name)
    if (!n) return null
    const v = n.getWorldPosition(new THREE.Vector3())
    return [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))]
  }
  const boxC = (name) => {
    const n = model.getObjectByName(name)
    if (!n) return null
    const v = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3())
    return [Number(v.x.toFixed(3)), Number(v.y.toFixed(3)), Number(v.z.toFixed(3))]
  }
  // 全机网格包围盒(按名字前缀分组)
  const groups = { BODY: null, GEAR: null, ARM: null, PROP: null, GIMBAL: null, SENSOR: null }
  const boxes = {}
  for (const key of Object.keys(groups)) boxes[key] = new THREE.Box3()
  model.traverse((o) => {
    if (!o.isMesh) return
    for (const key of Object.keys(boxes)) {
      if (o.name.startsWith(key)) boxes[key].expandByObject(o)
    }
  })
  const fmt = (b) =>
    b.isEmpty() ? null : {
      min: b.min.toArray().map((n) => Number(n.toFixed(3))),
      max: b.max.toArray().map((n) => Number(n.toFixed(3))),
    }
  return {
    motor_FL: p('CTRL_Prop_FrontLeft_Spin'),
    motor_FR: p('CTRL_Prop_FrontRight_Spin'),
    motor_RL: p('CTRL_Prop_RearLeft_Spin'),
    motor_RR: p('CTRL_Prop_RearRight_Spin'),
    armHinge_FL: p('CTRL_Arm_FrontLeft_Fold'),
    armHinge_RL: p('CTRL_Arm_RearLeft_Fold'),
    gimbalYaw: p('CTRL_Gimbal_Yaw'),
    gimbalRoll: p('CTRL_Gimbal_Roll'),
    podCenter: boxC('GIMBAL_BlackCameraPod'),
    shellCenter: boxC('GIMBAL_BlackCameraShell'),
    lensMesh: p('GIMBAL_BlackCameraLens') ?? boxC('GIMBAL_BlackCameraLens'),
    glassFrontL: boxC('SENSOR_Glass_Front_L'),
    glassFrontR: boxC('SENSOR_Glass_Front_R'),
    housing: boxC('BODY_Fixed_GimbalHousing_Center'),
    groups: Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, fmt(b)])),
  }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
