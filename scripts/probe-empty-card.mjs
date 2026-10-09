/**
 * 探针:/glb 空状态卡片里"选择模型文件"按钮与下方说明文字是否重叠。
 *
 * 判据(数值,不靠肉眼):按钮矩形与文字段落矩形在垂直方向不得相交。
 * 用法: node scripts/probe-empty-card.mjs [url]   (SHOTS=1 时输出卡片特写截图)
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
if (SHOTS) mkdirSync(DIR, { recursive: true })

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })
await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.empty-card', { timeout: 60_000 })
await page.waitForTimeout(600)

const layout = await page.evaluate(() => {
  const rect = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }
  }
  const style = (selector, prop) => {
    const el = document.querySelector(selector)
    return el ? getComputedStyle(el)[prop] : null
  }
  return {
    button: rect('.empty-primary'),
    tip: rect('.empty-card p.empty-tip'),
    samples: rect('.empty-samples'),
    tipMarginTop: style('.empty-card p.empty-tip', 'marginTop'),
    tipLineHeight: style('.empty-card p.empty-tip', 'lineHeight'),
    buttonHeight: style('.empty-primary', 'height'),
  }
})

const f = (n) => (typeof n === 'number' ? n.toFixed(2) : String(n))
console.log('按钮        :', JSON.stringify(layout.button))
console.log('下方说明    :', JSON.stringify(layout.tip))
console.log('说明 margin-top :', layout.tipMarginTop, ' line-height:', layout.tipLineHeight)

// 重叠判定:垂直区间相交(留 0.5px 容差)
const gapButtonTip = layout.tip.top - layout.button.bottom
const overlap = gapButtonTip < -0.5
console.log(`\n按钮底 → 说明顶 间距 = ${f(gapButtonTip)} px  →  ${overlap ? '重叠(遮挡)' : '正常'}`)

if (SHOTS) {
  // 页面主循环一直在渲染,element.screenshot 会卡在"等待元素稳定"直到超时;
  // 改用整页截图 + clip(不做稳定性等待)
  const box = await page.evaluate(() => {
    const r = document.querySelector('.empty-card').getBoundingClientRect()
    return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }
  })
  await page.screenshot({ path: join(DIR, 'empty-card.png'), clip: box, animations: 'disabled' })
  console.log('SHOT  empty-card.png')
}
await browser.close()
process.exit(overlap ? 1 : 0)
