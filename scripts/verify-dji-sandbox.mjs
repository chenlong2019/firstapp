/**
 * DJI 无人机测试沙盒 —— 端到端验证脚本(直接操作界面,而不是只调引擎 API)。
 *
 * 覆盖:界面结构 → 出厂阻止项 → 展开机臂 → 上电自检/预热/搜星 → 自动起飞 →
 * 双摇杆拖拽与自回中 → 键盘映射 → 相机视角与云台 → 参数面板 → 故障注入 →
 * 灯光面板(手动覆盖 / 自动跟随) → 避障刹停(含关闭避障的对照) →
 * 遥控失联失效保护返航 → 电池与低电量保护 → 重置与停桨(仅落地后允许)→ 零控制台错误。
 *
 * 用法:先起 dev server,再 `node scripts/verify-dji-sandbox.mjs [url]`
 * 环境变量:SHOTS=1 时把截图写到 .verify-shots/
 *
 * 说明:无头 Chromium 下 WebGPU 会回退到 WebGL2,帧率只有 2~3 FPS;引擎按固定步长补帧,
 * 因此仿真时间会比真实时间跑得快,下面的等待时间都按"事件发生"而不是"精确时刻"来断言。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
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
  if (SHOOT) await page.screenshot({ path: join(SHOT_DIR, `sandbox-${name}.png`) })
}

/** 读取引擎真值(避免只看界面文字导致假通过) */
const state = () =>
  page.evaluate(() => {
    const debug = window.__djiDebug
    const sim = debug.fly.sim
    const snapshot = sim.snapshot()
    return {
      phase: sim.phase,
      mode: sim.mode,
      position: { ...sim.position },
      velocity: { ...sim.velocity },
      stick: { ...sim.stick },
      armFold: debug.fly.rig.armFold,
      cameraMode: debug.fly.cameraMode,
      lightOverride: debug.fly.lightOverride,
      statusKey: debug.fly.lights.statusKey,
      obstacle: { ...snapshot.obstacle },
      batteryPercent: snapshot.batteryPercent,
      positionSource: snapshot.positionSource,
      gpsBars: snapshot.gpsBars,
      rcBars: snapshot.rcBars,
      tiltPitch: snapshot.tiltPitch,
      motorLoad: snapshot.motorLoad,
      gimbalPitch: snapshot.gimbalPitch,
      rthReason: snapshot.rthReason,
      damaged: snapshot.damaged,
    }
  })

const waitSim = (expression, timeout = 60000) =>
  page.waitForFunction(new Function(`return (${expression})`), undefined, { timeout })
const engine = (expression) => page.evaluate(expression)

/* ═════════════════════ 1. 界面结构 ═════════════════════ */
section('界面结构')
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await waitSim('window.__djiDebug?.fly?.rig', 120000)

/** 记录仿真经过的每一个阶段:低帧率下"瞬时阶段"可能在两次采样之间就过去了 */
await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  window.__phaseLog = []
  const original = sim.step.bind(sim)
  sim.step = (delta) => {
    original(delta)
    const log = window.__phaseLog
    if (log[log.length - 1] !== sim.phase) log.push(sim.phase)
  }
})

check('六个分页面板', (await page.locator('.tabs button').count()) === 6)
check('双虚拟摇杆', (await page.locator('.stick-pad').count()) === 2)
check('姿态仪 + 罗盘', (await page.locator('.attitude').count()) === 2)
check('HUD 阶段显示', (await page.locator('[data-testid="snap-phase"]').count()) === 1)
check('事件日志', (await page.locator('[data-testid="event-log"]').count()) === 1)
check('模型加载提示已消失', (await page.locator('.loading').count()) === 0)
await shot('01-initial')

/* ═════════════════════ 2. 出厂状态:机臂收纳 → 阻止起飞 ═════════════════════ */
section('出厂状态与起飞前检查')
let snapshot = await state()
check('初始处于未上电', snapshot.phase === 'powerOff', snapshot.phase)
check('机臂默认收纳(模拟真机开箱)', snapshot.armFold > 0.98, `fold=${snapshot.armFold.toFixed(3)}`)
check(
  '检查单列出 9 项',
  (await page.locator('[data-testid="checklist"] li').count()) === 9,
  `count=${await page.locator('[data-testid="checklist"] li').count()}`,
)
const checklistText = await page.locator('[data-testid="checklist"]').innerText()
check('检查单含模型部件自检', checklistText.includes('模型部件自检'))
check('机臂检查项标红', checklistText.includes('机臂处于收纳状态'))
check('起飞按钮被禁用', await page.locator('[data-testid="btn-takeoff"]').isDisabled())
const blockHint = (await page.locator('.block-hint').innerText()).trim()
check('界面给出阻止原因', blockHint.includes('机臂已展开'), blockHint)
// 前视雷达:未上电时不工作
check('雷达未上电不工作', (await page.evaluate(() => window.__djiDebug.fly.getRadarSnapshot().detecting)) === false)
await shot('02-folded')

