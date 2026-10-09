/**
 * 多格式模型加载层:把不同格式的模型统一成 `{ scene, animations, fileName, format }`。
 *
 * 为什么单独成一层:GLTFLoader / FBXLoader / OBJLoader / STLLoader / PLYLoader / ColladaLoader
 * 的返回值形态各不相同(有的给 scene、有的直接给 Group、有的只给 BufferGeometry、有的把动画
 * 挂在返回对象自己身上),调用方(GlbViewer)只该关心"拿到一棵可挂进场景的 Object3D + 动画列表"。
 *
 * 关键约定:
 * - STL / PLY 只有几何、没有材质与场景图,这里自行包一层 Mesh/Points 并给默认双面材质;
 * - 只有几何的格式没有动画,`animations` 一律给空数组,调用方不必判空;
 * - 本地多文件导入时,模型里写的相对路径(.mtl / 贴图 / .bin)会被改写成对应文件的 blob URL
 *   —— 靠 LoadingManager.setURLModifier 按"基名"查表,否则 blob URL 没有目录可言,外部资源必然丢。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

/** 查看器支持的模型格式(除 glb/gltf 外都是"常用交换格式"里的经典几种)。 */
export type ModelFormat = 'glb' | 'gltf' | 'fbx' | 'obj' | 'stl' | 'ply' | 'dae'

/** 单种格式的元信息。 */
export interface ModelFormatInfo {
  /** 页面显示名 */
  label: string
  /** 不带点的小写扩展名 */
  extension: string
  /** 该格式是否会引用同目录的外部资源(.mtl / 贴图 / .bin)——决定"要不要支持多文件一起导入" */
  external: boolean
}

/** 格式注册表:新增格式只需在这里加一行,再在 loadByFormat 里补一个分支。 */
export const MODEL_FORMATS: Record<ModelFormat, ModelFormatInfo> = {
  glb: { label: 'glTF 二进制', extension: 'glb', external: false },
  gltf: { label: 'glTF', extension: 'gltf', external: true },
  fbx: { label: 'FBX', extension: 'fbx', external: true },
  obj: { label: 'OBJ', extension: 'obj', external: true },
  stl: { label: 'STL', extension: 'stl', external: false },
  ply: { label: 'PLY', extension: 'ply', external: false },
  dae: { label: 'COLLADA', extension: 'dae', external: true },
}

/** 全部受支持扩展名(带点,小写)。 */
export const MODEL_EXTENSIONS: string[] = Object.values(MODEL_FORMATS).map(
  (info) => `.${info.extension}`,
)

/** 供页面文案使用的扩展名列举(如 `.glb / .gltf / …`)。 */
export const SUPPORTED_EXTENSIONS_TEXT = MODEL_EXTENSIONS.join(' / ')

/** file input 的 accept 属性:扩展名 + 常见 MIME,让系统文件对话框默认过滤出可用的文件。 */
export const MODEL_ACCEPT_ATTRIBUTE = [
  ...MODEL_EXTENSIONS,
  'model/gltf-binary',
  'model/gltf+json',
  'model/fbx',
  'model/obj',
  'model/stl',
  'model/ply',
  'model/vnd.collada+xml',
].join(',')

/** 外部资源扩展名:这些不是"模型本体",而是贴图 / 材质 / 顶点缓冲。 */
const SIDECAR_EXTENSIONS = [
  '.mtl',
  '.bin',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tga',
  '.gif',
  '.ktx2',
  '.ktx',
  '.dds',
  '.hdr',
]

/** 取小写扩展名(含点);没有扩展名时返回空串。 */
function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index).toLowerCase()
}

