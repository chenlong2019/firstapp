/**
 * 场景内航点编辑(Mission Scene Edit)专项回归。
 *
 * 覆盖:
 *  - 航点列表有最大高度、超出时在列表内部滚动(不会把左侧面板一直撑长);
 *  - 「显示航点」「显示航线」两个独立开关各管一层,互不牵连;
 *  - 场景编辑开关:开启后自动把整条航线框进画面(默认机位贴着飞机,航点全在画面外);
 *  - 真实鼠标拖拽航点 → 内核坐标与三维标记同步改变(原位更新,不整层重建);
 *  - Shift + 拖拽 → 改高度;高度受「限高」夹紧;
 *  - 双击地面 → 在该处插入航点(按折线就近插到对应段);
 *  - 面板列表 ↔ 场景选中双向联动、选中高亮跟着航点走;
 *  - 选中后 Delete 删除、Esc 取消选中;
 *  - 航点隐藏后不可拾取;任务执行中 / 机载视角下禁止编辑;
 *  - 零控制台错误。
 *
 * 用法:先起 dev server,再 `node scripts/verify-mission-scene-edit.mjs [url]`
 * 环境变量:SHOTS=1 时把截图写到 .verify-shots/
 *
 * 说明:无头 Chromium 下 WebGPU 回退 WebGL2 只有 2~3 FPS,所以断言全部按
 * "状态发生了变化"来判,不追精确帧;拖拽用 page.mouse 真事件,不直接调 API 绕过交互。
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
  if (SHOOT) await page.screenshot({ path: join(SHOT_DIR, `scene-edit-${name}.png`) })
}

/** 场景编辑的引擎真值 */
const editState = () =>
  page.evaluate(() => {
    const fly = window.__djiDebug.fly
    const world = fly.world
    const nodes = world.missionMarkerNodes ?? []
    return {
      edit: fly.getMissionEditState(),
      selected: fly.getMissionSelected(),
      mission: fly.sim.mission.map((w) => ({ ...w })),
      status: fly.sim.missionStatus,
      pendingStart: fly.sim.missionPendingStart,
      phase: fly.sim.phase,
      cameraMode: fly.cameraMode,
      // 三维标记的实际位置:用来验证"原位更新"真的挪了标记
      markerPositions: nodes.map((node) => ({
        x: Number(node.group.position.x.toFixed(3)),
        z: Number(node.group.position.z.toFixed(3)),
        pillarY: Number(node.pillar.scale.y.toFixed(3)),
      })),
      markerGroupVisible: world.missionMarkerGroup?.visible ?? null,
      pathGroupVisible: world.missionPathGroup?.visible ?? null,
      selectVisible: world.missionSelectGroup?.visible ?? null,
      selectX: Number(world.missionSelectGroup?.position?.x ?? 0),
      selectZ: Number(world.missionSelectGroup?.position?.z ?? 0),
      hoverVisible: world.missionHoverGroup?.visible ?? null,
      maxAltitude: fly.sim.config.maxAltitude,
    }
  })

/** 某个航点的屏幕坐标(取光柱 55% 高处,拖动时好抓) */
const waypointScreen = (index) =>
  page.evaluate((i) => {
    const { fly, THREE, game } = window.__djiDebug
    const node = fly.world.missionMarkerNodes[i]
    if (!node) return null
    const waypoint = fly.sim.mission[i]
    const point = new THREE.Vector3()
    node.group.getWorldPosition(point)
    point.y += Math.max(1, waypoint.altitude) * 0.55
    const world = point.clone()
    point.project(game.camera)
    return {
      x: ((point.x + 1) / 2) * window.innerWidth,
      y: ((1 - point.y) / 2) * window.innerHeight,
      ndcZ: point.z,
      world: { x: world.x, y: world.y, z: world.z },
      hit: document.elementFromPoint(
        ((point.x + 1) / 2) * window.innerWidth,
        ((1 - point.y) / 2) * window.innerHeight,
      )?.tagName,
    }
  }, index)

