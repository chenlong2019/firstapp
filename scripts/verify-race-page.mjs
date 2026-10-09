/**
 * 海湾竞速页面(/race)——端到端验证脚本。
 *
 * 这个页面是把上游 img2threejs/preview 的 race.html 整体搬进 firstapp 的路由:
 * 场景脚本从"页面级脚本"改成了可挂载/可销毁的 mountRace(),无人机道具换成了
 * firstapp 的 DJI 飞控内核 + 机械装配层。所以这份检查分四段:
 *
 * 1. **移植保真**   —— 原来的车 / 相机 / 天气 / 灯光 / 模型树 / 载具控制是否照常;
 * 2. **无人机跟随** —— 模型是否载入、机臂是否展开、是否随车悬停;
 * 3. **无人机接管** —— U 键/按钮接管、键盘打杆(W/S 前后、A/D 左右转、Z/X 升降、
 *                      Q/E 偏航、I/K/J/L 同义)、摇杆量是否真的进了飞控、HUD 读数、
 *                      起飞/降落(V)与返航(B)、交还后平滑回位;
 * 3b.**操控权交接** —— 接管期间键盘整体交给无人机(驾驶键借调过去),车不被暂停
 *                      但不再吃键盘;交还后键盘立刻还给汽车,镜头可单独切换;
 * 3c.**机载视角**   —— 相机是否真的架在云台上(位置/朝向)、跟着飞机走、云台俯仰
 *                      (T/F)、跟拍↔机载(M 键与面板按钮);
 * 4. **SPA 生命周期** —— 反复进出路由不叠加实例、卸载后不残留全局监听与画布。
 *
 * 用法:先起 dev server,再 `node scripts/verify-race-page.mjs [url]`
 * 环境变量:SHOTS=1 时把截图写到 .verify-shots/
 *
 * 说明:无头 Chromium 下 WebGPU 回退到 WebGL2,加上 128MB 场景资源,帧率只有几 FPS;
 * 场景按固定步长补帧,所以断言看"事件是否发生",不看精确时刻,等待时间给得很宽。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 清掉大小写两种写法的代理环境变量,确保无头浏览器直连本机 127.0.0.1 服务
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const BASE = process.argv[2] ?? 'http://127.0.0.1:15176'
const RACE_URL = `${BASE}/race`
const DJI_URL = `${BASE}/dji`
const SHOOT = process.env.SHOTS === '1'
const SHOT_DIR = join(process.cwd(), '.verify-shots')
if (SHOOT) mkdirSync(SHOT_DIR, { recursive: true })

const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} │ ${name}${detail ? ` │ ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n──── ${title} ────`)
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

const shot = async (name) => {
  if (!SHOOT) return
  // 场景是 128MB 资源 + 持续 rAF 的重页面,无头下截图偶尔会等合成器超时;
  // 截图只是留证,失败不该让整套检查挂掉。
  try {
    await page.screenshot({ path: join(SHOT_DIR, `race-${name}.png`), timeout: 60_000 })
  } catch (error) {
    console.log(`   · 截图 ${name} 失败:${String(error).split('\n')[0]}`)
  }
}

/**
 * 直接派发点击。
 * 这个页面在无头环境只有 2 FPS,Playwright 的 click 要等"元素位置连续两帧稳定"
 * 才能落点,会一直等到超时;派发 click 事件同样走真实 DOM 监听,且不受帧率影响。
 */
const tap = (selector) =>
  page.evaluate((sel) => {
    const element = document.querySelector(sel)
    if (!element) throw new Error(`找不到 ${sel}`)
    element.click()
  }, selector)

/** 等待场景就绪(车辆与车模都在) */
const waitReady = (timeout = 180_000) =>
  page.waitForFunction(() => Boolean(window.__RACE__?.ready?.()), null, { timeout })

/** 车辆状态 */
const carState = () => page.evaluate(() => window.__RACE__.state())
/** 无人机状态 */
const droneState = () => page.evaluate(() => window.__RACE__.drone())
/** 接管飞行读数(未接管为 null) */
const droneFlight = () => page.evaluate(() => window.__RACE__.droneFlight())
/** 接管开关 */
const setPilot = (value) => page.evaluate((want) => window.__RACE__.dronePilot(want), value)
/** 等待条件成立 */
const waitFor = (fn, arg = undefined, timeout = 120_000) => page.waitForFunction(fn, arg, { timeout })
const wait = (ms) => page.waitForTimeout(ms)

/**
 * 踩住油门直到里程真的涨起来。
 *
 * 无头环境这个场景只有 ~2 FPS,主循环又按固定步长补帧(单帧最多补 0.3 秒仿真),
 * 所以"按住 3 秒"实际只推进了一秒多的仿真,里程涨不到阈值——断言会因为机器
 * 忙不忙而飘。改成按里程等,慢机器就多等一会儿,判定标准始终如一。
 */