/** 按文件名/URL 判断格式;不是受支持的模型格式时返回 null。 */
export function detectModelFormat(name: string): ModelFormat | null {
  const key = extensionOf(name.split(/[?#]/)[0] ?? name).slice(1)
  return key in MODEL_FORMATS ? (key as ModelFormat) : null
}

/** 是否是受支持的"模型本体"文件(用于从拖入的一堆文件中挑出主模型)。 */
export function isModelFile(name: string): boolean {
  return detectModelFormat(name) !== null
}

/** 是否是外部资源文件(.mtl / 贴图 / .bin)。 */
export function isSidecarFile(name: string): boolean {
  return !isModelFile(name) && SIDECAR_EXTENSIONS.includes(extensionOf(name))
}

/** 加载完成的模型:调用方只依赖这四个字段,与具体格式无关。 */
export interface LoadedModel {
  /** 可直接挂进场景的根节点 */
  scene: THREE.Object3D
  /** 动画片段(无动画的格式为空数组,不必判空) */
  animations: THREE.AnimationClip[]
  /** 展示用文件名 */
  fileName: string
  format: ModelFormat
  /**
   * glb / gltf 的原始文件字节。
   * 压缩与"省了多少"必须基于原始文件 —— 把 scene 重新导出会产生不同的基准,
   * 压缩比就失去意义。其他格式不保留(压缩时先用 GLTFExporter 转成 glb)。
   */
  sourceBytes?: Uint8Array
}

/** 加载失败原因分类,便于页面给出不同的提示文案。 */
export type ModelLoadErrorCode =
  /** 没有任何可载入的模型文件(只拖了贴图/材质) */
  | 'empty'
  /** 扩展名不受支持 */
  | 'unsupported'
  /** 解析失败(文件损坏、缺解码器、引用了缺失的外部资源) */
  | 'parse'

/** 加载失败:带 code,页面据此区分"选错文件"和"文件本身有问题"。 */
export class ModelLoadError extends Error {
  readonly code: ModelLoadErrorCode

  constructor(message: string, code: ModelLoadErrorCode) {
    super(message)
    this.name = 'ModelLoadError'
    this.code = code
  }
}

/** 进度回调:progress 为 null 表示资源没给 content-length,无法算百分比。 */
export type ModelProgressHandler = (progress: number | null) => void

export interface ModelLoadOptions {
  onProgress?: ModelProgressHandler
}

/** 建 glTF 加载器:压缩过的模型必须挂上 Draco / meshopt 解码器,否则解析直接失败。 */
function createGltfLoader(manager: THREE.LoadingManager): GLTFLoader {
  const loader = new GLTFLoader(manager)
  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath('/draco/')
  loader.setDRACOLoader(dracoLoader)
  loader.setMeshoptDecoder(MeshoptDecoder)
  return loader
}

/**
 * STL / PLY 只有几何没有材质,给一套中性默认材质。
 * 必须双面:这两类文件(尤其扫描件与 3D 打印件)常有翻转的面片方向,单面渲染会看到破洞。
 * PLY 带顶点色时把底色留给白色,否则顶点色会被底色乘暗。
 */
function createGeometryMaterial(vertexColors: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : 0xcfd8dc,
    metalness: 0.08,
    roughness: 0.72,
    side: THREE.DoubleSide,
    vertexColors,
  })
}

/** 把 loader 的 ProgressEvent 折成 0~1 进度(拿不到总长度时给 null)。 */
function progressReporter(onProgress?: ModelProgressHandler) {
  return (event: ProgressEvent): void => {
    const total = event.total || 0
    onProgress?.(total > 0 ? event.loaded / total : null)
  }
}

/** 按格式分派到具体 loader,统一返回 LoadedModel。 */
async function loadByFormat(
  format: ModelFormat,
  url: string,
  manager: THREE.LoadingManager,
  mtlUrl: string | null,
  fileName: string,
  onProgress?: ModelProgressHandler,
): Promise<LoadedModel> {
  const report = progressReporter(onProgress)

  switch (format) {
    case 'glb':
    case 'gltf': {
      const gltf = await createGltfLoader(manager).loadAsync(url, report)
      return { scene: gltf.scene, animations: gltf.animations ?? [], fileName, format }
    }
    case 'fbx': {
      // FBXLoader 的产物是 Group,动画挂在它自己的 animations 上;贴图按文件内相对路径解析
      const group = await new FBXLoader(manager).loadAsync(url, report)
      return { scene: group, animations: group.animations ?? [], fileName, format }
    }
    case 'obj': {
      const loader = new OBJLoader(manager)
      // OBJ 自身不引用材质库(文件里的 mtllib 不会被 OBJLoader 解析),得由调用方找到 .mtl 预先装上
      if (mtlUrl) {
        const materials = await new MTLLoader(manager).loadAsync(mtlUrl)
        materials.preload()
        loader.setMaterials(materials)
      }
      const group = await loader.loadAsync(url, report)
      return { scene: group, animations: [], fileName, format }
    }
    case 'stl': {
      const geometry = await new STLLoader(manager).loadAsync(url, report)
      // ASCII STL 常缺法线,补算一次;否则光照会整片发黑
      if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
      return {
        scene: new THREE.Mesh(geometry, createGeometryMaterial(false)),
        animations: [],
        fileName,
        format,
      }
    }
    case 'ply': {
      const geometry = await new PLYLoader(manager).loadAsync(url, report)
      const colored = Boolean(geometry.getAttribute('color'))
      // 没有索引的 PLY 是点云(只有顶点没有面):用 Points 渲染,当 Mesh 画会拉出乱七八糟的三角形
      if (geometry.index === null) {
        return {
          scene: new THREE.Points(
            geometry,
            new THREE.PointsMaterial({ size: 0.01, vertexColors: colored, sizeAttenuation: true }),
          ),
          animations: [],
          fileName,
          format,
        }
      }
      return {
        scene: new THREE.Mesh(geometry, createGeometryMaterial(colored)),
        animations: [],
        fileName,
        format,
      }
    }
    case 'dae': {
      // 这个版本的 ColladaLoader 把动画挂在 scene.animations 上;访问返回对象自己的
      // .animations 会打一条弃用警告(回归里"控制台必须干净"会因此失败),所以走 scene。
      // 返回类型本身允许 null(空文件 / 解析不出内容时)。
      const collada = await new ColladaLoader(manager).loadAsync(url, report)
      if (!collada) throw new ModelLoadError('COLLADA 内容为空或解析失败', 'parse')
      return {
        scene: collada.scene,
        animations: collada.scene.animations ?? [],
        fileName,
        format,
      }
    }
  }
}

/** 取 URL 的末段文件名(去掉目录、查询串与哈希),用于展示;保留原始大小写。 */
export function displayNameOf(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url
  const last = clean.split(/[\\/]/).pop() ?? clean
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** 同上去掉目录,但转小写 —— 外部资源查表用的键(FS 与网络对大小写不敏感,统一小写最稳)。 */
function baseNameOf(url: string): string {
  return displayNameOf(url).toLowerCase()
}

/**
 * 建"外部资源按基名查表"的加载管理器——本地多文件导入的关键。
 *
 * 本地文件只能拿到 blob URL,而 blob URL 没有目录层级,模型里写的 `Tree_Tex.png`
 * 或 `./textures/a.jpg` 一律解析不到。这里把所有一起选中的文件的 blob URL 按**基名**建索引。
 *
 * 坑:loader 拿到 blob URL 的模型后,会用 `extractUrlBase` 把"目录"拼在相对路径前面,
 * 得到 `blob:http://…/CesiumMilkTruck.jpg` 这种字符串——它以 blob: 开头,看起来像绝对地址,
 * 实际却指向一个不存在的 uuid。所以这里**不能**对 blob: 前缀放行,一律先按基名查表,
 * 查不到才原样放行(data: / http(s): 的真绝对地址、或确实缺失的资源)。
 */
function createResourceManager(resources: Map<string, string>): THREE.LoadingManager {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    return resources.get(baseNameOf(url)) ?? url
  })
  return manager
}

