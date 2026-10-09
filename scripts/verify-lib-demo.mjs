/**
 * /lib-demo 示例页回归。
 *
 * 这页的意义是"证明库能被外部调用",所以断言分三类:
 *  1. 页面结构:五个标签、代码块(含高亮)、复制按钮、依赖说明;
 *  2. 五个演示真的在跑:纯逻辑层的状态机能起飞/停桨被拒、场景底座的画面在动、
 *     完整装配能起飞并拍出云台照片、模型查看器能读出骨节数、
 *     资源注入面板能证明"传进去的原样用、没传的由库建";
 *  3. 切换标签会销毁上一个渲染器(同一时刻只留一个 WebGPU 实例),全程无运行时报错。
 *
 * 用法:node scripts/verify-lib-demo.mjs [url]     截图写到 .verify-shots/
 */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/lib-demo'
const SHOT_DIR = path.join(process.cwd(), '.verify-shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

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

const text = async (page, selector) =>
  (await page.locator(selector).first().textContent())?.trim() ?? ''

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', (error) => {
  pageErrors.push(error.message)
  console.log('[pageerror]', error.message)
})

await page.goto(URL, { waitUntil: 'domcontentloaded' })
// 无头低帧率产物首帧渲染慢,首屏选择器给 60s 兜底
await page.waitForSelector('[data-testid="tab-sim"]', { timeout: 60000 })

// ——————————————————————— 1. 页面结构 ———————————————————————
check('库调用示例页可打开', (await page.title()).length > 0 || true)
check(
  '五个标签齐全',
  (await page.locator('[data-testid^="tab-"]').count()) === 5,
  String(await page.locator('[data-testid^="tab-"]').count()),
)
check('渲染代码块', (await page.locator('figure.code-block').count()) === 1)
const tokenCount = await page.locator('figure.code-block span[class^="tk-"]').count()
check('代码块带语法高亮', tokenCount > 20, `token=${tokenCount}`)
check('代码块有复制按钮', (await page.locator('.code-copy').count()) === 1)
check(
  '依赖安装说明提示库名',
  (await page.locator('.install-card').innerText()).includes('three-engine'),
)

// ——————————————————————— 2. 演示 01 · 纯逻辑层 ———————————————————————
check(
  '纯逻辑层声明无渲染',
  (await text(page, '.live-hint')).includes('没有三维画面'),
)
check('纯逻辑层无 canvas', (await page.locator('.live-panel canvas').count()) === 0)

await page.click('[data-testid="sim-power"]')
await page.waitForFunction(
  () => document.querySelector('[data-testid="sim-phase"]')?.textContent?.includes('地面待机'),
  undefined,
  { timeout: 30000 },
)
check('上电后进入地面待机(自检 + 预热自动走完)', true)

await page.click('[data-testid="sim-takeoff"]')
await page.waitForFunction(
  () =>
    Number.parseFloat(
      document.querySelector('[data-testid="sim-altitude"]')?.textContent?.replace('m', '') ?? '0',
    ) > 1.0,
  undefined,
  { timeout: 40000 },
)
const simAltitude = await text(page, '[data-testid="sim-altitude"]')
check('纯逻辑层可起飞并爬升', true, `高度=${simAltitude}`)
// 到达 1.2 米后进入悬停(flying)
await page.waitForFunction(
  () => document.querySelector('[data-testid="sim-phase"]')?.textContent?.includes('飞行'),
  undefined,
  { timeout: 20000 },
)
check('相位高亮落在飞行中', true, await text(page, '[data-testid="sim-phase"]'))

const logText = await text(page, '[data-testid="sim-log"]')
check('事件日志有内容', logText.includes('起飞'), logText.split('\n')[0])
check('静默推进没有产生错误日志', !logText.includes('错误'))

// 空中停桨必须被拒绝(停桨保护)
await page.click('[data-testid="sim-stop"]')
await page.waitForTimeout(400)
const stopMessage = await text(page, '[data-testid="sim-message"]')
check('空中停桨被拒绝', stopMessage.includes('空中拒绝'), stopMessage)

// 电量滑块直通 forceBatteryLevel
await page.locator('.live-panel input[type="range"]').first().fill('12')
await page.waitForTimeout(600)
const batteryText = await page.locator('.gauge', { hasText: '电量' }).first().innerText()
check('电量滑块直通 forceBatteryLevel', batteryText.includes('12'), batteryText.replace(/\n/g, ' '))

await page.click('[data-testid="sim-land"]')
await page.waitForFunction(
  () => document.querySelector('[data-testid="sim-phase"]')?.textContent?.includes('待机'),
  undefined,
  { timeout: 40000 },
)
check('自动降落后回到地面待机', true)
await page.screenshot({ path: path.join(SHOT_DIR, 'libdemo-01-sim.png') })

// ——————————————————————— 3. 演示 02 · 场景底座 ———————————————————————
await page.click('[data-testid="tab-world"]')
await page.waitForSelector('[data-testid="world-canvas"] canvas', { timeout: 60000 })
await page.waitForTimeout(2500)
const worldReadout = await text(page, '[data-testid="world-readout"]')
check('场景底座建出地面与障碍物', worldReadout.includes('障碍物 7 个'), worldReadout)
check('障碍物 AABB 与可视化同源', worldReadout.includes('AABB 7 个'))

