/**
 * 只打包不压缩的 ZIP 写入器。
 *
 * 职责:把若干 `{ 文件名, 字节 }` 打成一个 ZIP(本地文件头 + 中央目录 + 结束记录)。
 * 位置:`/models` 工作台批量压缩后"下载 zip"用。
 * 导出:`createStoreZip()`、`crc32()`。
 *
 * 非直觉约定:
 * - **只用 store(不 deflate)**。要打包的是 glb / gltf,它们内部已经是压缩数据
 *   (网格是 meshopt/Draco,贴图是 PNG/JPEG/WebP),再 deflate 一遍通常只能省 0~1%,
 *   却要付出几十秒 CPU —— 得不偿失。也正因为不压缩,这里完全不需要引第三方库。
 * - 不做 ZIP64。条目数超 65535 或单条/总量超 4 GB 时**抛错**而不是静默写坏 ——
 *   本工具的输入是模型文件,正常远远到不了这个量级,一旦触发就说明用法不对。
 * - 文件名一律按 UTF-8 编码并置通用位标记(bit 11),否则中文名在资源管理器里是乱码。
 */

/** 一条要写进 zip 的记录。 */
export interface ZipEntry {
  /** 包内文件名(可含目录分隔符 `/`) */
  name: string
  data: Uint8Array
}

export interface ZipOptions {
  /** 记录时间戳;不传用当前时间。测试里传固定值可得到字节级可复现的产物。 */
  date?: Date
}

/** 本地文件头 / 中央目录项 / 结束记录的签名。 */
const SIGNATURE_LOCAL = 0x04034b50
const SIGNATURE_CENTRAL = 0x02014b50
const SIGNATURE_END = 0x06054b50
/** 通用位标记 bit 11:文件名按 UTF-8 解释。 */
const FLAG_UTF8 = 0x0800
/** ZIP 容量上限(不做 ZIP64)。 */
const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * 标准 CRC-32(ZIP 用的那个多项式 0xEDB88320)。
 * 导出是为了让回归脚本能独立校验产物,而不是只能"信任写入器"。
 */
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (let index = 0; index < bytes.byteLength; index++) {
    value = (CRC_TABLE[(value ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** 把 Date 折成 DOS 时间/日期两个 16 位字段(ZIP 的古老格式,1980 年之前会被夹到 1980)。 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const packed = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time: time & 0xffff, date: packed & 0xffff }
}

/** 顺序写入字节的容器:小段(头)按需新建,大段(文件数据)直接引用,最后一次性拼起来。 */
class ByteWriter {
  private readonly chunks: Uint8Array[] = []
  private total = 0

  get offset(): number {
    return this.total
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.total += bytes.byteLength
  }

  /** 写一个 30/46/22 字节的小结构:填进临时数组后整体推入。 */
  pushStruct(length: number, fill: (view: DataView) => void): void {
    const buffer = new Uint8Array(length)
    fill(new DataView(buffer.buffer))
    this.push(buffer)
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.total)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.byteLength
    }
    return out
  }
}

/**
 * 打包成 ZIP(store 模式)。
 *
 * @param entries 记录列表;同名条目会被原样写入(解压时后者覆盖前者),调用方负责去重
 * @throws 条目数或体积超过 ZIP(非 ZIP64)上限
 */
export function createStoreZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`条目过多(${entries.length}),超出 ZIP 上限 ${MAX_ENTRIES}`)
  }
  const { time: dosTime, date: dosDate } = dosDateTime(options.date ?? new Date())
  const encoder = new TextEncoder()
  const writer = new ByteWriter()
  const central: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = []

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const size = entry.data.byteLength
    if (size > MAX_BYTES) throw new Error(`单个条目过大:${entry.name}`)
    const checksum = crc32(entry.data)
    const localOffset = writer.offset
    if (localOffset > MAX_BYTES) throw new Error('打包结果超过 4 GB,超出 ZIP 上限')

    writer.pushStruct(30, (view) => {
      view.setUint32(0, SIGNATURE_LOCAL, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, FLAG_UTF8, true)
      view.setUint16(8, 0, true) // 压缩方式:0 = store
      view.setUint16(10, dosTime, true)
      view.setUint16(12, dosDate, true)
      view.setUint32(14, checksum, true)
      view.setUint32(18, size, true)
      view.setUint32(22, size, true)
      view.setUint16(26, name.byteLength, true)
      view.setUint16(28, 0, true)
    })
    writer.push(name)
    writer.push(entry.data)

    central.push({ name, crc: checksum, size, offset: localOffset })
  }

  const centralStart = writer.offset
  for (const item of central) {
    writer.pushStruct(46, (view) => {
      view.setUint32(0, SIGNATURE_CENTRAL, true)
      view.setUint16(4, 20, true) // version made by
      view.setUint16(6, 20, true) // version needed
      view.setUint16(8, FLAG_UTF8, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, dosTime, true)
      view.setUint16(14, dosDate, true)
      view.setUint32(16, item.crc, true)
      view.setUint32(20, item.size, true)
      view.setUint32(24, item.size, true)
      view.setUint16(28, item.name.byteLength, true)
      view.setUint16(30, 0, true)
      view.setUint16(32, 0, true)
      view.setUint16(34, 0, true)
      view.setUint16(36, 0, true)
      view.setUint32(38, 0, true)
      view.setUint32(42, item.offset, true)
    })
    writer.push(item.name)
  }
  const centralSize = writer.offset - centralStart

  writer.pushStruct(22, (view) => {
    view.setUint32(0, SIGNATURE_END, true)
    view.setUint16(4, 0, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, central.length, true)
    view.setUint16(10, central.length, true)
    view.setUint32(12, centralSize, true)
    view.setUint32(16, centralStart, true)
    view.setUint16(20, 0, true)
  })

  return writer.concat()
}

/**
 * 给批量产物起一个不重名的包内文件名(重名时补 `-2`、`-3`…)。
 * 同名条目会覆盖,而"压了 20 个模型却只剩 8 个"是很难自查的问题,所以在源头就去重。
 */
export function uniqueArchiveName(used: Set<string>, name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  let index = 2
  while (used.has(candidate)) {
    candidate = `${stem}-${index}${extension}`
    index++
  }
  used.add(candidate)
  return candidate
}
