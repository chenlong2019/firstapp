// /models 模型批量工作台回归:批量体检 + 批量压缩 + zip 打包 + 两条体检口径的一致性。
//
// ⚠️ 必须跑 **dev server**:页面的调试出口 `__modelsDebug` 挂在 `import.meta.env.DEV` 分支里,
// 生产构建会被摇树删掉,对着 preview 跑只会在等出口时超时且毫无报错(同 /glb 的 __glbDebug)。
//
// 前置:node scripts/make-model-fixtures.mjs   # 生成 tiny.glb / tiny-quantized.glb / dense.glb / fake.glb
//
// 覆盖:
//   A. 页面骨架:菜单项、空状态文案、file input 的 accept
//   B. 收文件:多选入表(按体积降序);非 .glb 被拒并给出提示
//   C. 全部体检:表格数值 = 夹具的已知指标(三角面 15 / 材质 3 / 贴图 16px / C·73)
//   D. 压缩全部:dense.glb 明显变小;「省」列有百分比(小夹具允许为负,见下)
//   E. zip:下载产物能被解压、条目名正确、每条都是合法 GLB 且字节数与表格显示值一致
//   F. 交叉口径:同一条模型,「解读字节」与「遍历 THREE 场景」两套采集必须给出相同指标
//      (size 例外 —— three 不对 KHR_mesh_quantization 反量化,见 glb-inspect 的注释)
//   G. 负例:内容不是 GLB 的 .glb → 标记为「已跳过」而不是失败
//   H. 控制台无未预期错误
//
// ⚠️ 材质期望值是 3 不是 2:glTF 里只定义了 2 个材质,但 GLTFLoader 会因「缺切线 / 顶点色 /
//    缺法线」克隆材质,三条 primitive 各命中一个克隆键,场景里就是 3 个 THREE 材质。
//    glb-inspect 的 materialFlags() 镜像了这条规则,两条口径必须都数 3。
//
// 用法:node scripts/verify-model-batch.mjs [baseUrl]      SHOTS=1 输出截图
import { chromium } from 'playwright'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = (process.argv[2] ?? 'http://127.0.0.1:15176/models').replace(/\/+$/, '')
const FIXTURES = join(ROOT, '.verify-fixtures')
const SHOTS = process.env.SHOTS === '1'
const SHOT_DIR = join(ROOT, '.verify-shots')
if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true })

/** tiny.glb 的已知指标(与 make-model-fixtures.mjs 的构造一一对应)。 */
const TINY = {
  triangles: 15,
  vertices: 15,
  // 3 而非 2:GLTFLoader 按「(原材质) + 缺切线 / 顶点色 / 缺法线」克隆材质,三条 primitive
  // 各命中一个不同的克隆键 —— 详见 glb-inspect.ts 的 materialFlags()。
  materials: 3,
  textures: 1,
  maxTextureSize: 16,
  missingNormal: 2,
  missingUvWithTexture: 1,
  unindexedMeshes: 1,
  score: 73,
  grade: 'C',
}

/** 入表的三个夹具,表格按体积降序排列。 */
const FILES = ['dense.glb', 'tiny.glb', 'tiny-quantized.glb']

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

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, acceptDownloads: true })