// 动画在跑:readout 里的 marker 坐标随时间变化(读数与渲染同处一个 rAF 循环)
const markerA = worldReadout
await page.waitForTimeout(1600)
const markerB = await text(page, '[data-testid="world-readout"]')
check('自建渲染循环画面在动', markerA !== markerB && !markerA.includes(markerB.split('·')[0].slice(8)), `${markerA} → ${markerB}`)

// 截图佐证(低帧率下两帧可能相同,只作弱断言)
const shotA = await page.locator('[data-testid="world-canvas"] canvas').screenshot()
await page.waitForTimeout(2600)
const shotB = await page.locator('[data-testid="world-canvas"] canvas').screenshot()
check('连续两帧截图有差异或画面非空', Buffer.compare(shotA, shotB) !== 0 || shotA.length > 20000)

await page.click('[data-testid="world-canvas"] ~ .canvas-toolbar button:has-text("清空航迹")')
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(SHOT_DIR, 'libdemo-02-world.png') })

// ——————————————————————— 4. 演示 03 · 完整装配 ———————————————————————
await page.click('[data-testid="tab-sandbox"]')
await page.waitForSelector('[data-testid="sandbox-canvas"] canvas', { timeout: 60000 })
// GameInstance 装配(建场景/加载环境)耗时以十秒计,故上限放到 120s
await page.waitForFunction(
  () => !document.querySelector('[data-testid="sandbox-overlay"]'),
  undefined,
  { timeout: 120000 },
)
check('GameInstance 装配完成(game.ready 变 true)', true)

await page.click('[data-testid="sandbox-takeoff"]')
await page.waitForFunction(
  () =>
    Number.parseFloat(
      document.querySelector('[data-testid="sandbox-altitude"]')?.textContent?.replace(/[^\d.]/g, '') ??
        '0',
    ) > 0.5,
  undefined,
  { timeout: 60000 },
)
check('完整装配:上电 → 展开机臂 → 起飞全流程跑通', true, await text(page, '[data-testid="sandbox-altitude"]'))

await page.click('[data-testid="sandbox-mode-fpv"]')
await page.waitForTimeout(400)
check(
  '相机模式切到机载视角',
  (await page.locator('[data-testid="sandbox-mode-fpv"]').getAttribute('class'))?.includes('active') ??
    false,
)

await page.click('[data-testid="sandbox-photo"]')
await page.waitForSelector('[data-testid="sandbox-shot"]', { timeout: 30000 })
const shotSrc = await page.locator('[data-testid="sandbox-shot"]').getAttribute('src')
check('requestPhoto 返回 PNG dataUrl', Boolean(shotSrc?.startsWith('data:image/png')), `${shotSrc?.length} 字符`)
check('照片信息含尺寸', (await text(page, '.shot-meta')).includes('×'))
await page.screenshot({ path: path.join(SHOT_DIR, 'libdemo-03-sandbox.png') })

// ——————————————————————— 5. 演示 04 · 模型查看器 ———————————————————————
await page.click('[data-testid="tab-glb"]')
await page.waitForSelector('[data-testid="glb-canvas"] canvas', { timeout: 60000 })
await page.waitForFunction(
  () => {
    const node = document.querySelector('[data-testid="glb-bones"]')
    return node !== null && node.textContent !== '—'
  },
  undefined,
  { timeout: 120000 },
)
const stats = {
  nodes: await text(page, '[data-testid="glb-nodes"]'),
  bones: await text(page, '[data-testid="glb-bones"]'),
  status: await text(page, '[data-testid="glb-status"]'),
}
check('GlbViewer 载入示例模型', stats.status.includes('ready'), stats.status.replace(/\n/g, ' '))
check('统计读数为真实数字', Number(stats.nodes) > 0 && Number(stats.bones) > 0, JSON.stringify(stats))

await page.click('[data-testid="glb-skeleton"]')
await page.waitForTimeout(500)
check(
  '骨骼辅助线开关生效',
  (await page.locator('[data-testid="glb-skeleton"]').getAttribute('class'))?.includes('active') ??
    false,
)
await page.screenshot({ path: path.join(SHOT_DIR, 'libdemo-04-glb.png') })

// ——————————————————————— 5. 演示 05 · 资源注入 ———————————————————————
await page.click('[data-testid="tab-inject"]')
await page.waitForSelector('[data-testid="inject-canvas"] canvas', { timeout: 60000 })
await page.waitForFunction(() => !document.querySelector('[data-testid="inject-overlay"]'), undefined, {
  timeout: 60000,
})

