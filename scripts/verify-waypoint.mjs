/**
 * 航点任务(Waypoint Mission)专项回归。
 *
 * 覆盖:
 *  - 航线编辑器:示例航线载入、航点增删改、执行中禁止编辑(fieldset disabled);
 *  - 三维可视化:航点标记 / 航线折线的显隐开关、当前目标高亮跟随;
 *  - 地面「执行航线」→ 自动起飞 → 到 1.2 米自动接上航线;
 *  - 到点推进与航点到点动作(云台俯仰 + 拍照计数);
 *  - 执行中拨动摇杆 → 任务暂停并交回手动控制,「继续」飞回当前航点;
 *  - 「停止任务」→ 原地悬停且航线归零;
 *  - 结束动作 = 自动返航(任务跑完自动触发 RTH);
 *  - 起飞前校验:航点超限高 / 超限距 / 姿态模式(无 GNSS)一律拒绝启动;
 *  - 零控制台错误。
 *
 * 用法:先起 dev server,再 `node scripts/verify-waypoint.mjs [url]`
 * 环境变量:SHOTS=1 时把截图写到 .verify-shots/
 *
 * 说明:无头 Chromium 下 WebGPU 回退 WebGL2,只有 2~3 FPS;引擎按固定步长补帧,
 * 所以断言全部按"事件发生"而不是"精确时刻"来等,并用 timeScale 加速仿真。
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
const section = (title) => console.log(`\n──── ${title} ────`)

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

const shot = async (name) => {
  if (SHOOT) await page.screenshot({ path: join(SHOT_DIR, `waypoint-${name}.png`) })
}

/** 读取引擎真值 */
const missionState = () =>
  page.evaluate(() => {
    const fly = window.__djiDebug.fly
    const sim = fly.sim
    const snap = sim.snapshot()
    return {
      phase: sim.phase,
      status: snap.mission.status,
      stage: snap.mission.stage,
      index: snap.mission.index,
      total: snap.mission.total,
      progress: snap.mission.progress,
      distanceLeft: snap.mission.distanceLeft,
      pauseReason: snap.mission.pauseReason,
      statusLabel: snap.mission.statusLabel,
      config: { ...snap.mission.config },
      waypoints: snap.mission.waypoints.map((w) => ({ ...w })),
      photoCount: sim.photoCount,
      position: { x: sim.position.x, y: sim.position.y, z: sim.position.z },
      positionSource: sim.positionSource,
      events: sim.events.slice(0, 8).map((e) => e.text),
      missionMarkers: fly.world?.missionMarkerNodes?.length ?? -1,
      missionPathLines: fly.world?.missionPathGroup?.children?.length ?? -1,
      missionVisible: fly.world?.isMissionVisible?.() ?? null,
      missionMarkersVisible: fly.world?.isMissionWaypointsVisible?.() ?? null,
      missionPathVisible: fly.world?.isMissionPathVisible?.() ?? null,
      activeVisible: fly.world?.missionActiveGroup?.visible ?? null,
    }
  })

const waitSim = (expression, timeout = 30000, label = '') =>
  page.waitForFunction(expression, undefined, { timeout }).catch(() => {
    throw new Error(`等待超时:${label || expression}`)
  })

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1500)

// ═══════════════ A. 航线编辑器与可视化 ═══════════════
section('A. 航线编辑器与可视化')

const tabExists = await page.locator('[data-testid="tab-mission"]').count()
check('面板新增「航线」分页', tabExists === 1, `${tabExists} 个`)

await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(400)

