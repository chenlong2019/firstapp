/**
 * 生成在线 demo 的部署目录(仅部署使用)。
 *
 * 职责:把 `dist/` 的构建产物复制到 `.deploy-demo/`,再塞进静态服务器与 `package.json`,
 *       得到一个可以直接上传部署的自包含目录(部署沙箱不跑 vite,只跑 `node server.mjs`)。
 * 位置:项目根目录下运行;产物目录 `.deploy-demo/` 已加入 .gitignore。
 * 导出:无 —— 以脚本形式直接运行。
 *
 * 非直觉约定:
 * - 部署目标刻意不含 `package.json` 里的 `pg` 依赖:整个项目根目录拿去部署会被判定
 *   「需要外部数据库」而拒绝,所以只送静态产物。代价是 /roads 在线上没有后端,属预期降级。
 * - 必须先把 `dist/` 构建好;本脚本不触发 vite build,避免隐式的长时间等待。
 */
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(PROJECT, 'dist')
const OUT = join(PROJECT, '.deploy-demo')

/** 目录体积(递归求和,单位 MB),仅用于打印。 */
async function dirSizeMb(dir) {
  const { readdirSync, statSync } = await import('node:fs')
  let total = 0
  const walk = (p) => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(dir)
  return (total / 1024 / 1024).toFixed(1)
}

const distInfo = await stat(DIST).catch(() => null)
if (!distInfo?.isDirectory()) {
  console.error('[prepare-deploy] 找不到 dist/,请先运行: npx vite build')
  process.exit(1)
}

console.log('[prepare-deploy] 清空旧的部署目录 ...')
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

console.log('[prepare-deploy] 复制 dist/ → .deploy-demo/ ...')
await cp(DIST, OUT, { recursive: true })

console.log('[prepare-deploy] 写入静态服务器 ...')
await cp(join(PROJECT, 'scripts', 'deploy-server.mjs'), join(OUT, 'server.mjs'))

// 无依赖的 package.json:部署沙箱据此识别为 node 项目并执行 npm start
await writeFile(
  join(OUT, 'package.json'),
  JSON.stringify(
    {
      name: 'firstapp-demo',
      private: true,
      type: 'module',
      scripts: { start: 'node server.mjs' },
    },
    null,
    2,
  ) + '\n',
  'utf8',
)

console.log('[prepare-deploy] 完成')
console.log(`  目录: ${OUT}`)
console.log(`  体积: ${await dirSizeMb(OUT)} MB`)
console.log('  启动: node server.mjs  (读取 PORT 环境变量,默认 3000)')