/* ═════════════════════ 3. 展开机臂 → 上电 → 搜星 → 待机 ═════════════════════ */
section('开箱流程:展开机臂 → 上电 → 搜星')
await page.locator('[data-testid="btn-arm"]').click()
await waitSim('window.__djiDebug.fly.rig.armFold < 0.02', 20000)
// 机臂全开后桨叶还要缓缓张开(真机节奏),自检项以"完全张开"为准
await waitSim('window.__djiDebug.fly.rig.bladeOpen > 0.98', 20000)
check('机臂已展开到位', (await state()).armFold < 0.02)
check('桨叶已完全张开', (await page.evaluate(() => window.__djiDebug.fly.rig.bladeOpen)) > 0.98)
check(
  '展开后机臂检查项通过',
  (await page.locator('[data-testid="checklist"]').innerText()).includes('已展开'),
)

await page.locator('[data-testid="btn-power"]').click()
snapshot = await state()
check('点击电源进入开机自检', snapshot.phase === 'selfCheck', snapshot.phase)
await waitSim("window.__djiDebug.fly.sim.phase === 'warmingUp'", 30000)
check('自检结束进入传感器预热', true)
check('预热期间灯语为传感器预热', (await state()).statusKey === 'sensorWarmup')
await shot('03-warmup')

await waitSim("window.__djiDebug.fly.sim.phase === 'standby'", 60000)
snapshot = await state()
check('预热完成进入地面待机', snapshot.phase === 'standby')
check('已进入 GNSS 卫星定位', snapshot.positionSource === 'gps', snapshot.positionSource)
check('GNSS 格数 >= 3', snapshot.gpsBars >= 3, `bars=${snapshot.gpsBars}`)
check('状态灯为 GNSS 定位正常', snapshot.statusKey === 'gnssNormal', snapshot.statusKey)
check(
  'HUD 显示"地面待机"',
  (await page.locator('[data-testid="snap-phase"]').innerText()).trim() === '地面待机',
  (await page.locator('[data-testid="snap-phase"]').innerText()).trim(),
)
// 雷达(锥形视场):上电后工作;正前方 13m 处的细柱"灯杆"必须被前视双镜头发现(中线无盲区)
const radarStandby = await page.evaluate(() => window.__djiDebug.fly.getRadarSnapshot())
check('上电后雷达开始工作', radarStandby.detecting === true)
check('雷达瞄准默认为正前/正上', radarStandby.aim === 'forward', radarStandby.aim)
check('前视左镜头发现正前方灯杆(中线盲区已消除)', radarStandby.left?.label === '灯杆', JSON.stringify(radarStandby.left))
check('前视右镜头发现正前方灯杆', radarStandby.right?.label === '灯杆', JSON.stringify(radarStandby.right))
const frontDist = radarStandby.left?.distance ?? 0
check('灯杆距离在 16m 附近', frontDist > 10 && frontDist < 18, `dist=${frontDist.toFixed(2)}`)
check(
  '避障卡片显示雷达面板(前视+上视共 4 条射线)',
  (await page.locator('.radar-rays .radar-ray').count()) === 4,
  `count=${await page.locator('.radar-rays .radar-ray').count()}`,
)
check('上视雷达量程 15m', radarStandby.upRange === 15, `upRange=${radarStandby.upRange}`)
const upNoNear = [radarStandby.upLeft, radarStandby.upRight].every((hit) => hit === null || hit.distance > 3)
check('上视初始无近距命中', upNoNear, JSON.stringify({ upL: radarStandby.upLeft, upR: radarStandby.upRight }))

