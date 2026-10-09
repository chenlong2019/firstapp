/**
 * 在线 demo 用的静态文件服务器(仅部署使用,不参与本地开发)。
 *
 * 职责:把 `dist/` 的构建产物当站点根目录对外提供,并补齐 SPA 回退。
 * 位置:由 `scripts/prepare-deploy.mjs` 复制进部署目录、改名为 `server.mjs`。
 * 导出:无 —— 以脚本形式直接运行。
 *
 * 非直觉约定:
 * - `.wasm` 必须回 `application/wasm`,否则 Cesium 的 `instantiateStreaming` 会拒绝加载。
 * - 路由是 web history 模式,任何找不到的路径都必须回落 `index.html`,否则刷新子页面即 404。
 * - 端口取自 `PORT`(部署平台注入),且必须监听 `0.0.0.0` 才能被反向代理访问。
 * - 压缩只作用于文本类资源并做内存缓存;`.glb` 本身已压缩,再 gzip 纯属浪费 CPU。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

/** 站点根目录 = 本文件所在目录(部署时 server.mjs 与 dist 内容同级)。 */
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
const PORT = Number(process.env.PORT ?? 3000)

/** 扩展名 → Content-Type。缺省按八位字节流处理。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  // 模型查看器要加载的文本格式,按文本回以让浏览器正确解码
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.fbx': 'application/octet-stream',
  '.stl': 'application/octet-stream',
  '.ply': 'application/octet-stream',
  '.dae': 'model/vnd.collada+xml',
}

/** 值得 gzip 的扩展名(纯文本;二进制格式压缩收益低)。 */
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.map',
  '.svg',
  '.txt',
  '.xml',
  '.obj',
  '.mtl',
  '.gltf',
  '.dae',
])

/** gzip 结果缓存,避免同一文件被反复压缩。 */
const gzipCache = new Map()

/** 带缓存的 gzip 压缩。 */
function compress(file, buf) {
  const hit = gzipCache.get(file)
  if (hit) return hit
  const out = gzipSync(buf)
  gzipCache.set(file, out)
  return out
}

/** 路径是否落在站点根目录内(防目录穿越)。 */
function insideRoot(target) {
  return target === ROOT || target.startsWith(ROOT + sep)
}

/** 解析请求路径对应的磁盘文件;找不到时统一回落 index.html 以支持 history 路由。 */
async function resolveFile(pathname) {
  const direct = resolve(ROOT, '.' + pathname)
  if (!insideRoot(direct)) return null

  let info = await stat(direct).catch(() => null)
  if (info?.isDirectory()) {
    const index = join(direct, 'index.html')
    info = await stat(index).catch(() => null)
    return info?.isFile() ? index : null
  }
  if (info?.isFile()) return direct

  // SPA 回退:静态资源确实缺失时返回 null(由调用方决定 404),只有「看起来像页面」的路径才回落
  if (extname(pathname) === '') {
    const index = join(ROOT, 'index.html')
    const indexInfo = await stat(index).catch(() => null)
    return indexInfo?.isFile() ? index : null
  }
  return null
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname = url.pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    pathname = '/'
  }

  const file = await resolveFile(pathname)
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
    return
  }

  const buf = await readFile(file).catch(() => null)
  if (!buf) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('500 Read Error')
    return
  }

  const ext = extname(file).toLowerCase()
  const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' }
  const accept = String(req.headers['accept-encoding'] ?? '')

  if (COMPRESSIBLE.has(ext) && accept.includes('gzip')) {
    const gz = compress(file, buf)
    headers['Content-Encoding'] = 'gzip'
    headers['Content-Length'] = String(gz.length)
    headers.Vary = 'Accept-Encoding'
    res.writeHead(200, headers)
    res.end(gz)
    return
  }

  headers['Content-Length'] = String(buf.length)
  res.writeHead(200, headers)
  res.end(buf)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`demo server listening on 0.0.0.0:${PORT} (root: ${ROOT})`)
})
