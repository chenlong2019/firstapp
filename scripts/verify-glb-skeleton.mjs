/**
 * GLB 查看器 —— 骨骼动画回归验证。
 *
 * 覆盖:
 * ① 无骨骼模型(djiair.glb)不受影响:无骨架、无骨骼/动画面板;
 * ② 骨骼模型(djiair_renamed.glb):识别 skin.joints 骨节与烘焙动画;
 * ③ 动画真的驱动几何:骨节四元数变化 → 机臂网格 / 二级桨叶世界坐标随之移动;
 * ④ 播放推进 / 逐帧步进 / 循环方式 / 速度 / 重播;
 * ⑤ 骨架辅助线开关与顶点刷新(含"开关不被每帧覆盖"的老坑);
 * ⑥ 页面面板读数与模型树骨节标记。
 *
 * 用法: node scripts/verify-glb-skeleton.mjs [url]
 * 默认 http://127.0.0.1:15176/glb(需先起 dev server)。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15176/glb'
const SHOTS = process.env.SHOTS === '1'
const DIR = join(process.cwd(), '.verify-shots')
mkdirSync(DIR, { recursive: true })

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} │ ${name}${detail ? ' │ ' + detail : ''}`)
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push('CONSOLE ' + m.text())
})

/** 点顶部工具栏的示例按钮并等目标模型真正就位(只看 stats 非空会读到上一个模型)。 */
const loadSample = async (index, fileName) => {
  await page.locator('.top-button.subtle').nth(index).click()
  await page.waitForFunction((name) => window.__glbDebug.viewer.getStats()?.fileName === name, fileName, {
    timeout: 180000,
  })
  await page.waitForTimeout(1000)
}

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__glbDebug?.viewer, null, { timeout: 60000 })

/* ═════════════════ 1. 无骨骼模型不受影响 ═════════════════ */
console.log('\n──── 无骨骼模型(djiair.glb) ────')
await page.locator('.empty-samples button').nth(1).click()
await page.waitForFunction(() => window.__glbDebug.viewer.getStats()?.fileName === 'djiair.glb', null, {
  timeout: 180000,
})
await page.waitForTimeout(1000)
const raw = await page.evaluate(() => {
  const v = window.__glbDebug.viewer
  return {
    stats: v.getStats(),
    clips: v.getAnimationState().names.length,
    rigGroup: !!v.rigGroup,
    explode: v.isExplodeAvailable(),
    skeletonPanel: !!document.querySelector('[data-testid="skeleton-on"]'),
    animPanel: !!document.querySelector('[data-testid="anim-toggle"]'),
  }
})
check('骨节数 0', raw.stats.bones === 0, `bones=${raw.stats.bones}`)
check('不建骨架辅助线组', raw.rigGroup === false)
check('不显示骨骼面板', raw.skeletonPanel === false)
check('不显示动画面板(模型无动画)', raw.animPanel === false, `clips=${raw.clips}`)
check('爆炸图维持原有行为(该模型层级过深,不可用)', raw.explode === false)

/* ═════════════════ 2. 骨骼模型:动画加载 ═════════════════ */
console.log('\n──── 骨骼模型载入 ────')
await loadSample(0, 'djiair_renamed.glb')
await page.waitForFunction(() => window.__glbDebug.viewer.getAnimationState().names.length > 0, null, {
  timeout: 60000,
})
await page.waitForTimeout(800)
const initial = await page.evaluate(() => {
  const v = window.__glbDebug.viewer
  return {
    stats: v.getStats(),
    anim: v.getAnimationState(),
    rig: v.getRigInfo(),
    rigGroupExists: !!v.rigGroup,
    rigGroupVisible: v.rigGroup?.visible ?? null,
    segments: v.rigSegments.length,
    vertexCount: v.rigLines.geometry.getAttribute('position').count,
  }
})
console.log('  统计:', JSON.stringify({ bones: initial.stats.bones, anim: initial.anim.names }))
check('统计里骨节数 = 16', initial.stats.bones === 16, `bones=${initial.stats.bones}`)
check('识别到 1 条动画', initial.anim.names.length === 1, JSON.stringify(initial.anim.names))
check('动画时长 ≈ 6.4s', Math.abs(initial.anim.duration - 6.4) < 0.01, `duration=${initial.anim.duration}`)
check(
  '单帧时长 = 40ms(25fps 烘焙反推)',
  Math.abs(initial.anim.frameStep - 0.04) < 0.005,
  `frameStep=${initial.anim.frameStep}`,
)
check(
  '骨架容器识别为 RIG_DJI_Arms_Props',
  initial.rig.rigs.join(',') === 'RIG_DJI_Arms_Props',
  JSON.stringify(initial.rig.rigs),
)
check(
  '骨链根 = 四条机臂折叠骨',
  initial.rig.roots.length === 4 && initial.rig.roots.every((name) => name.startsWith('ARM_')),
  JSON.stringify(initial.rig.roots),
)
check('骨架辅助线已建好且默认不显示', initial.rigGroupExists && initial.rigGroupVisible === false)
check(
  '骨架顶点数 = 线段数 × 2',
  initial.vertexCount === initial.segments * 2 && initial.segments > 0,
  `segments=${initial.segments} vertices=${initial.vertexCount}`,
)