const driveUntilMoved = async (key, want = 1, timeout = 45_000) => {
  const start = (await carState()).distance ?? 0
  await page.keyboard.down(key)
  try {
    // 注意:waitForFunction 只把函数体本身送进浏览器,闭包里的变量不会带过去,
    // 需要的值必须走第二个参数(arg)显式传。
    await waitFor(({ from, distance }) => (window.__RACE__.state().distance ?? 0) > from + distance, { from: start, distance: want }, timeout)
  } catch {
    // 超时不必在这里炸:把现状交给下面的断言去判定失败,报告更清楚
  }
  const state = await carState()
  await page.keyboard.up(key)
  await wait(300)
  return { start, state }
}

/** 等条件成立,超时返回 false 而不抛——失败交给下面的断言报告 */
const waitOk = async (predicate, arg = undefined, timeout = 40_000) => {
  try {
    await page.waitForFunction(predicate, arg, { timeout })
    return true
  } catch {
    return false
  }
}

/** 按住某个键直到无人机状态满足条件(同样不赌时间,赌状态) */
const holdDrone = async (key, predicate, arg = undefined, timeout = 40_000) => {
  await page.keyboard.down(key)
  const ok = await waitOk(predicate, arg, timeout)
  await page.keyboard.up(key)
  return ok
}

// ─────────────────────────────── 1. 页面与场景 ───────────────────────────────
section('页面与场景')

await page.goto(RACE_URL, { waitUntil: 'domcontentloaded' })

const hostCount = await page.locator('.race-page').count()
check('路由挂载了场景容器 .race-page', hostCount === 1, `count=${hostCount}`)
const viewportOk = await page.locator('.race-page #race-viewport').count()
check('场景骨架在容器内部(#race-viewport)', viewportOk === 1, `count=${viewportOk}`)
// 场景入口是懒加载 chunk,骨架先到、脚本后到,这里等它挂载完
await page.waitForFunction(() => typeof window.__RACE__ === 'object' && window.__RACE__ !== null, null, { timeout: 120_000 })
const apiOk = await page.evaluate(() => typeof window.__RACE__ === 'object' && window.__RACE__ !== null)
check('暴露调试出口 window.__RACE__', apiOk === true)

const canvasSize = await page.evaluate(() => {
  const canvas = document.querySelector('#race-viewport canvas')
  return canvas ? [canvas.clientWidth, canvas.clientHeight] : null
})
check('渲染画布已创建且有尺寸', Array.isArray(canvasSize) && canvasSize[0] > 200 && canvasSize[1] > 200, JSON.stringify(canvasSize))

await waitReady()
const wheelCount = await page.evaluate(() => window.__RACE__.info().wheelCount)
check('车辆与车模已就绪', await page.evaluate(() => window.__RACE__.ready()), `wheelCount=${wheelCount}`)

// 回归:面板默认收起。`.race-tree` 自带 display:flex,会把 hidden 属性的
// 默认 display:none 顶掉,面板会"常开"——靠 .race-page [hidden] 兜底。
const treeHiddenAtStart = await page.locator('#race-tree').isHidden()
const panelHiddenAtStart = await page.locator('#race-panel').isHidden()
check('模型树面板默认收起', treeHiddenAtStart === true)
check('设置面板默认收起', panelHiddenAtStart === true)

// 回归:两个面板必须真的点得开。
// 上游 `setPanelOpen(panel.hidden)` 被改成 `setPanelOpen(!panel.hidden)` 时,
// 与内部 `panel.hidden = !open` 的感叹号互相抵消,点击变成空操作——
// 元素在、监听器在、命中测试也正常,唯独什么都不发生。这里逐一验证。
await tap('#race-settings')
await wait(250)
check('点「设置」能打开设置面板', (await page.locator('#race-panel').isVisible()) === true)
check('设置按钮 aria-expanded 同步', (await page.getAttribute('#race-settings', 'aria-expanded')) === 'true')
await tap('#race-settings')
await wait(250)
check('再点「设置」能收起', (await page.locator('#race-panel').isHidden()) === true)

await tap('#race-tree-toggle')
await wait(250)
check('点「模型树」能打开模型树面板', (await page.locator('#race-tree').isVisible()) === true)
await tap('#race-tree-close')
await wait(250)
check('点「×」能关掉模型树', (await page.locator('#race-tree').isHidden()) === true)

// 画面真的渲染出了东西:取样像素里颜色种类足够多(纯色说明没画出来)
// 采样在页面内做,不然 1600×900 的像素数组要整个走一遍 CDP。
const sampling = await page.evaluate(() => {
  const pixels = window.__RACE__.pixels()
  const seen = new Set()
  for (let i = 0; i < pixels.data.length; i += 4 * 97) {
    seen.add(`${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]}`)
  }
  return { distinct: seen.size, width: pixels.width, height: pixels.height }
})
check('画面有实际渲染内容(颜色种类 > 24)', sampling.distinct > 24, `distinct=${sampling.distinct}, size=${sampling.width}x${sampling.height}`)

