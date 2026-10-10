/**
 * GLB 二进制体检:不解码、不建场景,直接读容器算出与 `auditScene` 同口径的指标。
 *
 * 职责:解析 GLB 容器(魔数 / 分块 / JSON / BIN),从 glTF JSON 里把指标抠出来 ——
 *       三角面与顶点来自 `accessor.count`、材质来自 primitive 的 material 引用、
 *       贴图边长读 PNG/JPEG/WebP 的文件头 —— 全程**不解码图像、不构造 THREE 对象**,
 *       因此单模型是毫秒级,批量扫几十个大模型也不会把内存打爆。
 * 位置:`/models` 工作台的批量体检用它;`/glb` 查看器仍然用 `auditScene`(那边模型本来
 *       就已经在内存里了,再解析一遍字节反而多余)。
 * 导出:`inspectGlbBytes()`、`collectMetricsFromGlb()`、`parseGlbContainer()`、`imageDimensions()`。
 *
 * 非直觉约定:
 * - **两条口径必须一致**:本文件产出的 `AuditMetrics` 要和 `collectMetricsFromScene` 对上,
 *   所以这里刻意模仿 three 的 GLTFLoader 行为 —— 多 primitive 的 mesh 会被包一层 Group、
 *   strip/fan 会被转成三角形索引、没有 material 的 primitive 共用一个默认材质……
 *   这些"不是 glTF 规范、而是 three 实现细节"的地方都有注释标注。回归 verify-model-batch
 *   会在真实模型上逐指标对比两条路,发现漂移就说明这里模仿错了。
 * - 计数按**节点实例**而非 mesh 定义:同一个 mesh 被两个节点引用会在场景里出现两次,
 *   指标也必须算两次。贴图按「索引 + 颜色空间」去重;**材质按「索引 + 克隆标记」去重** ——
 *   GLTFLoader 会因缺切线/顶点色/缺法线克隆材质,直接按索引去重会少算,见 `materialFlags()`。
 * - 只支持**自包含 GLB**。`.gltf` + 外部 `.bin`/贴图没法从单个字节流读出全貌,
 *   调用方应先用 `isSelfContainedGlb()` 判掉并给出"跳过"的理由。
 * - Draco 压缩的 primitive 拿不到 `min`/`max`(accessor 无 bufferView),包围盒会缺一块;
 *   面数与顶点数不受影响(计数写在 JSON 里,与压缩无关)。KTX2/basisu 贴图读不出边长,按 0 计。
 */
import { auditFromMetrics } from './model-audit-rules'
import type { AuditMetrics, AuditReport } from './model-audit-rules'

// ──────────────────────────────────────────────────────────────────────────
// glTF JSON 的最小结构
// 只声明用到的字段,且全部可选 —— 输入是不可信的外部文件,任何字段都可能缺席。
// ──────────────────────────────────────────────────────────────────────────

/** accessor.componentType:量化后的模型会出现整数类型,反量程要用到。 */
const COMPONENT_BYTE = 5120
const COMPONENT_UNSIGNED_BYTE = 5121
const COMPONENT_SHORT = 5122
const COMPONENT_UNSIGNED_SHORT = 5123
const COMPONENT_UNSIGNED_INT = 5125
const COMPONENT_FLOAT = 5126
/** primitive.mode:0 点 / 1 线 / 2 线环 / 3 线段 / 4 三角形 / 5 三角带 / 6 三角扇。 */
const MODE_TRIANGLES = 4
const MODE_TRIANGLE_STRIP = 5
const MODE_TRIANGLE_FAN = 6

interface GltfAccessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  count: number
  type: string
  /** 整数分量是否按类型量程归一化(量化后的模型为 true) */
  normalized?: boolean
  min?: number[]
  max?: number[]
}

interface GltfBufferView {
  buffer: number
  byteOffset?: number
  byteLength: number
  byteStride?: number
}

interface GltfPrimitive {
  attributes?: Record<string, number>
  indices?: number
  material?: number
  mode?: number
}

interface GltfMesh {
  primitives?: GltfPrimitive[]
}

