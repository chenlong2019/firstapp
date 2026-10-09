/**
 * three-engine 通用库构建编排。
 *
 * 三步，顺序固定：
 *   1. ESM   —— three 全部 external（vite.lib.config.ts --mode es）
 *   2. UMD    —— three 打进包体（--mode umd），浏览器 <script> 直挂 window.ThreeEngine
 *   3. .d.ts —— tsc 只产声明（tsconfig.lib.json）
 * 最后往 dist-lib/ 写一份可独立分发的 package.json。
 *
 * 用法：node scripts/build-lib.mjs
 * 产物：dist-lib/{index.js, index.js.map, index.umd.cjs, index.umd.cjs.map,
 *               index.d.ts, three-engine/*.d.ts, package.json}
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'dist-lib')

/** 读 app 的 package.json，库版本跟着 app 走 */
const appPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const t0 = Date.now()
const steps = []

function log(msg) {
  process.stdout.write(`${msg}\n`)
}

function kb(file) {
  const size = fs.statSync(file).size
  return `${(size / 1024).toFixed(1)} KB`
}

// ── 0. 清理产物目录 ────────────────────────────────────────────────────────
// 先清空 dist-lib,避免上次构建的残留(如已删模块的 .d.ts)混进分发产物
fs.rmSync(outDir, { recursive: true, force: true })

// ── 1 & 2. Vite 库构建（ESM / UMD） ────────────────────────────────────────
const { build } = await import('vite')

for (const mode of ['es', 'umd']) {
  const label = mode === 'es' ? 'ESM (three external)' : 'UMD (three bundled)'
  log(`\n▶ ${label}`)
  await build({
    root,
    configFile: path.join(root, 'vite.lib.config.ts'),
    mode,
    logLevel: 'warn',
  })
  steps.push(mode)
}

// ── 3. 类型声明 ────────────────────────────────────────────────────────────
// 用 TypeScript 编译器 API 在进程内跑：本机 spawnSync 起子进程偶发 EBUSY，
// 且进程内能拿到结构化诊断（不必去解析 stdout 文本）。
log('\n▶ 类型声明 (.d.ts)')
const ts = (await import('typescript')).default
const tsconfigPath = path.join(root, 'tsconfig.lib.json')
const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
if (configFile.error) {
  log(`✗ 读取 ${path.basename(tsconfigPath)} 失败：${ts.flattenDiagnosticMessageText(configFile.error.messageText, ' ')}`)
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
const program = ts.createProgram(parsed.fileNames, parsed.options)
const emitResult = program.emit()
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitResult.diagnostics]
if (diagnostics.length > 0) {
  for (const diagnostic of diagnostics) {
    const where = diagnostic.file
      ? `${path.relative(root, diagnostic.file.fileName)}(${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1})`
      : ''
    log(`  ${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
  }
  log(`✗ 类型声明生成失败（${diagnostics.length} 个错误）—— 类型错误必须先清零，否则库没有可用的 .d.ts`)
  process.exit(1)
}

// ── 4. 生成可分发包描述 ────────────────────────────────────────────────────
const libPkg = {
  name: 'three-engine',
  version: appPkg.version ?? '0.0.0',
  description: '与框架无关的 Three.js 三维引擎库：无人机飞控仿真、机体装配、灯光、测距雷达、GLB 查看器',
  type: 'module',
  sideEffects: false,
  main: './index.umd.cjs',
  module: './index.js',
  types: './index.d.ts',
  exports: {
    '.': {
      types: './index.d.ts',
      import: './index.js',
      // UMD 产物同时声明为 default，裸 <script> 场景走 CDN 直挂即可
      default: './index.js',
    },
  },
  files: ['index.js', 'index.js.map', 'index.umd.cjs', 'index.umd.cjs.map', 'index.d.ts', 'three-engine'],
  peerDependencies: {
    three: '>=0.180.0',
    // three 不自带类型，ESM 使用方需自行安装；不装也只是丢类型提示，不影响运行
    '@types/three': '>=0.180.0',
  },
  peerDependenciesMeta: {
    '@types/three': { optional: true },
  },
}
fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(libPkg, null, 2)}\n`, 'utf8')

// ── 5. 汇总 ────────────────────────────────────────────────────────────────
log('\n产物：')
log(`  入口                ${kb(path.join(outDir, 'index.js'))} (ESM)`)
const declCount = fs
  .readdirSync(path.join(outDir, 'three-engine'))
  .filter((f) => f.endsWith('.d.ts')).length
log(`  three-engine/*.d.ts  ${declCount} 个模块声明`)
log(`\n✓ 库构建完成（${((Date.now() - t0) / 1000).toFixed(1)}s），输出目录 dist-lib/`)