/** 世界坐标 → 屏幕坐标(用于双击地面这类"点某个场景位置"的操作) */
const screenOf = (x, y, z) =>
  page.evaluate(
    ([px, py, pz]) => {
      const { THREE, game } = window.__djiDebug
      const point = new THREE.Vector3(px, py, pz)
      point.project(game.camera)
      return {
        x: ((point.x + 1) / 2) * window.innerWidth,
        y: ((1 - point.y) / 2) * window.innerHeight,
        ndcZ: point.z,
      }
    },
    [x, y, z],
  )

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.world', undefined, { timeout: 120000 })
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1500)

await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(400)

// ═══════════════ A. 航点列表最大高度 ═══════════════
section('A. 航点列表最大高度')

const listMetrics = () =>
  page.evaluate(() => {
    const list = document.querySelector('[data-testid="waypoint-list"]')
    const card = list.closest('.card')
    return {
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      cardHeight: Math.round(card.getBoundingClientRect().height),
      count: list.children.length,
      panelBody: document.querySelector('.panel-left .panel-body').clientHeight,
    }
  })

// ① 航点少时:列表贴着内容,不出现滚动条、不留空
await page.evaluate(() => {
  window.__djiDebug.fly.setMission([
    { x: 0, z: -30, altitude: 35, speed: 6 },
    { x: 30, z: -30, altitude: 40, speed: 6 },
    { x: 30, z: 20, altitude: 40, speed: 6 },
  ])
})
await page.waitForTimeout(400)
const small = await listMetrics()
check(
  '航点少时列表贴着内容(没有多余留白、也不滚动)',
  small.count === 3 && small.scrollHeight <= small.clientHeight + 2,
  `client=${small.clientHeight} scroll=${small.scrollHeight}`,
)

// ② 堆到 12 个航点:列表必须自己滚,而不是把卡片一直撑长
await page.evaluate(() => {
  const list = []
  for (let index = 0; index < 12; index += 1) {
    list.push({ x: -60 + index * 10, z: -40 + (index % 3) * 15, altitude: 30 + index, speed: 6 })
  }
  window.__djiDebug.fly.setMission(list)
})
await page.waitForTimeout(500)
const many = await listMetrics()
check(
  '12 个航点时列表出现内部滚动',
  many.count === 12 && many.scrollHeight > many.clientHeight + 20,
  `${many.count} 行 client=${many.clientHeight} scroll=${many.scrollHeight}`,
)
check('列表高度被限死(不超过 360px)', many.clientHeight <= 360, `client=${many.clientHeight}`)
const names = await page.locator('[data-testid="waypoint-list"] > li').count()
check('列表行数与内核一致', names === 12, `${names} 行`)

// ③ 回到 5 个航点的示例航线:卡片高度必须与 12 个航点时一致(已经顶到上限,不再随数量增长)
await page.click('[data-testid="mission-preset"]')
await page.waitForTimeout(400)
const middle = await listMetrics()
check('「示例航线」恢复 5 个航点', middle.count === 5, `${middle.count} 个`)
check(
  '航点从 12 个减到 5 个,卡片高度纹丝不动(卡在上限,不再随数量增长)',
  Math.abs(middle.cardHeight - many.cardHeight) <= 2 && middle.clientHeight === many.clientHeight,
  `12 个:${many.cardHeight}px(列表 ${many.clientHeight}) → 5 个:${middle.cardHeight}px(列表 ${middle.clientHeight})`,
)
check(
  '面板滚动区高度不受航点数影响',
  Math.abs(many.panelBody - small.panelBody) < 4,
  `${small.panelBody} → ${many.panelBody}`,
)

// ═══════════════ B. 航点 / 航线 独立显隐 ═══════════════
section('B. 航点与航线独立显隐')

const toggleCount = await page.locator('[data-testid="toggle-mission-waypoints"]').count()
check('航线分页里有「显示航点」开关', toggleCount === 1, `${toggleCount} 个`)
check(
  '航线分页里有「显示航线」开关',
  (await page.locator('[data-testid="toggle-mission-path"]').count()) === 1,
  '',
)