interface GltfNode {
  children?: number[]
  mesh?: number
  skin?: number
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}

interface GltfTextureRef {
  index: number
}

interface GltfMaterial {
  alphaMode?: string
  doubleSided?: boolean
  pbrMetallicRoughness?: {
    baseColorTexture?: GltfTextureRef
    metallicRoughnessTexture?: GltfTextureRef
  }
  normalTexture?: GltfTextureRef
  occlusionTexture?: GltfTextureRef
  emissiveTexture?: GltfTextureRef
}

interface GltfTexture {
  source?: number
  extensions?: { KHR_texture_basisu?: { source?: number } }
}

interface GltfImage {
  bufferView?: number
  mimeType?: string
  uri?: string
}

interface GltfSkin {
  joints?: number[]
}

interface GltfAnimation {
  name?: string
  samplers?: Array<{ input?: number }>
}

interface GltfJson {
  nodes?: GltfNode[]
  meshes?: GltfMesh[]
  accessors?: GltfAccessor[]
  bufferViews?: GltfBufferView[]
  materials?: GltfMaterial[]
  textures?: GltfTexture[]
  images?: GltfImage[]
  skins?: GltfSkin[]
  animations?: GltfAnimation[]
  scenes?: Array<{ nodes?: number[] }>
  scene?: number
}

// ──────────────────────────────────────────────────────────────────────────
// GLB 容器
// ──────────────────────────────────────────────────────────────────────────

/** GLB 魔数 'glTF'(小端 uint32)。 */
const GLB_MAGIC = 0x46546c67
/** 分块类型 JSON / BIN。 */
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

export interface GlbContainer {
  json: GltfJson
  /** BIN 分块;纯 JSON 的 glb(无几何)时为 null。 */
  bin: Uint8Array | null
  version: number
}

/**
 * GLB 是否是"自包含"的(可单文件搬运、可被本模块体检)。
 * 判据很宽松:魔数 + JSON 分块能解析出来即可 —— 具体解析错误留给 `parseGlbContainer` 报。
 */
export function isSelfContainedGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(0, true) === GLB_MAGIC
}

/**
 * 解析 GLB 容器,取出 JSON 与 BIN 两个分块。
 *
 * 分块长度**已包含 4 字节对齐的填充**,所以直接 `offset = 分块起点 + 长度` 即可,
 * 不要再自己补齐 —— 自己补会多跳或者少跳,越界报错会变得难以定位。
 *
 * @throws 头部不完整 / 魔数不符 / 版本不是 2 / 分块越界 / 缺 JSON 分块 / JSON 解析失败
 */
export function parseGlbContainer(bytes: Uint8Array): GlbContainer {
  if (bytes.byteLength < 12) throw new Error('GLB 头部不完整(不足 12 字节)')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('不是 GLB 文件(魔数不匹配)')
  const version = view.getUint32(4, true)
  if (version !== 2) throw new Error(`不支持的 GLB 版本:${version}(本工具只处理 glTF 2.0)`)

  // 头里的总长度可能与实际字节数不符(文件被追加/截断过):取两者较小值,不越界为第一优先
  const declared = view.getUint32(8, true)
  const limit = Math.min(declared, bytes.byteLength)

  let offset = 12
  let json: GltfJson | null = null
  let bin: Uint8Array | null = null

  while (offset + 8 <= limit) {
    const chunkLength = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    const start = offset + 8
    const end = start + chunkLength
    if (end > bytes.byteLength) throw new Error('GLB 分块长度越界,文件可能被截断')

    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end))) as GltfJson
    } else if (chunkType === CHUNK_BIN) {
      bin = bytes.subarray(start, end)
    }
    offset = end
  }

  if (!json) throw new Error('GLB 缺少 JSON 分块')
  return { json, bin, version }
}

