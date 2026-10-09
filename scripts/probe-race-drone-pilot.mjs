/**
 * 诊断探针:接管无人机后,键盘到底有没有驱动到飞控?
 *
 * 与 verify 脚本的区别:这里全部用**真实鼠标 / 真实按键**,并且每一步都打印
 * 飞控侧的摇杆量(`stick`)、被按住的键(`keys`)和相机焦点,把"看起来没反应"
 * 拆成可判定的问题:
 *   · 接管没成功(按钮禁用 / 飞控没进 flying)
 *   · 按键没进 drone-control 的 pressed 集合(keys 为空)
 *   · 摇杆进了但飞控不响应(stick 有值而高度/速度不变)
 *   · 都在动,只是镜头没切过去,人眼以为是"没反应"
 *
 * 用法:node scripts/probe-race-drone-pilot.mjs [baseUrl]
 */
import { chromium } from 'playwright'

const BASE = process.argv[2] ?? 'http://127.0.0.1:15176'

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.on('pageerror', (error) => console.log('PAGEERROR │', String(error).split('\n')[0]))
page.on('console', (message) => {
  if (message.type() === 'error') console.log('CONSOLE-ERR │', message.text().slice(0, 200))
})

await page.goto(`${BASE}/race`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__RACE__?.ready?.()), null, { timeout: 180_000 })
console.log('车辆就绪,等无人机模型…')
await page.waitForFunction(() => window.__RACE__.drone().status === 'ready', null, { timeout: 240_000 })
console.log('无人机模型就绪')

// 采样全部走引擎/调试 API:约 2FPS,渲染帧和 rAF 时序都不可靠;长度单位=场景米,角度=度
const snap = () =>
  page.evaluate(() => {
    const api = window.__RACE__
    const flight = api.droneFlight()
    const drone = api.drone()
    const cam = api.cameraPose()
    return {
      status: drone.status,
      piloting: drone.piloting,
      armFold: +drone.armFold.toFixed(4),
      focus: api.cameraFocus(),
      pos: drone.position,
      camPos: cam.position.map((v) => +v.toFixed(2)),
      phase: flight?.phase ?? null,
      altitude: flight ? +flight.altitude.toFixed(3) : null,
      hSpeed: flight ? +flight.horizontalSpeed.toFixed(3) : null,
      heading: flight ? +flight.heading.toFixed(1) : null,
      tiltPitch: flight ? +flight.tiltPitch.toFixed(2) : null,
      stick: flight?.stick ?? null,
      keys: flight?.keys ?? null,
      gimbal: flight ? +flight.gimbalPitch.toFixed(1) : null,
      carDistance: +(api.state().distance ?? 0).toFixed(3),
      warn: flight?.warning || drone.error || '',
    }
  })

console.log('\n[0] 接管前(跟随态)')
console.log(JSON.stringify(await snap()))

// 面板里的接管按钮在"模型载入完成"之前是禁用的 —— 先确认真能点
await page.evaluate(() => document.querySelector('#race-settings').click())
await page.waitForTimeout(600)
const buttonState = await page.evaluate(() => {
  const button = document.querySelector('#race-drone-pilot')
  return { disabled: button.disabled, text: button.textContent.trim(), hidden: button.closest('#race-panel').hidden }
})
console.log('\n[1] 接管按钮:', JSON.stringify(buttonState))

const box = await page.locator('#race-drone-pilot').boundingBox()
if (!box) throw new Error('接管按钮没有可见区域')
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
await page.waitForTimeout(3000)
console.log('\n[2] 真实鼠标点击「接管操控」之后')
console.log(JSON.stringify(await snap()))

// —— 逐键测摇杆:按住时打印飞控侧的杆量 ——
// 按住时长≈5 帧:判据只能取飞控 keys/stick 与位姿差值,别等画面
const hold = async (code, ms = 2500) => {
  const before = await snap()
  await page.keyboard.down(code)
  await page.waitForTimeout(ms)
  const during = await snap()
  await page.keyboard.up(code)
  await page.waitForTimeout(700)
  const afterMs = await snap()
  const fmt = (value, size = 7) => String(value).padStart(size)
  console.log(
    `${code.padEnd(7)} keys=${JSON.stringify(during.keys)} stick=${JSON.stringify(during.stick)}` +
      ` Δalt=${fmt(during.altitude === null ? null : +(during.altitude - before.altitude).toFixed(3), 8)}` +
      ` ΔhSpeed=${fmt(during.hSpeed === null ? null : +(during.hSpeed - before.hSpeed).toFixed(3))}` +
      ` Δhdg=${fmt(during.heading === null ? null : +(((during.heading - before.heading + 540) % 360) - 180).toFixed(1))}` +
      ` Δpos=${JSON.stringify(before.pos.map((v, i) => +(during.pos[i] - v).toFixed(3)))}` +
      ` 之后Δpos=${JSON.stringify(afterMs.pos.map((v, i) => +(afterMs.pos[i] - before.pos[i]).toFixed(3)))}`,
  )
  return { before, during, after: afterMs }
}

console.log('\n[3] 摇杆逐键(每键按住 2.5s)')
for (const code of ['KeyZ', 'KeyX', 'KeyI', 'KeyK', 'KeyJ', 'KeyL', 'KeyQ', 'KeyE']) await hold(code)

console.log('\n[4] 驾驶键(W)在接管期间借给无人机 —— 该看到飞机前飞,不是汽车加速')
await hold('KeyW', 2000)

console.log('\n[5] 机载视角')
console.log('M 键之前 focus =', (await snap()).focus)
await page.keyboard.press('KeyM')
await page.waitForTimeout(1500)
const fpv = await snap()
console.log('M 键之后 focus =', fpv.focus, ' 机位=', JSON.stringify(fpv.camPos), ' 飞机=', JSON.stringify(fpv.pos))
await page.keyboard.press('KeyM')
await page.waitForTimeout(1200)
console.log('再按 M → focus =', (await snap()).focus)

console.log('\n[6] 云台俯仰(T / F)')
console.log('起手云台 =', (await snap()).gimbal)
await page.keyboard.press('KeyT')
await page.waitForTimeout(1200)
console.log('按 T 之后 =', (await snap()).gimbal)
await page.keyboard.press('KeyF')
await page.keyboard.press('KeyF')
await page.waitForTimeout(1200)
console.log('按两次 F 之后 =', (await snap()).gimbal)

console.log('\n[7] 用调试出口直接切机载视角')
const viaApi = await page.evaluate(() => {
  const before = window.__RACE__.cameraPose().position
  const focus = window.__RACE__.setCameraFocus('fpv')
  const after = window.__RACE__.cameraPose().position
  return { focus, before: before.map((v) => +v.toFixed(2)), after: after.map((v) => +v.toFixed(2)) }
})
console.log(JSON.stringify(viaApi))
await page.waitForTimeout(1500)
console.log('切完之后:', JSON.stringify(await snap()))

await browser.close()
