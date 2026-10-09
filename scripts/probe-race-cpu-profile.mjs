/**
 * 海湾竞速页面(/race)载入期 CPU 采样探针 —— 定位"卡顿那几秒到底在跑什么函数"。
 *
 * 与 probe-race-load-timing.mjs 的分工:那个回答"堵了多久"(长任务时长/里程碑),
 * 这个回答"被谁堵住"(函数级自我耗时 + 调用栈归属 + 逐秒时间轴)。用 CDP Profiler
 * 采样,按 self time 聚合到函数,并重建调用栈找出"谁推出的"重活。
 *
 * 用法:node scripts/probe-race-cpu-profile.mjs [baseUrl] [等待毫秒]
 * 默认 http://127.0.0.1:15176 / 等待 25000ms(覆盖整个载入窗口)
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const BASE = (process.argv[2] ?? 'http://127.0.0.1:15176').replace(/\/+$/, '')
const WAIT = Number(process.argv[3] ?? 25000)
const INTERVAL_MS = 0.5

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const client = await page.context().newCDPSession(page)

// 记录载入遮罩的里程碑:后面要把采样时间轴对齐到"撤遮罩"那一刻,才能说清
// 卡顿到底发生在遮罩底下还是亮相之后。
await page.addInitScript(() => {
  window.__MARK__ = { appeared: null, hidden: null, text: [] }
  const M = window.__MARK__
  // 用绝对墙钟(Date.now())打点:和 Node 侧共用同一时钟,才能和剖析时间轴对齐
  const now = () => Date.now()
  const watch = () => {
    const el = document.querySelector('#race-status')
    if (!el) return false
    M.appeared = now()
    const record = () => {
      const last = M.text[M.text.length - 1]
      const text = el.hidden ? '(hidden)' : el.textContent || ''
      if (!last || last.text !== text) {
        M.text.push({ t: now(), text })
        if (el.hidden) M.hidden = now()
      }
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
  if (!watch()) {
    const timer = setInterval(() => {
      if (watch()) clearInterval(timer)
    }, 16)
  }
})

await client.send('Profiler.enable')
await client.send('Profiler.setSamplingInterval', { interval: INTERVAL_MS * 1000 })
await client.send('Profiler.start')

const t0 = Date.now()
await page.goto(`${BASE}/race`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(WAIT)
const { profile } = await client.send('Profiler.stop')
console.log(`采样窗口: ${Date.now() - t0} ms\n`)

const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const parentOf = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id)

const label = (node) => {
  const cf = node.callFrame
  const url = (cf.url || '').replace(/^https?:\/\/127\.0\.0\.1:15176/, '').replace(/^.*\.vite\/deps\//, 'deps/')
  return `${cf.functionName || '(anonymous)'}${url ? ` @ ${url}:${cf.lineNumber + 1}` : ''}`
}

// 采样 → 带时间戳的序列(timeDeltas 与 samples 一一对应)
const samples = profile.samples ?? []
const deltas = profile.timeDeltas ?? []
const timeline = []
let cursor = 0
for (let i = 0; i < samples.length; i++) {
  cursor += (deltas[i] ?? INTERVAL_MS * 1000) / 1000
  timeline.push({ t: cursor, id: samples[i] })
}

// —— 自我耗时排行 ——
const selfMs = new Map()
for (const s of timeline) {
  const node = byId.get(s.id)
  if (!node) continue
  const key = label(node)
  selfMs.set(key, (selfMs.get(key) ?? 0) + INTERVAL_MS)
}
const total = [...selfMs.values()].reduce((a, b) => a + b, 0)

console.log(`──── 函数自我耗时 TOP 20(合计 ${Math.round(total)} ms)────`)
for (const [key, ms] of [...selfMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(Math.round(ms)).padStart(6)} ms  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${key}`)
}

// —— 逐秒时间轴:每秒最耗时的 2 个函数(标出该秒在遮罩内还是亮相后)——
const marks = await page.evaluate(() => window.__MARK__ ?? null)
const revealAt = marks?.hidden ? marks.hidden - t0 : null
console.log(`\n载入遮罩: 出现 ${marks?.appeared ? marks.appeared - t0 : '?'} ms  →  隐藏 ${revealAt ?? '?'} ms`)
for (const s of marks?.text ?? []) console.log(`  ${String(s.t - t0).padStart(7)} ms  ${s.text}`)

console.log('\n──── 逐秒时间轴(每秒 top2 + 该秒采样总时长)────')
const buckets = new Map()
for (const s of timeline) {
  const b = Math.floor(s.t / 1000)
  const node = byId.get(s.id)
  if (!node) continue
  const key = label(node)
  const m = buckets.get(b) ?? new Map()
  m.set(key, (m.get(key) ?? 0) + INTERVAL_MS)
  buckets.set(b, m)
}
for (const b of [...buckets.keys()].sort((a, b2) => a - b2)) {
  const m = buckets.get(b)
  const sum = [...m.values()].reduce((a, c) => a + c, 0)
  const top = [...m.entries()].sort((a, c) => c[1] - a[1]).slice(0, 2)
  const parts = top.map(([k, v]) => `${k.split(' @ ')[0]} ${Math.round(v)}ms`).join('  |  ')
  const phase = revealAt === null ? '' : b * 1000 < revealAt ? '[遮罩中]' : '[亮相后]'
  console.log(
    `  ${String(b).padStart(3)}s ${phase.padEnd(9)} 采样 ${String(Math.round(sum)).padStart(5)}ms   ${parts}`,
  )
}

// —— 重活的调用栈归属:找出是哪条路径把时间吃掉的 ——
console.log('\n──── 关键函数的调用栈(自上而下,附每层自我耗时)────')
const selfOf = (id) => {
  const node = byId.get(id)
  return node ? (selfMs.get(label(node)) ?? 0) : 0
}
const pathOf = (id) => {
  const path = []
  let cur = id
  while (cur !== undefined) {
    path.unshift(label(byId.get(cur)))
    cur = parentOf.get(cur)
  }
  return path
}
// 以"包含 (program) / onFirstUse 的栈"为样本,统计最常见的完整调用路径
const hotIds = new Set()
for (const [key] of selfMs) {
  if (/\(program\)|onFirstUse|texSubImage2D|compileShader/.test(key)) {
    for (const s of timeline) if (label(byId.get(s.id) ?? { callFrame: {} }) === key) hotIds.add(key)
  }
}
const pathCount = new Map()
for (const s of timeline) {
  const key = label(byId.get(s.id) ?? {})
  if (!/\(program\)|onFirstUse|texSubImage2D|compileShader|compile\(/.test(key)) continue
  const p = pathOf(s.id)
    .map((x) => x.split(' @ ')[0])
    .filter((x) => x !== '(anonymous)')
    .slice(-7)
    .join(' → ')
  pathCount.set(p, (pathCount.get(p) ?? 0) + 1)
}
for (const [p, n] of [...pathCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`  ${String(Math.round(n * INTERVAL_MS)).padStart(6)} ms  ${p}`)
}
void selfOf
void hotIds

await browser.close()