// ──────────────────────────────────────────────────────────────────────────
// 图片尺寸:只读文件头,不解码
// ──────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** JPEG 的 SOF 段(帧起始,带尺寸):C0-CF 里排除 DHT(C4)/JPG(C8)/DAC(CC)。 */
function isJpegSofFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/**
 * 从图片字节头读出 [宽, 高];识别不了(未知格式 / 数据不完整)返回 null。
 *
 * 支持 PNG / JPEG / WebP 三种 —— 覆盖 glb 里实际会出现的全部情况(KTX2 是 GPU 压缩格式,
 * 边长写在自身的头部结构里,这里不解析,返回 null 让调用方按 0 计)。
 * 只读前若干字节,因此对一张 8K 贴图和一张 64px 贴图的开销完全相同。
 */
export function imageDimensions(bytes: Uint8Array): [number, number] | null {
  const read32be = (at: number): number =>
    ((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
  const read16be = (at: number): number => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
  const read32le = (at: number): number =>
    (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)
  // PNG:8 字节签名 + IHDR(长度4 + 类型4),宽高是 IHDR 里的头两个大端 uint32
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) && bytes.byteLength >= 24) {
    return [read32be(16), read32be(20)]
  }

  // JPEG:从 FF D8 之后逐个扫标记段,遇到 SOF 段就是尺寸;遇到 SOS 说明进了熵编码数据,停止
  if ((bytes[0] ?? 0) === 0xff && (bytes[1] ?? 0) === 0xd8) {
    let at = 2
    while (at + 4 <= bytes.byteLength) {
      if (bytes[at] !== 0xff) {
        at++
        continue
      }
      const marker = bytes[at + 1] ?? 0
      if (marker === 0xff) {
        at++
        continue
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2
        continue
      }
      if (marker === 0xda) break
      const segmentLength = read16be(at + 2)
      if (segmentLength < 2) break
      if (isJpegSofFrame(marker) && at + 8 < bytes.byteLength) {
        return [read16be(at + 7), read16be(at + 5)]
      }
      at += 2 + segmentLength
    }
    return null
  }

  // WebP:RIFF....WEBP 之后按子格式解 —— VP8X 是显式 24 位宽高,VP8 是无损/Lossy 的位域
  if (read32le(0) === 0x46464952 && read32le(8) === 0x50424557 && bytes.byteLength >= 30) {
    const chunk = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0)
    if (chunk === 'VP8X') {
      const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16))
      const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16))
      return [width, height]
    }
    if (chunk === 'VP8 ') {
      return [read16be(26) & 0x3fff, read16be(28) & 0x3fff]
    }
    if (chunk === 'VP8L') {
      const bits = read32le(21)
      return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)]
    }
  }

  // KTX2 / basisu 的边长写在自身头部结构里,这里不解析 —— 返回 null,调用方按 0 计
  return null
}

// ──────────────────────────────────────────────────────────────────────────
// 矩阵:包围盒要的是"世界坐标下的盒子",得把节点变换乘出来
// ──────────────────────────────────────────────────────────────────────────

/**
 * 取矩阵元素。`noUncheckedIndexedAccess` 下下标访问是可选类型,统一在这里收口成 number,
 * 免得乘法表达式里到处写 `!` 或 `?? 0`。
 */
function m4(value: ArrayLike<number>, index: number): number {
  return value[index] ?? 0
}

/** 4×4 列主序矩阵相乘(与 glTF `node.matrix` 的存储顺序一致)。 */
function multiplyMat4(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        m4(a, row) * m4(b, col * 4) +
        m4(a, 4 + row) * m4(b, col * 4 + 1) +
        m4(a, 8 + row) * m4(b, col * 4 + 2) +
        m4(a, 12 + row) * m4(b, col * 4 + 3)
    }
  }
  return out
}

/** 变换一个点(仿射矩阵隐含 w=1,不做透视除法)。 */
function transformPoint(matrix: Float64Array, x: number, y: number, z: number): [number, number, number] {
  return [
    m4(matrix, 0) * x + m4(matrix, 4) * y + m4(matrix, 8) * z + m4(matrix, 12),
    m4(matrix, 1) * x + m4(matrix, 5) * y + m4(matrix, 9) * z + m4(matrix, 13),
    m4(matrix, 2) * x + m4(matrix, 6) * y + m4(matrix, 10) * z + m4(matrix, 14),
  ]
}