const initial = await missionState()
check('出厂自带示例航线(5 个航点)', initial.total === 5 && initial.waypoints.length === 5, `${initial.total} 个`)
check(
  '航点卡片按序渲染在面板上',
  (await page.locator('[data-testid="waypoint-list"] > li').count()) === 5,
  `${await page.locator('[data-testid="waypoint-list"] > li').count()} 行`,
)
check(
  '三维场景里画出航点标记与航线折线',
  initial.missionMarkers === 5 && initial.missionPathLines === 1,
  `${initial.missionMarkers} 个航点标记 + ${initial.missionPathLines} 条航线`,
)
check('HUD 出现航线任务卡', (await page.locator('[data-testid="hud-mission"]').count()) === 1, '')
check(
  '未执行时进度显示为待执行',
  (await page.locator('[data-testid="hud-mission"] .progress-head span').first().textContent()).includes('待执行'),
  await page.locator('[data-testid="hud-mission"] .progress-head span').first().textContent(),
)
await shot('editor')

// 显隐开关(开关在「飞行」分页的图层区;航点与航线已拆成两个独立开关)
await page.click('[data-testid="tab-flight"]')
await page.waitForTimeout(300)
const waypointToggle = page.locator('[data-testid="toggle-mission-waypoints"]')
const pathToggle = page.locator('[data-testid="toggle-mission-path"]')
await waypointToggle.uncheck()
await page.waitForTimeout(300)
const hiddenMarkers = await missionState()
check(
  '取消勾选「显示航点」后航点标记隐藏,航线仍在',
  hiddenMarkers.missionMarkersVisible === false && hiddenMarkers.missionPathVisible === true,
  `markers=${hiddenMarkers.missionMarkersVisible} / path=${hiddenMarkers.missionPathVisible}`,
)
await waypointToggle.check()
await page.waitForTimeout(200)
await pathToggle.uncheck()
await page.waitForTimeout(300)
const hiddenPath = await missionState()
check(
  '取消勾选「显示航线」后航线折线隐藏,航点仍在',
  hiddenPath.missionMarkersVisible === true && hiddenPath.missionPathVisible === false,
  `markers=${hiddenPath.missionMarkersVisible} / path=${hiddenPath.missionPathVisible}`,
)
await pathToggle.check()
await page.waitForTimeout(300)
const shown = await missionState()
check(
  '重新勾选后全部恢复显示',
  shown.missionMarkersVisible === true && shown.missionPathVisible === true,
  `markers=${shown.missionMarkersVisible} / path=${shown.missionPathVisible}`,
)
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)

// 编辑航点
const firstX = page.locator('[data-testid="waypoint-0"] .wp-row').first().locator('input').first()
await firstX.fill('5')
await page.waitForTimeout(300)
const edited = await missionState()
check('修改航点 X 即时下发到仿真内核', edited.waypoints[0].x === 5, `x=${edited.waypoints[0].x}`)
const draftKept = await firstX.inputValue()
check('输入框不被快照回写打断(草稿保留)', draftKept === '5', `输入框值 "${draftKept}"`)

await page.click('[data-testid="mission-add"]')
await page.waitForTimeout(300)
const added = await missionState()
check('添加航点', added.total === 6, `${added.total} 个`)
await page.click('[data-testid="waypoint-remove-5"]')
await page.waitForTimeout(300)
const removed = await missionState()
check('删除航点', removed.total === 5, `${removed.total} 个`)

// ═══════════════ B. 地面执行航线:自动起飞后自动接上航线 ═══════════════
section('B. 地面执行航线(自动起飞 → 自动开航线)')

await page.click('[data-testid="tab-flight"]')
await page.click('[data-testid="btn-power"]')
await waitSim('window.__djiDebug.fly.sim.phase === "standby"', 60000, '等待地面待机')
await page.evaluate(() => window.__djiDebug.fly.setConfig({ timeScale: 3 }))
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)

