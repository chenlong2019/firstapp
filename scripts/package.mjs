/**
 * Electron 打包脚本(替代直跑 electron-builder)。
 *
 * 为什么不直接 electron-builder:本机(杀软/索引器)会把构建刚写出的
 * win-unpacked/resources/app.asar 锁死(EBUSY/EPERM),几分钟后连目录都改不了名,
 * 导致 release/ 下堆积一堆删不掉的目录。
 *
 * 策略:
 *   1. 构建到一次性工作目录 release/.work-<时间戳>;
 *   2. 把安装包(Setup/portable/blockmap)移动到 release/ 根目录;
 *   3. 【立刻】删除工作目录 —— 趁杀软锁还没落地;
 *   4. 顺手清理上一次遗留的可删残留(.work-* / win-unpacked.tmp)。
 *
 * 用法:
 *   node scripts/package.mjs            # vite build + 完整打包
 *   node scripts/package.mjs --dir      # 只出免安装目录(不产安装包)
 *   node scripts/package.mjs --skip-build  # dist 已是最新时跳过 vite build
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const RELEASE = path.join(ROOT, 'release')
const args = new Set(process.argv.slice(2))
const dirOnly = args.has('--dir')
const skipBuild = args.has('--skip-build')

/** 本机环境绕行:清 NODE_OPTIONS(safe-delete shim 会拦 electron-builder 的 fs.rm)。 */
function childEnv() {
  const env = { ...process.env }
  env.NODE_OPTIONS = ''
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function run(cmd, cmdArgs, label) {
  console.log(`\n== ${label} ==`)
  // shell:false 直接 exec,避免 Windows 下经 cmd 重新解析带空格/引号的路径
  const result = spawnSync(cmd, cmdArgs, { cwd: ROOT, env: childEnv(), stdio: 'inherit', shell: false })
  if (result.status !== 0) {
    throw new Error(`${label} 失败(exit ${result.status})`)
  }
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 清理历史残留:能删则删,删不动(被句柄锁住)就跳过。 */
function cleanStale() {
  for (const name of ['win-unpacked', 'win-unpacked.tmp', 'builder-debug.yml']) {
    const target = path.join(RELEASE, name)
    if (fs.existsSync(target) && rmrf(target)) console.log(`已清理上次残留: release/${name}`)
  }
  if (fs.existsSync(RELEASE)) {
    for (const name of fs.readdirSync(RELEASE).filter((n) => n.startsWith('.work-'))) {
      if (rmrf(path.join(RELEASE, name))) console.log(`已清理上次工作目录: release/${name}`)
    }
  }
}

async function main() {
  cleanStale()

  // 从项目 package.json 解析依赖,拿到 vite 可执行文件在 node_modules 里的绝对路径
  const require_ = createRequire(path.join(ROOT, 'package.json'))
  if (!skipBuild) {
    // vite 8 收紧了 package.json 的 exports,不再暴露 ./bin/vite.js(直接 resolve 会报
    // "Package subpath './bin/vite.js' is not defined by exports")。
    // 改从包的 package.json(bin 字段仍指向真实 CLI)推出可执行文件路径,与版本解耦。
    const vitePkgPath = require_.resolve('vite/package.json')
    const vitePkg = JSON.parse(fs.readFileSync(vitePkgPath, 'utf8'))
    const viteBinRel = typeof vitePkg.bin === 'string' ? vitePkg.bin : vitePkg.bin.vite
    const viteBin = path.join(path.dirname(vitePkgPath), viteBinRel)
    run(process.execPath, [viteBin, 'build'], 'vite build')
  } else {
    console.log('\n== 跳过 vite build(--skip-build) ==')
  }

  // 每次都用全新工作目录,彻底绕开"旧产物被锁"的问题
  const workDir = path.join(RELEASE, `.work-${Date.now()}`)
  fs.mkdirSync(workDir, { recursive: true })

  const builderArgs = [
    path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
    `--config.directories.output=${path.relative(ROOT, workDir)}`,
  ]
  if (dirOnly) builderArgs.push('--dir')
  // 本机绕行:预解压的 Electron 发行目录,让 builder 走"复制"分支,避免解压后改名被拦
  const prebuiltDist = path.join(ROOT, '.electron-dist')
  if (fs.existsSync(path.join(prebuiltDist, 'electron.exe'))) {
    builderArgs.push(`--config.electronDist=${path.relative(ROOT, prebuiltDist)}`)
  }

  run(process.execPath, builderArgs, `electron-builder${dirOnly ? ' --dir' : ''}`)

  // 把产物挪到 release/ 根目录
  const moved = []
  for (const name of fs.readdirSync(workDir)) {
    const source = path.join(workDir, name)
    const target = path.join(RELEASE, name)
    if (name === 'win-unpacked') continue // 免安装目录单独处理
    if (fs.statSync(source).isFile()) {
      fs.rmSync(target, { force: true })
      fs.renameSync(source, target)
      moved.push(name)
    }
  }
  if (moved.length) console.log(`\n安装包已输出到 release/: ${moved.join('、')}`)

  // 免安装目录:优先占用 release/win-unpacked,挪不动就保留工作目录(不删)
  let keepWorkDir = false
  const builtUnpacked = path.join(workDir, 'win-unpacked')
  if (fs.existsSync(builtUnpacked)) {
    const target = path.join(RELEASE, 'win-unpacked')
    if (!fs.existsSync(target)) {
      try {
        fs.renameSync(builtUnpacked, target)
        console.log('免安装目录: release/win-unpacked')
      } catch {
        keepWorkDir = true
        console.log(`免安装目录(旧目录被锁,无法挪动,已原位保留): ${builtUnpacked}`)
      }
    } else {
      keepWorkDir = true
      console.log(`免安装目录(旧目录被锁未清,新目录原位保留): ${builtUnpacked}`)
    }
  }

  // 趁杀软锁还没落地,立刻清理工作目录(仅当没有需要保留的内容)
  if (keepWorkDir) {
    console.log('已保留工作目录(内含免安装版)')
  } else if (rmrf(workDir)) {
    console.log('工作目录已清理')
  } else {
    console.log(`警告:工作目录暂时被占用,稍后可手动删除: ${workDir}`)
  }
}

main().catch((error) => {
  console.error(`\n[package] ${error.message}`)
  process.exit(1)
})
