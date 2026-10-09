/**
 * 海湾竞速页面(/race)载入时间线探针。
 *
 * 回答的问题:从导航到「可开跑」这段时间花在哪 —— 网络下载、模型解析,还是主线程被
 * 同步工作堵住(长任务)。用于定位「进页面卡顿很久」的根因,也是优化的验收依据。
 *
 * 采集项:
 * 1. 载入遮罩的文案时间线 —— 卡在哪一步一目了然,并给出「遮罩撤掉」的准确时刻;
 * 2. 长任务(P>50ms)时间线 —— 并**按遮罩状态切分**:遮罩底下的阻塞用户看不到,
 *    亮相之后的阻塞才是真正的「假死卡顿」;
 * 3. 资源时序 —— 各 .glb/.fbx/贴图 的下载耗时与体积(看首屏下载量)。
 *
 * ⚠️ 里程碑一律以**页面内的时间戳**为准,不用 Playwright 的轮询返回时刻 ——
 *    主线程被堵住时轮询本身会被推迟,用它会得出"就绪 26 秒"这种失真的结论。
 *
 * 用法:node scripts/probe-race-load-timing.mjs [baseUrl | 完整页面地址]
 *   可传带查询串的完整地址做 A/B,例如 .../race?warmup=0&defer=0
 * 环境变量:SHOTS=1 出载入完成截图
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

// 允许直接传完整页面地址(可带查询串),便于 A/B 对比 ?warmup=0&defer=0 这类开关
const ARG = (process.argv[2] ?? 'http://127.0.0.1:15176').replace(/\/+$/, '')
const PAGE_URL = /\/race(\?|$)/.test(ARG) ? ARG : `${ARG}/race`
const SHOOT = process.env.SHOTS === '1'
const SHOT_DIR = join(process.cwd(), '.verify-shots')
if (SHOOT) mkdirSync(SHOT_DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

// 限速:无头环境走 localhost,带宽无限,「先下载哪些资源」的差别完全测不出来。
// THROTTLE=<kbps> 用 CDP 模拟真实带宽,才能验证"把大件挪出关键路径"是否真的更快。
const THROTTLE_KBPS = Number(process.env.THROTTLE ?? 0)
if (THROTTLE_KBPS > 0) {
  const client = await page.context().newCDPSession(page)
  await client.send('Network.enable')
  await client.send('Network.setCacheDisabled', { cacheDisabled: true })
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 60,
    downloadThroughput: (THROTTLE_KBPS * 1000) / 8,
    uploadThroughput: (THROTTLE_KBPS * 1000) / 8,
  })
  console.log(`网络限速: ${THROTTLE_KBPS} kbps, RTT 60ms, 禁用缓存`)
}

const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text())
})

// 在任何页面脚本之前埋探针:长任务观察器 + 载入遮罩时间线
await page.addInitScript(() => {
  const P = { longTasks: [], statusLog: [] }
  window.__LOADPROBE__ = P
  // 全部用 performance.now()(相对导航起点):与长任务的 startTime 同一时间基准
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        P.longTasks.push({
          start: +entry.startTime.toFixed(1),
          dur: +entry.duration.toFixed(1),
        })
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    /* 无 longtask 支持时降级为纯遮罩时间线 */
  }

  const watchStatus = () => {
    const el = document.querySelector('#race-status')
    if (!el) return false
    let last = ''
    const record = () => {
      const text = el.hidden ? '(hidden)' : el.textContent || ''
      if (text === last) return
      last = text
      P.statusLog.push({ t: +performance.now().toFixed(1), text })
    }
    record()
    new MutationObserver(record).observe(el, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    })
    return true
  }
  if (!watchStatus()) {
    const timer = setInterval(() => {
      if (watchStatus()) clearInterval(timer)
    }, 16)
  }
})

const navStart = Date.now()
await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
console.log(`导航(domcontentloaded): ${Date.now() - navStart} ms`)

// 只用来等一个足够长的观察窗口;真实里程碑取页面内时间戳
await page.waitForFunction(
  () => (window.__LOADPROBE__?.statusLog ?? []).some((s) => s.text === '(hidden)'),
  null,
  { timeout: 180_000, polling: 200 },
).catch(() => undefined)
// 亮相之后再观察一段,才能量到"亮相后卡顿"
await page.waitForTimeout(6000)

