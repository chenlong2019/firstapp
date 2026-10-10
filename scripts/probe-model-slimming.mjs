/**
 * 模型瘦身收益评估(离线跑,不参与前端构建)。
 *
 * 职责:对 public/models 下的模型逐个跑「清理 + 量化 + meshopt」这条**浏览器可跑**的
 *       压缩链,报告每个模型的原始体积、贴图占比与压缩后体积,用来判断"先把哪些模型
 *       压掉、能省多少带宽"。
 * 位置:项目根目录运行。
 * 用法:node scripts/probe-model-slimming.mjs [--limit N] [--resize 1024] [模型路径...]
 * 导出:无 —— 以脚本形式直接运行,结果打印到 stdout。
 *
 * 非直觉约定:
 * - 走的是与前端 model-optimize.ts **同一条链**(dedup+prune+weld+quantize+meshopt),
 *   这样评估出的收益就是真实可交付的收益;Draco 故意不参与 —— draco3d npm 包只有
 *   Node 版,浏览器跑不了,拿它算收益会高估。
 * - `Document` 的 transform 是破坏性的,每个变体都要重新 `io.read()` 读一份。
 * - 贴图占比从文档层统计**编码后**字节(不是解码显存),因为省的是下载量。
 * - textencode 会大幅改变体积:按需关掉才看得出几何/贴图的真实构成。
 */
import { NodeIO, Logger } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, weld, meshopt, quantize, textureCompress } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = 'public/models'

// —— 参数解析 ——
const args = process.argv.slice(2)
const limitIndex = args.indexOf('--limit')
const LIMIT = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 12
const explicit = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  })
  // 默认级别会刷几百行 prune/quantize 提示,把结果表挤没;只留错误。
  .setLogger(new Logger(Logger.Verbosity.ERROR))
await MeshoptEncoder.ready

/** 递归找出所有 glb。 */
async function findGlbs(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await findGlbs(full)))
    else if (entry.name.toLowerCase().endsWith('.glb')) out.push(full)
  }
  return out
}

/** 文档层的字节构成(编码后口径)。 */
function breakdown(doc) {
  const root = doc.getRoot()
  let textureBytes = 0
  const dims = []
  for (const texture of root.listTextures()) {
    textureBytes += texture.getImage()?.byteLength ?? 0
    const size = texture.getSize()
    if (size) dims.push(Math.max(size[0], size[1]))
  }
  let triangles = 0
  let vertices = 0
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION')
      const indices = prim.getIndices()
      if (position) vertices += position.getCount()
      if (indices && prim.getMode() === 4) triangles += Math.floor(indices.getCount() / 3)
    }
  }
  return {
    textureBytes,
    textures: root.listTextures().length,
    maxTextureDim: dims.length ? Math.max(...dims) : 0,
    materials: root.listMaterials().length,
    triangles,
    vertices,
    animations: root.listAnimations().length,
  }
}

/** 默认目标:public/models 下体积最大的 LIMIT 个 glb。 */
async function defaultTargets() {
  const all = await findGlbs(ROOT)
  const sized = []
  for (const p of all) sized.push({ p, size: (await stat(p)).size })
  sized.sort((a, b) => b.size - a.size)
  return sized.slice(0, LIMIT).map((x) => x.p)
}

const targets = explicit.length ? explicit : await defaultTargets()

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2)

console.log(
  '模型'.padEnd(46) + '原始'.padStart(9) + '贴图'.padStart(9) + '仅几何'.padStart(9) +
    '几何+贴图'.padStart(11) + '省'.padStart(8),
)
console.log('-'.repeat(94))

let totalRaw = 0
let totalOut = 0
let totalBoth = 0
const rows = []

for (const target of targets) {
  const raw = await readFile(target)
  const doc = await io.read(target)
  const info = breakdown(doc)

  const work = await io.read(target)
  await work.transform(dedup(), prune(), weld(), quantize(), meshopt({ encoder: MeshoptEncoder }))
  const out = await io.writeBinary(work)
  // 压缩后构成要在 transform 之后、同一份文档上统计(不能拿原文件重读)
  const after = breakdown(work)

  // 第二刀:贴图降采样 + WebP。几何与贴图是两条独立的收益来源,贴图往往是更大的那条。
  const textured = await io.read(target)
  await textured.transform(
    dedup(),
    prune(),
    weld(),
    quantize(),
    meshopt({ encoder: MeshoptEncoder }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 82 }),
  )
  const both = await io.writeBinary(textured)

  totalRaw += raw.byteLength
  totalOut += out.byteLength
  totalBoth += both.byteLength
  rows.push({ target, raw: raw.byteLength, out: out.byteLength, both: both.byteLength, info, after })

  console.log(
    relative('.', target).slice(0, 45).padEnd(46) +
      `${mb(raw.byteLength)}MB`.padStart(9) +
      `${mb(info.textureBytes)}MB`.padStart(9) +
      `${mb(out.byteLength)}MB`.padStart(9) +
      `${mb(both.byteLength)}MB`.padStart(11) +
      `${((1 - both.byteLength / raw.byteLength) * 100).toFixed(0)}%`.padStart(8),
  )
}

console.log('-'.repeat(94))
const pct = (a, b) => ((1 - b / a) * 100).toFixed(1)
console.log(
  `合计 ${targets.length} 个模型: ${mb(totalRaw)} MB → 仅几何 ${mb(totalOut)} MB (省 ${pct(totalRaw, totalOut)}%)` +
    ` / 几何+贴图 ${mb(totalBoth)} MB (省 ${pct(totalRaw, totalBoth)}%, 约 ${mb(totalRaw - totalBoth)} MB)`,
)

console.log('\n=== 明细(压缩前 → 压缩后) ===')
for (const row of rows) {
  const before = row.info
  const after = row.after
  console.log(
    `\n${relative('.', row.target)}\n` +
      `  贴图 ${mb(before.textureBytes)}MB→${mb(after.textureBytes)}MB  ${before.textures}→${after.textures} 张` +
      `  最大边 ${before.maxTextureDim}→${after.maxTextureDim}\n` +
      `  三角面 ${before.triangles}→${after.triangles}  顶点 ${before.vertices}→${after.vertices}` +
      `  材质 ${before.materials}→${after.materials}  动画 ${before.animations}→${after.animations}`,
  )
}
