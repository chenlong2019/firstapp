// 模型查看器「多格式导入 + 只看当前部件」端到端验证:
//   node scripts/make-model-fixtures.mjs          # 先生成夹具
//   node scripts/verify-model-formats.mjs [base]  # 默认 http://localhost:15185
//
// 前置:
//   1) 必须跑 **dev server** —— 页面调试出口 __glbDebug 由 import.meta.env.DEV 门控,
//      preview 产物里会被摇树删掉,脚本会卡在等 viewer 出现;
//   2) 已生成夹具(.verify-fixtures/,见 make-model-fixtures.mjs)。
//
// 覆盖:
//   A. 导入入口:accept 属性 / 空状态文案含全部支持格式;
//   B. 多格式导入:OBJ(+MTL+贴图)· STL · PLY(顶点色)· COLLADA · FBX —— 每种都断言
//      "树有节点 + 网格数 + 该格式特有的结果"(如 STL 恰好 4 面、OBJ 材质名与贴图);
//   C. 只看当前部件:可见性不变量(只有目标子树 + 祖先链可见)、树/DOM 同步、
//      横幅与控件、退出后按快照还原;
//   D. 交互:隔离中换部件、手动勾显隐会退出隔离;
//   E. 负例:不支持的扩展名 / 只选贴图不带模型。
//
// 截图(SHOTS=1)写到 .verify-shots/。
import { chromium } from 'playwright'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.argv[2] ?? 'http://localhost:15185'
const FIXTURES = join(ROOT, '.verify-fixtures')
const SHOT_DIR = join(ROOT, '.verify-shots')
const SHOTS = process.env.SHOTS === '1'
mkdirSync(SHOT_DIR, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}${extra ? ` :: ${extra}` : ''}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${extra ? ` :: ${extra}` : ''}`)
  }
}

/** 夹具是本脚本的前提:缺了就直接说清怎么生成,别让人对着超时发呆。 */
const required = [
  'cube.obj',
  'cube.mtl',
  'cube.png',
  'tetra.stl',
  'quad.ply',
  'CesiumMilkTruck.dae',
  'CesiumMilkTruck.jpg',
  'Tree.fbx',
]
const missing = required.filter((name) => !existsSync(join(FIXTURES, name)))
if (missing.length) {
  console.error(`缺少夹具: ${missing.join(', ')}`)
  console.error('请先运行: node scripts/make-model-fixtures.mjs')
  process.exit(1)
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push(String(err)))

/** 真实 click 在重页面会卡"两帧稳定"等待,统一用 DOM 直接派发。 */
const clickSelector = async (selector) => {
  const hit = await page.evaluate((sel) => {
    const element = document.querySelector(sel)
    if (!element) return false
    element.click()
    return true
  }, selector)
  if (!hit) throw new Error(`找不到元素: ${selector}`)
  // Vue 的响应式更新走微任务,给一帧的时间让 DOM 跟上
  await page.waitForTimeout(260)
}

/** 按可见文字点按钮(工具栏按钮没有 id,按文案定位最稳)。 */
const clickByText = async (selector, text) => {
  const hit = await page.evaluate(
    ([sel, label]) => {
      const element = [...document.querySelectorAll(sel)].find(
        (candidate) => candidate.textContent?.trim() === label,
      )
      if (!element) return false
      element.click()
      return true
    },
    [selector, text],
  )
  if (!hit) throw new Error(`找不到文案为「${text}」的 ${selector}`)
  await page.waitForTimeout(260)
}

/** 引擎侧统计快照(带格式相关的补充信息)。 */
const probeModel = () =>
  page.evaluate(() => {
    const viewer = window.__glbDebug?.viewer
    if (!viewer?.model) return null
    const out = {
      meshes: 0,
      triangles: 0,
      materials: [],
      textured: 0,
      /** 有 map 且图片真的解码完成(map.image 存在)——只数 map 会把加载失败的也算进去 */
      texturedLoaded: 0,
      vertexColors: 0,
      points: 0,
      objects: 0,
      rootKind: '',
    }
    const root = viewer.model
    out.rootKind = root.isMesh ? 'mesh' : root.isPoints ? 'points' : 'group'
    root.traverse((object) => {
      out.objects += 1
      if (object.isPoints) out.points += 1
      if (!object.isMesh && !object.isSkinnedMesh) return
      out.meshes += 1
      const geometry = object.geometry
      const index = geometry.getIndex()
      const count = index ? index.count : (geometry.getAttribute('position')?.count ?? 0)
      out.triangles += Math.floor(count / 3)
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      for (const material of materials) {
        if (!material) continue
        out.materials.push(material.name || '(无名)')
        if (material.map) {
          out.textured += 1
          if (material.map.image) out.texturedLoaded += 1
        }
        if (material.vertexColors) out.vertexColors += 1
      }
    })
    return out
  })

/**
 * 缩放范围不变量:取景距离必须落在 [minDistance, maxDistance] 内。
 *
 * OrbitControls 出厂值 min 2.2 / max 160 是按"米级"场景写死的;FBX 等模型常以**厘米**为单位
 * (包围球半径可达上百),取景所需距离越过上限时相机会被夹进模型内部 —— 此时滚轮拉远毫无反应,
 * 用户看到的就是"加载完几乎不能缩放"。
 */
const zoomRange = () =>
  page.evaluate(() => {
    const viewer = window.__glbDebug.viewer
    const THREE = window.__glbDebug.THREE
    viewer.model.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(viewer.model)
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3)
    const halfFov = THREE.MathUtils.degToRad(viewer.camera.fov * 0.5)
    return {
      radius,
      ideal: (radius * 1.6) / Math.sin(halfFov),
      current: viewer.camera.position.distanceTo(viewer.controls.target),
      min: viewer.controls.minDistance,
      max: viewer.controls.maxDistance,
    }
  })

/** 断言缩放范围随模型尺度自适应;expectRadiusAbove>0 时额外要求大尺度模型的上限被放大。 */
const checkZoomRange = async (label, expectRadiusAbove = 0) => {
  const z = await zoomRange()
  const detail = `r=${z.radius.toFixed(1)} ideal=${z.ideal.toFixed(1)} current=${z.current.toFixed(1)} range=[${z.min.toFixed(2)}, ${z.max.toFixed(2)}]`
  check(`${label}:取景距离未被 maxDistance 夹住`, z.ideal <= z.max + 1e-6 && z.current <= z.max + 1e-6, detail)
  check(`${label}:缩放范围合法(0 < min < max)`, z.min > 0 && z.min < z.max, detail)
  if (expectRadiusAbove > 0) {
    check(`${label}:cm 级模型的上限随半径放大(>300)`, z.max > 300, detail)
  }
  return z
}

/** 等某个文件名载入完成(引擎的 stats.fileName 是"载入完成"的权威信号)。 */
const waitLoaded = (fileName, timeout = 90_000) =>
  page.waitForFunction(
    (name) => window.__glbDebug?.viewer?.getStats()?.fileName === name,
    fileName,
    { timeout },
  )

const loadFiles = async (names, expectName = names[0], timeout = 90_000) => {
  await page.setInputFiles(
    'input.file-input',
    names.map((name) => join(FIXTURES, name)),
  )
  try {
    await waitLoaded(expectName, timeout)
  } catch (error) {
    // 超时必须带上"引擎当时说什么",否则对着一个空 timeout 只能瞎猜
    const context = await page
      .evaluate(() => ({
        status: window.__glbDebug?.viewer ? undefined : 'viewer 未挂载(dev 门控/页面重载?)',
        viewer: null,
      }))
      .catch(() => ({ status: '页面不可用' }))
    const statusState = await page
      .evaluate(() => {
        const viewer = window.__glbDebug?.viewer
        // GlbLoadStatus 在引擎实例上无法直接读,读页面 UI 的 loading/error 卡片
        return {
          loadingCard: document.querySelector('.loading-card')?.textContent?.trim() ?? null,
          errorCard: document.querySelector('.error-card')?.textContent?.trim() ?? null,
        }
      })
      .catch(() => null)
    console.error(`载入 ${expectName} 超时。context=${JSON.stringify(context)}`)
    console.error(`页面状态=${JSON.stringify(statusState)}`)
    console.error(`已捕获的控制台输出=${JSON.stringify(errors.slice(-6))}`)
    throw error
  }
  return probeModel()
}

const dumpRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.tree-row')].map((row) => {
      const padding = parseFloat(getComputedStyle(row).paddingLeft)
      return {
        id: Number(row.dataset.nodeId),
        depth: Math.round((padding - 6) / 12),
        name: row.querySelector('.tree-name')?.textContent?.trim() ?? '',
        kind: row.querySelector('.kind-chip')?.textContent?.trim() ?? '',
        hidden: row.classList.contains('hidden'),
        solo: row.classList.contains('solo'),
        selected: row.classList.contains('selected'),
        checked: row.querySelector('input.tree-check')?.checked ?? false,
      }
    }),
  )

/** 逐对象校验"只看"的可见性不变量:可见 ⇔ 属于目标子树 或 是目标的祖先。 */
const isolateInvariant = (id) =>
  page.evaluate((nodeId) => {
    const viewer = window.__glbDebug.viewer
    const target = viewer.nodeById.get(nodeId)
    if (!target) return { ok: false, reason: '目标节点不存在' }
    const inTargetSubtree = (object) => {
      let current = object
      while (current) {
        if (current === target) return true
        current = current.parent
      }
      return false
    }
    const isTargetAncestor = (object) => {
      let current = target
      while (current) {
        if (current === object) return true
        current = current.parent
      }
      return false
    }
    let visible = 0
    const wrong = []
    viewer.model.traverse((object) => {
      const expected = inTargetSubtree(object) || isTargetAncestor(object)
      if (object.visible) visible += 1
      if (object.visible !== expected) wrong.push(object.name || object.type)
    })
    return { ok: wrong.length === 0, wrong: wrong.slice(0, 6), visible }
  }, id)

const isolateState = () =>
  page.evaluate(() => {
    const viewer = window.__glbDebug?.viewer
    return {
      isolated: viewer?.getIsolatedId() ?? null,
      isIsolated: viewer?.isIsolated() ?? false,
      banner: document.querySelector('.isolate-bar')?.textContent?.trim() ?? '',
      topSolo: Boolean(document.querySelector('.top-button.solo')),
      toolbarActive: Boolean(document.querySelector('.toolbar .solo-button.active')),
    }
  })

const shot = async (name) => {
  if (!SHOTS) return
  await page.screenshot({ path: join(SHOT_DIR, name) })
  console.log(`SHOT  ${name}`)
}

// ————————————————————————— A. 入口与空状态 —————————————————————————
console.log(`\n== A. 导入入口(${BASE}/glb) ==`)
await page.goto(`${BASE}/glb`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__glbDebug?.viewer), null, { timeout: 90_000 })

const accept = await page.getAttribute('input.file-input', 'accept')
check(
  '文件对话框接受 multi-format 扩展名',
  ['.glb', '.gltf', '.fbx', '.obj', '.stl', '.ply', '.dae'].every((ext) => accept?.includes(ext)),
  `accept=${accept}`,
)
const emptyText = await page.textContent('.empty-card')
check(
  '空状态列出全部支持格式',
  ['fbx', 'obj', 'stl', 'ply', 'dae'].every((ext) => emptyText?.toLowerCase().includes(ext)),
  (emptyText ?? '').replace(/\s+/g, ' ').slice(0, 90),
)
check('文件输入支持多选', (await page.getAttribute('input.file-input', 'multiple')) !== null)

// 空状态布局:主按钮与下方说明文字不得重叠(曾因 empty-tip 的 -6px 上边距把文字压到按钮上)
const emptyLayout = await page.evaluate(() => {
  const gap = (above, below) => {
    const a = document.querySelector(above)?.getBoundingClientRect()
    const b = document.querySelector(below)?.getBoundingClientRect()
    return a && b ? b.top - a.bottom : null
  }
  return {
    buttonTip: gap('.empty-primary', '.empty-card p.empty-tip'),
    tipSamples: gap('.empty-card p.empty-tip', '.empty-samples'),
  }
})
check(
  '空状态:主按钮与下方说明文字不重叠',
  emptyLayout.buttonTip !== null && emptyLayout.buttonTip > 0.5,
  `按钮→说明间距=${emptyLayout.buttonTip?.toFixed(1)}px(说明→示例=${emptyLayout.tipSamples?.toFixed(1)}px)`,
)

// ————————————————————————— B. 多格式导入 —————————————————————————
console.log('\n== B. 多格式导入 ==')

// OBJ + MTL + PNG:顺带验证"外部资源按基名改写 blob URL"这条链路
let probe = await loadFiles(['cube.obj', 'cube.mtl', 'cube.png'])
check('OBJ(+MTL+贴图)载入成功', probe !== null && probe.meshes > 0, JSON.stringify(probe))
check(
  'OBJ 应用了 MTL 里的材质名',
  probe?.materials.includes('CubeTex') === true,
  `materials=${probe?.materials.join(', ')}`,
)
check('OBJ 的外部贴图被解析到(blob URL 改写生效)', (probe?.texturedLoaded ?? 0) > 0, `texturedLoaded=${probe?.texturedLoaded}`)
const objRows = await dumpRows()
check('OBJ 模型树有节点', objRows.length > 0, `rows=${objRows.length}`)
// 小模型的缩放范围也要合法(取景距离不会被夹)
await checkZoomRange('OBJ 小模型')

// 重新载入同一份夹具时,先切到别的模型,确保 fileName 变化能被观察到
await loadFiles(['tetra.stl'])
probe = await probeModel()
check('STL 载入成功且包成了网格', probe?.rootKind === 'mesh', `rootKind=${probe?.rootKind}`)
check('STL 三角面数 = 4(正四面体)', probe?.triangles === 4, `triangles=${probe?.triangles}`)

// 大尺度模型(模拟 Mixamo FBX 的厘米单位):缩放范围必须随尺度放大,
// 否则相机被夹进模型内部 → 滚轮拉远毫无反应(用户实测过的"加载完几乎不能缩放")
await loadFiles(['big-tetra.stl'])
const bigZoom = await checkZoomRange('大尺度 STL(×170)', 100)
check('大尺度夹具确实是"厘米级"(半径 > 100)', bigZoom.radius > 100, `r=${bigZoom.radius.toFixed(1)}`)

await loadFiles(['quad.ply'])
probe = await probeModel()
check('PLY 载入成功', probe !== null && probe.meshes > 0, JSON.stringify(probe))
check('PLY 三角面数 = 2', probe?.triangles === 2, `triangles=${probe?.triangles}`)
check('PLY 顶点色被启用', (probe?.vertexColors ?? 0) > 0, `vertexColors=${probe?.vertexColors}`)

await loadFiles(['CesiumMilkTruck.dae', 'CesiumMilkTruck.jpg'])
probe = await probeModel()
check('COLLADA 载入成功', probe !== null && probe.meshes > 0, JSON.stringify(probe))
check(
  'COLLADA 外部贴图被解析到',
  (probe?.texturedLoaded ?? 0) > 0,
  `texturedLoaded=${probe?.texturedLoaded} / materials=${probe?.materials.slice(0, 3).join(', ')}`,
)
await shot('model-formats-dae.png')

await loadFiles(['Tree.fbx', 'Tree_Tex.png'])
probe = await probeModel()
check('FBX 载入成功', probe !== null && probe.meshes > 0, JSON.stringify(probe))
await shot('model-formats-fbx.png')

// ————————————————————————— C. 只看当前部件 —————————————————————————
console.log('\n== C. 只看当前部件 ==')
// 用一个"确实有多个同级部件"的模型:COLLADA 拖拉机有车身 + 若干轮子
await loadFiles(['CesiumMilkTruck.dae', 'CesiumMilkTruck.jpg'])
await clickByText('.toolbar button', '展开全部')

let rows = await dumpRows()
check('模型树展开后有可操作的行', rows.length >= 3, `rows=${rows.length}`)

/**
 * 挑隔离目标:必须"子树里真有网格"且"有同级兄弟"。
 * 只按深度找兄弟会挑到空占位组(隔离后画布上空无一物),那种用例证明不了什么。
 */
const pick = await page.evaluate(() => {
  const viewer = window.__glbDebug.viewer
  const flat = []
  const walk = (node, parentId) =>
    flat.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      parentId,
      meshCount: node.meshCount,
    }) && node.children.forEach((child) => walk(child, node.id))
  viewer.getTree().forEach((node) => walk(node, null))

  const byParent = new Map()
  for (const item of flat) {
    if (item.parentId === null) continue
    const list = byParent.get(item.parentId) ?? []
    list.push(item)
    byParent.set(item.parentId, list)
  }
  for (const list of byParent.values()) {
    if (list.length < 2) continue
    const withMesh = list.filter((item) => item.meshCount > 0)
    if (!withMesh.length) continue
    const target = withMesh[0]
    const sibling = list.find((item) => item.id !== target.id)
    return { target, siblingName: sibling?.name ?? '', siblingId: sibling?.id ?? null }
  }
  return null
})
check(
  '找到"含网格且有兄弟"的部件作为隔离目标',
  Boolean(pick?.target && pick.siblingId !== null),
  `${pick?.target?.name}(${pick?.target?.kind}, mesh=${pick?.target?.meshCount}) ↔ ${pick?.siblingName}`,
)
const targetRow = rows.find((row) => row.id === pick.target.id)
const siblingRow = rows.find((row) => row.id === pick.siblingId)
check('目标与兄弟都能在树里定位到', Boolean(targetRow && siblingRow))

const beforeAll = await probeModel()
await clickSelector(`.tree-row[data-node-id="${targetRow.id}"] .tree-solo`)
let state = await isolateState()
check('点行尾 ◎ 进入只看模式', state.isolated === targetRow.id, `isolated=${state.isolated}`)
check('只看横幅出现且带部件名', state.banner.includes(targetRow.name), `banner=${state.banner}`)
check('顶栏出现只看提示按钮', state.topSolo)

const invariant = await isolateInvariant(targetRow.id)
check('可见性不变量成立(只留目标子树 + 祖先链)', invariant.ok, JSON.stringify(invariant))
check(
  '可见对象数确实变少',
  invariant.visible < (beforeAll?.objects ?? 0),
  `visible=${invariant.visible} / objects=${beforeAll?.objects}`,
)
const visibleMeshes = await page.evaluate(() => {
  let count = 0
  window.__glbDebug.viewer.model.traverse((object) => {
    if ((object.isMesh || object.isSkinnedMesh) && object.visible) count += 1
  })
  return count
})
check('隔离后仍有网格可见(不是空组)', visibleMeshes > 0, `visibleMeshes=${visibleMeshes}`)

rows = await dumpRows()
const siblingAfter = rows.find((row) => row.id === siblingRow.id)
const targetAfter = rows.find((row) => row.id === targetRow.id)
check('同级兄弟在树里被标为隐藏', siblingAfter?.hidden === true, `hidden=${siblingAfter?.hidden}`)
check('目标行带只看标记且自身可见', targetAfter?.solo === true && targetAfter?.hidden === false)
check('只看按钮在工具栏呈激活态', state.toolbarActive)
// 无头环境只有 2 FPS:截图前多等一帧,否则拍到的是改可见性之前那一帧
await page.waitForTimeout(900)
await shot('model-formats-isolate.png')

// 隔离中单击一个被隐藏的部件:只看目标跟着挪过去(否则选中的是个看不见的东西)
await clickSelector(`.tree-row[data-node-id="${siblingRow.id}"]`)
state = await isolateState()
check('隔离中点隐藏部件会把只看目标挪过去', state.isolated === siblingRow.id, `isolated=${state.isolated}`)
const movedInvariant = await isolateInvariant(siblingRow.id)
check('换目标后可见性不变量仍成立', movedInvariant.ok, JSON.stringify(movedInvariant))

// 退出:可见性必须回到进入前的快照(逐对象比对)
await clickSelector(`.tree-row[data-node-id="${siblingRow.id}"] .tree-solo`)
state = await isolateState()
check('再点一次 ◎ 退出只看', state.isolated === null && !state.topSolo, `state=${JSON.stringify(state)}`)
check('横幅消失', state.banner === '')
const restored = await page.evaluate(() => {
  const viewer = window.__glbDebug.viewer
  let visible = 0
  let total = 0
  viewer.model.traverse((object) => {
    total += 1
    if (object.visible) visible += 1
  })
  return { visible, total }
})
check('退出后全部对象恢复可见(快照还原)', restored.visible === restored.total, JSON.stringify(restored))

// ————————————————————————— D. 手动改显隐会退出隔离 —————————————————————————
console.log('\n== D. 隔离期间手动改显隐 ==')
await clickSelector(`.tree-row[data-node-id="${targetRow.id}"] .tree-solo`)
check('重新进入只看', (await isolateState()).isolated === targetRow.id)
await clickSelector(`.tree-row[data-node-id="${siblingRow.id}"] input.tree-check`)
state = await isolateState()
check('手动勾选显隐会退出只看', state.isolated === null, `isolated=${state.isolated}`)

// ————————————————————————— E. 负例 —————————————————————————
console.log('\n== E. 负例 ==')
await page.setInputFiles('input.file-input', join(FIXTURES, 'cube.mtl'))
await page.waitForSelector('.error-card', { timeout: 20_000 })
let errorText = await page.textContent('.error-card')
check('只选材质库不带模型时给出明确提示', /没有可载入的模型文件/.test(errorText ?? ''), errorText ?? '')
await clickSelector('.error-card button')

// ————————————————————————— 收尾 —————————————————————————
const unexpected = errors.filter(
  (text) =>
    !/WebGL|WebGPU|GPU stall|Deprecation|Download the React|source map|favicon|Failed to load resource/i.test(
      text,
    ),
)
check('无未预期的控制台错误', unexpected.length === 0, unexpected.slice(0, 3).join(' | '))

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