// 可视化开关:雷达射线 / 照明光束都默认不显示,勾选才显示(每帧 update/applyAux 不能覆盖状态)
const beamsDefault = await page.evaluate(() => ({
  group: window.__djiDebug.fly.radar.group.visible,
  flag: window.__djiDebug.fly.isRadarBeamsVisible(),
  reading: window.__djiDebug.fly.getRadarSnapshot().detecting,
}))
check(
  '雷达射线默认不显示(读数照常工作)',
  beamsDefault.group === false && beamsDefault.flag === false && beamsDefault.reading === true,
  JSON.stringify(beamsDefault),
)
await page.evaluate(() => window.__djiDebug.fly.setRadarBeamsVisible(true))
await page.waitForTimeout(300)
const beamsOn = await page.evaluate(() => window.__djiDebug.fly.radar.group.visible)
check('勾选"雷达射线"后显示(每帧 update 不覆盖)', beamsOn === true, `group=${beamsOn}`)
await page.evaluate(() => window.__djiDebug.fly.setRadarBeamsVisible(false))
await page.waitForTimeout(300)
const beamsOff = await page.evaluate(() => window.__djiDebug.fly.radar.group.visible)
check('取消勾选后又隐藏', beamsOff === false, `group=${beamsOff}`)
check(
  '照明光束默认不显示',
  (await page.evaluate(() => window.__djiDebug.fly.isAuxBeamVisible())) === false,
)
await shot('04-standby')