const probe = await page.evaluate(() => ({
  ...(window.__LOADPROBE__ ?? {}),
  resources: performance.getEntriesByType('resource').map((r) => ({
    name: r.name.replace(location.origin, ''),
    kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024),
    dur: Math.round(r.duration),
    start: Math.round(r.startTime),
  })),
  paints: performance.getEntriesByType('paint').map((p) => ({
    name: p.name,
    t: Math.round(p.startTime),
  })),
}))

const fmt = (n) => String(Math.round(n)).padStart(7)
const log = probe.statusLog ?? []
const revealAt = log.find((s) => s.text === '(hidden)')?.t ?? null

console.log('\n──── 载入遮罩文案时间线(页面内时间戳)────')
for (const s of log) console.log(`  ${fmt(s.t)} ms  ${s.text}`)
console.log(
  revealAt === null
    ? '  ⚠️ 遮罩始终没有撤掉'
    : `  → 可开跑时刻(遮罩撤掉): ${Math.round(revealAt)} ms`,
)

// 长任务按遮罩状态切分:遮罩底下的阻塞用户看不到,亮相后的才是"假死"
const before = (probe.longTasks ?? []).filter((t) => revealAt === null || t.start < revealAt)
const after = (probe.longTasks ?? []).filter((t) => revealAt !== null && t.start >= revealAt)
const totalBlocking = (list) => list.reduce((sum, t) => sum + Math.max(0, t.dur - 50), 0)

console.log('\n──── 长任务按阶段切分 ────')
console.log(
  `  遮罩底下  ${String(before.length).padStart(3)} 个  阻塞 ${Math.round(totalBlocking(before))} ms  (用户只看到载入条)`,
)
console.log(
  `  亮相之后  ${String(after.length).padStart(3)} 个  阻塞 ${Math.round(totalBlocking(after))} ms  (真正的卡顿)`,
)
const worstAfter = after.slice().sort((a, b) => b.dur - a.dur)[0]
console.log(
  worstAfter
    ? `  亮相后最长的一次冻结: 起于 ${Math.round(worstAfter.start)} ms,持续 ${Math.round(worstAfter.dur)} ms`
    : '  亮相后没有长任务(正常:场景每帧要渲好几遍,软件渲染下每帧都是长任务)',
)
console.log(
  '  ⚠️ 无头 Chromium 走软件光栅化,这个场景一帧要渲 4-5 遍,帧时间 200-400 ms ——',
)
console.log(
  '     「亮相后阻塞」在这里主要反映的是每帧的渲染开销,不是一次性的卡顿;',
)
console.log(
  '     要判断"编译阻塞发生在遮罩内还是亮相后",看 probe-race-cpu-profile.mjs 的逐秒归属。',
)
for (const t of after.slice().sort((a, b) => b.dur - a.dur).slice(0, 5)) {
  console.log(`    起于 ${fmt(t.start)} ms   持续 ${fmt(t.dur)} ms`)
}

console.log('\n──── 首次绘制 ────')
console.log(`  ${probe.paints.map((p) => `${p.name}=${p.t}ms`).join('  ') || '(无)'}`)

console.log('\n──── 体积最大的前 12 个资源 ────')
for (const r of probe.resources.slice().sort((a, b) => b.kb - a.kb).slice(0, 12)) {
  console.log(
    `  ${String(r.kb).padStart(7)} KB  ${String(r.dur).padStart(6)} ms  起于 ${fmt(r.start)} ms  ${r.name}`,
  )
}
const totalKb = probe.resources.reduce((sum, r) => sum + r.kb, 0)
console.log(`  合计下载: ${(totalKb / 1024).toFixed(1)} MB`)

if (SHOOT) {
  await page.screenshot({ path: join(SHOT_DIR, 'race-load-done.png'), animations: 'disabled' })
  console.log('\n  SHOT race-load-done.png')
}

console.log('\n  控制台错误:', errors.length ? errors.slice(0, 5) : '无')
await browser.close()
process.exit(revealAt === null ? 1 : 0)