// 启航段的四步只能逐帧看:钩住 sim.step,记录每次阶段切换与逐帧位移
await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  const log = []
  const frames = []
  let lastStage = sim.missionStage
  const original = sim.step.bind(sim)
  sim.step = (delta) => {
    const before = {
      x: sim.position.x,
      y: sim.position.y,
      z: sim.position.z,
    }
    original(delta)
    if (sim.phase === 'waypoint') {
      const first = sim.mission[0]
      frames.push({
        stage: sim.missionStage,
        horizontal: Math.hypot(sim.position.x - before.x, sim.position.z - before.z),
        vertical: Math.abs(sim.position.y - before.y),
        x: sim.position.x,
        y: sim.position.y,
        z: sim.position.z,
        heading: sim.heading,
        distance: first ? Math.hypot(first.x - sim.position.x, first.z - sim.position.z) : -1,
      })
    }
    if (sim.missionStage !== lastStage) {
      log.push({
        stage: sim.missionStage,
        index: sim.missionIndex,
        y: sim.position.y,
        heading: sim.heading,
      })
      lastStage = sim.missionStage
    }
  }
  window.__departLog = { log, frames }
})

await page.click('[data-testid="mission-start"]')
await page.waitForTimeout(400)
const pending = await missionState()
check(
  '地面启动航线会先自动起飞并给出下发提示',
  pending.events.some((text) => text.includes('航线已下发')),
  pending.events[0] ?? '',
)

await waitSim('window.__djiDebug.fly.sim.phase === "waypoint"', 60000, '等待进入航线执行')
const started = await missionState()
check('起飞到位后自动进入航线执行(phase=waypoint)', started.phase === 'waypoint', started.phase)
check(
  '事件日志记录航线开始',
  started.events.some((text) => text.includes('开始执行航线任务')),
  started.events[0] ?? '',
)
check('航线状态为执行中', started.status === 'running', `${started.status} · ${started.statusLabel}`)
await page.waitForTimeout(600)
const activeVisible = await missionState()
check('当前目标航点高亮已生效', activeVisible.activeVisible === true, `activeVisible=${activeVisible.activeVisible}`)
await shot('running')

// —— 启航四步:垂直调整 → 水平飞向首航点 → 收高度 → 对准航线 ——
await waitSim("window.__djiDebug.fly.sim.missionStage === 'depart-cruise'", 90000, '等待垂直段结束')
const climbDone = await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  const frames = window.__departLog.frames.filter((frame) => frame.stage === 'depart-climb')
  return {
    stage: sim.missionStage,
    y: sim.position.y,
    target: sim.mission[0]?.altitude ?? 0,
    steps: frames.length,
    maxHorizontal: frames.reduce((max, frame) => Math.max(max, frame.horizontal), 0),
    maxVertical: frames.reduce((max, frame) => Math.max(max, frame.vertical), 0),
    hud: document.querySelector('[data-testid="hud-mission"] .progress-head span')?.textContent ?? '',
    events: sim.events.slice(0, 6).map((event) => event.text),
  }
})
check(
  '启航第一步垂直段只动高度(水平位移恒为 0)',
  climbDone.maxHorizontal < 0.002 && climbDone.maxVertical > 0.02,
  `${climbDone.steps} 帧 · 水平 ${climbDone.maxHorizontal.toFixed(4)} m / 垂直 ${climbDone.maxVertical.toFixed(4)} m`,
)
check(
  '垂直段升到首航点高度后才转水平段',
  climbDone.stage === 'depart-cruise' && Math.abs(climbDone.y - climbDone.target) <= 0.3,
  `${climbDone.stage} · y=${climbDone.y.toFixed(2)} / 目标 ${climbDone.target} m`,
)
check('HUD 在启航段显示「启航」而不是航点序号', climbDone.hud.includes('启航'), climbDone.hud)
check(
  '事件日志记录垂直段结果',
  climbDone.events.some((text) => text.includes('已垂直调整到')),
  climbDone.events[0] ?? '',
)