/* ═════════════════════ 4. 一键起飞 ═════════════════════ */
section('自动起飞')
await page.locator('[data-testid="btn-takeoff"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'flying'", 40000)
snapshot = await state()
check('已到达 1.2 米并进入悬停', Math.abs(snapshot.position.y - 1.2) < 0.05, `y=${snapshot.position.y.toFixed(2)}`)
check('电机已带载', snapshot.motorLoad > 0.4, `load=${snapshot.motorLoad.toFixed(2)}`)
await page.waitForFunction(
  () => Number((document.querySelector('[data-testid="snap-altitude"]').textContent ?? '').replace(/[^\d.]/g, '')) > 1.1,
  undefined,
  { timeout: 8000 },
)
check('HUD 高度实时刷新', true)
// 近地悬停(AGL 1.2m)时辅助灯自动点亮,但"照明光束"默认不勾选 → 朝下的锥形光柱不画
const auxHover = await page.evaluate(() => ({
  auxOn: window.__djiDebug.fly.lights.auxOn,
  beam: window.__djiDebug.fly.lights.auxBeam.visible,
}))
check('近地悬停时底部辅助灯点亮', auxHover.auxOn === true, JSON.stringify(auxHover))
check('未勾选"照明光束"时不画朝下光锥', auxHover.beam === false, `beam=${auxHover.beam}`)
await page.evaluate(() => window.__djiDebug.fly.setAuxBeamVisible(true))
await page.waitForTimeout(300)
check(
  '勾选"照明光束"后朝下光锥出现',
  (await page.evaluate(() => window.__djiDebug.fly.lights.auxBeam.visible)) === true,
)
await page.evaluate(() => window.__djiDebug.fly.setAuxBeamVisible(false))
await shot('05-hover')

/* ═════════════════════ 5. 虚拟摇杆:拖拽 + 自回中 ═════════════════════ */
section('虚拟双摇杆(美国手 Mode 2)')
const rightBox = await page.locator('.stick-pad').nth(1).boundingBox()
const rightCenter = { x: rightBox.x + rightBox.width / 2, y: rightBox.y + rightBox.height / 2 }
const pushY = rightBox.height / 2 - 3
await page.mouse.move(rightCenter.x, rightCenter.y - pushY)
await page.mouse.down()
await page.waitForTimeout(150)
snapshot = await state()
check('右杆推满前进 → 俯仰指令 +1', snapshot.stick.pitch > 0.9, `pitch=${snapshot.stick.pitch.toFixed(2)}`)
// 平飞测试本意是验证摇杆操纵,正前方 16m 的灯杆会触发飞控避障刹停干扰读数 → 临时关闭
await page.evaluate(() => {
  window.__djiDebug.fly.sim.faults.obstacleAvoidanceOff = true
})
await page.waitForTimeout(2500)
const forward = await state()
check(
  '开始平飞',
  Math.hypot(forward.velocity.x, forward.velocity.z) > 4,
  `v=${Math.hypot(forward.velocity.x, forward.velocity.z).toFixed(2)} m/s`,
)
check('机身前倾(俯仰为负)', forward.tiltPitch < -3, `pitch=${forward.tiltPitch.toFixed(1)}°`)
check('电机负荷上升', forward.motorLoad > 0.5, `load=${forward.motorLoad.toFixed(2)}`)
await page.evaluate(() => {
  window.__djiDebug.fly.sim.faults.obstacleAvoidanceOff = false
})
await shot('06-forward')

await page.mouse.up()
await page.waitForTimeout(3200)
snapshot = await state()
check('松杆自回中 → 俯仰指令归零', Math.abs(snapshot.stick.pitch) < 0.02, `pitch=${snapshot.stick.pitch.toFixed(3)}`)
check(
  '定点悬停刹停(水平速度 < 0.6)',
  Math.hypot(snapshot.velocity.x, snapshot.velocity.z) < 0.6,
  `v=${Math.hypot(snapshot.velocity.x, snapshot.velocity.z).toFixed(3)} m/s`,
)

const leftBox = await page.locator('.stick-pad').nth(0).boundingBox()
const leftCenter = { x: leftBox.x + leftBox.width / 2, y: leftBox.y + leftBox.height / 2 }
const climbBefore = (await state()).position.y
await page.mouse.move(leftCenter.x, leftCenter.y - (leftBox.height / 2 - 3))
await page.mouse.down()
await page.waitForTimeout(1600)
const climbing = await state()
check('左杆推满 → 油门指令 +1', climbing.stick.throttle > 0.9, `throttle=${climbing.stick.throttle.toFixed(2)}`)
check('无人机爬升', climbing.position.y > climbBefore + 3, `y=${climbing.position.y.toFixed(2)}`)
await page.mouse.up()
check('左杆松手自回中', Math.abs((await state()).stick.throttle) < 0.02)
await page.waitForTimeout(2800)
const held = await state()
check('松杆定高(垂直速度归零)', Math.abs(held.velocity.y) < 0.4, `vy=${held.velocity.y.toFixed(3)}`)

/* ═════════════════════ 6. 键盘摇杆 ═════════════════════ */
section('键盘映射')
await page.keyboard.down('ArrowUp')
await page.waitForTimeout(800)
check('↑ 键 = 右杆前进', (await state()).stick.pitch > 0.9)
await page.keyboard.up('ArrowUp')
await page.waitForTimeout(400)
check('松开 ↑ 键归中', Math.abs((await state()).stick.pitch) < 0.02)
await page.keyboard.press('m')
await page.waitForTimeout(500)
check('M 键循环到运动挡 S', (await state()).mode === 'sport', (await state()).mode)
await page.keyboard.press('m')
await page.waitForTimeout(400)
check('再按一次到平稳挡 C', (await state()).mode === 'cine', (await state()).mode)
await page.keyboard.press('m')
await page.waitForTimeout(400)
check('再按一次回到普通挡 N', (await state()).mode === 'normal')

/* ═════════════════════ 7. 相机视角与云台 ═════════════════════ */
section('相机视角与云台')
for (const [label, mode] of [
  ['跟随', 'follow'],
  ['机载', 'fpv'],
  ['观察者', 'orbit'],
]) {
  await page.locator(`.deck-center button:text-is("${label}")`).click()
  await page.waitForTimeout(400)
  check(`切换到${label}视角`, (await state()).cameraMode === mode)
  if (mode === 'fpv') await shot('07-camera-fpv')
}

const gimbalSlider = page.locator('[data-testid="gimbal-pitch"]')
await gimbalSlider.fill('-90')
await page.waitForTimeout(400)
check('云台滑块写到 -90°(俯视)', (await state()).gimbalPitch === -90, `${(await state()).gimbalPitch}`)
await gimbalSlider.fill('60')
await page.waitForTimeout(400)
check('云台滑块写到 +60°(上限)', (await state()).gimbalPitch === 60)
await page.locator('.panel-right button:text-is("云台回中")').click()
await page.waitForTimeout(400)
check('云台一键回中(-10°)', Math.abs((await state()).gimbalPitch + 10) < 0.01)
await page.locator('[data-testid="camera-zoom"]').fill('3')
await page.waitForTimeout(400)
check('变焦滑块生效', (await engine('window.__djiDebug.fly.sim.cameraZoom')) === 3)

/* ═════════════════════ 8. 参数面板 ═════════════════════ */
section('参数面板')
await page.locator('[data-testid="tab-config"]').click()
await page.waitForTimeout(300)
check(
  '参数页渲染',
  await page.locator('.panel-left .card-title span:text-is("飞行限制")').first().isVisible(),
)
await page.locator('.panel-left .segmented.three button:text-is("平稳挡 C")').click()
await page.waitForTimeout(400)
check('切换飞行挡位写入仿真', (await state()).mode === 'cine')
check(
  '挡位参数说明随挡位更新',
  (await page.locator('.panel-left .fine-print', { hasText: '水平 5 m/s' }).count()) > 0,
  await page.locator('.panel-left .card:has-text("飞行挡位") .fine-print').innerText(),
)

await page.locator('[data-testid="cfg-windSpeed"]').fill('8')
await page.waitForTimeout(400)
check('风速滑块写入仿真', (await engine('window.__djiDebug.fly.sim.config.windSpeed')) === 8)
await page.locator('[data-testid="cfg-windDirection"]').fill('90')
await page.waitForTimeout(400)
check('风向滑块写入仿真', (await engine('window.__djiDebug.fly.sim.config.windDirection')) === 90)
check(
  '风向文字为东',
  (await page.locator('.panel-left .fine-print', { hasText: '风吹向 东' }).count()) > 0,
  await page.locator('.panel-left .card:has-text("风场") .fine-print').innerText(),
)
await page.locator('[data-testid="cfg-windSpeed"]').fill('0')
await page.locator('[data-testid="cfg-windDirection"]').fill('0')
await page.waitForTimeout(400)
check('风速风向可复位', (await engine('window.__djiDebug.fly.sim.config.windSpeed')) === 0)

await page.locator('[data-testid="cfg-maxAltitude"]').fill('60')
await page.waitForTimeout(400)
check('限高写入仿真', (await engine('window.__djiDebug.fly.sim.config.maxAltitude')) === 60)
await page.locator('[data-testid="cfg-maxAltitude"]').fill('120')
await page.locator('[data-testid="cfg-rthAltitude"]').fill('30')
await page.waitForTimeout(400)
check('返航高度写入仿真', (await engine('window.__djiDebug.fly.sim.config.rthAltitude')) === 30)
await page.locator('[data-testid="cfg-rthAltitude"]').fill('20')
await page.locator('.panel-left .segmented.three button:text-is("普通挡 N")').click()
await waitSim("window.__djiDebug.fly.sim.mode === 'normal'", 10000)
check('挡位切回普通挡 N', true)

/* ═════════════════════ 9. 故障注入 ═════════════════════ */
section('故障注入')
await page.locator('[data-testid="tab-faults"]').click()
await page.waitForTimeout(300)
check('故障项共 7 个', (await page.locator('.fault-list .switch-row').count()) === 7)

await page.locator('[data-testid="fault-gnssLost"]').click()
await waitSim('window.__djiDebug.fly.sim.faults.gnssLost === true', 10000)
check('GNSS 丢失写入仿真', true)
check('定位模式降级(不再是卫星定位)', (await state()).positionSource !== 'gps', (await state()).positionSource)
check('GNSS 格数归零', (await state()).gpsBars === 0, `bars=${(await state()).gpsBars}`)
check('界面计数生效', (await page.locator('.panel-left :text-is("1 项生效中")').count()) > 0)
await shot('08-faults')

await page.locator('[data-testid="fault-gnssLost"]').click()
await waitSim('window.__djiDebug.fly.sim.faults.gnssLost === false', 10000)
await waitSim("window.__djiDebug.fly.sim.positionSource === 'gps'", 40000)
check('恢复 GNSS 后回到卫星定位', (await state()).positionSource === 'gps')

await page.locator('[data-testid="fault-compassError"]').click()
await waitSim('window.__djiDebug.fly.sim.faults.compassError === true', 10000)
await waitSim("window.__djiDebug.fly.sim.positionSource !== 'gps'", 30000)
check('指南针受扰 → 退出卫星定位', (await state()).positionSource !== 'gps', (await state()).positionSource)
await page.locator('[data-testid="fault-compassError"]').click()
await page.waitForTimeout(500)

/* ═════════════════════ 10. 灯光面板 ═════════════════════ */
section('灯光面板')
await page.locator('[data-testid="tab-lights"]').click()
await page.waitForTimeout(300)
await page.locator('.status-button:text-is("飞控严重故障")').click()
await waitSim("window.__djiDebug.fly.lightOverride === 'fcError'", 10000)
check('手动选择灯语 → 覆盖自动模式', (await state()).lightOverride === 'fcError')
check('状态灯跟随手动选择', (await state()).statusKey === 'fcError')
check('面板标注为手动覆盖', (await page.locator('.panel-left :text-is("手动覆盖")').count()) > 0)
await page.locator('.panel-left button:text-is("恢复自动跟随")').click()
await waitSim('window.__djiDebug.fly.lightOverride === null', 10000)
check('可恢复自动跟随', (await state()).lightOverride === null)
check('自动模式下灯语由飞行状态决定', (await state()).statusKey === 'motorRunning', (await state()).statusKey)

/* ═════════════════════ 11. 避障刹停(关闭避障对照) ═════════════════════ */
section('避障刹停')
// 建筑 A:x=16,z=-12,9×9,高 13 → 南面墙在 z=-7.5;探测器半径 1.6,故膨胀面在 z=-5.9
const installBrakeCounter = () =>
  page.evaluate(() => {
    const sim = window.__djiDebug.fly.sim
    window.__brakeCount = 0
    if (!sim.__brakeHook) {
      sim.__brakeHook = true
      const original = sim.step.bind(sim)
      sim.step = (delta) => {
        original(delta)
        if (sim.obstacleReport?.braking) window.__brakeCount += 1
      }
    }
  })
const placeInFrontOfBuilding = () =>
  page.evaluate(() => {
    const sim = window.__djiDebug.fly.sim
    sim.forceBatteryLevel(100)
    if (sim.phase !== 'flying') sim.phase = 'flying'
    sim.position.x = 16
    sim.position.z = -2
    sim.position.y = 3
    sim.velocity.x = 0
    sim.velocity.z = 0
    sim.velocity.y = 0
    sim.heading = 0
    sim.setStick({ pitch: 1, roll: 0, yaw: 0, throttle: 0 })
  })

await installBrakeCounter()
await placeInFrontOfBuilding()
await page.waitForTimeout(4000)
const brakeCount = await engine('window.__brakeCount')
const braked = await state()
check('避障触发刹停', brakeCount > 0, `braking 帧数=${brakeCount}`)
check('刹停方向为前方', braked.obstacle.brakingDirection === 'forward' || braked.obstacle.forward !== null, `dir=${braked.obstacle.brakingDirection}`)
check('前方障碍距离被测出', braked.obstacle.forward !== null, `forward=${braked.obstacle.forward?.toFixed(2)}`)
check('没有撞进建筑(开启避障)', braked.position.z > -7.5, `z=${braked.position.z.toFixed(2)}`)
await page.evaluate(() => window.__djiDebug.fly.sim.setStick({ pitch: 0 }))
await shot('09-obstacle')

await page.evaluate(() => {
  window.__djiDebug.fly.sim.faults.obstacleAvoidanceOff = true
})
await installBrakeCounter()
await placeInFrontOfBuilding()
await page.waitForTimeout(4000)
const noAvoid = await state()
check('关闭避障后不再刹停(对照)', (await engine('window.__brakeCount')) === 0)
check('关闭避障后径直穿过障碍物', noAvoid.position.z < -7.5, `z=${noAvoid.position.z.toFixed(2)}`)
await page.evaluate(() => {
  window.__djiDebug.fly.sim.faults.obstacleAvoidanceOff = false
  window.__djiDebug.fly.sim.setStick({ pitch: 0 })
})

/* ═════════════════════ 11.5 上视雷达:天桥正下方测距 + 灯杆近距 + 瞄准切换 ═════════════════════ */
section('上视雷达(机背双孔)')
// 天桥正下方:上视镜头朝正上方,应命中桥底
await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  sim.position.x = 0
  sim.position.y = 5.4
  sim.position.z = 10.5
  sim.velocity.x = 0
  sim.velocity.y = 0
  sim.velocity.z = 0
})
await page.waitForTimeout(300)
const radarUp = await page.evaluate(() => window.__djiDebug.fly.getRadarSnapshot())
check('天桥正下方上视左镜头命中天桥', radarUp.upLeft?.label === '天桥', JSON.stringify(radarUp.upLeft))
check('天桥正下方上视右镜头命中天桥', radarUp.upRight?.label === '天桥', JSON.stringify(radarUp.upRight))
const upDist = radarUp.upLeft?.distance ?? 0
check('上视距离与桥底高度吻合', upDist > 0.5 && upDist < 3, `dist=${upDist.toFixed(2)}`)