/** 由节点的 matrix 或 TRS 合成局部矩阵(T × R × S)。 */
function composeLocalMatrix(node: GltfNode): Float64Array {
  const raw = node.matrix
  if (raw && raw.length === 16) {
    const out = new Float64Array(16)
    for (let i = 0; i < 16; i++) out[i] = raw[i] ?? 0
    return out
  }

  const tx = node.translation?.[0] ?? 0
  const ty = node.translation?.[1] ?? 0
  const tz = node.translation?.[2] ?? 0
  const qx = node.rotation?.[0] ?? 0
  const qy = node.rotation?.[1] ?? 0
  const qz = node.rotation?.[2] ?? 0
  const qw = node.rotation?.[3] ?? 1
  const sx = node.scale?.[0] ?? 1
  const sy = node.scale?.[1] ?? 1
  const sz = node.scale?.[2] ?? 1

  // 四元数 → 旋转矩阵(标准公式),再按列乘以缩放,最后写入平移
  const r00 = 1 - 2 * (qy * qy + qz * qz)
  const r01 = 2 * (qx * qy - qw * qz)
  const r02 = 2 * (qx * qz + qw * qy)
  const r10 = 2 * (qx * qy + qw * qz)
  const r11 = 1 - 2 * (qx * qx + qz * qz)
  const r12 = 2 * (qy * qz - qw * qx)
  const r20 = 2 * (qx * qz - qw * qy)
  const r21 = 2 * (qy * qz + qw * qx)
  const r22 = 1 - 2 * (qx * qx + qy * qy)

  const out = new Float64Array(16)
  out[0] = r00 * sx
  out[1] = r10 * sx
  out[2] = r20 * sx
  out[4] = r01 * sy
  out[5] = r11 * sy
  out[6] = r21 * sy
  out[8] = r02 * sz
  out[9] = r12 * sz
  out[10] = r22 * sz
  out[12] = tx
  out[13] = ty
  out[14] = tz
  out[15] = 1
  return out
}

// ──────────────────────────────────────────────────────────────────────────
// 指标采集
// ──────────────────────────────────────────────────────────────────────────

/** 安全取数组元素:下标越界或数组缺席都返回 undefined。 */
function at<T>(list: readonly T[] | undefined, index: number | undefined): T | undefined {
  if (!list || index === undefined || index < 0 || index >= list.length) return undefined
  return list[index]
}

/** 材质的全部贴图槽位,以及该槽位在 three 里对应的颜色空间(sRGB 槽位会让贴图被克隆一次)。 */
function textureSlots(material: GltfMaterial | undefined): Array<{ index: number; srgb: boolean }> {
  if (!material) return []
  const slots: Array<{ index: number; srgb: boolean }> = []
  const base = material.pbrMetallicRoughness?.baseColorTexture?.index
  if (base !== undefined) slots.push({ index: base, srgb: true })
  const emissive = material.emissiveTexture?.index
  if (emissive !== undefined) slots.push({ index: emissive, srgb: true })
  const normal = material.normalTexture?.index
  if (normal !== undefined) slots.push({ index: normal, srgb: false })
  const occlusion = material.occlusionTexture?.index
  if (occlusion !== undefined) slots.push({ index: occlusion, srgb: false })
  const roughness = material.pbrMetallicRoughness?.metallicRoughnessTexture?.index
  if (roughness !== undefined) slots.push({ index: roughness, srgb: false })
  return slots
}

/**
 * GLTFLoader `assignFinalMaterial` 的克隆标记:缺切线 / 带顶点色 / 缺法线。
 *
 * 三者都是克隆键(`ClonedMaterial:<uuid>:derivative-tangents:vertex-colors:flat-shading:`)
 * 的组成部分,所以标记不同的 primitive 即使共用同一个 glTF 材质,也会各自拿到一个克隆体。
 * 注意「缺 TANGENT」在真实模型里几乎总成立(glTF 很少导出切线),因此这个位很关键。
 */
