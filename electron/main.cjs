/**
 * Electron 主进程。
 *
 * 为什么不是直接 loadFile(dist/index.html)?
 * 本项目的 index.html 使用绝对路径资源(/assets、/Cesium),路由是 web history 模式,
 * Cesium 还依赖 Web Worker / WASM —— 这些在 file:// 协议下都会失败。
 * 因此这里在主进程内起一个只监听 127.0.0.1 的静态服务,把 dist 当作站点根目录,
 * 窗口用 http://127.0.0.1:<随机端口> 打开,所有路径/路由/Worker 问题一并消失。
 *
 * 开发调试:先启动 vite(15176),再设 ELECTRON_START_URL=http://localhost:15176 运行 electron .
 */
const { app, BrowserWindow, shell } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

// 统一应用名称(影响 userData 目录 %APPDATA%/ThreeViewer、任务栏分组等)
app.setName('ThreeViewer')

/**
 * 排查/自动化测试用:打包后的 exe 不接受命令行开关,只能在主进程里显式开启远程调试端口。
 * 用法(仅调试时):APP_DEBUG_PORT=9333 FirstApp.exe
 */
if (process.env.APP_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.APP_DEBUG_PORT)
}

/**
 * 兼容排障:虚拟机/远程桌面等环境下 GPU 驱动异常会导致渲染进程崩溃(Chromium 会直接
 * "GPU process isn't usable. Goodbye." 退出),此时可用环境变量强制软件渲染:
 *   APP_DISABLE_GPU=1                 → app.disableHardwareAcceleration()
 *   APP_CHROMIUM_FLAGS="--no-sandbox --use-angle=swiftshader"  → 追加任意 Chromium 开关
 * 正常桌面环境无需设置。
 */
if (process.env.APP_DISABLE_GPU) {
  app.disableHardwareAcceleration()
}

for (const flag of (process.env.APP_CHROMIUM_FLAGS ?? '').split(' ').filter(Boolean)) {
  const [name, value] = flag.replace(/^--/, '').split('=')
  app.commandLine.appendSwitch(name, value)
}

// 打包后 __dirname 为 app.asar/electron,dist 与其同级被一起打进 asar
const DIST_DIR = path.join(__dirname, '..', 'dist')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.pbf': 'application/vnd.mapbox-vector-tile',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

/** 把 dist 当静态站点根目录提供服务;无扩展名的未命中路径回退到 index.html(SPA 路由)。 */
function createStaticServer() {
  return http.createServer((request, response) => {
    let pathname
    try {
      // 用哑基址把相对 URL 补成绝对再取 pathname,顺带 decodeURIComponent 解 %xx
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      response.writeHead(400).end('bad request')
      return
    }

    let filePath = path.normalize(path.join(DIST_DIR, pathname))
    // 目录穿越防护:越出 dist 的请求一律拒绝
    if (!filePath.startsWith(DIST_DIR)) {
      response.writeHead(403).end('forbidden')
      return
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html')
    }
    if (!fs.existsSync(filePath)) {
      // 带扩展名的资源缺失按 404 处理,其余视为前端路由请求
      if (path.extname(pathname)) {
        response.writeHead(404).end('not found')
        return
      }
      filePath = path.join(DIST_DIR, 'index.html')
    }

    const stat = fs.statSync(filePath)
    // no-cache:本地服务不做缓存,避免重新打包 dist 后仍读到旧文件
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    fs.createReadStream(filePath).pipe(response)
  })
}

let staticServer = null

async function startStaticServer() {
  staticServer = createStaticServer()
  await new Promise((resolve, reject) => {
    staticServer.once('error', reject)
    // 端口传 0 由系统分配空闲端口,避免与用户机器上已占用端口冲突
    staticServer.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${staticServer.address().port}`
}

async function createWindow() {
  const devUrl = process.env.ELECTRON_START_URL
  const target = devUrl ?? (await startStaticServer())

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#071116',
    title: 'ThreeViewer',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // three.js 的 WebGPU/WebGL2 渲染在默认沙箱下正常,无需特殊开关
    },
  })

  // 页面里的外链交给系统浏览器,不在应用窗口内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  console.log(`[main] 本地服务地址: ${target}`)
  try {
    await win.loadURL(target)
  } catch (error) {
    // 渲染进程异常(如 GPU 驱动崩溃)不应让整个应用直接退出:保留窗口与本地服务便于排查
    console.error('[main] 页面加载失败:', error)
  }
  if (devUrl) win.webContents.openDevTools({ mode: 'detach' })
}

// 单实例:重复启动时聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.example.firstapp')
    void createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (staticServer) staticServer.close()
    staticServer = null
    if (process.platform !== 'darwin') app.quit()
  })
}