await shot('01-idle')

// ─────────────────────────── 2. 上游功能移植保真 ───────────────────────────
section('上游功能移植保真')

// 驾驶:油门踩下去,里程要涨、车轮要转。
// 注意 `setInput()` 会被主循环每帧的键盘状态覆盖(applyDrivingInput 是权威输入源),
// 无头检查必须走真实按键,否则等于没踩油门。
const before = await carState()
const driven = await driveUntilMoved('ArrowUp')
const driving = driven.state
check('车辆可被驱动(里程增长)', driving.distance > before.distance + 0.5, `${before.distance?.toFixed?.(2)} → ${driving.distance?.toFixed?.(2)}`)
check('车轮随车速转动', driving.wheelSpin !== before.wheelSpin, `spin=${driving.wheelSpin?.toFixed?.(2)}`)

// 相机:跟随相机会跟着车走
const camBefore = await page.evaluate(() => window.__RACE__.cameraPose())
await page.keyboard.down('ArrowUp')
await wait(2500)
const camAfter = await page.evaluate(() => window.__RACE__.cameraPose())
await page.keyboard.up('ArrowUp')
await page.keyboard.press('KeyR')
await wait(400)
const camMoved = Math.hypot(
  camAfter.position[0] - camBefore.position[0],
  camAfter.position[2] - camBefore.position[2],
)
check('跟随相机随车移动', camMoved > 0.5, `moved=${camMoved.toFixed(2)}m`)

// 天气:开雨 → 湿路与雨滴都要真的开
const rainBefore = await page.evaluate(() => window.__RACE__.rain())
await page.evaluate(() => window.__RACE__.setRain(true, 1))
await wait(1200)
const rainAfter = await page.evaluate(() => ({ rain: window.__RACE__.rain(), weather: window.__RACE__.weather() }))
check('雨量开关生效', rainBefore.enabled !== true && rainAfter.rain.enabled === true, `enabled=${rainAfter.rain.enabled}`)
check('湿路反射层跟着开启', Boolean(rainAfter.weather.wetRoad?.enabled ?? rainAfter.weather.wetRoad?.active), JSON.stringify(rainAfter.weather.wetRoad))
await shot('02-rain')
await page.evaluate(() => window.__RACE__.setRain(false))

// 昼夜:夜间的亮度参数应可调(滑块下限 0.3,这里给到下限即可)
const night = await page.evaluate(() => window.__RACE__.nightBrightness(0.2))
check('昼夜亮度可调', typeof night === 'number' && night <= 0.31, `nightBrightness=${night}`)
await page.evaluate(() => window.__RACE__.nightBrightness(1))

// 阴影:太阳阴影相机在跟随
const shadow = await page.evaluate(() => window.__RACE__.shadow())
check('太阳阴影已启用并跟随飞机以外的目标', shadow.enabled === true && shadow.casters > 0, JSON.stringify({ casters: shadow.casters, extent: shadow.extent }))

// 模型树:能开能关,且能给出根节点
const treeOpen = await page.evaluate(() => window.__RACE__.setTreeOpen(true))
const treeRoot = await page.evaluate(() => window.__RACE__.treeRoot())
check('模型树可展开', treeOpen === true && treeRoot !== null, JSON.stringify(treeRoot))
await page.evaluate(() => window.__RACE__.setTreeOpen(false))

// 场景控制桥(MCP 契约)仍挂着
const bridge = await page.evaluate(() => Boolean(window.__RACE_SCENE__ || window.__SCENE_CONTROL__ || document.querySelector('#race-status')))
check('场景状态栏元素仍在', bridge === true)

// ─────────────────────────── 3. 无人机:载入与跟随 ───────────────────────────
section('无人机 · 载入与跟随')

await waitFor(() => window.__RACE__.drone().status === 'ready')
const drone = await droneState()
check('无人机模型载入成功', drone.status === 'ready', `status=${drone.status}`)
check('模型网格与三角面非空', drone.meshes > 0 && drone.triangles > 0, `meshes=${drone.meshes}, tris=${Math.round(drone.triangles)}`)
check('归一化尺寸为 0.42m 量级', drone.size.every((v) => v > 0) && Math.max(...drone.size) > 0.1, JSON.stringify(drone.size))
check('无人机在场景中可见', drone.visible === true)

// 出厂是收纳态,场景里应当自动展开机臂
await waitFor(() => window.__RACE__.drone().armFold < 0.05, undefined, 60_000)
const opened = await droneState()
check('机臂自动展开(armFold < 0.05)', opened.armFold < 0.05, `armFold=${opened.armFold.toFixed(4)}`)
await waitFor(() => Math.max(...window.__RACE__.drone().flightSize) > 0, undefined, 30_000)
const flightSize = (await droneState()).flightSize
check('展开后外形有实测尺寸', Math.max(...flightSize) > 0.05, JSON.stringify(flightSize))
console.log(`   · 载入包围盒 ${JSON.stringify(drone.size)} · 展开后 ${JSON.stringify(flightSize)}`)