function materialFlags(primitive: GltfPrimitive): string {
  const attributes = primitive.attributes ?? {}
  const derivativeTangents = attributes.TANGENT === undefined ? 'd' : ''
  const vertexColors = attributes.COLOR_0 !== undefined ? 'c' : ''
  const flatShading = attributes.NORMAL === undefined ? 'f' : ''
  return `${derivativeTangents}${vertexColors}${flatShading}`
}

/** 贴图索引 → 图像索引(KHR_texture_basisu 会把 source 挪进扩展里)。 */
function imageIndexOfTexture(texture: GltfTexture | undefined): number | undefined {
  if (!texture) return undefined
  return texture.extensions?.KHR_texture_basisu?.source ?? texture.source
}

/**
 * 从 glTF JSON(+BIN)采集指标。
 *
 * 这里的每一条都在**模仿 GLTFLoader 的产物**,不是照抄规范 —— 差别都写在下面对应的注释里,
 * 因为回归要拿它与 `collectMetricsFromScene` 逐项对比。
 */
export function collectMetricsFromGlb(json: GltfJson, bin: Uint8Array | null = null): AuditMetrics {
  const gltfNodes = json.nodes ?? []
  const meshes = json.meshes ?? []
  const accessors = json.accessors ?? []
  const materials = json.materials ?? []
  const bufferViews = json.bufferViews ?? []

  // three 会为 glTF 的 scene 建一个 Group 当根,所以节点数从 1 起算
  let nodes = 1
  let meshesCount = 0
  let skinnedMeshes = 0
  let primitives = 0
  let triangles = 0
  let vertices = 0
  let missingUvWithTexture = 0
  let missingNormal = 0
  let unindexedMeshes = 0

  // 材质去重。⚠️ 不能只按 glTF 材质索引去重 —— GLTFLoader 的 `assignFinalMaterial` 会在
  // 「缺 TANGENT / 带顶点色 / 缺 NORMAL」时把材质克隆一份,克隆键 = `材质 uuid + 三种标记`
  // (GLTFLoader.js 的 `ClonedMaterial:` 分支),于是"同一材质被有法线与无法线的两条 primitive
  // 共用"会分裂成两个 THREE 材质。这里镜像该规则,用「材质索引(或 default) + 标记位」当复合键。
  const usedMaterialKeys = new Set<string>()
  // 透明 / 双面的判定只需按 glTF 材质索引去重(克隆体与原材质同属性,按克隆体数会翻倍)。
  const usedMaterialIndices = new Set<number>()
  // 贴图按「贴图索引 + 颜色空间」去重:同一个贴图索引被用作 sRGB 槽位与非 sRGB 槽位时,
  // GLTFLoader 会克隆出两个 THREE Texture(共享 image),显存统计会算两次 —— 这里照抄。
  const usedTextures = new Set<string>()

  // 父子关系。⚠️ three 只实例化**默认场景可达**的节点 —— 孤立节点既不出现在场景里、
  // 也不该被统计,所以下面挑根节点时优先看 glTF 的 scene 定义,而不是"没有父节点"。
  const parentOf = new Map<number, number>()
  for (const [index, node] of gltfNodes.entries()) {
    for (const child of node.children ?? []) {
      if (child >= 0 && child < gltfNodes.length) parentOf.set(child, index)
    }
  }

  const sceneDef = at(json.scenes, json.scene ?? 0)
  const sceneRoots = (sceneDef?.nodes ?? []).filter((index) => index >= 0 && index < gltfNodes.length)
  const roots: number[] = sceneRoots.length
    ? [...new Set(sceneRoots)]
    : gltfNodes.map((_, index) => index).filter((index) => !parentOf.has(index))

  // 宽度优先算深度(避免深模型把递归栈打爆);只有根可达的节点才有深度
  const depth = new Map<number, number>()
  const queue: number[] = [...roots]
  for (const root of roots) depth.set(root, 1)
  while (queue.length) {
    const current = queue.shift() ?? -1
    if (current < 0) break
    const currentDepth = depth.get(current) ?? 1
    for (const child of gltfNodes[current]?.children ?? []) {
      if (!depth.has(child) && child >= 0 && child < gltfNodes.length) {
        depth.set(child, currentDepth + 1)
        queue.push(child)
      }
    }
  }

  // 世界包围盒:从场景根出发把节点矩阵乘下来,再把每个 primitive 的 POSITION 盒变换过去。
  // 用可变累加器而不是两个 let —— let 在闭包里被重新赋值后,外层的类型收窄会失效。
  const bounds = {
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
  }

  const extendBox = (positionAccessor: GltfAccessor | undefined, world: Float64Array): void => {
    const positionMin = positionAccessor?.min
    const positionMax = positionAccessor?.max
    if (!positionAccessor || !positionMin || !positionMax) return
    // 量化过的 POSITION 是整数,min/max 也写在未反量化的量程上,要先除回去(见 normalizationDivisor)
    const divisor = positionAccessor.normalized ? normalizationDivisor(positionAccessor.componentType) : 1
    const xs = [(positionMin[0] ?? 0) / divisor, (positionMax[0] ?? 0) / divisor]
    const ys = [(positionMin[1] ?? 0) / divisor, (positionMax[1] ?? 0) / divisor]
    const zs = [(positionMin[2] ?? 0) / divisor, (positionMax[2] ?? 0) / divisor]
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          const [wx, wy, wz] = transformPoint(world, x, y, z)
          bounds.min[0] = Math.min(bounds.min[0], wx)
          bounds.min[1] = Math.min(bounds.min[1], wy)
          bounds.min[2] = Math.min(bounds.min[2], wz)
          bounds.max[0] = Math.max(bounds.max[0], wx)
          bounds.max[1] = Math.max(bounds.max[1], wy)
          bounds.max[2] = Math.max(bounds.max[2], wz)
        }
      }
    }
  }

  const walk = (nodeIndex: number, parentMatrix: Float64Array): void => {
    const node = at(gltfNodes, nodeIndex)
    if (!node) return
    const world = multiplyMat4(parentMatrix, composeLocalMatrix(node))
    // 每个节点都会产生一个 Object3D;⚠️ 多 primitive 的 mesh 在 GLTFLoader 里是
    // 「一个 Group + N 个 Mesh」共 N+1 个对象(单 primitive 时节点本身就是那个 Mesh)。
    // 子节点也会挂到这个 Group 下,所以树的深度同样要 +1。
    nodes += 1
    const mesh = at(meshes, node.mesh)
    if (mesh) {
      const list = mesh.primitives ?? []
      if (list.length > 1) nodes += list.length
      for (const primitive of list) {
        const mode = primitive.mode ?? MODE_TRIANGLES
        const positionAccessor = at(accessors, primitive.attributes?.POSITION)
        const positionCount = positionAccessor?.count ?? 0
        const indexCount = at(accessors, primitive.indices)?.count

        primitives++
        // mode >= 4 的 primitive 会成为 Mesh(三角带/三角扇会被转成三角形索引)
        if (mode >= MODE_TRIANGLES) meshesCount++
        if (node.skin !== undefined && mode >= MODE_TRIANGLES) skinnedMeshes++
        vertices += positionCount

        if (mode === MODE_TRIANGLES) {
          triangles += indexCount !== undefined ? Math.floor(indexCount / 3) : Math.floor(positionCount / 3)
        } else if (mode === MODE_TRIANGLE_STRIP || mode === MODE_TRIANGLE_FAN) {
          // 转成三角形索引后:面数 = 顶点数 - 2(索引化与未索引化都是这个结果)
          triangles += Math.max(0, (indexCount ?? positionCount) - 2)
        } else {
          // 点/线:场景口径对它们的三角形计数就是这个式子(几何上没有三角面),照抄以保持一致
          triangles += indexCount !== undefined ? Math.floor(indexCount / 3) : Math.floor(positionCount / 3)
        }

        // 三角带/三角扇会被转成索引几何,所以"没有索引"只对真·未索引的普通 primitive 成立
        if (primitive.indices === undefined && mode !== MODE_TRIANGLE_STRIP && mode !== MODE_TRIANGLE_FAN) {
          unindexedMeshes++
        }
        if (!primitive.attributes?.NORMAL) missingNormal++

        const materialIndex = primitive.material
        const material = at(materials, materialIndex)
        if (materialIndex !== undefined) {
          usedMaterialIndices.add(materialIndex)
          for (const slot of textureSlots(material)) {
            usedTextures.add(`${slot.index}:${slot.srgb ? 'srgb' : 'linear'}`)
          }
        }
        // "没有材质"的 primitive 共用一份默认材质(createDefaultMaterial 带缓存),但它同样
        // 会被克隆,所以也要并进复合键 —— 用 'default' 当材质键。
        usedMaterialKeys.add(`${materialIndex ?? 'default'}|${materialFlags(primitive)}`)

        // 有贴图却没有 UV —— 场景口径只看 baseColorTexture(即 material.map)
        const hasUv = primitive.attributes?.TEXCOORD_0 !== undefined
        if (!hasUv && material?.pbrMetallicRoughness?.baseColorTexture) missingUvWithTexture++

        // 包围盒:POSITION 的 min/max 缺失时(Draco 压缩)这块就统计不到,只能跳过
        if (mode >= MODE_TRIANGLES) extendBox(positionAccessor, world)
      }
    }
    for (const child of node.children ?? []) walk(child, world)
  }

  for (const root of roots) walk(root, new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))

  // 骨骼:多条 skin 可能共用同一个关节节点,按节点去重
  const joints = new Set<number>()
  for (const skin of json.skins ?? []) {
    for (const joint of skin.joints ?? []) joints.add(joint)
  }

  // 动画:场景口径按 clip.name 去重(three 对无名动画给 `animation_${i}`)
  const animationNames = new Set<string>()
  let animationSeconds = 0
  for (const [index, animation] of (json.animations ?? []).entries()) {
    animationNames.add(animation.name ?? `animation_${index}`)
    for (const sampler of animation.samplers ?? []) {
      const input = at(accessors, sampler.input)
      const seconds = readAccessorLastFloat(input, bufferViews, bin)
      if (seconds !== null) animationSeconds = Math.max(animationSeconds, seconds)
    }
  }

  // 贴图显存与最大边长
  let textureMemory = 0
  let maxTextureSize = 0
  for (const key of usedTextures) {
    const texture = at(json.textures, Number(key.split(':')[0]))
    const image = at(json.images, imageIndexOfTexture(texture))
    const size = imageSizeOf(image, bufferViews, bin)
    if (!size) continue
    textureMemory += Math.round(size[0] * size[1] * 4 * 1.34)
    maxTextureSize = Math.max(maxTextureSize, size[0], size[1])
  }

  // 材质统计:透明 / 双面按 glTF 材质索引去重(克隆体与原材质同属性,按索引数才与场景口径一致)
  let transparentMaterials = 0
  let doubleSidedMaterials = 0
  for (const index of usedMaterialIndices) {
    const material = at(materials, index)
    if (!material) continue
    if (material.alphaMode === 'BLEND') transparentMaterials++
    if (material.doubleSided === true) doubleSidedMaterials++
  }

  // 层级深度:场景根占 1 层;多 primitive 的 mesh 会多出一层 Group
  let maxDepth = 1
  for (const [index, node] of gltfNodes.entries()) {
    const nodeDepth = depth.get(index)
    if (nodeDepth === undefined) continue
    const primitiveCount = at(meshes, node.mesh)?.primitives?.length ?? 0
    maxDepth = Math.max(maxDepth, nodeDepth + 1 + (primitiveCount > 1 ? 1 : 0))
  }

  const size: [number, number, number] = Number.isFinite(bounds.min[0])
    ? [
        +(bounds.max[0] - bounds.min[0]).toFixed(3),
        +(bounds.max[1] - bounds.min[1]).toFixed(3),
        +(bounds.max[2] - bounds.min[2]).toFixed(3),
      ]
    : [0, 0, 0]

  return {
    nodes,
    maxDepth,
    meshes: meshesCount,
    skinnedMeshes,
    primitives,
    triangles,
    vertices,
    materials: usedMaterialKeys.size,
    transparentMaterials,
    doubleSidedMaterials,
    textures: usedTextures.size,
    textureMemoryMB: +(textureMemory / 1024 / 1024).toFixed(1),
    maxTextureSize,
    bones: joints.size,
    animations: animationNames.size,
    animationSeconds: +animationSeconds.toFixed(2),
    // 字节口径没有渲染器,drawcall 无从实测;它是展示项、不参与评分(见 model-audit 的约定)
    drawCalls: 0,
    missingUvWithTexture,
    missingNormal,
    unindexedMeshes,
    size,
  }
}