// 灯杆近距:摆到灯杆正前 5m,前视应报 ~4m
await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  sim.position.x = 0
  sim.position.y = 3
  sim.position.z = -11
  sim.velocity.x = 0
  sim.velocity.y = 0
  sim.velocity.z = 0
})
await page.waitForTimeout(300)
const radarNear = await page.evaluate(() => window.__djiDebug.fly.getRadarSnapshot())
check('灯杆正前 5m 处前视命中灯杆', radarNear.left?.label === '灯杆' && radarNear.right?.label === '灯杆', JSON.stringify({ L: radarNear.left, R: radarNear.right }))
const nearDist = radarNear.left?.distance ?? 0
check('灯杆距离约 4m', nearDist > 2.5 && nearDist < 5.5, `dist=${nearDist.toFixed(2)}`)

// 瞄准切换:切到镜头面朝向后快照应反映模式,切回 forward 恢复
await page.evaluate(() => window.__djiDebug.fly.setRadarAim('sensor'))
await page.waitForTimeout(400)
const aimSensor = await page.evaluate(() => window.__djiDebug.fly.getRadarSnapshot().aim)
check('瞄准切换到镜头面朝向', aimSensor === 'sensor', aimSensor)
await page.evaluate(() => window.__djiDebug.fly.setRadarAim('forward'))
await page.waitForTimeout(400)
const aimForward = await page.evaluate(() => window.__djiDebug.fly.getRadarSnapshot().aim)
check('瞄准切回正前/正上', aimForward === 'forward', aimForward)
await shot('11b-up-radar')