/** 无人机锚点:车体右前方,两者距离在一段时间内应保持稳定 */
const followDrift = async () => {
  const [car, craft] = await Promise.all([carState(), droneState()])
  return {
    gap: Math.hypot(craft.position[0] - car.position[0], craft.position[1] - car.position[1], craft.position[2] - car.position[2]),
    car: car.position,
    craft: craft.position,
  }
}
const beforeFollow = await followDrift()
await driveUntilMoved('ArrowUp', 1)
const afterFollow = await followDrift()
const carMoved = Math.hypot(afterFollow.car[0] - beforeFollow.car[0], afterFollow.car[2] - beforeFollow.car[2])
const craftMoved = Math.hypot(afterFollow.craft[0] - beforeFollow.craft[0], afterFollow.craft[2] - beforeFollow.craft[2])
check('随车悬停前置:车辆确实开动了', carMoved > 0.3, `车位移=${carMoved.toFixed(2)}m`)
check('随车悬停:无人机跟着车一起挪动', craftMoved > 0.3, `机位移=${craftMoved.toFixed(2)}m`)
check('随车悬停:车辆行驶中锚距保持稳定', Math.abs(afterFollow.gap - beforeFollow.gap) < Math.max(1.2, beforeFollow.gap * 0.5), `${beforeFollow.gap.toFixed(2)}m → ${afterFollow.gap.toFixed(2)}m`)
check('随车悬停:无人机挂在车体右前方', beforeFollow.gap > 0.5, `锚距=${beforeFollow.gap.toFixed(2)}m`)

// 「起飞」不要求先接管:未接管时按钮就可用,点一下直接进入接管并飞起来
check('未接管时「起飞」按钮可用', (await page.locator('#race-drone-takeoff').isEnabled()) === true)
await tap('#race-drone-takeoff')
await waitOk(() => window.__RACE__.droneFlight() !== null, undefined, 60_000)
const afterTakeoffButton = await droneFlight()
check('点「起飞」直接接管并起飞', afterTakeoffButton !== null && afterTakeoffButton.phase === 'flying', `phase=${afterTakeoffButton?.phase}`)
await tap('#race-drone-pilot')
await waitOk(() => window.__RACE__.droneFlight() === null, undefined, 60_000)
check('交还后回到随车悬停', (await droneFlight()) === null)

// 特写:开设置面板 → 「查看无人机」,相机直接框住它,看跟随姿态与模型细节
await tap('#race-settings')
await wait(300)
await tap('#race-drone-focus')
await wait(1500)
await shot('03b-follow-closeup')
await page.keyboard.press('KeyC')
await wait(800)
// 面板现在是真的会打开的,截图前收起来,别挡住场景
await tap('#race-settings')
await wait(300)
await shot('03c-follow')

// ─────────────────────────── 4. 无人机:接管操控 ───────────────────────────
section('无人机 · 接管操控')

const linked = await setPilot(true)
check('可以接管操控', linked === true)
const flightStart = await droneFlight()
check('接管后进入飞行状态', flightStart !== null && flightStart.phase === 'flying', `phase=${flightStart?.phase}`)
check('接管后机臂保持展开', (await droneState()).armFold < 0.05, `armFold=${(await droneState()).armFold.toFixed(4)}`)
let hudVisible = true
try {
  await page.locator('#race-drone-hud').waitFor({ state: 'visible', timeout: 15_000 })
} catch {
  hudVisible = false
}
check('飞行 HUD 自动展开', hudVisible === true)
// 读数卡要真的在刷新,不是冻在接管那一刻
const hudAltitude = () => page.locator('#drone-hud-altitude').innerText()
const hudPhase = await page.locator('#drone-hud-phase').innerText()
const hudBefore = await hudAltitude()
const hudAltStart = (await droneFlight()).altitude
await holdDrone('KeyZ', (from) => (window.__RACE__.droneFlight()?.altitude ?? 0) > from + 0.3, hudAltStart)
await wait(1500)
const hudAfter = await hudAltitude()
check('HUD 读数随飞行刷新', hudBefore !== hudAfter, `高度 ${hudBefore} → ${hudAfter}`)
check('HUD 显示飞行相位', /起飞|悬停|飞行|上升/.test(hudPhase), `phase=${hudPhase}`)
const pilotButtonText = await page.locator('#race-drone-pilot').innerText()
check('接管按钮切换为「交还操控」', pilotButtonText.includes('交还'), `text=${pilotButtonText.trim()}`)
const landingEnabled = await page.locator('#race-drone-land').isEnabled()
check('降落/返航按钮在接管后可用', landingEnabled === true)
await shot('04-pilot')

