// 生成多格式模型验证夹具:node scripts/make-model-fixtures.mjs [输出目录]
//
// 为什么要自己造:OBJ/STL/PLY 这些格式仓库里没有现成样本,而验证"多格式导入"必须要有真实文件。
// 这里用最小手写内容(立方体 / 四面体)生成,体积几 KB,且每个文件的内容都是可预期的,
// 断言才能写具体数字(例如 STL 恰好 4 个三角面)。
//
// 另外从本地已有资源复制两个"真实世界样本":
//   - Cesium 样例的 COLLADA 模型(带外部 .jpg 贴图,验证 DAE 的同目录资源解析)
//   - public/models/trees 的 FBX(验证二进制 FBX 与外部贴图)
//
// 输出目录默认 `.verify-fixtures/`(已 gitignore);这些文件只给回归脚本用,不进 public、不进 dist。
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(process.argv[2] ?? join(ROOT, '.verify-fixtures'))
mkdirSync(OUT, { recursive: true })

// ————————————————————————— PNG(校验 OBJ 的贴图引用能不能解析到) —————————————————————————
// 手写 PNG:8x8 双色方块。用 zlib 压缩 IDAT,自己算 CRC32 —— 目的是不引任何依赖。
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 生成 size×size 的棋盘格 PNG(两色调),用来肉眼确认贴图真的贴上了。 */
function makeCheckerPng(size = 8) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let offset = 0
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0 // 每行前面的 filter 字节
    offset += 1
    for (let x = 0; x < size; x += 1) {
      const bright = (x + y) % 2 === 0
      raw[offset] = bright ? 0xff : 0x2a
      raw[offset + 1] = bright ? 0x9a : 0x5a
      raw[offset + 2] = bright ? 0x40 : 0x1a
      raw[offset + 3] = 0xff
      offset += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ————————————————————————— OBJ + MTL + PNG —————————————————————————
// 立方体 8 顶点 6 面;材质名 CubeTex 与贴图 cube.png 写在 MTL 里,
// 验证"多文件一起导入时按基名改写相对路径"这条链路。
const OBJ = `# 验证夹具:单位立方体 + 外部材质库
mtllib cube.mtl
o Cube
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
vn 0 0 -1
vn 0 0 1
vn -1 0 0
vn 1 0 0
vn 0 -1 0
vn 0 1 0
vt 0 1
vt 1 1
vt 1 0
vt 0 0
usemtl CubeTex
s off
f 1/1/1 2/2/1 3/3/1 4/4/1
f 5/1/2 8/2/2 7/3/2 6/4/2
f 1/1/3 5/2/3 8/3/3 4/4/3
f 2/1/4 6/2/4 7/3/4 3/4/4
f 1/1/5 2/2/5 6/3/5 5/4/5
f 4/1/6 8/2/6 7/3/6 3/4/6
`

const MTL = `# 验证夹具:单个材质,带贴图
newmtl CubeTex
Ka 0.20 0.20 0.20
Kd 0.85 0.45 0.20
Ks 0.20 0.20 0.20
Ns 32
map_Kd cube.png
`

// ————————————————————————— STL(ASCII,正四面体 4 面) —————————————————————————
const STL = `solid tetra
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
  facet normal 0 -1 0
    outer loop
      vertex 0 0 0
      vertex 0 0 1
      vertex 1 0 0
    endloop
  endfacet
  facet normal 0.5774 0.5774 0.5774
    outer loop
      vertex 1 0 0
      vertex 0 1 0
      vertex 0 0 1
    endloop
  endfacet
  facet normal 1 0 0
    outer loop
      vertex 0 0 0
      vertex 0 1 0
      vertex 0 0 1
    endloop
  endfacet
endsolid tetra
`

// ————————————————————————— PLY(ASCII,1 个四边面 = 2 个三角面,带顶点色) —————————————————————————
const PLY = `ply
format ascii 1.0
comment 验证夹具:带顶点色的四边形(2 个三角面)
element vertex 4
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 2
property list uchar int vertex_indices
end_header
-1 -1 0 255 150 60
1 -1 0 255 150 60
1 1 0 90 200 255
-1 1 0 90 200 255
3 0 1 2
3 0 2 3
`

writeFileSync(join(OUT, 'cube.obj'), OBJ)
writeFileSync(join(OUT, 'cube.mtl'), MTL)
writeFileSync(join(OUT, 'cube.png'), makeCheckerPng())
writeFileSync(join(OUT, 'tetra.stl'), STL)
writeFileSync(join(OUT, 'quad.ply'), PLY)

// ————————————————————————— 大尺度 STL(复现"缩放范围写死"的 bug) —————————————————————————
// 几何与 tetra.stl 相同,整体放大 170 倍 —— 模拟 Mixamo 导出的 FBX(以厘米为单位:人物包围球半径 ~100)。
// 这类模型取景所需距离远超 OrbitControls 写死的 maxDistance=160,相机会被夹进模型内部,
// 表现为"加载完滚轮拉远毫无反应"。必须有这么一个夹具,回归才盖得住这条。
const scaleStl = (source, factor) =>
  source.replace(
    /vertex (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g,
    (_, x, y, z) =>
      `vertex ${(Number(x) * factor).toFixed(4)} ${(Number(y) * factor).toFixed(4)} ${(Number(z) * factor).toFixed(4)}`,
  )

writeFileSync(join(OUT, 'big-tetra.stl'), scaleStl(STL, 170))

// ————————————————————————— GLB 夹具(校验"二进制体检"口径) —————————————————————————
// 手搓一个每个数字都可预期的 glb:1 个 mesh 里塞 3 个 primitive ——
//   A 立方体,带法线 / UV / 贴图材质            → 12 面、8 顶点
//   B 四边形,无法线、无 UV、无材质             →  2 面、4 顶点
//   C 不带索引、无法线、无 UV,却引用 A 的贴图材质 →  1 面、3 顶点
// 期望指标(场景口径与字节口径必须给出一模一样的数字,见 verify-model-batch):
//   triangles 15 · vertices 15 · materials 3 · textures 1 · maxTextureSize 16px
//   missingNormal 2 · missingUvWithTexture 1 · unindexedMeshes 1 · size [2,2,2]
// ⚠️ materials 是 3 而不是 2:glTF 里只定义了 2 个材质,但 three 的 GLTFLoader 会因
//    「缺切线 / 顶点色 / 缺法线」克隆材质(见 glb-inspect 的 materialFlags),这里三条
//    primitive 各命中一个不同的克隆键,于是场景里有 3 个 THREE 材质 —— 字节口径必须跟着数 3。
// 另出一份 tiny-quantized.glb:量化后 accessor.min/max 是**未反量化**的整数,
// 包围盒仍必须是 [2,2,2] —— 专门盯 KHR_mesh_quantization 的反量化。
const CUBE_POSITIONS = new Float32Array([
  -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
  -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
])
const CUBE_NORMALS = new Float32Array([
  0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
])
const CUBE_UVS = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1])
const CUBE_INDICES = new Uint16Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
  3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4,
])
const QUAD_POSITIONS = new Float32Array([-0.2, -0.2, 0, 0.2, -0.2, 0, 0.2, 0.2, 0, -0.2, 0.2, 0])
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3])
const LOOSE_POSITIONS = new Float32Array([-0.1, 0.5, 0, 0.1, 0.5, 0, 0, 0.7, 0])