/* ═════════════════ 3. 动画驱动几何 ═════════════════ */
console.log('\n──── 动画驱动几何 ────')
const pose = await page.evaluate(async () => {
  const v = window.__glbDebug.viewer
  const THREE = window.__glbDebug.THREE
  const read = () => {
    v.model.updateMatrixWorld(true)
    const center = (name) =>
      new THREE.Box3().setFromObject(v.model.getObjectByName(name)).getCenter(new THREE.Vector3()).toArray()
    return {
      q: v.model.getObjectByName('ARM_FrontLeft_Fold_Bone').quaternion.toArray(),
      arm: center('ARM_FrontLeft'),
      blade: center('PROP_FrontLeft_Blade_1'),
    }
  }
  await v.seek(0)
  const folded = read()
  await v.seek(3.2)
  const unfolded = read()
  await v.seek(0)
  return { folded, unfolded }
})
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]))
const quatDelta = distance(pose.folded.q, pose.unfolded.q)
const armShift = distance(pose.folded.arm, pose.unfolded.arm)
const bladeShift = distance(pose.folded.blade, pose.unfolded.blade)
check('折叠/展开两姿态骨节四元数不同', quatDelta > 0.1, `Δq=${quatDelta.toFixed(3)}`)
check('机臂网格世界坐标被骨骼带着移动', armShift > 0.01, `Δ=${armShift.toFixed(4)}`)
check('二级骨骼(桨叶)也跟随移动', bladeShift > 0.01, `Δ=${bladeShift.toFixed(4)}`)

/* ═════════════════ 4. 播放控制 ═════════════════ */
console.log('\n──── 播放控制 ────')
// 无头环境帧率低(主循环 delta 上限 0.1s),所以断言"持续推进"而不是绝对秒数
const playback = await page.evaluate(async () => {
  const v = window.__glbDebug.viewer
  v.seek(0)
  v.setAnimationPlaying(true)
  await new Promise((r) => setTimeout(r, 800))
  const first = v.getAnimationState().time
  await new Promise((r) => setTimeout(r, 1400))
  const second = v.getAnimationState().time
  const playing = v.getAnimationState().playing
  v.setAnimationPlaying(false)
  return { first, second, playing }
})
check('播放后时间前进', playback.second > 0.15, `time=${playback.second.toFixed(3)}`)
check(
  '播放中时间持续推进',
  playback.second > playback.first + 0.1,
  `${playback.first.toFixed(3)} → ${playback.second.toFixed(3)}`,
)
check('播放状态为 playing', playback.playing === true)

const step = await page.evaluate(() => {
  const v = window.__glbDebug.viewer
  v.seek(0)
  v.stepFrame(1)
  const forward = v.getAnimationState()
  v.stepFrame(1)
  const twice = v.getAnimationState()
  v.stepFrame(-1)
  const back = v.getAnimationState()
  return { forward: forward.time, twice: twice.time, back: back.time, playing: back.playing }
})
check('单帧步进 = frameStep', Math.abs(step.forward - 0.04) < 0.005, `t=${step.forward}`)
check('连续步进累加', Math.abs(step.twice - 0.08) < 0.005, `t=${step.twice}`)
check('反向步进回退一帧', Math.abs(step.back - 0.04) < 0.005, `t=${step.back}`)
check('步进时自动暂停', step.playing === false)

const loopModes = await page.evaluate(async () => {
  const v = window.__glbDebug.viewer
  const out = []
  for (const mode of ['pingpong', 'once', 'repeat']) {
    v.setLoopMode(mode)
    out.push({ mode, state: v.getAnimationState().loop })
  }
  v.setAnimationSpeed(0.5)
  const speed = v.getAnimationState().speed
  v.setAnimationSpeed(1)
  v.restartAnimation()
  await new Promise((r) => setTimeout(r, 300))
  return { out, speed, afterRestart: v.getAnimationState() }
})
check(
  '循环方式可切换并写回状态',
  loopModes.out.every((item) => item.mode === item.state),
  JSON.stringify(loopModes.out.map((item) => item.mode)),
)
check('速度可设置', Math.abs(loopModes.speed - 0.5) < 1e-6, `speed=${loopModes.speed}`)
check(
  '重新播放从头开始且处于播放态',
  loopModes.afterRestart.playing === true && loopModes.afterRestart.time < 0.6,
  `t=${loopModes.afterRestart.time.toFixed(3)}`,
)