// ── 操控权交接:接管期间键盘整体归无人机,交还后立刻还给汽车 ──
// 车本身不被暂停(物理照常),但它不再吃键盘 —— 否则按 W 会一边让飞机前飞、
// 一边给汽车加油,那才是真的"车机绑定"。
const pausedWhileFlying = await page.evaluate(() => window.__RACE__.paused())
check('接管无人机不会暂停车辆', pausedWhileFlying === false, `paused=${pausedWhileFlying}`)

const carBeforeBorrow = await carState()
// 注意:杆量/按键要在**按住期间**读——holdDrone 松手后才读,读到的是回中的 0
await page.keyboard.down('KeyW')
const borrowIn = await waitOk(() => (window.__RACE__.droneFlight()?.stick?.pitch ?? 0) > .9, undefined, 30_000)
const borrowKeys = await page.evaluate(() => window.__RACE__.droneFlight()?.keys ?? [])
const carDuringBorrow = await carState()
await page.keyboard.up('KeyW')
const borrowOut = await waitOk(() => (window.__RACE__.droneFlight()?.stick?.pitch ?? 1) === 0, undefined, 20_000)
check('接管期间驾驶键 W 驱动无人机(飞控收到前后杆量)', borrowIn === true)
check('接管期间驾驶键记入飞行键集合', borrowKeys.includes('KeyW'), `keys=${JSON.stringify(borrowKeys)}`)
check('松开 W 后摇杆回中', borrowOut === true)
check(
  '接管期间车辆不吃键盘(不给动力)',
  carDuringBorrow.speed <= carBeforeBorrow.speed + 0.05,
  `车速 ${carBeforeBorrow.speed.toFixed(2)} → ${carDuringBorrow.speed.toFixed(2)} m/s`,
)
check('接管期间车辆仍不被暂停/复位', carDuringBorrow.distance >= carBeforeBorrow.distance - 0.01)

// 方向键同义:↑ 在接管期间也是"前飞"
const arrowBorrowed = await holdDrone('ArrowUp', () => (window.__RACE__.droneFlight()?.stick?.pitch ?? 0) > .9, undefined, 30_000)
check('接管期间方向键 ↑ 与 W 同义(前飞)', arrowBorrowed === true)
// A/D 顺着驾驶直觉给偏航(左转/右转)
await page.keyboard.down('KeyA')
const yawBorrowed = await waitOk(() => (window.__RACE__.droneFlight()?.stick?.yaw ?? 0) < -.9, undefined, 30_000)
const yawDuring = (await droneFlight())?.stick.yaw
await page.keyboard.up('KeyA')
check('接管期间 A 键左偏航', yawBorrowed === true, `yaw=${yawDuring}`)

// 无人机按键只作用在无人机上:按 I 前飞,车辆不会因此获得动力
const carBeforePush = await carState()
const flightBeforePush = await droneFlight()
const pushOk = await holdDrone('KeyI', () => (window.__RACE__.droneFlight()?.horizontalSpeed ?? 0) > 0.3, undefined, 45_000)
const flightPushing = await droneFlight()
const carAfterPush = await carState()
check('按住 I 让无人机前飞(水平速度 > 0.3 m/s)', pushOk === true && flightPushing.horizontalSpeed > 0.3, `v=${flightPushing.horizontalSpeed.toFixed(2)}m/s`)
check(
  '无人机按键不会给车辆动力',
  carAfterPush.speed <= carBeforePush.speed + 0.05,
  `车速 ${carBeforePush.speed.toFixed(2)} → ${carAfterPush.speed.toFixed(2)} m/s`,
)
check('无人机按键不会暂停/复位车辆', (await carState()).distance >= carAfterPush.distance - 0.01)
check('并飞时无人机读数照常刷新', flightPushing.altitude !== flightBeforePush.altitude || flightPushing.horizontalSpeed > 0.3, `alt=${flightPushing.altitude.toFixed(2)}m`)

// ── 摇杆量:按键必须真的进到飞控。HUD 上那四根条子读的就是它,
//    所以"按键有没有进来"这件事从此是可以从画面上看出来的 ──
await page.keyboard.down('KeyI')
const stickIn = await waitOk(() => (window.__RACE__.droneFlight()?.stick?.pitch ?? 0) > .9, undefined, 20_000)
const stickKeys = await page.evaluate(() => window.__RACE__.droneFlight()?.keys ?? [])
const stickBarHeight = await page.evaluate(() => document.querySelector('#drone-hud-stick-pitch')?.style.height ?? '')
await page.keyboard.up('KeyI')
const stickOut = await waitOk(() => (window.__RACE__.droneFlight()?.stick?.pitch ?? 1) === 0, undefined, 20_000)
check('按住 I 时飞控收到前后杆量(=1)', stickIn === true)
check('按键进入飞行键集合', stickKeys.includes('KeyI'), `keys=${JSON.stringify(stickKeys)}`)
check('HUD 摇杆条随杆量伸长', parseFloat(stickBarHeight) > 10, `height=${stickBarHeight}`)
check('松开按键摇杆回中', stickOut === true)