// 扩展名是 .glb、内容却不是 GLB —— 批量处理要能识别并标记"跳过",而不是抛个看不懂的解析错误
writeFileSync(join(OUT, 'fake.glb'), 'this is definitely not a glb file')

// ————————————————————————— 高压夹具(验证"压缩真的能瘦身") —————————————————————————
// tiny.glb 只有 2 KB —— 对这么小的文件,meshopt 的容器头开销比它省下的几何还多,压缩后
// 反而会**变大**(压缩器的正常表现,不是缺陷)。要验证"压缩确实能瘦身",几何量得够大,
// 所以另出一份高分辨率 UV 球:160×80 段 ≈ 2.56 万面 / 约 0.7 MB,压缩后有明确收益。
const DENSE_SEGMENTS = 160
const DENSE_RINGS = 80

function buildDenseSphere() {
  const positions = []
  const normals = []
  const uvs = []
  const indices = []
  for (let ring = 0; ring <= DENSE_RINGS; ring += 1) {
    const v = ring / DENSE_RINGS
    const phi = v * Math.PI
    for (let segment = 0; segment <= DENSE_SEGMENTS; segment += 1) {
      const u = segment / DENSE_SEGMENTS
      const theta = u * Math.PI * 2
      const x = Math.sin(phi) * Math.cos(theta)
      const y = Math.cos(phi)
      const z = Math.sin(phi) * Math.sin(theta)
      positions.push(x, y, z)
      normals.push(x, y, z)
      uvs.push(u, 1 - v)
    }
  }
  const stride = DENSE_SEGMENTS + 1
  for (let ring = 0; ring < DENSE_RINGS; ring += 1) {
    for (let segment = 0; segment < DENSE_SEGMENTS; segment += 1) {
      const a = ring * stride + segment
      const b = a + stride
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  }
}

try {
  const { Document, NodeIO } = await import('@gltf-transform/core')
  const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions')
  const { quantize } = await import('@gltf-transform/functions')

  const buildTiny = () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const makeAccessor = (name, type, array) =>
      doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer)

    const texture = doc.createTexture('checker').setImage(makeCheckerPng(16)).setMimeType('image/png')
    const textured = doc.createMaterial('Textured').setBaseColorTexture(texture)
    const plain = doc.createMaterial('Plain')

    const cube = doc
      .createPrimitive()
      .setAttribute('POSITION', makeAccessor('posA', 'VEC3', CUBE_POSITIONS))
      .setAttribute('NORMAL', makeAccessor('nrmA', 'VEC3', CUBE_NORMALS))
      .setAttribute('TEXCOORD_0', makeAccessor('uvA', 'VEC2', CUBE_UVS))
      .setIndices(makeAccessor('idxA', 'SCALAR', CUBE_INDICES))
      .setMaterial(textured)

    const quad = doc
      .createPrimitive()
      .setAttribute('POSITION', makeAccessor('posB', 'VEC3', QUAD_POSITIONS))
      .setIndices(makeAccessor('idxB', 'SCALAR', QUAD_INDICES))
      .setMaterial(plain)

    const loose = doc
      .createPrimitive()
      .setAttribute('POSITION', makeAccessor('posC', 'VEC3', LOOSE_POSITIONS))
      .setMaterial(textured)

    const mesh = doc.createMesh('Tiny').addPrimitive(cube).addPrimitive(quad).addPrimitive(loose)
    const root = doc.createNode('TinyRoot').setMesh(mesh)
    root.addChild(doc.createNode('TinyChild'))
    doc.createScene('Scene').addChild(root)
    return doc
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  writeFileSync(join(OUT, 'tiny.glb'), Buffer.from(await io.writeBinary(buildTiny())))

  const quantified = buildTiny()
  await quantified.transform(quantize())
  writeFileSync(join(OUT, 'tiny-quantized.glb'), Buffer.from(await io.writeBinary(quantified)))

  // 高压夹具:走完全一样的写入路径,只是几何量足够大 —— 压缩前后才有可测的差异
  const sphere = buildDenseSphere()
  const denseDoc = new Document()
  const denseBuffer = denseDoc.createBuffer()
  const denseAccessor = (name, type, array) =>
    denseDoc.createAccessor(name).setType(type).setArray(array).setBuffer(denseBuffer)
  const denseMesh = denseDoc.createMesh('Dense').addPrimitive(
    denseDoc
      .createPrimitive()
      .setAttribute('POSITION', denseAccessor('dpos', 'VEC3', sphere.positions))
      .setAttribute('NORMAL', denseAccessor('dnrm', 'VEC3', sphere.normals))
      .setAttribute('TEXCOORD_0', denseAccessor('duv', 'VEC2', sphere.uvs))
      .setIndices(denseAccessor('didx', 'SCALAR', sphere.indices)),
  )
  denseDoc.createScene('Scene').addChild(denseDoc.createNode('DenseRoot').setMesh(denseMesh))
  writeFileSync(join(OUT, 'dense.glb'), Buffer.from(await io.writeBinary(denseDoc)))
  console.log('已生成: tiny.glb / tiny-quantized.glb(二进制体检口径)/ dense.glb(可压缩性)')
} catch (error) {
  console.log(`GLB 夹具生成失败(跳过): ${error.message}`)
}

// ————————————————————————— 真实样本(复制,缺失则跳过并提示) —————————————————————————
const copies = [
  [
    'D:/project/Cesium-1.144/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.dae',
    'CesiumMilkTruck.dae',
  ],
  [
    'D:/project/Cesium-1.144/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.jpg',
    'CesiumMilkTruck.jpg',
  ],
  [join(ROOT, 'public/models/trees/Tree.fbx'), 'Tree.fbx'],
  [join(ROOT, 'public/models/trees/Tree_Tex.png'), 'Tree_Tex.png'],
]

const missing = []
for (const [source, name] of copies) {
  if (!existsSync(source)) {
    missing.push(source)
    continue
  }
  copyFileSync(source, join(OUT, name))
}

console.log(`夹具目录: ${OUT}`)
console.log('已生成: cube.obj / cube.mtl / cube.png / tetra.stl / quad.ply / big-tetra.stl')
console.log(`已复制: ${copies.length - missing.length} 个真实样本`)
if (missing.length) console.log(`缺失(跳过):\n  ${missing.join('\n  ')}`)