await page.locator('[data-testid="toggle-mission-path"]').uncheck()
await page.waitForTimeout(300)
const pathOff = await editState()
check(
  '关掉「显示航线」:折线层隐藏,航点层仍在',
  pathOff.pathGroupVisible === false && pathOff.markerGroupVisible === true,
  `path=${pathOff.pathGroupVisible} markers=${pathOff.markerGroupVisible}`,
)
await page.locator('[data-testid="toggle-mission-waypoints"]').uncheck()
await page.waitForTimeout(300)
const bothOff = await editState()
check(
  '再关掉「显示航点」:两层都隐藏',
  bothOff.pathGroupVisible === false && bothOff.markerGroupVisible === false,
  `path=${bothOff.pathGroupVisible} markers=${bothOff.markerGroupVisible}`,
)
await page.locator('[data-testid="toggle-mission-path"]').check()
await page.waitForTimeout(300)
const pathOn = await editState()
check(
  '只勾回「显示航线」:折线回来了,航点仍是隐藏的(两者互不牵连)',
  pathOn.pathGroupVisible === true && pathOn.markerGroupVisible === false,
  `path=${pathOn.pathGroupVisible} markers=${pathOn.markerGroupVisible}`,
)
await page.locator('[data-testid="toggle-mission-waypoints"]').check()
await page.waitForTimeout(300)
const bothOn = await editState()
check(
  '两层都恢复显示',
  bothOn.pathGroupVisible === true && bothOn.markerGroupVisible === true,
  '',
)
await shot('visibility')

// ═══════════════ C. 场景编辑开关与自动框航线 ═══════════════
section('C. 场景编辑开关')

const beforeToggle = await editState()
check('默认关闭场景编辑', beforeToggle.edit.enabled === false && beforeToggle.edit.active === false, '')

await page.click('[data-testid="scene-edit-toggle"]')
await page.waitForTimeout(600)
const enabled = await editState()
check('开启后场景编辑生效(观察者视角 + 航线未执行)', enabled.edit.enabled === true && enabled.edit.active === true, JSON.stringify(enabled.edit))

const projections = await page.evaluate(() => {
  const { fly, THREE, game } = window.__djiDebug
  return fly.sim.mission.map((waypoint, index) => {
    const node = fly.world.missionMarkerNodes[index]
    const point = new THREE.Vector3()
    node.group.getWorldPosition(point)
    point.y += Math.max(1, waypoint.altitude) * 0.55
    point.project(game.camera)
    return {
      x: ((point.x + 1) / 2) * window.innerWidth,
      y: ((1 - point.y) / 2) * window.innerHeight,
      onScreen: Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && point.z < 1,
    }
  })
})
check(
  '开启场景编辑时自动把整条航线框进画面',
  projections.every((item) => item.onScreen),
  `在画面内 ${projections.filter((item) => item.onScreen).length}/${projections.length}`,
)
await shot('enabled')

// ═══════════════ D. 拖拽航点改位置 ═══════════════
section('D. 拖拽航点')

const start = await editState()
const target = await waypointScreen(0)
check(
  '航点 0 投到画布上且没被面板挡住',
  target !== null && target.ndcZ < 1 && target.x > 334 && target.x < 1244 && target.hit === 'CANVAS',
  target ? `x=${Math.round(target.x)} y=${Math.round(target.y)} hit=${target.hit}` : 'null',
)

await page.mouse.move(target.x, target.y)
await page.waitForTimeout(150)
const hovered = await editState()
check('鼠标悬停到航点上时出现悬停高亮', hovered.hoverVisible === true, `hover=${hovered.hoverVisible}`)

await page.mouse.down()
await page.mouse.move(target.x + 130, target.y + 55, { steps: 10 })
await page.waitForTimeout(300)
const dragging = await editState()
check('拖拽中:选中态为拖动中', dragging.edit.dragging === true, JSON.stringify(dragging.edit))
check(
  '拖拽中:三维标记已跟着动(原位更新,不需要重建整层)',
  Math.abs(dragging.markerPositions[0].x - dragging.mission[0].x) < 0.01 &&
    Math.abs(dragging.markerPositions[0].z - dragging.mission[0].z) < 0.01,
  `marker=(${dragging.markerPositions[0].x},${dragging.markerPositions[0].z}) sim=(${dragging.mission[0].x},${dragging.mission[0].z})`,
)
await page.mouse.up()
await page.waitForTimeout(300)
const dropped = await editState()
const moved =
  Math.abs(dropped.mission[0].x - start.mission[0].x) > 1 || Math.abs(dropped.mission[0].z - start.mission[0].z) > 1