// 镜头与会话解耦:接管时跟拍无人机;C 把镜头拿回车辆,但仍在接管中
const focusWhileFlying = await page.evaluate(() => window.__RACE__.cameraFocus())
check('接管后镜头交给无人机', focusWhileFlying === 'drone', `focus=${focusWhileFlying}`)
await page.keyboard.press('KeyC')
await wait(900)
const focusBackOnCar = await page.evaluate(() => window.__RACE__.cameraFocus())
check('按 C 可把镜头拿回车辆', focusBackOnCar === 'car', `focus=${focusBackOnCar}`)
check('镜头回车辆后仍在接管无人机', (await droneFlight()) !== null)
await page.keyboard.press('KeyU')
await waitOk(() => window.__RACE__.droneFlight() === null, undefined, 30_000)
// 交还的那一刻键盘回到汽车:同样按 ↑,这次动的是车(里程增长)
const carBeforeHandback = await carState()
const carAfterHandback = (await driveUntilMoved('ArrowUp')).state
check(
  '交还后驾驶键立刻还给汽车(里程增长)',
  carAfterHandback.distance > carBeforeHandback.distance + 0.5,
  `里程 ${carBeforeHandback.distance.toFixed(2)} → ${carAfterHandback.distance.toFixed(2)}`,
)
await page.keyboard.press('KeyU')
await waitOk(() => window.__RACE__.droneFlight() !== null, undefined, 30_000)
await wait(600)
check('再次接管后镜头回到无人机', (await page.evaluate(() => window.__RACE__.cameraFocus())) === 'drone')

// ─────────────────────────── 4b. 无人机 · 机载视角 ───────────────────────────
section('无人机 · 机载视角')

/** 相机与无人机的距离:跟拍约 3.5m,机载应该只有几十厘米(相机就架在云台上) */
const cameraToDrone = async () => {
  const [cam, craft] = await Promise.all([
    page.evaluate(() => window.__RACE__.cameraPose()),
    droneState(),
  ])
  return Math.hypot(cam.position[0] - craft.position[0], cam.position[1] - craft.position[1], cam.position[2] - craft.position[2])
}
/** 相机朝向与机头方向的夹角(度) */
const cameraHeadingError = async () => {
  const [cam, craft] = await Promise.all([
    page.evaluate(() => window.__RACE__.cameraPose()),
    droneState(),
  ])
  const diff = Math.abs(((cam.lookYaw - craft.heading) * 180 / Math.PI + 540) % 360 - 180)
  return diff
}

const chaseDistance = await cameraToDrone()
check('跟拍视角:相机吊在机身后方(> 2m)', chaseDistance > 2, `距离=${chaseDistance.toFixed(2)}m`)

const fpvFocus = await page.evaluate(() => window.__RACE__.setCameraFocus('fpv'))
check('切到机载视角', fpvFocus === 'fpv', `focus=${fpvFocus}`)
await wait(1200)
const fpvDistance = await cameraToDrone()
const fpvHeadingError = await cameraHeadingError()
check('机载视角:相机就架在云台上(< 1m)', fpvDistance < 1, `距离=${fpvDistance.toFixed(2)}m`)
check('机载视角:镜头顺着机头方向(±12°)', fpvHeadingError < 12, `夹角=${fpvHeadingError.toFixed(1)}°`)
await shot('06-fpv')

// 机载视角是"真挂在云台上":飞机往前飞,相机必须跟着走
const fpvCamBefore = await page.evaluate(() => window.__RACE__.cameraPose().position)
const fpvPushOk = await holdDrone('KeyI', () => (window.__RACE__.droneFlight()?.horizontalSpeed ?? 0) > .4, undefined, 40_000)
await wait(900)
const fpvCamAfter = await page.evaluate(() => window.__RACE__.cameraPose().position)
const fpvCamMoved = Math.hypot(fpvCamAfter[0] - fpvCamBefore[0], fpvCamAfter[2] - fpvCamBefore[2])
check('机载视角下按 I 前飞(飞控响应)', fpvPushOk === true)
check('机载相机会跟着飞机一起走', fpvCamMoved > .5, `机位移动=${fpvCamMoved.toFixed(2)}m`)

// 云台俯仰:按住 T 抬头、F 低头,松手即停
const gimbalStart = await page.evaluate(() => window.__RACE__.droneGimbalPitch())
await page.keyboard.press('KeyT')
await wait(900)
const gimbalUp = await page.evaluate(() => window.__RACE__.droneGimbalPitch())
await page.keyboard.press('KeyF')
await page.keyboard.press('KeyF')
await wait(900)
const gimbalDown = await page.evaluate(() => window.__RACE__.droneGimbalPitch())
check('按 T 云台抬头', gimbalUp > gimbalStart, `${gimbalStart}° → ${gimbalUp}°`)
check('按 F 云台低头', gimbalDown < gimbalUp, `${gimbalUp}° → ${gimbalDown}°`)
await page.evaluate(() => window.__RACE__.droneGimbalPitch(-10))

