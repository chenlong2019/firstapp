/**
 * 浏览器侧的模型压缩:把 glb 重新打包得更小。
 *
 * 职责:导出 `optimizeGlb()` —— 清理冗余(dedup/prune/weld)+ 属性量化 + meshopt 几何压缩,
 *       并回报压缩前后的字节数与耗时。
 * 位置:供 /glb 查看器的「模型体检」面板调用;重依赖全部动态 import,不拖累首屏加载。
 *
 * 非直觉约定:
 * - 浏览器必须用 `WebIO`(不是 NodeIO —— 后者依赖 fs/path,浏览器里无法解析)。
 * - `draco3d` 的 npm 包**只有 Node 版**(wasm 靠 fs 读文件),浏览器里跑不了 Draco 编码。
 *   实测同一模型:meshopt 省 46%、Draco 省 58% —— 11 个百分点的差距不值得引入外部 wasm 资源,
 *   因此几何压缩统一走 meshopt(它也是 Khronos 的规定扩展,three 的 MeshoptDecoder 直接能读)。
 * - `Document` 的 transform 是破坏性的:一个 document 只能压一次,重复压缩要先重新读。
 * - 量化会把 float32 属性降到 16 位以内;UV 超出 [0,1] 的模型会被 gltf-transform 自动跳过并打日志,
 *   属正常现象,不影响其余属性。
 */
import type { Document } from '@gltf-transform/core'
import type * as GtFunctions from '@gltf-transform/functions'

/** 几何压缩算法。`none` = 只做清理与量化。 */
export type OptimizeAlgorithm = 'none' | 'quantize' | 'meshopt'

export interface OptimizeOptions {
  algorithm: OptimizeAlgorithm
  /** 是否做 dedup / prune / weld 冗余清理,默认 true */
  cleanup?: boolean
}

export interface OptimizeResult {
  bytes: Uint8Array
  originalBytes: number
  optimizedBytes: number
  /** 省下的比例,0~1 */
  savedRatio: number
  algorithm: OptimizeAlgorithm
  durationMs: number
}

/** WebIO 的链式接口(库自身的类型在动态 import 场景下不好直接引用,这里只声明用到的方法)。 */
interface WebIOInstance {
  registerExtensions(extensions: readonly unknown[]): WebIOInstance
  registerDependencies(dependencies: Record<string, unknown>): WebIOInstance
  readBinary(bytes: Uint8Array): Promise<Document>
  writeBinary(document: Document): Promise<Uint8Array>
}

interface Toolkit {
  createWebIO: () => WebIOInstance
  ALL_EXTENSIONS: readonly unknown[]
  functions: typeof GtFunctions
  MeshoptEncoder: unknown
  MeshoptDecoder: unknown
}

let toolkitPromise: Promise<Toolkit> | null = null

/**
 * 懒加载压缩所需的库。
 * 失败时清空缓存以便下次重试 —— 网络抖动不该让功能永久不可用。
 */
async function loadToolkit(): Promise<Toolkit> {
  if (!toolkitPromise) {
    toolkitPromise = (async () => {
      const [core, extensions, functions, meshopt] = await Promise.all([
        import('@gltf-transform/core'),
        import('@gltf-transform/extensions'),
        import('@gltf-transform/functions'),
        import('meshoptimizer'),
      ])
      // meshopt 的编码器是 wasm,必须等 ready,否则压缩时静默产出空结果
      await meshopt.MeshoptEncoder.ready
      const WebIO = core.WebIO as unknown as new () => WebIOInstance
      return {
        createWebIO: () => new WebIO(),
        ALL_EXTENSIONS: extensions.ALL_EXTENSIONS as readonly unknown[],
        functions,
        MeshoptEncoder: meshopt.MeshoptEncoder,
        MeshoptDecoder: meshopt.MeshoptDecoder,
      }
    })().catch((error: unknown) => {
      toolkitPromise = null
      throw error
    })
  }
  return toolkitPromise
}

/** 预热压缩依赖(用户展开面板时静默调用,避免点击导出才开始下载)。 */
export async function warmUpOptimizer(): Promise<void> {
  await loadToolkit()
}

/** 压缩依赖是否已经加载完成(不触发加载)。 */
export function isOptimizerReady(): boolean {
  return toolkitPromise !== null
}

/**
 * 压缩 glb 字节流。
 *
 * @param source 原始 glb 字节
 * @param options 压缩选项(算法 + 是否清理)
 * @returns 压缩产物与体积统计
 */
export async function optimizeGlb(
  source: Uint8Array,
  options: OptimizeOptions,
): Promise<OptimizeResult> {
  const started = performance.now()
  const { createWebIO, ALL_EXTENSIONS, functions, MeshoptEncoder, MeshoptDecoder } =
    await loadToolkit()

  const io = createWebIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      // 解码器用于读取 meshopt 压缩过的输入;编码器则供 EXT_meshopt_compression
      // 在**写文件**时使用 —— 少注册编码器会在 prewrite 阶段报 `encodeFilterOct undefined`。
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    })

  const document = await io.readBinary(source)

  const transforms: unknown[] = []
  if (options.cleanup !== false) {
    transforms.push(functions.dedup(), functions.prune(), functions.weld())
  }
  if (options.algorithm === 'quantize' || options.algorithm === 'meshopt') {
    transforms.push(functions.quantize())
  }
  if (options.algorithm === 'meshopt') {
    transforms.push(functions.meshopt({ encoder: MeshoptEncoder }))
  }

  if (transforms.length) {
    await document.transform(...(transforms as Parameters<Document['transform']>))
  }

  const bytes = await io.writeBinary(document)
  const originalBytes = source.byteLength
  const optimizedBytes = bytes.byteLength

  return {
    bytes,
    originalBytes,
    optimizedBytes,
    savedRatio: originalBytes > 0 ? 1 - optimizedBytes / originalBytes : 0,
    algorithm: options.algorithm,
    durationMs: performance.now() - started,
  }
}