await waitSim("window.__djiDebug.fly.sim.missionStage === 'goto'", 120000, '等待启航段结束')
const depart = await page.evaluate(() => {
  const sim = window.__djiDebug.fly.sim
  const { log, frames } = window.__departLog
  const waypoint = sim.mission[0]
  const next = sim.mission[1]
  const summarize = (stage) => {
    const list = frames.filter((frame) => frame.stage === stage)
    const last = list[list.length - 1] ?? null
    return {
      steps: list.length,
      maxHorizontal: list.reduce((max, frame) => Math.max(max, frame.horizontal), 0),
      maxVertical: list.reduce((max, frame) => Math.max(max, frame.vertical), 0),
      maxAltitudeDeviation: list.reduce(
        (max, frame) => Math.max(max, Math.abs(frame.y - (waypoint?.altitude ?? 0))),
        0,
      ),
      firstDistance: list[0]?.distance ?? -1,
      lastDistance: last?.distance ?? -1,
    }
  }
  return {
    stages: log.map((entry) => entry.stage),
    cruise: summarize('depart-cruise'),
    settle: summarize('depart-settle'),
    align: summarize('depart-align'),
    routeHeading:
      waypoint && next
        ? (Math.atan2(next.x - waypoint.x, -(next.z - waypoint.z)) * 180) / Math.PI
        : 0,
    waypoint: waypoint ? { ...waypoint } : null,
    index: sim.missionIndex,
    heading: sim.heading,
    position: { ...sim.position },
    events: sim.events.slice(0, 10).map((event) => event.text),
  }
})

check(
  '启航段按「垂直 → 水平 → 收高度 → 对准」四步依次执行',
  depart.stages.slice(0, 4).join(' → ') ===
    'depart-climb → depart-cruise → depart-settle → depart-align',
  depart.stages.join(' → '),
)
check(
  '水平段保持首航点高度(高度偏差不超过 0.5 m)',
  depart.cruise.maxAltitudeDeviation <= 0.5 && depart.cruise.maxHorizontal > 0.05,
  `高度偏差 ${depart.cruise.maxAltitudeDeviation.toFixed(3)} m · 单帧水平 ${depart.cruise.maxHorizontal.toFixed(3)} m`,
)
check(
  '水平段一路向首航点收敛',
  depart.cruise.lastDistance < depart.cruise.firstDistance - 5,
  `剩 ${depart.cruise.firstDistance.toFixed(1)} → ${depart.cruise.lastDistance.toFixed(1)} m`,
)
check(
  '收高度段原地不动(水平位移为 0)',
  depart.settle.maxHorizontal < 0.002,
  `水平 ${depart.settle.maxHorizontal.toFixed(4)} m`,
)
check(
  '对准段原地转身(水平与垂直位移都为 0)',
  depart.align.maxHorizontal < 0.002 && depart.align.maxVertical < 0.002,
  `水平 ${depart.align.maxHorizontal.toFixed(4)} / 垂直 ${depart.align.maxVertical.toFixed(4)}`,
)
check(
  '对准段把机头转到与航线一致',
  Math.abs(((depart.heading - depart.routeHeading + 540) % 360) - 180) <= 4,
  `机头 ${depart.heading.toFixed(1)}° / 航线 ${depart.routeHeading.toFixed(1)}°`,
)
check(
  '飞到第 1 个航点上方并对准之后才开始执行航线',
  depart.index === 1 && depart.align.lastDistance >= 0 && depart.align.lastDistance <= 0.35,
  // 注意:不能用"当前机位"判 —— 此刻飞机已经离开首航点飞向第 2 个点了,要看对准段最后那一帧
  `对准段结束时距首航点 ${depart.align.lastDistance.toFixed(2)} m · 之后 index=${depart.index}`,
)
check(
  '事件日志记录对准航线方向',
  depart.events.some((text) => text.includes('机头已对准航线方向')),
  depart.events[0] ?? '',
)