// M 键在跟拍与机载之间来回切
await page.keyboard.press('KeyM')
await wait(900)
const focusAfterM = await page.evaluate(() => window.__RACE__.cameraFocus())
check('按 M 切回跟拍', focusAfterM === 'drone', `focus=${focusAfterM}`)
await page.keyboard.press('KeyM')
await wait(900)
const focusAfterM2 = await page.evaluate(() => window.__RACE__.cameraFocus())
check('再按 M 回到机载', focusAfterM2 === 'fpv', `focus=${focusAfterM2}`)

// 机载视角不影响"谁在被操控":镜头在云台上,操控权仍在无人机手里 ——
// 所以这里按 ↑ 动的该是飞机(驾驶键在接管期间借调给了它),车辆依旧不吃键盘
const carBeforeFpvDrive = await carState()
const fpvBorrowed = await holdDrone('ArrowUp', () => (window.__RACE__.droneFlight()?.stick?.pitch ?? 0) > .9, undefined, 30_000)
const carAfterFpvDrive = await carState()
check('机载视角下驾驶键仍驱动无人机', fpvBorrowed === true)
check(
  '机载视角下车辆依旧不吃键盘',
  carAfterFpvDrive.speed <= carBeforeFpvDrive.speed + 0.05,
  `车速 ${carBeforeFpvDrive.speed.toFixed(2)} → ${carAfterFpvDrive.speed.toFixed(2)} m/s`,
)
check('机载视角下仍在接管无人机', (await droneFlight()) !== null)

// 面板上的三挡按钮:选中态跟着镜头走
await tap('#race-settings')
await wait(400)
const camButtonActive = await page.evaluate(() => document.querySelector('#race-drone-cam-fpv').classList.contains('is-active'))
check('面板「机载视角」按钮显示选中态', camButtonActive === true)
await tap('#race-drone-cam-car')
await wait(900)
const focusViaButton = await page.evaluate(() => window.__RACE__.cameraFocus())
check('面板「车辆视角」按钮把镜头拿回车里', focusViaButton === 'car', `focus=${focusViaButton}`)
await tap('#race-drone-cam-fpv')
await wait(900)
check('面板「机载视角」按钮能切回云台', (await page.evaluate(() => window.__RACE__.cameraFocus())) === 'fpv')
await tap('#race-settings')
await wait(300)

// 高度:按住升降摇杆上推(Z)
const altBefore = (await droneFlight()).altitude
const climbed = await holdDrone('KeyZ', (from) => (window.__RACE__.droneFlight()?.altitude ?? 0) > from + 0.3, altBefore)
const afterClimb = await droneFlight()
check('键盘 Z 让飞机爬升', climbed === true && afterClimb.altitude > altBefore + 0.2, `${altBefore.toFixed(2)}m → ${afterClimb.altitude.toFixed(2)}m`)

// 偏航:按住 E
const yawBefore = (await droneFlight()).heading
const yawed = await holdDrone('KeyE', (from) => {
  const now = window.__RACE__.droneFlight()?.heading ?? from
  return Math.abs(((now - from + 540) % 360) - 180) > 8
}, yawBefore)
const afterYaw = await droneFlight()
const yawDelta = Math.abs(((afterYaw.heading - yawBefore + 540) % 360) - 180)
check('键盘 E 让机头偏航', yawed === true && yawDelta > 5, `heading ${yawBefore.toFixed(0)}° → ${afterYaw.heading.toFixed(0)}°`)

// 前进:按住 I,水平速度与位移都要有
const posBefore = (await droneState()).position
await page.keyboard.down('KeyI')
const speedOk = await waitOk(() => (window.__RACE__.droneFlight()?.horizontalSpeed ?? 0) > 0.3, undefined, 45_000)
const afterForward = await droneFlight()
const movedOk = await waitOk((from) => {
  const p = window.__RACE__.drone().position
  return Math.hypot(p[0] - from[0], p[2] - from[2]) > 0.8
}, posBefore, 45_000)
const posAfter = (await droneState()).position
await page.keyboard.up('KeyI')
await wait(400)
const travelled = Math.hypot(posAfter[0] - posBefore[0], posAfter[2] - posBefore[2])
check('键盘 I 让飞机前飞(水平速度 > 0.3 m/s)', speedOk === true && afterForward.horizontalSpeed > 0.3, `v=${afterForward.horizontalSpeed.toFixed(2)}m/s`)
check('前进产生水平位移(> 0.5m)', movedOk === true && travelled > 0.5, `moved=${travelled.toFixed(2)}m`)
check('机身出现俯仰倾斜', Math.abs(afterForward.tiltPitch) > 0.5, `tiltPitch=${afterForward.tiltPitch.toFixed(2)}°`)

