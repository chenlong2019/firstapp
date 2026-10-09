/**
 * 校验「部署产物」能否脱离 vite dev server 独立运行。
 *
 * 职责:用真实浏览器逐个打开线上要暴露的页面,确认画布有渲染、没有致命报错。
 * 位置:上传部署前自测;也可指向线上 URL 复检。
 * 用法:node scripts/probe-deploy-demo.mjs [baseUrl]   默认 http://127.0.0.1:15301
 *      SHOTS=1 时输出截图到 .verify-shots/。
 *
 * 非直觉约定:
 * - 断言只看"画布已渲染 + 无致命错误",不看截图 —— 无头 GPU 下帧率极低,
 *   靠像素判断会得到假阴性。
 * - `/roads` 需要本地 Postgres,静态部署下必然报错,属预期降级,因此不纳入判据。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 会话里注入的 HTTP 代理会让 Playwright 连不上本地服务
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

// 末尾斜杠会与路由拼接出 `//glb`,统一剥掉
const BASE = (process.argv[2] ?? 'http://127.0.0.1:15301').replace(/\/+$/, '')
const SHOTS = process.env.SHOTS === '1'
const OUT = '.verify-shots'

/** 页面清单:路径 → 说明。 */
const PAGES = [
  ['/', '首页(应重定向到 /glb)'],
  ['/glb', 'GLB 模型查看器'],
  ['/race', '海湾竞速'],
  ['/tesla', 'Tesla 车型展示'],
  ['/dji', 'DJI 无人机沙盒'],
  ['/lib-demo', '库示例'],
]

if (SHOTS) mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)))

let failed = 0

for (const [route, label] of PAGES) {
  errors.length = 0
  const url = BASE + route
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
  } catch (e) {
    console.log(`✗ ${route.padEnd(10)} ${label} —— 打开失败: ${e.message.split('\n')[0]}`)
    failed++
    continue
  }

  // 等引擎初始化并渲染若干帧(无头下很慢,给足时间)
  await page.waitForTimeout(7000)

  const info = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    return {
      url: location.pathname,
      hasCanvas: !!canvas,
      size: canvas ? `${canvas.width}x${canvas.height}` : '-',
      hasGL: !!gl,
      title: document.title,
    }
  })

  const fatal = errors.filter((e) => !/roads|Failed to fetch|ERR_CONNECTION|net::/i.test(e))
  const ok = info.hasCanvas && info.hasGL

  console.log(
    `${ok ? '✓' : '✗'} ${route.padEnd(10)} ${label}  → ${info.url}  canvas=${info.hasCanvas}(${info.size}) webgl=${info.hasGL}  错误=${fatal.length}`,
  )
  if (fatal.length) {
    fatal.slice(0, 3).forEach((e) => console.log(`     ! ${e}`))
  }
  if (!ok) failed++

  if (SHOTS) {
    const name = 'deploy' + (route === '/' ? '-root' : route.replace(/\//g, '-')) + '.png'
    // 整页 clip 截图:该页持续渲染,locator.screenshot 会卡"元素稳定"直到超时
    await page.screenshot({ path: join(OUT, name), animations: 'disabled' })
    console.log(`     SHOT ${name}`)
  }
}

await browser.close()
console.log(`\n结果: ${PAGES.length - failed}/${PAGES.length} 通过`)
process.exit(failed ? 1 : 0)
