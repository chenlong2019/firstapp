/**
 * 验证模型体检与压缩链路(离线跑,不参与前端构建)。
 *
 * 职责:对真实 glb 计算体检指标,并对比「无压缩 / Draco / meshopt」三种产物的体积,
 *       为前端「模型体检 + 压缩导出」面板提供依据与回归基线。
 * 位置:项目根目录运行。
 * 用法:node scripts/probe-gltf-optimize.mjs [模型路径]
 *
 * 非直觉约定:
 * - Draco 的编码器是 wasm,`createEncoderModule()` 必须 await,否则 transform 时静默失败。
 * - `Document` 的 transform 是破坏性的,每次对比都要重新 `io.read()` 读一份新文档。
 * - 指标一律从原始文件层统计(不是 three 渲染层),这样与「交付给别人的模型」一致。
 */
import { NodeIO, Logger } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, weld, draco, meshopt, quantize } from '@gltf-transform/functions'
import draco3d from 'draco3d'
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const INPUT = process.argv[2] ?? 'public/models/2024_tesla_model_3_rigged.glb'
const OUT = '.verify-fixtures/optimize'

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  })
await MeshoptEncoder.ready

/** 从文档层统计体检指标。 */
function audit(doc) {
  const root = doc.getRoot()
  let triangles = 0
  let vertices = 0
  let primitives = 0
  let indexed = 0
  let withUV = 0
  let withNormal = 0

  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      primitives++
      const position = prim.getAttribute('POSITION')
      const indices = prim.getIndices()
      const mode = prim.getMode()
      const count = indices ? indices.getCount() : position ? position.getCount() : 0
      if (mode === 4) triangles += Math.floor(count / 3)
      if (position) vertices += position.getCount()
      if (indices) indexed++
      if (prim.getAttribute('TEXCOORD_0')) withUV++
      if (prim.getAttribute('NORMAL')) withNormal++
    }
  }

  let textureBytes = 0
  const textureDims = []
  for (const texture of root.listTextures()) {
    const size = texture.getSize()
    if (size) {
      const [w, h] = size
      textureDims.push(`${w}x${h}`)
      // 粗略按 RGBA8 估显存
      textureBytes += w * h * 4
    }
  }

  const joints = root
    .listSkins()
    .reduce((sum, skin) => sum + skin.listJoints().length, 0)

  let animationSeconds = 0
  for (const animation of root.listAnimations()) {
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput()
      const max = input?.getMaxNormalized()
      if (max && max[0] > animationSeconds) animationSeconds = max[0]
    }
  }

  return {
    nodes: root.listNodes().length,
    meshes: root.listMeshes().length,
    primitives,
    triangles,
    vertices,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    textureDims,
    textureBytesMB: +(textureBytes / 1024 / 1024).toFixed(1),
    skins: root.listSkins().length,
    joints,
    animations: root.listAnimations().length,
    animationSeconds: +animationSeconds.toFixed(2),
    indexedRatio: primitives ? `${indexed}/${primitives}` : '-',
    uvRatio: primitives ? `${withUV}/${primitives}` : '-',
    normalRatio: primitives ? `${withNormal}/${primitives}` : '-',
  }
}

/** 跑一条优化链路并返回产物字节数。 */
async function optimize(label, transforms) {
  const document = await io.read(INPUT)
  await document.transform(...transforms)
  const glb = await io.writeBinary(document)
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, `${label}.glb`), glb)
  return glb.byteLength
}

const raw = await readFile(INPUT)
console.log(`\n模型: ${basename(INPUT)}`)
console.log(`原始体积: ${(raw.byteLength / 1024 / 1024).toFixed(2)} MB\n`)

const document = await io.read(INPUT)
const report = audit(document)

console.log('=== 体检指标(文件层) ===')
for (const [key, value] of Object.entries(report)) {
  if (key === 'textureDims') continue
  console.log(`  ${key.padEnd(18)} ${value}`)
}
if (report.textureDims.length) {
  const unique = [...new Set(report.textureDims)]
  console.log(`  纹理尺寸分布       ${unique.slice(0, 8).join(', ')}${unique.length > 8 ? ' ...' : ''}`)
}

console.log('\n=== 压缩对比 ===')
const base = raw.byteLength
const results = []

results.push(['仅清理(dedup+prune+weld)', await optimize('clean', [dedup(), prune(), weld()])])
results.push(['清理 + 量化(纯 JS)', await optimize('quantize', [dedup(), prune(), weld(), quantize()])])
results.push([
  '量化 + meshopt(浏览器可跑)',
  await optimize('quantize-meshopt', [dedup(), prune(), weld(), quantize(), meshopt({ encoder: MeshoptEncoder })]),
])
results.push([
  'Draco 几何压缩(仅 Node)',
  await optimize('draco', [dedup(), prune(), weld(), draco({ quantizePosition: 14 }) ]),
])
results.push([
  'meshopt 几何压缩',
  await optimize('meshopt', [dedup(), prune(), weld(), meshopt({ encoder: MeshoptEncoder })]),
])

for (const [label, bytes] of results) {
  const ratio = ((1 - bytes / base) * 100).toFixed(1)
  console.log(
    `  ${label.padEnd(26)} ${(bytes / 1024 / 1024).toFixed(2)} MB  (省 ${ratio}%)`,
  )
}
console.log(`\n产物目录: ${OUT}`)