/** 读 accessor 的最后一个 FLOAT 分量(动画时长用):优先 min/max,缺失时回落到 BIN 里的实际数据。 */
function readAccessorLastFloat(
  accessor: GltfAccessor | undefined,
  bufferViews: readonly GltfBufferView[],
  bin: Uint8Array | null,
): number | null {
  if (!accessor || accessor.count <= 0) return null
  const fromMax = accessor.max?.[0]
  if (typeof fromMax === 'number' && Number.isFinite(fromMax)) return fromMax
  if (accessor.componentType !== COMPONENT_FLOAT) return null

  const view = at(bufferViews, accessor.bufferView)
  if (!view || !bin) return null
  const components = componentsOfType(accessor.type)
  if (components <= 0) return null
  const stride = view.byteStride ?? components * 4
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const start = base + (accessor.count - 1) * stride
  if (start < 0 || start + 4 > bin.byteLength) return null
  return new DataView(bin.buffer, bin.byteOffset + start, 4).getFloat32(0, true)
}

/** accessor.type → 分量个数。 */
function componentsOfType(type: string): number {
  switch (type) {
    case 'SCALAR':
      return 1
    case 'VEC2':
      return 2
    case 'VEC3':
      return 3
    case 'VEC4':
      return 4
    case 'MAT2':
      return 4
    case 'MAT3':
      return 9
    case 'MAT4':
      return 16
    default:
      return 0
  }
}