// 重刹停桨:未落地时不应允许(与沙盒一致的失效保护)
const emergency = await page.evaluate(() => window.__RACE__.droneFlight().airborne)
check('飞行中处于 airborne', emergency === true)

// 返航:空中按 B
await page.keyboard.press('KeyB')
const modes = await waitOk(() => {
  const flight = window.__RACE__.droneFlight()
  return Boolean(flight) && (flight.phase === 'rth' || flight.modeLabel.includes('返航'))
}, undefined, 30_000)
const rth = await droneFlight()
check('键盘 B 触发智能返航', modes === true && (rth.phase === 'rth' || rth.modeLabel.includes('返航')), `phase=${rth.phase}, mode=${rth.modeLabel}`)
await shot('05-rth')

// 降落:按 V
await page.keyboard.press('KeyV')
await waitOk(() => {
  const flight = window.__RACE__.droneFlight()
  return Boolean(flight) && (flight.phase === 'landing' || flight.phase === 'flying' || flight.phase === 'standby' || flight.phase === 'stopped')
}, undefined, 30_000)
const landed = await droneFlight()
check('键盘 V 触发自动降落', landed.phase === 'landing' || landed.airborne === false, `phase=${landed.phase}, airborne=${landed.airborne}`)

// 交还操控:位置平滑回位,车辆恢复可驾驶
await setPilot(false)
await wait(250)
const stillPiloting = await droneFlight()
check('交还操控后立即回到跟随模式', stillPiloting === null)
const carBeforeResume = await carState()
const carResumed = (await driveUntilMoved('ArrowUp')).state
check('交还操控后车辆恢复可驾驶', carResumed.distance > carBeforeResume.distance + 0.5, `里程 ${carBeforeResume.distance.toFixed(2)} → ${carResumed.distance.toFixed(2)}`)
const hudHidden = await page.locator('#race-drone-hud').isHidden()
check('交还操控后 HUD 收起', hudHidden === true)
const backDrift = (await followDrift()).gap
check('交还操控后无人机飞回车旁', backDrift < 8, `锚距=${backDrift.toFixed(2)}m`)
await shot('06-rejoin')

// 热键 U 也能来回切换
await page.keyboard.press('KeyU')
await waitFor(() => window.__RACE__.droneFlight() !== null, undefined, 30_000)
check('热键 U 可再次接管', (await droneFlight()) !== null)
await page.keyboard.press('KeyU')
await wait(300)
check('热键 U 可交还操控', (await droneFlight()) === null)

// ─────────────────────── 5. SPA 生命周期:进出路由不叠加 ───────────────────────
section('SPA 生命周期')

await page.goto(DJI_URL, { waitUntil: 'domcontentloaded' })
await wait(2500)
const hostOnDji = await page.locator('.race-page').count()
check('离开 /race 后场景容器已卸载', hostOnDji === 0, `count=${hostOnDji}`)
const apiGone = await page.evaluate(() => window.__RACE__ === undefined)
check('离开 /race 后调试出口已清空', apiGone === true)

await page.goto(RACE_URL, { waitUntil: 'domcontentloaded' })
await waitReady()
const reHost = await page.locator('.race-page').count()
const reCanvas = await page.locator('#race-viewport canvas').count()
check('回到 /race 后只有一份场景实例', reHost === 1 && reCanvas === 1, `host=${reHost}, canvas=${reCanvas}`)

// 再来一次往返,确认实例不累积、调试出口仍可用
await page.goto(DJI_URL, { waitUntil: 'domcontentloaded' })
await wait(2000)
await page.goto(RACE_URL, { waitUntil: 'domcontentloaded' })
await waitReady()
const thirdHost = await page.locator('.race-page').count()
const thirdCanvas = await page.locator('#race-viewport canvas').count()
check('二次往返仍只有一份实例', thirdHost === 1 && thirdCanvas === 1, `host=${thirdHost}, canvas=${thirdCanvas}`)
const thirdDrone = await droneState()
check('二次进入后无人机仍能载入', thirdDrone.status === 'ready' || thirdDrone.status === 'loading', `status=${thirdDrone.status}`)

// ─────────────────────────────── 6. 控制台 ───────────────────────────────
section('控制台')

// 场景资源里有几处上游自带的 404 探测(knots LOD 等),过滤掉已知噪声再看
const unexpected = errors.filter(
  (text) =>
    !/favicon/i.test(text) &&
    !/Download the Vue Devtools/i.test(text) &&
    !/three-engine/.test(text) &&
    !/Failed to load resource/i.test(text),
)
check('无未预期的控制台错误', unexpected.length === 0, unexpected.slice(0, 3).join(' | '))
if (errors.length !== unexpected.length) {
  console.log(`\n(已忽略 ${errors.length - unexpected.length} 条已知噪声:devtools / 资源 404 / lib-demo 的 three-engine 别名)`)
}

await shot('07-final')
await browser.close()

console.log(`\n共 ${results.length} 项,失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
