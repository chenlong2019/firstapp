# ThreeViewer

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### 道路 MVT 演示

先在 `roads_demo` 数据库中执行 `server/search-index.sql`，为道路名称、道路编号和 OSM ID 建立搜索索引。可以使用 pgAdmin 的 Query Tool 执行，也可以在安装了 `psql` 的环境中运行：

```sh
psql -h 127.0.0.1 -p 5432 -U postgres -d roads_demo -f server/search-index.sql
```

启动道路服务和前端：

```sh
$env:PGPASSWORD="123456"
npm run server
npm run dev -- --host 127.0.0.1 --port 5175
```

打开 `http://127.0.0.1:5175/roads` 后，可以按道路名称或道路编号搜索道路。点击搜索结果会自动定位地图、添加高亮，并显示道路属性；直接点击地图上的道路仍然使用最近道路查询。

空间查询支持点、线、面。线和面单击加点，移动鼠标预览，双击完成，右键取消。红色查询图形保留在地图上，蓝色表示命中的道路。线与面边界沿 Cesium 的椭球测地线按不超过 500 米加密，绘制与数据库相交计算使用同一组坐标。

空间查询结果每批加载 200 条，自动取完全部匹配结果，并显示总数与加载进度；列表每页显示 100 条，翻页不影响已加载道路的高亮。点击“清除”会中止后续请求并移除查询图形及结果。`POST /roads/query` 接收 `geometry`、`limit`、`offset`，返回 `results`、`count`（本批数量）、`total`（总数）和 `hasMore`。

道路服务提供以下接口：

- `GET /tiles/roads/{z}/{x}/{y}.pbf`：动态 MVT 瓦片
- `GET /roads/search?q=道路名称或编号&limit=10`：道路搜索
- `GET /roads/nearest?lon=116.4&lat=39.9`：查询坐标附近道路
- `POST /roads/query`：提交 GeoJSON `Point`、`LineString` 或 `Polygon`，查询相交道路
- `GET /health`：数据库连接检查

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

### Run Unit Tests with [Vitest](https://vitest.dev/)

```sh
npm run test:unit
```

### Run End-to-End Tests with [Playwright](https://playwright.dev)

```sh
# Install browsers for the first run
npx playwright install

# When testing on CI, must build the project first
npm run build

# Runs the end-to-end tests
npm run test:e2e
# Runs the tests only on Chromium
npm run test:e2e -- --project=chromium
# Runs the tests of a specific file
npm run test:e2e -- tests/example.spec.ts
# Runs the tests in debug mode
npm run test:e2e -- --debug
```

### Lint with [ESLint](https://eslint.org/)

```sh
npm run lint
```

## 打包桌面应用（Electron → Windows exe）

前端资源全部是绝对路径（`/assets`、`/Cesium`），路由是 web history 模式，Cesium 还依赖 Worker/WASM —— 这些在 `file://` 下都会失败。因此主进程（`electron/main.cjs`）会启动一个只监听 `127.0.0.1` 的静态服务，把 `dist` 当作站点根目录，再用 `http://127.0.0.1:<随机端口>` 打开窗口。

```sh
# 1. 打包（内部先 vite build，再 electron-builder）
npm run electron:build
# 产物：release/ThreeViewer Setup 0.0.0.exe（安装包）、release/ThreeViewer 0.0.0.exe（免安装）

# 2. 只出免安装目录，调试用（更快）
npm run electron:pack        # → release/win-unpacked/ThreeViewer.exe

# 3. 开发调试：先 npm run dev 起 vite，再以开发地址启动窗口
#    PowerShell: $env:ELECTRON_START_URL="http://localhost:15176"; npm run electron:dev
```

打包入口是 `scripts/package.mjs`：构建到一次性工作目录 `release/.work-<时间戳>`，把安装包挪到 `release/` 根目录后立刻删除工作目录。这么做是因为部分杀软/索引器会把刚写出的 `win-unpacked/resources/app.asar` 锁死（EBUSY/EPERM），几分钟后连目录都删不掉、改不了名 —— 直接跑 electron-builder 会让 `release/` 逐渐堆积无法删除的目录。若某个残留目录已被锁死，重启后删除即可。

应用图标是 `build/icon.ico`（256/128/64/48/32/16 多尺寸，线框立方体），换图标直接覆盖该文件后重新打包即可；网页 favicon 在 `public/favicon.ico`，由同一套图标生成。

常用排障环境变量（正常桌面不需要）：

| 变量 | 作用 |
| --- | --- |
| `APP_DEBUG_PORT=9333` | 开启远程调试端口，便于用 CDP 连接打包产物排查 |
| `APP_DISABLE_GPU=1` | 关闭硬件加速（老驱动/远程桌面） |
| `APP_CHROMIUM_FLAGS="--no-sandbox --use-angle=swiftshader"` | 追加 Chromium 开关；虚拟机里 GPU 进程反复崩溃导致 `GPU process isn't usable. Goodbye.` 时用这组可强制软件渲染 |

若构建时报 `EPERM/EBUSY rename ... win-unpacked.tmp`：说明机器上有杀软或残留进程占用解压目录。可先清掉 `release/` 下的残留（必要时重启），或预先把 Electron 发行包解压到某目录，再用 `npx electron-builder --config.electronDist=<解压目录>` 打包（该路径会走“复制文件”而不是“解压+改名”）。

要在 exe 里同时跑本地 Postgres 瓦片服务（`server/index.mjs`），可在 `electron/main.cjs` 中用 `child_process.fork` 拉起它。