check(
  '松手后航点坐标真的改了(内核为权威值)',
  moved,
  `(${start.mission[0].x.toFixed(0)},${start.mission[0].z.toFixed(0)}) → (${dropped.mission[0].x.toFixed(0)},${dropped.mission[0].z.toFixed(0)})`,
)
check('松手后不再处于拖动状态', dropped.edit.dragging === false, '')
check(
  '拖拽只动了这一个航点',
  dropped.mission[1].x === start.mission[1].x && dropped.mission[1].z === start.mission[1].z,
  '',
)
check(
  '选中高亮停在被拖的那个航点上',
  dropped.selectVisible === true &&
    Math.abs(dropped.selectX - dropped.mission[0].x) < 0.05 &&
    Math.abs(dropped.selectZ - dropped.mission[0].z) < 0.05,
  `select=(${dropped.selectX},${dropped.selectZ})`,
)

// ═══════════════ E. Shift 拖拽改高度 ═══════════════
section('E. Shift 拖拽改高度')

const beforeAltitude = (await editState()).mission[0].altitude
const anchor = await waypointScreen(0)
await page.mouse.move(anchor.x, anchor.y)
await page.keyboard.down('Shift')
await page.mouse.down()
await page.mouse.move(anchor.x, anchor.y - 90, { steps: 10 })
await page.waitForTimeout(300)
const altitudeDragging = await editState()
check(
  'Shift 拖拽进入"调整高度"模式',
  altitudeDragging.edit.mode === 'altitude',
  JSON.stringify(altitudeDragging.edit),
)
check(
  '向上拖把航点拉高了',
  altitudeDragging.mission[0].altitude > beforeAltitude,
  `${beforeAltitude} → ${altitudeDragging.mission[0].altitude}`,
)
check(
  '光柱与高度环随高度一起变长',
  Math.abs(altitudeDragging.markerPositions[0].pillarY - altitudeDragging.mission[0].altitude) < 0.01,
  `pillar=${altitudeDragging.markerPositions[0].pillarY}`,
)
await page.mouse.up()
await page.keyboard.up('Shift')
await page.waitForTimeout(300)
const altitudeDone = await editState()
check(
  'Shift 松开后回到普通状态',
  altitudeDone.edit.dragging === false && altitudeDone.edit.mode === null,
  '',
)

// 限高夹紧:把高度一路拖到天上,应当停在下拉前的高度上限
const limit = altitudeDone.maxAltitude
const anchor2 = await waypointScreen(0)
await page.mouse.move(anchor2.x, anchor2.y)
await page.keyboard.down('Shift')
await page.mouse.down()
await page.mouse.move(anchor2.x, anchor2.y - 800, { steps: 12 })
await page.waitForTimeout(400)
await page.mouse.up()
await page.keyboard.up('Shift')
await page.waitForTimeout(300)
const clamped = await editState()
check(
  `高度被「限高」夹在 ${limit} m 以内`,
  clamped.mission[0].altitude <= limit,
  `altitude=${clamped.mission[0].altitude}`,
)
// 拖回一个正常高度,免得后面双击新增时模板继承到 120 m
await page.evaluate(() => {
  window.__djiDebug.fly.updateMissionWaypoint(0, { altitude: 35 })
})
await page.waitForTimeout(200)

// ═══════════════ F. 双击地面新增 ═══════════════
section('F. 双击地面新增航点')