/* ═════════════════════ 12. 遥控失联 → 自动返航 ═════════════════════ */
section('遥控失联 → 失效保护返航')
await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  sim.forceBatteryLevel(100)
  sim.position.x = 25
  sim.position.z = 18
  sim.position.y = 12
  sim.velocity.x = 0
  sim.velocity.z = 0
  sim.velocity.y = 0
  sim.setStick({ pitch: 0, roll: 0, yaw: 0, throttle: 0 })
  sim.faults.rcLost = true
})
await waitSim("window.__djiDebug.fly.sim.phase === 'rth'", 30000)
check('失联 3 秒后自动触发返航', (await state()).phase === 'rth')
check('返航原因为遥控信号丢失', (await state()).rthReason === '遥控信号丢失', (await state()).rthReason)
check('遥控信号格数归零', (await state()).rcBars === 0, `bars=${(await state()).rcBars}`)
await waitSim('window.__djiDebug.fly.sim.position.y >= 19.5', 60000)
check('先爬升到返航高度 20 米', true, `y=${(await state()).position.y.toFixed(1)}`)
await page.evaluate(() => {
  window.__djiDebug.fly.sim.faults.rcLost = false
})
await waitSim("window.__djiDebug.fly.sim.phase === 'standby'", 180000)
const landed = await state()
check('自动返航并降落完成', landed.phase === 'standby' && landed.position.y === 0)
check(
  '落点回到返航点上方',
  Math.hypot(landed.position.x, landed.position.z) < 1.2,
  `(${landed.position.x.toFixed(2)}, ${landed.position.z.toFixed(2)})`,
)
const events = await page.locator('[data-testid="event-log"] li .m').allInnerTexts()
check('事件日志记录完整返航流程', events.some((text) => text.includes('已安全降落')), events.slice(0, 2).join(' / '))
await shot('10-landed')