/** 从一起选中的文件里挑出 .mtl(OBJ 的材质库),返回它的 blob URL。 */
function findMtlUrl(resources: Map<string, string>): string | null {
  for (const [name, url] of resources) {
    if (name.endsWith('.mtl')) return url
  }
  return null
}

/**
 * 探测同目录下与 OBJ 同名的 .mtl(仅 URL 载入用)。
 * 先用 HEAD 问一下存不存在:不存在就直接按"无材质"加载,避免 FileLoader 打一条 404 噪音日志
 * (在"控制台必须干净"的回归里,这种噪音和真的报错分不开)。
 */
async function probeSiblingMtl(objUrl: string): Promise<string | null> {
  if (!/^https?:/i.test(objUrl)) return null
  const mtlUrl = objUrl.replace(/\.obj($|[?#])/i, '.mtl$1')
  if (mtlUrl === objUrl) return null
  try {
    const response = await fetch(mtlUrl, { method: 'HEAD' })
    return response.ok ? mtlUrl : null
  } catch {
    return null
  }
}

/**
 * 从一个 URL 载入模型(内置示例、或同目录带外部资源的模型走这条)。
 *
 * @param url 模型地址;格式按 url/fileName 的扩展名判定
 * @param fileName 展示用文件名(缺省取 url 末段)
 */
export async function loadModelFromUrl(
  url: string,
  fileName?: string,
  options: ModelLoadOptions = {},
): Promise<LoadedModel> {
  const name = fileName ?? displayNameOf(url)
  const format = detectModelFormat(name) ?? detectModelFormat(url)
  if (!format) {
    throw new ModelLoadError(
      `不支持的文件类型:${name}。当前支持 ${SUPPORTED_EXTENSIONS_TEXT}`,
      'unsupported',
    )
  }
  const manager = new THREE.LoadingManager()
  const mtlUrl = format === 'obj' ? await probeSiblingMtl(url) : null
  const model = await loadByFormat(format, url, manager, mtlUrl, name, options.onProgress)
  // 再取一份原始字节用于压缩(浏览器 HTTP 缓存会命中,不会真的下载两次)。
  // 取不到不算加载失败:调用方会退回"导出当前场景再压缩"。
  if (format === 'glb' || format === 'gltf') {
    try {
      const response = await fetch(url)
      if (response.ok) model.sourceBytes = new Uint8Array(await response.arrayBuffer())
    } catch {
      // 忽略:源字节属可选增强
    }
  }
  return model
}

/**
 * 从一组本地文件载入模型(拖拽 / 文件选择),支持把外部资源一起选进来。
 *
 * 主模型 = 列表中第一个受支持的模型文件(顺序即用户在文件对话框里的选择顺序、或拖拽顺序),
 * 其余文件一律当作可被引用的外部资源(贴图 / .mtl / .bin)。
 *
 * @throws ModelLoadError 列表里没有模型文件(code='empty'),或解析失败(code='parse')
 */
export async function loadModelFromFiles(
  files: File[],
  options: ModelLoadOptions = {},
): Promise<LoadedModel> {
  const list = Array.from(files)
  const main = list.find((file) => isModelFile(file.name))
  if (!main) {
    throw new ModelLoadError(
      `没有可载入的模型文件。请选择 ${SUPPORTED_EXTENSIONS_TEXT} 中的一种,其余贴图 / .mtl 可一并选中`,
      'empty',
    )
  }
  const format = detectModelFormat(main.name)
  if (!format) {
    throw new ModelLoadError(`不支持的文件类型:${main.name}`, 'unsupported')
  }

  // 所有文件都建 blob URL:主文件要拿来加载,其余用于解析相对路径引用
  const objectUrls: string[] = []
  const resources = new Map<string, string>()
  for (const file of list) {
    const objectUrl = URL.createObjectURL(file)
    objectUrls.push(objectUrl)
    resources.set(file.name.toLowerCase(), objectUrl)
  }

  let released = false
  const release = (): void => {
    if (released) return
    released = true
    objectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl))
  }

  try {
    const manager = createResourceManager(resources)
    const mainUrl = resources.get(main.name.toLowerCase())
    if (!mainUrl) throw new ModelLoadError(`无法读取文件:${main.name}`, 'parse')
    // 解析完成 ≠ 贴图加载完成:loadAsync 只等模型本体,贴图 / 材质库引用的图片
    // 还在异步读取,立刻回收 blob URL 会把它们掐死(表现为贴图变黑/丢材质)。
    // manager.onLoad 在"全部资源"完成后才触发,拿它当回收时机,再加超时兜底
    // (加载失败时 onError 走 catch 分支释放,onLoad 可能永远不来)。
    manager.onLoad = release
    window.setTimeout(release, 30_000)
    const mtlUrl = format === 'obj' ? findMtlUrl(resources) : null
    const model = await loadByFormat(format, mainUrl, manager, mtlUrl, main.name, options.onProgress)
    // 读 File 不依赖 blob URL,放在 release 之前取,免得回收后又被读一次
    if (format === 'glb' || format === 'gltf') {
      model.sourceBytes = new Uint8Array(await main.arrayBuffer())
    }
    return model
  } catch (error) {
    release()
    throw error
  }
}