const beforeAdd = await editState()
// 取第 1、2 个航点的地面连线中点:双击那里应该插到两者之间
const midX = (beforeAdd.mission[0].x + beforeAdd.mission[1].x) / 2
const midZ = (beforeAdd.mission[0].z + beforeAdd.mission[1].z) / 2
const ground = await screenOf(midX, 0, midZ)
check(
  '目标地面点可见且落在画布上',
  ground.ndcZ < 1 && ground.x > 334 && ground.x < 1244,
  `x=${Math.round(ground.x)} y=${Math.round(ground.y)}`,
)
await page.mouse.dblclick(ground.x, ground.y)
await page.waitForTimeout(500)
const added = await editState()
const newIndex = added.selected
check('双击地面新增了一个航点', added.mission.length === beforeAdd.mission.length + 1, `${beforeAdd.mission.length} → ${added.mission.length}`)
check(
  '新航点落在双击的那个地平位置上(1 米吸附)',
  newIndex >= 0 &&
    Math.abs(added.mission[newIndex].x - midX) <= 1.01 &&
    Math.abs(added.mission[newIndex].z - midZ) <= 1.01,
  `新点=(${added.mission[newIndex]?.x},${added.mission[newIndex]?.z}) 目标=(${midX.toFixed(1)},${midZ.toFixed(1)}) 插入位置=${newIndex}`,
)
check(
  '新航点插在这两个航点之间(不是接到队尾)',
  newIndex === 1 &&
    added.mission[0].x === beforeAdd.mission[0].x &&
    added.mission[2].x === beforeAdd.mission[1].x,
  `新点索引=${newIndex} 前一个=(${added.mission[newIndex - 1]?.x},${added.mission[newIndex - 1]?.z})`,
)
check('新增后自动选中它', newIndex >= 0 && added.selected === newIndex, `selected=${added.selected}`)
check(
  '三维标记数量同步增加',
  added.markerPositions.length === added.mission.length,
  `${added.markerPositions.length} 个标记`,
)
await shot('added')

// ═══════════════ G. 面板 ↔ 场景选中联动 ═══════════════
section('G. 选中联动')

await page.click('[data-testid="scene-edit-select-first"]')
await page.waitForTimeout(300)
const selectedFirst = await editState()
check('面板按钮选中第 1 个航点', selectedFirst.selected === 0, `selected=${selectedFirst.selected}`)
check(
  '列表里对应那一行高亮',
  (await page.locator('[data-testid="waypoint-0"]').getAttribute('class')).includes('selected'),
  await page.locator('[data-testid="waypoint-0"]').getAttribute('class'),
)
check(
  '场景里的选中高亮挪到该航点',
  Math.abs(selectedFirst.selectX - selectedFirst.mission[0].x) < 0.05,
  `select.x=${selectedFirst.selectX} mission.x=${selectedFirst.mission[0].x}`,
)
check(
  '状态条显示已选中',
  (await page.locator('[data-testid="scene-edit-status"]').textContent()).includes('已选中'),
  (await page.locator('[data-testid="scene-edit-status"]').textContent()).trim().slice(0, 40),
)

// 点列表行 → 场景选中跟着走
await page.locator('[data-testid="waypoint-2"] .wp-head').click()
await page.waitForTimeout(300)
const selectedRow = await editState()
check('点列表某一行 → 场景选中跟着切到该航点', selectedRow.selected === 2, `selected=${selectedRow.selected}`)

// ═══════════════ H. Delete / Esc ═══════════════
section('H. Delete 删除与 Esc 取消选中')

const beforeDelete = await editState()
await page.keyboard.press('Delete')
await page.waitForTimeout(400)
const afterDelete = await editState()
check(
  'Delete 删掉了选中的航点',
  afterDelete.mission.length === beforeDelete.mission.length - 1,
  `${beforeDelete.mission.length} → ${afterDelete.mission.length}`,
)
check(
  '三维标记数量同步减少',
  afterDelete.markerPositions.length === afterDelete.mission.length,
  `${afterDelete.markerPositions.length} 个`,
)

await page.click('[data-testid="scene-edit-select-first"]')
await page.waitForTimeout(250)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const escaped = await editState()
check('Esc 取消选中且高亮收起', escaped.selected === -1 && escaped.selectVisible === false, `selected=${escaped.selected} visible=${escaped.selectVisible}`)

// ═══════════════ I. 航点隐藏时不可拾取 ═══════════════
section('I. 隐藏后不可拾取')

