/**
 * 批量模型处理:把「体检 + 压缩」从单个模型扩展到一批。
 *
 * 职责:定义与文件来源解耦的 `BatchSource`,串行驱动 `inspectGlbBytes` 与 `optimizeGlb`,
 *       把每个条目的进度/结果写回可被 UI 直接渲染的 `BatchItem`。
 * 位置:`/models` 工作台的批量处理台。
 * 导出:`sourcesFromFiles()`、`createBatchItems()`、`runBatch()`、`batchTotals()`、`optimizedNameOf()`。
 *
 * 非直觉约定:
 * - **来源是"延迟读取"的**:`BatchSource.read()` 而不是直接存字节。批量常常一次拖进十几个
 *   几十 MB 的模型,全量常驻内存很容易把页面顶崩;交给 File 句柄按需读、读完即弃,
 *   常驻内存就只有压缩产物那一份。
 * - **串行,且每条之间主动让出主线程**。体检与压缩都是同步重活(压缩还要跑 meshopt 的
 *   wasm),连着做会让进度条从 0 直接跳到 100 —— 看起来像卡死。让出一次才能让浏览器上屏。
 *   代价是总时长略长于理论值,但这是批量场景下正确的取舍。
 * - **单条失败不中断整批**:失败只记在 `item.note` 上,后面的条目照常处理。
 *   批量场景下"20 个里坏了 1 个"远比"全军覆没"有用。
 * - 输出的字节留在 `item.output` 上供打包下载。⚠️ 如需把它塞进框架的响应式状态,
 *   注意 Vue 的 `reactive()` 对 Uint8Array 会直接返回原对象(不属于它代理的类型),
 *   所以不会出现"代理导致 Blob 构造失败"的问题。
 */
import type { AuditReport } from './model-audit-rules'
import type { OptimizeAlgorithm } from './model-optimize'
import { isSelfContainedGlb, inspectGlbBytes } from './glb-inspect'
import { optimizeGlb } from './model-optimize'

/** 一个待处理模型的来源。**延迟读取**是刻意的,见文件头说明。 */
export interface BatchSource {
  readonly id: string
  readonly name: string
  /** 原始文件大小(展示用,免去一次读取) */
  readonly size: number
  read: () => Promise<Uint8Array>
}

/** 条目状态机:pending →(auditing → audited)?→(optimizing → optimized)?,或 skipped / failed。 */
export type BatchStage =
  | 'pending'
  | 'auditing'
  | 'audited'
  | 'optimizing'
  | 'optimized'
  | 'skipped'
  | 'failed'

/** 批量处理台里的一行。 */
export interface BatchItem {
  readonly id: string
  readonly source: BatchSource
  stage: BatchStage
  /** 实际读到的字节数(读之前为 source.size) */
  inputBytes: number
  audit?: AuditReport
  /** 压缩产物字节数 */
  outputBytes?: number
  /** 省下的比例 0~1 */
  savedRatio?: number
  /** 压缩产物(供打包 zip / 单独下载) */
  output?: Uint8Array
  /** 跳过或失败的原因(展示用) */
  note?: string
}

export interface BatchRunOptions {
  /** 是否体检 */
  audit: boolean
  /** 是否压缩 */
  optimize: boolean
  algorithm: OptimizeAlgorithm
  /** 单个条目状态变化时回调(UI 用来刷新那一行) */
  onUpdate?: (item: BatchItem) => void
  /** 完成一个条目后回调(UI 用来更新进度) */
  onProgress?: (done: number, total: number) => void
  /** 返回 false 则中止后续条目(已处理的保留) */
  shouldContinue?: () => boolean
}

/** 从 File 列表建来源(file 是磁盘句柄,真正读字节发生在 `read()`) */
export function sourcesFromFiles(files: readonly File[]): BatchSource[] {
  return files.map((file, index) => ({
    // 同名同大小的两个文件也要能区分,所以带上序号
    id: `${index}-${file.name}-${file.size}`,
    name: file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  }))
}