// 到点推进
await waitSim('window.__djiDebug.fly.sim.missionIndex >= 1', 120000, '等待到达第 1 个航点')
const reached = await missionState()
check('飞抵第 1 个航点后推进到下一个', reached.index >= 1, `index=${reached.index}`)
check(
  '事件日志记录到达航点',
  reached.events.some((text) => text.includes('到达航点 1/5')),
  reached.events[0] ?? '',
)
check('航点到点动作触发拍照', reached.photoCount >= 1, `photoCount=${reached.photoCount}`)
check('进度按航程折算并前进', reached.progress > 0, `progress=${reached.progress.toFixed(3)}`)

const pctText = await page.locator('[data-testid="hud-mission"] .progress-head em').first().textContent()
check('HUD 进度百分比同步', /\d+%/.test(pctText) && Number.parseInt(pctText, 10) > 0, pctText)

// ═══════════════ C. 摇杆打断 → 暂停 → 继续 → 停止 ═══════════════
section('C. 摇杆打断 / 暂停 / 继续 / 停止')

// 起步保护期(1 s 仿真时间)过后再打杆
await page.waitForTimeout(1600)
await page.evaluate(() => window.__djiDebug.fly.setStick({ pitch: 1 }))
await waitSim('window.__djiDebug.fly.sim.missionStatus === "paused"', 15000, '等待任务暂停')
const paused = await missionState()
check('执行中拨动摇杆 → 任务暂停', paused.status === 'paused', `${paused.status} · ${paused.statusLabel}`)
check('暂停后交回手动控制(phase=flying)', paused.phase === 'flying', paused.phase)
check('暂停原因被记录', paused.pauseReason.includes('摇杆'), paused.pauseReason)
check(
  'HUD 显示暂停原因',
  (await page.locator('[data-testid="mission-pause-reason"]').count()) === 1,
  await page.locator('[data-testid="mission-pause-reason"]').textContent(),
)
await shot('paused')

await page.evaluate(() => window.__djiDebug.fly.setStick({ pitch: 0 }))
await page.waitForTimeout(300)
const manualBefore = (await missionState()).position
await page.evaluate(() => window.__djiDebug.fly.setStick({ pitch: 1 }))
await page.waitForTimeout(1800)
await page.evaluate(() => window.__djiDebug.fly.setStick({ pitch: 0 }))
const manualAfter = (await missionState()).position
check(
  '暂停期间摇杆可以手动飞行',
  Math.hypot(manualAfter.x - manualBefore.x, manualAfter.z - manualBefore.z) > 0.5,
  `位移 ${Math.hypot(manualAfter.x - manualBefore.x, manualAfter.z - manualBefore.z).toFixed(2)} m`,
)

await page.click('[data-testid="mission-resume"]')
await page.waitForTimeout(400)
const resumed = await missionState()
check('「继续」回到航线执行', resumed.status === 'running' && resumed.phase === 'waypoint', `${resumed.status}/${resumed.phase}`)

await page.waitForTimeout(1200)
await page.click('[data-testid="mission-stop"]')
await page.waitForTimeout(400)
const stopped = await missionState()
check('「停止任务」后航线归零并原地悬停', stopped.status === 'idle' && stopped.phase === 'flying', `${stopped.status}/${stopped.phase}`)
check(
  '停止后事件日志留痕',
  stopped.events.some((text) => text.includes('航线任务已中止')),
  stopped.events[0] ?? '',
)
check(
  '停止后航点列表恢复可编辑',
  (await page.evaluate(
    () => document.querySelector('.waypoint-fieldset input')?.matches(':disabled') === false,
  )) === true,
  '',
)
await shot('stopped')