/* ═════════════════════ 13. 电池与低电量保护 ═════════════════════ */
section('电池与低电量保护')
await page.evaluate(() => window.__djiDebug.fly.sim.autoTakeOff())
await waitSim("window.__djiDebug.fly.sim.phase === 'flying'", 40000)
const beforeDrain = (await state()).batteryPercent
await page.waitForTimeout(3000)
const afterDrain = (await state()).batteryPercent
check('悬停持续耗电', afterDrain < beforeDrain, `${beforeDrain.toFixed(2)}% → ${afterDrain.toFixed(2)}%`)
check(
  '电池分项遥测可读',
  (await engine('window.__djiDebug.fly.sim.batteryVoltage')) > 6.5,
  `V=${(await engine('window.__djiDebug.fly.sim.batteryVoltage')).toFixed(2)}`,
)
await page.evaluate(() => window.__djiDebug.fly.sim.forceBatteryLevel(12))
await waitSim('window.__djiDebug.fly.sim.lowBattery === true', 10000)
check('进入低电量预警', true)
await page.locator('[data-testid="tab-lights"]').click()
await waitSim("window.__djiDebug.fly.lights.statusKey === 'lowBattery'", 15000)
check('状态灯切为低电量(红灯慢闪)', (await state()).statusKey === 'lowBattery')
await page.locator('[data-testid="tab-flight"]').click()
const warnText = (await page.locator('.warn-list').count())
  ? (await page.locator('.warn-list').innerText()).replace(/\n/g, ' ')
  : ''
