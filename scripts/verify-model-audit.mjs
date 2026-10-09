/**
 * /glb 模型体检 + 压缩导出回归。
 *
 * 断言走的是 `window.__glbDebug.viewer` —— 体检与压缩属于引擎能力,DOM 只是壳,
 * 直接断言引擎返回值比截图比对可靠得多(无头环境只有 2~3 FPS)。
 * UI 层单独用 DOM 断言确认面板确实渲染出来了。
 *
 * ⚠️ 必须跑 dev server:`__glbDebug` 挂在 `import.meta.env.DEV` 分支里,
 * 生产构建会被摇掉,对着 preview 跑只会在等待出口时超时且毫无报错。
 *
 * 用法:node scripts/verify-model-audit.mjs [baseUrl]      SHOTS=1 输出截图
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 会话注入的代理会让浏览器连不上本地服务
delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const BASE = (process.argv[2] ?? 'http://127.0.0.1:15176/glb').replace(/\/+$/, '')
const SHOTS = process.env.SHOTS === '1'
const OUT = '.verify-shots'
const MODEL = {
  url: '/models/2024_tesla_model_3_rigged.glb',
  fileName: '2024_tesla_model_3_rigged.glb',
}

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}${detail ? `  ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ✗ ${name}  ${detail}`)
  }
}

if (SHOTS) mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)))

const downloads = []
page.on('download', (d) => downloads.push(d.suggestedFilename()))

console.log('\n=== 打开 /glb ===')
await page.goto(BASE, { waitUntil: 'load', timeout: 90_000 })
await page.waitForFunction(() => Boolean(window.__glbDebug?.viewer), null, { timeout: 90_000 })
check('调试出口就绪', true)

console.log('\n=== 载入示例模型 ===')
await page.evaluate((url) => window.__glbDebug.viewer.loadFromUrl(url), MODEL.url)
await page.waitForFunction(
  (name) => window.__glbDebug?.viewer?.getStats()?.fileName === name,
  MODEL.fileName,
  { timeout: 120_000 },
)
check('模型载入完成', true, MODEL.fileName)

// UI 的体检在 ready 后延迟 500ms 才计算(drawcall 要等渲染稳定)
await page.waitForTimeout(2000)

console.log('\n=== A. 体检指标 ===')
const audit = await page.evaluate(() => window.__glbDebug.viewer.refreshAudit())
check('体检返回报告', Boolean(audit))
check('三角面 > 0', audit?.metrics.triangles > 0, `triangles=${audit?.metrics.triangles}`)
check('顶点 > 0', audit?.metrics.vertices > 0, `vertices=${audit?.metrics.vertices}`)
check('材质 > 0', audit?.metrics.materials > 0, `materials=${audit?.metrics.materials}`)
check('贴图 > 0', audit?.metrics.textures > 0, `textures=${audit?.metrics.textures}`)
check('纹理显存已估算', audit?.metrics.textureMemoryMB > 0, `${audit?.metrics.textureMemoryMB} MB`)
check('绘制调用 > 0', audit?.metrics.drawCalls > 0, `calls=${audit?.metrics.drawCalls}`)
check(
  '节点与网格数合理',
  audit?.metrics.nodes > 0 && audit?.metrics.meshes > 0,
  `nodes=${audit?.metrics.nodes} meshes=${audit?.metrics.meshes}`,
)
check('包围盒尺寸已量测', (audit?.metrics.size ?? []).every((v) => v > 0), (audit?.metrics.size ?? []).join(' × '))

console.log('\n=== B. 评分与问题清单 ===')
check('评分落在 0~100', audit?.score >= 0 && audit?.score <= 100, `score=${audit?.score}`)
check('等级合法', ['A', 'B', 'C', 'D'].includes(audit?.grade), `grade=${audit?.grade}`)
const issues = audit?.issues ?? []
check('问题清单非空', issues.length > 0, `${issues.length} 条`)
check(
  '每条问题字段完整',
  issues.every((i) => i.id && i.title && i.detail && i.level),
  '',
)
const levels = [...new Set(issues.map((i) => i.level))]
check(
  '问题级别取值合法',
  levels.every((l) => ['error', 'warn', 'info', 'good'].includes(l)),
  levels.join(','),
)
// 评分只允许依赖模型固有指标:drawcall 这类随渲染设置波动的实测值一旦进评分,
// 同一模型两次体检就会差出十几分,回归也就锁不住了
const auditAgain = await page.evaluate(() => window.__glbDebug.viewer.refreshAudit())
check(
  '评分可重复(不随渲染波动)',
  auditAgain?.score === audit?.score && auditAgain?.grade === audit?.grade,
  `${audit?.score} vs ${auditAgain?.score}`,
)

console.log('\n=== C. 压缩 ===')
const optimized = await page.evaluate(async () => {
  const result = await window.__glbDebug.viewer.optimizeModel({ algorithm: 'meshopt' })
  return {
    originalBytes: result.originalBytes,
    optimizedBytes: result.optimizedBytes,
    savedRatio: result.savedRatio,
    bytesLength: result.bytes.length,
    magic: String.fromCharCode(...result.bytes.slice(0, 4)),
  }
})
check(
  '压缩返回结果',
  optimized.optimizedBytes > 0,
  `${(optimized.originalBytes / 1048576).toFixed(2)} MB → ${(optimized.optimizedBytes / 1048576).toFixed(2)} MB`,
)
check('产物确实更小', optimized.optimizedBytes < optimized.originalBytes, `省 ${(optimized.savedRatio * 100).toFixed(1)}%`)
check('压缩率 > 20%', optimized.savedRatio > 0.2, `${(optimized.savedRatio * 100).toFixed(1)}%`)
check('产物是合法 glb', optimized.magic === 'glTF', `magic=${optimized.magic}`)
check('字节数与声明一致', optimized.bytesLength === optimized.optimizedBytes)

console.log('\n=== D. 导出下载 ===')
for (const format of ['glb', 'gltf', 'obj', 'stl']) {
  const before = downloads.length
  await page.evaluate((f) => window.__glbDebug.viewer.exportModel(f), format)
  await page.waitForTimeout(2500)
  check(
    `导出 ${format} 触发下载`,
    downloads.length > before,
    downloads[downloads.length - 1] ?? '(无下载)',
  )
}

console.log('\n=== E. UI 面板 ===')
const ui = await page.evaluate(() => {
  const headings = [...document.querySelectorAll('.section h3')].map((h) => h.textContent.trim())
  return {
    headings,
    grade: document.querySelector('.audit-grade')?.textContent?.trim() ?? '',
    issueCount: document.querySelectorAll('.audit-list li').length,
    exportButtons: [...document.querySelectorAll('.export-grid button')].map((b) => b.textContent.trim()),
    optimizeButtons: [...document.querySelectorAll('.segmented.three button')].map((b) =>
      b.textContent.trim(),
    ),
  }
})
check('存在「模型体检」面板', ui.headings.some((h) => h.includes('模型体检')), ui.headings.join(' | ').slice(0, 140))
check('存在「压缩与导出」面板', ui.headings.some((h) => h.includes('压缩与导出')))
check('评分徽章已渲染', /^[ABCD] · \d+$/.test(ui.grade), `grade="${ui.grade}"`)
check('问题清单已渲染', ui.issueCount > 0, `${ui.issueCount} 条`)
check('压缩档位三个', ui.optimizeButtons.length === 3, ui.optimizeButtons.join(','))
check('导出按钮四个', ui.exportButtons.length === 4, ui.exportButtons.join(','))

if (SHOTS) {
  // 该页持续渲染:元素截图会卡在"等待稳定",一律用整页/clip 截图
  await page.screenshot({ path: join(OUT, 'model-audit.png'), animations: 'disabled' })
  console.log('  SHOT model-audit.png')
  // 体检区块在检查器面板深处,滚动过去补一张特写(体检 + 压缩导出两个区块)
  const auditSection = page.locator('.section', { hasText: '模型体检' }).first()
  await auditSection.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  const panels = await page.locator('.panel').all()
  const inspector = panels[panels.length - 1]
  const box = await inspector.boundingBox()
  if (box) {
    await page.screenshot({
      path: join(OUT, 'model-audit-panel.png'),
      clip: box,
      animations: 'disabled',
    })
    console.log('  SHOT model-audit-panel.png')
  }
}

const fatal = errors.filter((e) => !/roads|Failed to fetch|net::/i.test(e))
check('无控制台错误', fatal.length === 0, fatal.slice(0, 3).join(' | '))

await browser.close()
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
process.exit(failed ? 1 : 0)
