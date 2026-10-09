/**
 * three-engine 通用库构建回归（从「真实消费方」视角验证）。
 *
 * 本脚本不做源码级断言，只验产物能不能被真正用起来：
 *   1. 产物结构 + package.json 分发元数据
 *   2. ESM 产物：three 是否全部外置（peer）、有无被内联进包体
 *   3. UMD 产物：浏览器零构建 <script> 直挂 window.ThreeEngine 能否真的跑起来
 *   4. 消费方用 Vite 打包 ESM 产物能否解析成 bundle
 *   5. .d.ts 能否被 tsc（bundler 解析）消费
 *
 * 前置：先跑 `node scripts/build-lib.mjs`
 * 用法：node scripts/verify-lib-build.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist-lib')

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
const read = (p) => fs.readFileSync(p, 'utf8')
const exists = (p) => fs.existsSync(p)

// ── 1. 产物结构 ────────────────────────────────────────────────────────────
console.log('\n— 1. 产物结构 —')
const esmPath = path.join(dist, 'index.js')
const umdPath = path.join(dist, 'index.umd.cjs')
const dtsPath = path.join(dist, 'index.d.ts')
const pkgPath = path.join(dist, 'package.json')

check('ESM 产物存在', exists(esmPath))
check('UMD 产物存在', exists(umdPath))
check('入口声明文件存在', exists(dtsPath))
check('分发 package.json 存在', exists(pkgPath))

const declDir = path.join(dist, 'three-engine')
const declFiles = exists(declDir) ? fs.readdirSync(declDir).filter((f) => f.endsWith('.d.ts')) : []
// 模块数不写死:以 src/lib/three-engine 的 .ts 文件数为基准,新增/删除模块不用回来改这里
const srcModuleCount = fs
  .readdirSync(path.join(root, 'src/lib/three-engine'))
  .filter((f) => f.endsWith('.ts')).length
check(
  '模块声明齐全(与源码模块数一致)',
  declFiles.length === srcModuleCount,
  `${declFiles.length}/${srcModuleCount} 个`,
)

let pkg = {}
if (exists(pkgPath)) pkg = JSON.parse(read(pkgPath))
check('package.json: name/version', pkg.name === 'three-engine' && !!pkg.version, `${pkg.name}@${pkg.version}`)
check('package.json: module/main/types 三件套', pkg.module === './index.js' && pkg.main === './index.umd.cjs' && pkg.types === './index.d.ts')
check(
  'package.json: exports 指向声明与 ESM',
  pkg.exports?.['.']?.types === './index.d.ts' && pkg.exports?.['.']?.import === './index.js',
)
check('package.json: three 声明为 peerDependency', !!pkg.peerDependencies?.three, pkg.peerDependencies?.three ?? '')
check(
  '产物不含 public/ 静态资源',
  !exists(path.join(dist, 'Cesium')) && !exists(path.join(dist, 'draco')) && !exists(path.join(dist, 'models')),
)

// ── 2. ESM 外置校验 ────────────────────────────────────────────────────────
console.log('\n— 2. ESM 产物：three 必须外置 —')
const esmSrc = exists(esmPath) ? read(esmPath) : ''
const specifiers = new Set(esmSrc.match(/from\s+"([^"]+)"/g)?.map((m) => m.replace(/from\s+"|"/g, '')) ?? [])
const threeSpecifiers = [...specifiers].filter((s) => s === 'three' || s.startsWith('three/'))
check('存在 `from "three"` 外置引用', specifiers.has('three'))
check(
  'three 的 webgpu / tsl / examples 子路径均外置',
  ['three/webgpu', 'three/tsl'].every((s) => specifiers.has(s)) &&
    threeSpecifiers.some((s) => s.includes('examples/jsm')),
  threeSpecifiers.join(' , '),
)
const esmKb = exists(esmPath) ? fs.statSync(esmPath).size / 1024 : 0
// 体积区间:下限 50KB 防产物被清空,上限 400KB 防 three 被误内联进来
check('ESM 体积远小于 three 本体（未内联）', esmKb > 50 && esmKb < 400, `${esmKb.toFixed(1)} KB`)
check('ESM 产物不含 three 实现（无 REVISION 常量）', !/REVISION\s*=\s*['"`]186/.test(esmSrc))

// ── 3. UMD 浏览器直挂 ──────────────────────────────────────────────────────
console.log('\n— 3. UMD 产物：浏览器 <script> 直挂 —')
const umdSrc = exists(umdPath) ? read(umdPath) : ''
const umdKb = exists(umdPath) ? fs.statSync(umdPath).size / 1024 : 0
check(
  'UMD 自包含：three 已内联（含 WebGPURenderer 实现、无外置引用）',
  /WebGPURenderer/.test(umdSrc) && !/from\s+"three/.test(umdSrc) && umdKb > 1024,
  `${umdKb.toFixed(1)} KB`,
)
// ⚠️ 回归要点：three 的 DRACOLoader 在模块顶层执行 new URL(..., import.meta.url)，
// 非 ESM 格式下若 import.meta 被置空，工厂体会在初始化时抛 Invalid base URL 而整体中断，
// 症状是 window.ThreeEngine 存在但零导出（构建期仅一条 EMPTY_IMPORT_META 警告，极易漏看）。
check('UMD 已为 import.meta.url 注入合法基址', /document\.currentScript/.test(umdSrc))

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
await page.setContent('<!doctype html><html><body></body></html>')
await page.addScriptTag({ path: umdPath })

const umd = await page.evaluate(() => {
  const T = globalThis.ThreeEngine
  if (!T) return { missing: true }
  const expected = [
    'DroneSim', 'DroneRig', 'DroneLights', 'DroneRadar', 'DroneWorld', 'DroneFly',
    'GlbViewer', 'THREEViewer', 'PostEffects', 'ProjSystem', 'GameInstance', 'GameUI',
  ]
  const areClasses = expected.filter((n) => typeof T[n] === 'function')
  const sim = new T.DroneSim()
  // 空转 2 秒(120 步 × 1/60s),验证纯逻辑层脱离 DOM 也能稳定推进
  for (let i = 0; i < 120; i += 1) sim.step(1 / 60)
  const snap = sim.snapshot()
  return {
    missing: false,
    exportCount: Object.keys(T).length,
    areClasses,
    expectedCount: expected.length,
    phase: snap.phase,
    battery: Math.round(snap.batteryPercent),
    armFold: snap.armFold,
    configMaxAlt: T.DEFAULT_CONFIG?.maxAltitude,
    specWeightKg: T.DRONE_SPEC?.weightKg,
    specBatteryWh: T.DRONE_SPEC?.batteryWh,
  }
})

check('window.ThreeEngine 全局对象存在', !umd.missing)
check('无页面错误（零外部依赖即自洽）', pageErrors.length === 0, pageErrors.join(' ; '))
check('导出体积/数量合理', (umd.exportCount ?? 0) > 30, `${umd.exportCount} 个导出`)
check(
  '12 个主类均为可实例化构造函数',
  (umd.areClasses?.length ?? 0) === umd.expectedCount,
  `${umd.areClasses?.length}/${umd.expectedCount}`,
)
check('纯逻辑层可在无 DOM 依赖下实例化并推进', umd.phase === 'powerOff' && umd.battery === 100, `phase=${umd.phase} 电量=${umd.battery}%`)
check(
  '常量表随包导出',
  umd.configMaxAlt === 120 && umd.specWeightKg === 0.249 && umd.specBatteryWh === 18.96,
  `maxAltitude=${umd.configMaxAlt} 重量=${umd.specWeightKg}kg 电池=${umd.specBatteryWh}Wh`,
)
await browser.close()

// ── 4. 消费方用 Vite 打包 ESM 产物 ─────────────────────────────────────────
console.log('\n— 4. 消费方打包 ESM 产物 —')
const tmpDir = path.join(root, 'node_modules', '.tmp', 'lib-consumer')
fs.mkdirSync(tmpDir, { recursive: true })
const entryFile = path.join(tmpDir, 'entry.ts')
const relEsm = path.relative(tmpDir, esmPath).split(path.sep).join('/')
fs.writeFileSync(
  entryFile,
  `import { DroneSim, DroneRig, GlbViewer, DEFAULT_CONFIG, NEUTRAL_STICK } from '${relEsm.startsWith('.') ? relEsm : './' + relEsm}'\n` +
    `const sim = new DroneSim()\nsim.step(1 / 60)\n` +
    `export const bundle = { sim, DroneRig, GlbViewer, DEFAULT_CONFIG, NEUTRAL_STICK, snap: sim.snapshot() }\n`,
  'utf8',
)

const consumerOut = path.join(root, 'node_modules', '.tmp', 'lib-consumer-dist')
let consumerOk = false
let consumerError = ''
try {
  const { build } = await import('vite')
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    build: {
      outDir: consumerOut,
      emptyOutDir: false,
      minify: false,
      lib: { entry: entryFile, name: 'ConsumerBundle', formats: ['es'], fileName: () => 'consumer.js' },
    },
  })
  consumerOk = true
} catch (error) {
  consumerError = error instanceof Error ? error.message : String(error)
}
const consumerFile = path.join(consumerOut, 'consumer.js')
check('Vite 能把 ESM 产物打成 bundle', consumerOk && exists(consumerFile), consumerError.slice(0, 200))
if (exists(consumerFile)) {
  const consumerSrc = read(consumerFile)
  check('bundle 内联了 three（消费方自带）', /WebGPURenderer/.test(consumerSrc) && consumerSrc.length > 1024 * 1024)
  check('bundle 含库内符号（模块图解析成功）', consumerSrc.includes('DroneSim'))
}

// ── 5. .d.ts 被 tsc 消费 ───────────────────────────────────────────────────
console.log('\n— 5. 类型声明可消费 —')
const consumerTs = path.join(dist, '__consumer-check.ts')
fs.writeFileSync(
  consumerTs,
  `import {
  DroneSim, DroneRig, DroneLights, DroneRadar, DroneWorld, DroneFly,
  GlbViewer, THREEViewer, PostEffects, ProjSystem, GameInstance, GameUI,
  DEFAULT_CONFIG, DRONE_SPEC, NEUTRAL_STICK,
} from './index.js'
import type { DroneSnapshot, FlightPhase, StickState } from './index.js'

const sim = new DroneSim()
sim.step(1 / 60)
const snapshot: DroneSnapshot = sim.snapshot()
const phase: FlightPhase = snapshot.phase
const stick: StickState = snapshot.stick
const ctors: Array<unknown> = [
  DroneRig, DroneLights, DroneRadar, DroneWorld, DroneFly,
  GlbViewer, THREEViewer, PostEffects, ProjSystem, GameInstance, GameUI,
]
export const probe = { phase, stick, ctors, cfg: { ...DEFAULT_CONFIG }, spec: DRONE_SPEC, neutral: NEUTRAL_STICK }
`,
  'utf8',
)
const consumerTsconfig = path.join(dist, '__consumer-tsconfig.json')
fs.writeFileSync(
  consumerTsconfig,
  `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['__consumer-check.ts'],
    },
    null,
    2,
  )}\n`,
  'utf8',
)

// 同样用编译器 API 在进程内检查:本机 spawnSync 起子进程偶发 EBUSY
const ts = (await import('typescript')).default
const consumerConfig = ts.readConfigFile(consumerTsconfig, ts.sys.readFile)
const consumerParsed = ts.parseJsonConfigFileContent(consumerConfig.config, ts.sys, dist)
const consumerProgram = ts.createProgram(consumerParsed.fileNames, consumerParsed.options)
const consumerDiagnostics = ts.getPreEmitDiagnostics(consumerProgram)
const consumerMessages = consumerDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
check(
  'tsc 以 bundler 解析消费 .d.ts 无错误',
  consumerDiagnostics.length === 0,
  consumerMessages.slice(0, 3).join(' ; '),
)
check('声明文件非空', exists(dtsPath) && read(dtsPath).length > 200)

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} 库构建回归：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`)
process.exit(fail === 0 ? 0 : 1)