/** 按来源建空条目(先渲染出表行,再逐条跑,用户能立刻看到"收了哪些") */
export function createBatchItems(sources: readonly BatchSource[]): BatchItem[] {
  return sources.map((source) => ({
    id: source.id,
    source,
    stage: 'pending',
    inputBytes: source.size,
  }))
}

/** 压缩产物的文件名:统一落成 `.glb`(optimizeGlb 的产物只可能是 glb)。 */
export function optimizedNameOf(name: string): string {
  return `${name.replace(/\.[^.]*$/, '') || 'model'}.optimized.glb`
}

/** 让出主线程一次,给浏览器上屏的机会。 */
function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** 从任意抛出物里取出可读文案。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fail(item: BatchItem, options: BatchRunOptions, note: string): void {
  item.stage = 'failed'
  item.note = note
  options.onUpdate?.(item)
}

/** 处理一个条目:读 → 体检 → 压缩。任何一步失败都只记在本条上。 */
async function processItem(item: BatchItem, options: BatchRunOptions): Promise<void> {
  let bytes: Uint8Array
  try {
    bytes = await item.source.read()
  } catch (error) {
    fail(item, options, `读取失败:${messageOf(error)}`)
    return
  }
  item.inputBytes = bytes.byteLength

  if (!isSelfContainedGlb(bytes)) {
    item.stage = 'skipped'
    item.note = '不是自包含的 .glb —— 带外部 .bin / 贴图的模型请到「GLB 模型查看」里导入'
    options.onUpdate?.(item)
    return
  }

  if (options.audit) {
    item.stage = 'auditing'
    options.onUpdate?.(item)
    await yieldToHost()
    try {
      item.audit = inspectGlbBytes(bytes)
      item.stage = 'audited'
      options.onUpdate?.(item)
    } catch (error) {
      fail(item, options, `体检失败:${messageOf(error)}`)
      return
    }
  }

  if (options.optimize) {
    item.stage = 'optimizing'
    options.onUpdate?.(item)
    await yieldToHost()
    try {
      const result = await optimizeGlb(bytes, { algorithm: options.algorithm })
      item.output = result.bytes
      item.outputBytes = result.optimizedBytes
      item.savedRatio = result.savedRatio
      item.stage = 'optimized'
      options.onUpdate?.(item)
    } catch (error) {
      fail(item, options, `压缩失败:${messageOf(error)}`)
    }
  }
}

/**
 * 串行跑完整批。
 *
 * @param items 由 `createBatchItems` 建出的条目(会被原地更新)
 */
export async function runBatch(items: readonly BatchItem[], options: BatchRunOptions): Promise<void> {
  let done = 0
  for (const item of items) {
    if (options.shouldContinue && !options.shouldContinue()) return
    await processItem(item, options)
    done++
    options.onProgress?.(done, items.length)
    await yieldToHost()
  }
}

/** 汇总口径:只统计"有压缩产物"的条目,跳过的不能拉低平均值。 */
export interface BatchTotals {
  count: number
  skipped: number
  failed: number
  optimized: number
  inputBytes: number
  outputBytes: number
  /** 压缩前后总占比,0~1;没有产物时为 0 */
  savedRatio: number
}

/** 汇总一批条目的体积与成败。 */
export function batchTotals(items: readonly BatchItem[]): BatchTotals {
  let skipped = 0
  let failed = 0
  let optimized = 0
  let inputBytes = 0
  let outputBytes = 0

  for (const item of items) {
    if (item.stage === 'skipped') skipped++
    if (item.stage === 'failed') failed++
    if (item.outputBytes !== undefined) {
      optimized++
      inputBytes += item.inputBytes
      outputBytes += item.outputBytes
    }
  }

  return {
    count: items.length,
    skipped,
    failed,
    optimized,
    inputBytes,
    outputBytes,
    savedRatio: inputBytes > 0 ? 1 - outputBytes / inputBytes : 0,
  }
}