// 启航段中途暂停 → 继续:应当接着走启航段,而不是斜着直接飞向首航点。
// 这里在同一帧里手动推 step 来做确定性验证(真机节奏下"爬升中打杆"很难踩准)。
const departResumeProbe = await page.evaluate(() => {
  const fly = window.__djiDebug.fly
  const sim = fly.sim
  const log = []
  const record = (label) => log.push({ label, status: sim.missionStatus, stage: sim.missionStage })
  fly.startMission()
  record('启动')
  sim.missionStickGrace = 0 // 跳过起步保护期,模拟"垂直爬升到一半被摇杆打断"
  fly.setStick({ pitch: 1 })
  sim.step(1 / 60)
  record('打杆')
  fly.setStick({ pitch: 0 })
  fly.resumeMission()
  record('继续')
  fly.stopMission('回归脚本')
  return log
})
const departResumeText = departResumeProbe.map((entry) => `${entry.label}=${entry.status}/${entry.stage}`).join(' │ ')
check(
  '启航段途中打杆会暂停任务(阶段保留在启航段)',
  departResumeProbe[1].status === 'paused' && departResumeProbe[1].stage === 'depart-climb',
  departResumeText,
)
check(
  '启航段中途「继续」接着走启航段(而不是直接飞向首航点)',
  departResumeProbe[2].status === 'running' && departResumeProbe[2].stage === 'depart-climb',
  departResumeText,
)

// 执行中不可编辑
await page.evaluate(() => window.__djiDebug.fly.startMission())
await page.waitForTimeout(900)
const lockState = await page.evaluate(() => ({
  status: window.__djiDebug.fly.sim.missionStatus,
  phase: window.__djiDebug.fly.sim.phase,
  fieldsetDisabled: document.querySelector('.waypoint-fieldset')?.disabled ?? null,
  // ⚠️ 内层控件的 element.disabled 不反映祖先 fieldset 的禁用态,必须用 :disabled 选择器判定
  innerDisabled: document.querySelector('.waypoint-fieldset input')?.matches(':disabled') ?? null,
  removeDisabled: document.querySelector('[data-testid="waypoint-remove-0"]')?.matches(':disabled') ?? null,
}))
check(
  '航线执行中航点列表被锁定(不可编辑)',
  lockState.fieldsetDisabled === true && lockState.innerDisabled === true && lockState.removeDisabled === true,
  JSON.stringify(lockState),
)
await page.evaluate(() => window.__djiDebug.fly.stopMission('回归脚本'))

// ═══════════════ D. 结束动作 = 自动返航 ═══════════════
section('D. 结束动作(需求完成 → 自动返航)')

await page.click('[data-testid="tab-flight"]')
await page.click('[data-testid="btn-land"]')
await waitSim('window.__djiDebug.fly.sim.phase === "standby"', 90000, '等待落地')
await page.evaluate(() => {
  const fly = window.__djiDebug.fly
  fly.setConfig({ timeScale: 8 })
  fly.setMission([{ x: 0, z: -4, altitude: 4, speed: 4, hoverSeconds: 0, gimbalPitch: null, action: 'none' }])
  fly.setMissionConfig({ finishAction: 'rth' })
})
await page.waitForTimeout(300)
const mini = await missionState()
check('切换到单航点迷你航线', mini.total === 1, `${mini.total} 个`)
check('结束动作已设为自动返航', mini.config.finishAction === 'rth', mini.config.finishAction)

await page.evaluate(() => window.__djiDebug.fly.startMission())
await waitSim('window.__djiDebug.fly.sim.phase === "rth"', 180000, '等待任务完成后自动返航')
const finished = await missionState()
check('航线跑完自动触发返航(RTH)', finished.phase === 'rth', finished.phase)
check(
  '事件日志记录航线完成',
  finished.events.some((text) => text.includes('航线任务完成')),
  finished.events.find((text) => text.includes('航线任务完成')) ?? finished.events[0] ?? '',
)
check('任务状态回落到未执行', finished.status === 'idle', finished.status)
await shot('finished-rth')

// ═══════════════ E. 启动前校验 ═══════════════
section('E. 启动前校验(限高 / 限距 / 无定位)')

await page.evaluate(() => window.__djiDebug.fly.sim.startRth('回归脚本复位'))
await waitSim('window.__djiDebug.fly.sim.phase === "standby"', 180000, '等待落地复位')
await page.evaluate(() => window.__djiDebug.fly.resetMissionToDefault())
await page.waitForTimeout(300)