/* ═════════════════ 5. 骨架辅助线 ═════════════════ */
console.log('\n──── 骨架辅助线 ────')
const skeleton = await page.evaluate(async () => {
  const v = window.__glbDebug.viewer
  v.setAnimationPlaying(false)
  v.seek(0)
  const positions = v.rigLines.geometry.getAttribute('position')
  const before = Array.from(positions.array.slice(0, 9))
  v.setSkeletonVisible(true)
  const visibleAfterOn = v.rigGroup.visible
  v.seek(3.2)
  const afterPose = Array.from(positions.array.slice(0, 9))
  const finite = Array.from(positions.array).every((n) => Number.isFinite(n))
  const nonZero = Array.from(positions.array).some((n) => Math.abs(n) > 1e-6)
  v.setSkeletonVisible(false)
  const visibleAfterOff = v.rigGroup.visible
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  return {
    visibleAfterOn,
    visibleAfterOff,
    stillHidden: v.rigGroup.visible,
    finite,
    nonZero,
    moved: before.some((value, index) => Math.abs(value - afterPose[index]) > 1e-6),
  }
})
check('打开骨架后可见', skeleton.visibleAfterOn === true)
check(
  '关闭骨架后保持隐藏(不被每帧覆盖)',
  skeleton.visibleAfterOff === false && skeleton.stillHidden === false,
)
check('骨架顶点全为有限数', skeleton.finite)
check('骨架顶点非全零', skeleton.nonZero)
check('姿态改变后骨架顶点同步变化', skeleton.moved)

/* ═════════════════ 6. 页面 UI ═════════════════ */
console.log('\n──── 页面 UI ────')
const ui = await page.evaluate(() => ({
  timeText: document.querySelector('[data-testid="anim-time"]')?.textContent?.trim() ?? null,
  hasSkeletonPanel: !!document.querySelector('[data-testid="skeleton-on"]'),
  hasFrameStep: !!document.querySelector('[data-testid="anim-next-frame"]'),
  hasRestart: !!document.querySelector('[data-testid="anim-restart"]'),
  loopLabel: document.querySelector('[data-testid="anim-loop"]')?.textContent?.trim() ?? null,
  boneChip: document.querySelectorAll('.kind-bone').length,
}))
check('UI 有骨骼面板与骨架开关', ui.hasSkeletonPanel)
check('UI 有逐帧步进与重播按钮', ui.hasFrameStep && ui.hasRestart)
check('UI 时间轴有读数', /^\d+\.\d{2}s$/.test(ui.timeText ?? ''), `time=${ui.timeText}`)
check('UI 循环方式按钮有文案', (ui.loopLabel ?? '').length > 0, `label=${ui.loopLabel}`)
check('模型树出现骨节标记', ui.boneChip > 0, `kind-bone=${ui.boneChip}`)

// 真实点击:点"显示骨架"再点播放,确认交互链路通
await page.locator('[data-testid="skeleton-on"]').click()
await page.waitForTimeout(400)
const afterClick = await page.evaluate(() => ({
  visible: window.__glbDebug.viewer.isSkeletonVisible(),
  group: window.__glbDebug.viewer.rigGroup.visible,
}))
check('点击"开"真的显示骨架', afterClick.visible === true && afterClick.group === true)
await page.locator('[data-testid="skeleton-off"]').click()

if (SHOTS) {
  const shot = async (name, prepare) => {
    await page.evaluate(prepare)
    await page.waitForTimeout(1400)
    await page.screenshot({ path: join(DIR, name) })
  }
  await shot('skeleton-folded.png', () => {
    window.__glbDebug.viewer.setSkeletonVisible(false)
    window.__glbDebug.viewer.seek(0)
  })
  await shot('skeleton-unfolded.png', () => window.__glbDebug.viewer.seek(3.2))
  await shot('skeleton-helper-on.png', () => window.__glbDebug.viewer.setSkeletonVisible(true))
}

check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
console.log(failed === 0 ? '\n════════ 结果: 全部通过 ════════' : `\n════════ 结果: ${failed} 项失败 ════════`)
await browser.close()
process.exit(failed === 0 ? 0 : 1)
