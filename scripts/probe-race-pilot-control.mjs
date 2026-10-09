/**
 * 诊断:接管无人机之后,键盘/按钮到底把操控给了谁?
 *
 * 现象反馈:「机载视角有了,但接管操控按钮控制的还是汽车」——需要把这句话拆成
 * 可判定的问题:
 *   · 点「接管操控」按钮后,drone.piloting 是否真的变 true;
 *   · 按飞行键(I/K/J/L/Z/X/Q/E)时,飞机的位置/高度/机头是否真的在变;
 *   · 按驾驶键(W/A/S/D/方向键)时,飞机是否被"顺带"控制(不该);
 *   · 镜头焦点(focus)与 HUD 读数卡是否跟着接管走。
 *
 * 用法:node scripts/probe-race-pilot-control.mjs [baseUrl]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const BASE = process.argv[2] ?? 'http://127.0.0.1:15176'
const SHOOT = process.env.SHOTS === '1'
const SHOT_DIR = join(process.cwd(), '.verify-shots')
if (SHOOT) mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (error) => console.log('PAGEERROR │', String(error).split('\n')[0]))
page.on('console', (message) => {
  if (message.type() === 'error') console.log('CONSOLE-ERR │', message.text().slice(0, 200))
})

const shot = async (name) => {
  if (!SHOOT) return
  try {
    await page.screenshot({ path: join(SHOT_DIR, `probe-${name}.png`), timeout: 60_000 })
  } catch (error) {
    console.log(`   · 截图 ${name} 失败:${String(error).split('\n')[0]}`)
  }
}

await page.goto(`${BASE}/race`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__RACE__?.ready?.()), null, { timeout: 180_000 })
console.log('车辆就绪')
await page.waitForFunction(() => window.__RACE__.drone().status === 'ready', null, { timeout: 240_000 })
console.log('无人机模型就绪')

// 采样基于引擎/调试 API(约 2FPS,不能依赖渲染时序);长度单位=米,航向/角度=度
const snap = () =>
  page.evaluate(() => {
    const api = window.__RACE__
    const flight = api.droneFlight()
    const drone = api.drone()
    const car = api.state()
    const button = document.querySelector('#race-drone-pilot')
    return {
      piloting: drone.piloting,
      armFold: +drone.armFold.toFixed(3),
      dronePos: drone.position.map((v) => +v.toFixed(3)),
      droneHeading: +drone.heading.toFixed(1),
      phase: flight?.phase ?? null,
      altitude: flight ? +flight.altitude.toFixed(3) : null,
      stick: flight?.stick ?? null,
      keys: flight?.keys ?? null,
      carDistance: +(car.distance ?? 0).toFixed(3),
      carSpeed: +(car.speed ?? 0).toFixed(3),
      focus: api.cameraFocus(),
      hudHidden: document.querySelector('#race-drone-hud').hidden,
      buttonText: button.textContent.trim(),
      buttonDisabled: button.disabled,
      statusText: document.querySelector('#race-drone-status').textContent.trim(),
      toast: document.querySelector('#race-drone-toast').hidden
        ? ''
        : document.querySelector('#race-drone-toast').textContent.trim(),
    }
  })

// 对照按住期间(during)与松手后(after)两段,才能区分"没响应"与"松手回中"
const hold = async (code, ms = 2500) => {
  const before = await snap()
  await page.keyboard.down(code)
  await page.waitForTimeout(ms)
  const during = await snap()
  await page.keyboard.up(code)
  await page.waitForTimeout(800)
  const after = await snap()
  const delta = (a, b, key) => (a === null || b === null ? null : +(b - a).toFixed(3))
  console.log(
    `${code.padEnd(11)} keys=${JSON.stringify(during.keys)} stick=${JSON.stringify(during.stick)}` +
      ` Δ无人机=${JSON.stringify(before.dronePos.map((v, i) => +(during.dronePos[i] - v).toFixed(3)))}` +
      ` Δ高度=${delta(before.altitude, during.altitude)}` +
      ` Δ车距=${delta(before.carDistance, during.carDistance)}` +
      ` Δ车速=${delta(before.carSpeed, during.carSpeed)}`,
  )
  return { before, during, after }
}

console.log('\n[0] 初始(未接管)')
console.log(JSON.stringify(await snap()))

await page.evaluate(() => document.querySelector('#race-settings').click())
await page.waitForTimeout(800)
await shot('pilot-panel')

console.log('\n[1] 点「接管操控」按钮')
await page.evaluate(() => document.querySelector('#race-drone-pilot').click())
await page.waitForTimeout(4000)
console.log(JSON.stringify(await snap()))
await shot('pilot-engaged')

console.log('\n[2] 飞行键(应驱动无人机)')
for (const code of ['KeyI', 'KeyZ', 'KeyQ', 'KeyJ']) await hold(code)

console.log('\n[3] 驾驶键(接管期间借给无人机:W/S 前后、A/D 偏航,↑↓←→ 同义;车不吃键盘)')
for (const code of ['KeyW', 'KeyD', 'ArrowUp']) await hold(code)

console.log('\n[4] 机载视角下按同一个键:动的仍该是飞机(操控权没变)')
await page.evaluate(() => window.__RACE__.setCameraFocus('fpv'))
await page.waitForTimeout(1500)
console.log('focus =', (await snap()).focus)
await hold('KeyI')
await hold('KeyW')
await shot('pilot-fpv')

await browser.close()