check('界面出现低电量警告', warnText.includes('低电量'), warnText)
await page.evaluate(() => window.__djiDebug.fly.sim.forceBatteryLevel(8))
await waitSim("window.__djiDebug.fly.sim.phase === 'landing' || window.__djiDebug.fly.sim.phase === 'rth' || window.__djiDebug.fly.sim.phase === 'standby'", 60000)
check('严重低电量触发强制降落', (await state()).phase !== 'flying', (await state()).phase)
await waitSim("window.__djiDebug.fly.sim.phase === 'standby'", 90000)
check('强制降落完成并停桨', (await state()).phase === 'standby')
await shot('11-lowbattery')

/* ═════════════════════ 14. 重置与停桨(仅落地后允许) ═════════════════════ */
section('重置与停桨(仅落地后允许)')
await page.evaluate(() => window.__djiDebug.fly.sim.forceBatteryLevel(100))
await page.locator('[data-testid="tab-flight"]').click()
await page.locator('[data-testid="btn-reset"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'powerOff'", 10000)
snapshot = await state()
check('重置回到未上电', snapshot.phase === 'powerOff')
check('重置后电量恢复 100%', snapshot.batteryPercent === 100, `${snapshot.batteryPercent}%`)
check('重置后坐标归零', snapshot.position.x === 0 && snapshot.position.z === 0)
await page.locator('[data-testid="btn-power"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'standby'", 60000)
await page.locator('[data-testid="btn-takeoff"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'flying'", 40000)

/*
 * 停桨保护:飞行器没落地前禁止紧急停桨 —— 按钮禁用,且直接调引擎接口也必须被拒绝,
 * 既不改变飞行状态、也不损伤机体(只写一条警告日志)。
 */
const emergencyButton = page.locator('[data-testid="btn-emergency"]')
check('飞行中停桨按钮被禁用', await emergencyButton.isDisabled())
check(
  '按钮文案提示需先落地',
  (await emergencyButton.innerText()).includes('需先落地'),
  (await emergencyButton.innerText()).trim(),
)
check(
  '引擎接口拒绝空中停桨',
  (await page.evaluate(() => window.__djiDebug.fly.sim.emergencyStop())) === false,
)
await page.waitForTimeout(400)
const airStop = await state()
check('拒绝后仍在飞行且机体未受损', airStop.phase === 'flying' && !airStop.damaged, `phase=${airStop.phase}`)
// ⚠️ sim.events 是 unshift 维护的倒序数组 —— 最新一条在 [0]
const lastEvent = await engine("window.__djiDebug.fly.sim.events[0]")
check('拒绝原因写入事件日志', String(lastEvent.text).includes('请先降落'), JSON.stringify(lastEvent))

// 降落 → 落地后用停桨:只停电机,不损伤机体
await page.locator('[data-testid="btn-land"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'standby'", 90000)
check('自动降落后回到地面待机', (await state()).phase === 'standby')
await page.locator('[data-testid="btn-motors"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'motorsOn'", 20000)
// 界面快照是 100ms 轮询,等它把 phase 同步过来再断言按钮状态
await page.waitForTimeout(500)
check('落地后停桨按钮可用', !(await emergencyButton.isDisabled()))
await emergencyButton.click()
await waitSim("window.__djiDebug.fly.sim.phase === 'standby'", 20000)
const groundStop = await state()
check(
  '地面停桨只停电机、机体未受损',
  groundStop.phase === 'standby' && !groundStop.damaged,
  `phase=${groundStop.phase} damaged=${groundStop.damaged}`,
)

// 真实损坏路径(电池耗尽 → 空中动力丧失坠落)仍必须标记受损并禁止再起飞
await page.locator('[data-testid="btn-takeoff"]').click()
await waitSim("window.__djiDebug.fly.sim.phase === 'flying'", 40000)
await page.evaluate(() => window.__djiDebug.fly.sim.forceBatteryLevel(0))
await waitSim("window.__djiDebug.fly.sim.phase === 'stopped'", 90000)
check('电池耗尽空中失控坠地受损', (await state()).damaged)
check('受损后禁止起飞', await page.locator('[data-testid="btn-takeoff"]').isDisabled())
await shot('12-ground-stop')

/* ═════════════════════ 汇总 ═════════════════════ */
section('控制台错误')
const filtered = errors.filter((text) => !/favicon|DevTools|Download the Vue|WebGPU/i.test(text))
check('无控制台错误', filtered.length === 0, filtered.slice(0, 3).join(' | '))

console.log(`\n════════ 结果:${results.length - failed}/${results.length} 通过 ════════`)
if (failed > 0) {
  console.log('失败项:')
  results.filter((item) => !item.ok).forEach((item) => console.log(`  ✗ ${item.name} │ ${item.detail}`))
}

await browser.close()
process.exit(failed > 0 ? 1 : 0)