await page.locator('[data-testid="toggle-mission-waypoints"]').uncheck()
await page.waitForTimeout(300)
const hiddenTarget = await waypointScreen(0)
const beforeHiddenDrag = await editState()
await page.mouse.move(hiddenTarget.x, hiddenTarget.y)
await page.mouse.down()
await page.mouse.move(hiddenTarget.x + 120, hiddenTarget.y + 40, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(300)
const afterHiddenDrag = await editState()
check(
  '航点隐藏时拖不动它(看不见就点不着)',
  afterHiddenDrag.mission[0].x === beforeHiddenDrag.mission[0].x &&
    afterHiddenDrag.mission[0].z === beforeHiddenDrag.mission[0].z,
  `x=${afterHiddenDrag.mission[0].x}`,
)
await page.locator('[data-testid="toggle-mission-waypoints"]').check()
await page.waitForTimeout(300)

// ═══════════════ J. 执行中 / 机载视角禁止编辑 ═══════════════
section('J. 不可编辑的两种情况')

await page.click('[data-testid="scene-edit-select-first"]')
await page.waitForTimeout(250)
// 先上电到地面待机:上电前 phase 是 powerOff,startMission 会被"当前阶段无法执行"挡掉
await page.click('[data-testid="tab-flight"]')
await page.waitForTimeout(250)
await page.click('[data-testid="btn-power"]')
await page.waitForFunction(
  '["standby","motorsOn"].includes(window.__djiDebug.fly.sim.phase)',
  undefined,
  { timeout: 30000 },
)
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)
await page.evaluate(() => window.__djiDebug.fly.startMission())
await page.waitForTimeout(600)
const running = await editState()
check(
  '下发航线后(等待起飞到位 / 已在执行)场景编辑自动失效',
  running.edit.active === false && (running.pendingStart === true || running.status === 'running'),
  `active=${running.edit.active} pending=${running.pendingStart} status=${running.status} phase=${running.phase}`,
)
const runningTarget = await waypointScreen(0)
const beforeRunningDrag = await editState()
if (runningTarget) {
  await page.mouse.move(runningTarget.x, runningTarget.y)
  await page.mouse.down()
  await page.mouse.move(runningTarget.x + 90, runningTarget.y, { steps: 6 })
  await page.mouse.up()
}
await page.waitForTimeout(300)
const afterRunningDrag = await editState()
check(
  '任务执行期拖拽无效',
  afterRunningDrag.mission[0].x === beforeRunningDrag.mission[0].x,
  `x=${afterRunningDrag.mission[0].x}`,
)
check(
  '状态条给出不可编辑的原因',
  (await page.locator('[data-testid="scene-edit-status"]').textContent()).includes('任务执行中'),
  (await page.locator('[data-testid="scene-edit-status"]').textContent()).trim().slice(0, 40),
)
await page.evaluate(() => window.__djiDebug.fly.stopMission('回归脚本'))
await page.waitForTimeout(400)

// 切到机载视角
await page.click('[data-testid="tab-flight"]')
await page.waitForTimeout(250)
await page.click('[data-testid="camera-fpv"]')
await page.waitForTimeout(600)
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)
const fpv = await editState()
check(
  '机载视角下场景编辑不可用',
  fpv.cameraMode === 'fpv' && fpv.edit.active === false,
  `camera=${fpv.cameraMode} active=${fpv.edit.active}`,
)
check(
  '状态条提示需要切回观察者视角',
  (await page.locator('[data-testid="scene-edit-status"]').textContent()).includes('观察者视角'),
  (await page.locator('[data-testid="scene-edit-status"]').textContent()).trim().slice(0, 40),
)
await page.click('[data-testid="tab-flight"]')
await page.waitForTimeout(200)
await page.click('[data-testid="camera-orbit"]')
await page.waitForTimeout(600)
await page.click('[data-testid="tab-mission"]')
await page.waitForTimeout(300)
const backToOrbit = await editState()
check('切回观察者视角后恢复可编辑', backToOrbit.edit.active === true, `active=${backToOrbit.edit.active}`)

// ═══════════════ K. 关闭场景编辑 ═══════════════
section('K. 关闭场景编辑')

await page.click('[data-testid="scene-edit-toggle"]')
await page.waitForTimeout(400)
const disabled = await editState()
check(
  '关闭后编辑态与选中态一起收起',
  disabled.edit.enabled === false && disabled.selected === -1 && disabled.selectVisible === false,
  JSON.stringify(disabled.edit),
)

// ═══════════════ L. 收尾 ═══════════════
section('L. 控制台')

check('全程零控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n合计 ${pass + fail} 项:通过 ${pass},失败 ${fail}`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