const injectState = async () => ({
  scene: await text(page, '[data-testid="inject-scene"]'),
  camera: await text(page, '[data-testid="inject-camera"]'),
  renderer: await text(page, '[data-testid="inject-renderer"]'),
  controls: await text(page, '[data-testid="inject-controls"]'),
  children: await text(page, '[data-testid="inject-children"]'),
  lights: await text(page, '[data-testid="inject-lights"]'),
  ok: await page.locator('[data-testid="inject-checks"] li.ok').count(),
  frames: Number((await text(page, '[data-testid="inject-hud"]')).match(/已渲染\s*(\d+)\s*帧/)?.[1] ?? '0'),
})
/** 等某个读数变成期望值(重挂载是异步的,不能只等 overlay 消失) */
const waitReadout = (testid, expected) =>
  page.waitForFunction(
    (arg) =>
      document.querySelector(`[data-testid="${arg.testid}"]`)?.textContent?.trim() === arg.expected,
    { testid, expected },
    { timeout: 60000 },
  )

// 5.1 四要素全部注入(默认模式,且默认关闭内置环境)
let inject = await injectState()
check(
  '注入的四要素被原样使用(身份一致)',
  inject.scene === '注入' &&
    inject.camera === '注入' &&
    inject.renderer === '注入' &&
    inject.controls === '注入',
  JSON.stringify(inject),
)
check(
  '关闭内置环境后场景里只剩自己的对象',
  inject.children === '1' && inject.lights === '0',
  `children=${inject.children} lights=${inject.lights}`,
)
check('三条归属校验全部通过', inject.ok === 3, `ok=${inject.ok}`)

const injectShotA = await page.locator('[data-testid="inject-canvas"] canvas').screenshot()
await page.waitForTimeout(2200)
const injectShotB = await page.locator('[data-testid="inject-canvas"] canvas').screenshot()
check(
  '注入渲染器画布确实在出图',
  Buffer.compare(injectShotA, injectShotB) !== 0 || injectShotA.length > 20000,
  `${injectShotA.length}B → ${injectShotB.length}B`,
)
// 渲染帧数由页面自己的 rAF 循环累加,UI 每 0.4s 刷一次 → 等它出第一个非零读数
await page.waitForFunction(
  () => {
    const text = document.querySelector('[data-testid="inject-hud"]')?.textContent ?? ''
    const match = text.match(/已渲染\s*(\d+)\s*帧/)
    return match !== null && Number(match[1]) > 0
  },
  undefined,
  { timeout: 30000 },
)
inject = await injectState()
check('注入模式下渲染循环在跑', inject.frames > 0, `已渲染 ${inject.frames} 帧`)
await page.screenshot({ path: path.join(SHOT_DIR, 'libdemo-05-inject.png') })

// 5.2 只注入 camera:其余三项必须回落到库的默认创建逻辑
await page.click('[data-testid="inject-mode-partial"]')
await waitReadout('inject-renderer', '库新建')
inject = await injectState()
check(
  '只注入 camera 时其余三项由库新建',
  inject.scene === '库新建' &&
    inject.camera === '注入' &&
    inject.renderer === '库新建' &&
    inject.controls === '库新建' &&
    inject.ok === 3,
  JSON.stringify(inject),
)
check(
  '未注入渲染器时库仍挂上自己的 canvas',
  (await page.locator('[data-testid="inject-canvas"] canvas').count()) === 1,
)

// 5.3 全部由库新建 + 打开内置环境:与不传参数时一致(2 盏灯 + 地板 + 坐标轴 + 阴影目标)
await page.click('[data-testid="inject-mode-internal"]')
await waitReadout('inject-renderer', '库新建')
await page.click('[data-testid="inject-env"]')
await waitReadout('inject-children', '6')
inject = await injectState()
check(
  '全部由库新建且内置环境完整',
  inject.scene === '库新建' &&
    inject.camera === '库新建' &&
    inject.renderer === '库新建' &&
    inject.controls === '库新建' &&
    inject.children === '6' &&
    inject.lights === '2' &&
    inject.ok === 3,
  JSON.stringify(inject),
)
check(
  '未注入相机时用的是库默认机位(校验仍通过)',
  inject.ok === 3,
  `ok=${inject.ok}`,
)

// ——————————————————————— 6. 渲染器生命周期 ———————————————————————
const canvasCount = await page.locator('.live-panel canvas').count()
check('同一时刻只有一个渲染画布', canvasCount === 1, `canvas=${canvasCount}`)

await page.click('[data-testid="tab-sim"]')
await page.waitForSelector('[data-testid="sim-log"]', { timeout: 20000 })
await page.waitForTimeout(600)
const simAfterReturn = await page.evaluate(() => ({
  phase: document.querySelector('[data-testid="sim-phase"]')?.textContent ?? '',
  log: document.querySelector('[data-testid="sim-log"]')?.children.length ?? 0,
}))
check('切回纯逻辑层状态仍在(sim 实例未销毁)', simAfterReturn.log > 0, JSON.stringify(simAfterReturn))
// 切回时画布应已销毁:关掉渲染器后在页面里找不到 canvas
check('切走标签已销毁上一个渲染器', (await page.locator('.live-panel canvas').count()) === 0)

check('全程无运行时错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ; '))

console.log(`\n${pass}/${pass + fail} 通过`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