/**
 * 归一化 accessor 的反量程:整数分量要除以它才是实际数值(`normalized: true` 时)。
 *
 * ⚠️ 这里和 three 的行为**故意不一致**:`Box3.setFromObject` 走的是
 * `BufferAttribute.getX()`,拿到的是未反量化的原始整数,所以量化过的模型在 THREE 里
 * 算出的包围盒会大出好几个数量级(把 int16 直接当米用)。字节口径给的是**真实尺寸**,
 * 回归脚本因此把 `size` 排除在"两条口径必须一致"之外,单列一条已知差异。
 */
function normalizationDivisor(componentType: number): number {
  switch (componentType) {
    case COMPONENT_BYTE:
      return 127
    case COMPONENT_UNSIGNED_BYTE:
      return 255
    case COMPONENT_SHORT:
      return 32767
    case COMPONENT_UNSIGNED_SHORT:
      return 65535
    case COMPONENT_UNSIGNED_INT:
      return 4294967295
    default:
      return 1
  }
}

/** 从 image 定义取出内嵌字节,再读尺寸;外部 URI / 无 bufferView 时返回 null。 */
function imageSizeOf(
  image: GltfImage | undefined,
  bufferViews: readonly GltfBufferView[],
  bin: Uint8Array | null,
): [number, number] | null {
  if (!image || !bin) return null
  const view = at(bufferViews, image.bufferView)
  if (!view) return null
  const start = view.byteOffset ?? 0
  const end = start + view.byteLength
  if (start < 0 || end > bin.byteLength) return null
  return imageDimensions(bin.subarray(start, end))
}

/**
 * 对 GLB 字节做一次完整体检。
 *
 * @param bytes glb 原始字节
 * @returns 与 `auditScene` 同口径的报告;解析失败时抛出可读错误
 */
export function inspectGlbBytes(bytes: Uint8Array): AuditReport {
  const started = performance.now()
  const { json, bin } = parseGlbContainer(bytes)
  const metrics = collectMetricsFromGlb(json, bin)
  return auditFromMetrics(metrics, performance.now() - started)
}