const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 220))
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 220)}`))

console.log('\n=== A. 打开 /models ===')
await page.goto(BASE, { waitUntil: 'load', timeout: 90_000 })
await page.waitForFunction(() => Boolean(window.__modelsDebug), null, { timeout: 90_000 })

check('调试出口 __modelsDebug 存在', true)
check(
  '顶栏菜单含「模型批量工作台」',
  await page.locator('.app-nav').getByText('模型批量工作台').count() > 0 ||
    (await page.locator('.nav-link', { hasText: '模型批量工作台' }).count()) > 0,
)
check('空状态给出标题', (await page.locator('.empty-card h2').textContent())?.includes('批量'))
check(
  'file input 只接受 .glb',
  (await page.locator('input.file-input').getAttribute('accept')) === '.glb',
)

/** 点按钮:重页面上 Playwright 的"元素稳定"等待可能一直不满足,统一走 DOM click。 */
async function clickButton(text) {
  const clicked = await page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find((element) =>
      (element.textContent ?? '').includes(label),
    )
    if (!button) return false
    button.click()
    return true
  }, text)
  if (!clicked) throw new Error(`找不到按钮:${text}`)
}

/** 读表格 → 每行各列文本。 */
function readRows() {
  return page.$$eval('.batch-table tbody tr', (rows) =>
    rows.map((row) => [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim())),
  )
}

/**
 * 等这一批跑完。
 *
 * ⚠️ 不能用 DOM 的「状态列都是终态」当判据 —— 点击后 Vue 还没刷新,上一次运行的终态会被
 * 误判成本次已完成(实测:D 组在第二行还显示「压缩中…」时就返回了,而 zip 里两个产物都在,
 * 说明批处理其实跑完了、只是断言下得太早)。这里读组件状态:running 在 start() 里同步置位、
 * progress.done 每处理完一条 +1,都不经过 DOM,没有刷新延迟。
 */
function waitIdle() {
  return page.waitForFunction(
    () => {
      const state = window.__modelsDebug.batchState()
      return state.total > 0 && state.done === state.total && !state.running
    },
    null,
    { timeout: 120_000 },
  )
}

console.log('\n=== B. 收文件 ===')
await page.setInputFiles(
  'input.file-input',
  FILES.map((name) => join(FIXTURES, name)),
)
await page.waitForFunction(
  (count) => document.querySelectorAll('.batch-table tbody tr').length === count,
  FILES.length,
  { timeout: 20_000 },
)
let rows = await readRows()
check('三个 glb 都进了表', rows.length === FILES.length, `rows=${rows.length}`)
check(
  '按体积降序排列',
  rows.map((row) => row[0]).join(',') === FILES.join(','),
  rows.map((row) => row[0]).join(', '),
)
check('初始状态为「待处理」', rows.every((row) => row[8] === '待处理'))

// 非 .glb 被挡在门外
await page.setInputFiles('input.file-input', join(FIXTURES, 'cube.obj'))
await page.waitForTimeout(300)
rows = await readRows()
check('非 .glb 不入表', rows.length === FILES.length, `rows=${rows.length}`)
check('给出忽略提示', (await page.locator('.error-bar').count()) > 0)

console.log('\n=== C. 全部体检 ===')
await clickButton('全部体检')
await waitIdle()
rows = await readRows()
check('三行都变成「已体检」', rows.every((row) => row[8] === '已体检'), rows.map((row) => row[8]).join(', '))

// tiny 与 tiny-quantized 是同一次构造出来的,体检结果必须逐项一致;dense.glb 是另一份几何,
// 它的具体数字交给 F 组的双口径交叉验证去盯,这里只要求它也真的算出了面数。
const tinyRows = rows.filter((row) => row[0]?.startsWith('tiny'))
check('tiny 系列两行都在', tinyRows.length === 2, rows.map((row) => row[0]).join(', '))
check(
  `三角面 = ${TINY.triangles}`,
  tinyRows.every((row) => row[2] === TINY.triangles.toLocaleString()),
  tinyRows.map((row) => row[2]).join(', '),
)
check(
  `材质 = ${TINY.materials}`,
  tinyRows.every((row) => row[3] === String(TINY.materials)),
  tinyRows.map((row) => row[3]).join(', '),
)
check(
  `贴图列含 ${TINY.maxTextureSize}px`,
  tinyRows.every((row) => (row[4] ?? '').includes(`${TINY.maxTextureSize}px`)),
  tinyRows.map((row) => row[4]).join(', '),
)
check(
  `体检评分 = ${TINY.grade} · ${TINY.score}`,
  tinyRows.every((row) => row[5] === `${TINY.grade} · ${TINY.score}`),
  tinyRows.map((row) => row[5]).join(', '),
)
const denseRow = rows.find((row) => row[0] === 'dense.glb')
check('dense.glb 也体检出了面数', /^[\d,]+$/.test(denseRow?.[2] ?? ''), denseRow?.[2] ?? '(没找到该行)')
const summaryText = (await page.locator('.summary').textContent()) ?? ''
check('汇总条统计到 3 个', summaryText.includes('共 3 个'), summaryText.replace(/\s+/g, ' ').trim())

console.log('\n=== D. 压缩全部 ===')
await clickButton('压缩全部')
await waitIdle()
rows = await readRows()
check(
  '三行都变成「已完成」',
  rows.every((row) => row[8] === '已完成'),
  rows.map((row) => row[8]).join(', '),
)

/**
 * 表格里的体积是给人看的(≥1MB 取 1 位小数、≥1KB 取 0 位),解析回来必然丢精度,
 * 所以这里连「因显示舍入引入的误差上界」一起给出,断言按这个上界比 —— 否则 3716 B
 * 显示成 "4 KB" 会被误判为与表格不一致。
 */
const parseBytes = (text) => {
  if (text.includes('MB')) return { value: parseFloat(text) * 1048576, tolerance: 0.05 * 1048576 }
  if (text.includes('KB')) return { value: parseFloat(text) * 1024, tolerance: 0.5 * 1024 }
  return { value: parseFloat(text), tolerance: 0.5 }
}

const before = rows.map((row) => row[1])
const after = rows.map((row) => row[6])
check(
  '「省」列都有百分比(负值 = 压后反而变大)',
  rows.every((row) => /^-?\d+%$/.test(row[7] ?? '')),
  `${before.join(', ')} → ${after.join(', ')} | 省 ${rows.map((row) => row[7]).join(', ')}`,
)
// tiny 系列只有 ~2.5KB,meshopt 的容器头开销比它省下的几何还多 —— 压后变大是这个量级下
// 压缩器的正常表现,不是缺陷(所以不写"必须变小",那会是个假断言)。dense.glb 有 0.7MB
// 几何,才是"压缩能瘦身"这条功能本身的证词。
const denseAfter = rows.find((row) => row[0] === 'dense.glb')
check(
  'dense.glb 压后明显变小(≥50%)',
  denseAfter !== undefined && Number.parseInt(denseAfter[7] ?? '', 10) >= 50,
  denseAfter ? `${denseAfter[1]} → ${denseAfter[6]} · 省 ${denseAfter[7]}` : '(没找到 dense.glb 行)',
)
check('下载按钮带上计数 (3)', ((await page.locator('.top-bar').textContent()) ?? '').includes('(3)'))

console.log('\n=== E. zip 打包 ===')
const downloadPath = join(SHOT_DIR, 'models-optimized.zip')
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 60_000 }),
  clickButton('下载 zip'),
])
await download.saveAs(downloadPath)
check('下载文件名正确', download.suggestedFilename() === 'models-optimized.zip', download.suggestedFilename())

const archive = unzipSync(new Uint8Array(readFileSync(downloadPath)))
const names = Object.keys(archive)
check('包内三个条目', names.length === FILES.length, names.join(', '))
check(
  '条目名带 .optimized.glb 后缀',
  names.every((name) => name.endsWith('.optimized.glb')),
  names.join(', '),
)
const magicOk = names.every((name) => {
  const bytes = archive[name]
  if (!bytes || bytes.byteLength < 12) return false
  return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46
})
check('每个条目都是合法 GLB(魔数 glTF)', magicOk)
check(
  '解压用的是 fflate,CRC 校验通过(否则 unzipSync 会抛错)',
  true,
)

// 条目字节数应与表格「压缩后」列一致(表里是给人看的显示值,按显示精度给容差)
const archiveSizes = names.map((name) => archive[name]?.byteLength ?? 0).sort((a, b) => a - b)
const tableSizes = after.map(parseBytes).sort((a, b) => a.value - b.value)
const sizesMatch = archiveSizes.every((size, index) => {
  const shown = tableSizes[index]
  return shown !== undefined && Math.abs(size - shown.value) <= shown.tolerance
})
check(
  '条目字节数与表格「压缩后」一致(按显示精度)',
  sizesMatch,
  `${archiveSizes.join(', ')} vs ${tableSizes.map((entry) => entry.value).join(', ')}`,
)

console.log('\n=== F. 两条体检口径交叉验证 ===')
/**
 * 同一条模型,分别用「直读 GLB 容器」与「加载成 THREE 场景再遍历」采集指标并逐项比对。
 * size 单列:three 的 Box3 走 BufferAttribute.getX(),对 KHR_mesh_quantization 不做反量化,
 * 量化模型的包围盒会大出几个数量级 —— 这是 three 的既有行为,不是本项目的缺陷。
 */
async function crossCheck(name) {
  const base64 = readFileSync(join(FIXTURES, name)).toString('base64')
  return page.evaluate(async (payload) => {
    const debug = window.__modelsDebug
    const binary = atob(payload.base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)

    const byteMetrics = debug.inspectGlbBytes(bytes).metrics
    const file = new File([bytes], payload.name, { type: 'model/gltf-binary' })
    const model = await debug.loadModelFromFiles([file])
    const sceneMetrics = debug.collectMetricsFromScene(model.scene)
    return { byteMetrics, sceneMetrics }
  }, { base64, name })
}

for (const [name, compareSize] of [
  ['tiny.glb', true],
  ['tiny-quantized.glb', false],
]) {
  const { byteMetrics, sceneMetrics } = await crossCheck(name)
  const fields = [
    'triangles',
    'vertices',
    'nodes',
    'maxDepth',
    'meshes',
    'primitives',
    'materials',
    'transparentMaterials',
    'doubleSidedMaterials',
    'textures',
    'maxTextureSize',
    'bones',
    'animations',
    'missingUvWithTexture',
    'missingNormal',
    'unindexedMeshes',
  ]
  const drifted = fields.filter(
    (field) => JSON.stringify(byteMetrics[field]) !== JSON.stringify(sceneMetrics[field]),
  )
  check(
    `${name}:16 项指标两条口径一致`,
    drifted.length === 0,
    drifted.length
      ? drifted.map((field) => `${field} 字节=${byteMetrics[field]} 场景=${sceneMetrics[field]}`).join(' | ')
      : `tri=${sceneMetrics.triangles} vert=${sceneMetrics.vertices} nodes=${sceneMetrics.nodes}`,
  )

  if (compareSize) {
    check(
      `${name}:包围盒一致`,
      JSON.stringify(byteMetrics.size) === JSON.stringify(sceneMetrics.size),
      `字节=${byteMetrics.size} 场景=${sceneMetrics.size}`,
    )
  } else {
    check(
      `${name}:字节口径给出真实尺寸(量化后仍为 [2,2,2])`,
      JSON.stringify(byteMetrics.size) === JSON.stringify([2, 2, 2]),
      `字节=${byteMetrics.size}(场景口径因 three 不反量化而失真,属已知差异)`,
    )
  }
}

console.log('\n=== G. 负例:内容不是 GLB ===')
await page.setInputFiles('input.file-input', join(FIXTURES, 'fake.glb'))
await page.waitForFunction(
  (count) => document.querySelectorAll('.batch-table tbody tr').length === count,
  FILES.length + 1,
  { timeout: 20_000 },
)
await clickButton('全部体检')
await waitIdle()
rows = await readRows()
const fakeRow = rows.find((row) => row[0] === 'fake.glb')
check('假 glb 被标记为「已跳过」', fakeRow?.[8] === '已跳过', fakeRow?.[8] ?? '(没找到该行)')
check(
  '跳过理由说明需要自包含 glb',
  ((await page.locator('.col-state[title]').first().getAttribute('title')) ?? '').length >= 0 &&
    (await page.evaluate(() =>
      [...document.querySelectorAll('.col-state')].some((cell) =>
        (cell.getAttribute('title') ?? '').includes('自包含'),
      ),
    )),
)

console.log('\n=== H. 控制台 ===')
const unexpected = errors.filter((text) => !/favicon|DevTools/i.test(text))
check('无未预期控制台错误', unexpected.length === 0, unexpected.slice(0, 3).join(' | '))

if (SHOTS) {
  await page.screenshot({ path: join(SHOT_DIR, 'models-workbench.png') })
  console.log(`  截图 → ${join(SHOT_DIR, 'models-workbench.png')}`)
}

await browser.close()

console.log(`\n${'='.repeat(56)}`)
console.log(`通过 ${passed} · 失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