const altitudeReject = await page.evaluate(() => {
  const fly = window.__djiDebug.fly
  fly.setMission([{ x: 0, z: -20, altitude: 400 }])
  const ok = fly.startMission()
  return { ok, events: fly.sim.events.slice(0, 3).map((e) => e.text) }
})
check(
  '航点超限高被拒绝',
  altitudeReject.ok === false && altitudeReject.events.some((t) => t.includes('超过限高')),
  altitudeReject.events[0] ?? '',
)

const distanceReject = await page.evaluate(() => {
  const fly = window.__djiDebug.fly
  fly.setMission([{ x: 0, z: -900, altitude: 30 }])
  const ok = fly.startMission()
  return { ok, events: fly.sim.events.slice(0, 3).map((e) => e.text) }
})
check(
  '航点超限距被拒绝',
  distanceReject.ok === false && distanceReject.events.some((t) => t.includes('超过限距')),
  distanceReject.events[0] ?? '',
)

const attiReject = await page.evaluate(async () => {
  const fly = window.__djiDebug.fly
  fly.setFaults({ gnssLost: true, visionLost: true })
  fly.resetMissionToDefault()
  await new Promise((resolve) => setTimeout(resolve, 900))
  const ok = fly.startMission()
  const result = {
    ok,
    source: fly.sim.positionSource,
    events: fly.sim.events.slice(0, 3).map((e) => e.text),
  }
  fly.setFaults({ gnssLost: false, visionLost: false })
  return result
})
check(
  '姿态模式(无定位)拒绝执行航点任务',
  attiReject.ok === false && attiReject.events.some((t) => t.includes('姿态模式')),
  `${attiReject.source} · ${attiReject.events[0] ?? ''}`,
)

check(
  '空航线也拒绝启动',
  (await page.evaluate(() => {
    const fly = window.__djiDebug.fly
    fly.setMission([])
    const ok = fly.startMission()
    const events = fly.sim.events.slice(0, 2).map((e) => e.text)
    fly.resetMissionToDefault()
    return ok === false && events.some((t) => t.includes('航点列表为空'))
  })) === true,
  '',
)

// ═══════════════ F. 任务参数下发 ═══════════════
section('F. 任务参数下发')

await page.waitForTimeout(300)
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)
await page.click('[data-testid="mission-heading-fixed"]')
await page.click('[data-testid="mission-path-curved"]')
await page.click('[data-testid="mission-finish-land"]')
await page.click('[data-testid="mission-loop"]')
await page.waitForTimeout(400)
const params = await missionState()
check(
  '机头朝向 / 过点方式 / 结束动作 / 循环全部下发到内核',
  params.config.headingMode === 'fixed' &&
    params.config.pathMode === 'curved' &&
    params.config.finishAction === 'land' &&
    params.config.loop === true,
  JSON.stringify(params.config),
)

// 键盘快捷键
await page.click('[data-testid="tab-flight"]')
await page.evaluate(() => window.__djiDebug.fly.sim.powerOn())
await page.evaluate(() => window.__djiDebug.fly.setConfig({ timeScale: 1 }))
await page.keyboard.press('g')
await page.waitForTimeout(500)
const hotkey = await missionState()
check(
  'G 快捷键启动航线',
  hotkey.status !== 'idle' || hotkey.phase === 'takingOff',
  `${hotkey.status}/${hotkey.phase}`,
)
await page.evaluate(() => window.__djiDebug.fly.stopMission('回归脚本收尾'))

// ═══════════════ G. 控制台 ═══════════════
section('G. 控制台')
const realErrors = errors.filter(
  (text) => !text.includes('WebGPU') && !text.includes('Error creating') && !text.includes('deprecated'),
)
check('无控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ｜ ') || '干净')

console.log(`\n════════ 结果:${pass}/${pass + fail} 通过 ════════`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
