// 模型树显隐复选框端到端验证:node scripts/verify-tree-checkbox.mjs
// 需先起 dev server(默认 http://localhost:15185)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const BASE = process.env.VERIFY_URL ?? 'http://localhost:15185'
const SHOT_DIR = 'D:/learnProject/firstapp/.verify-shots'
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

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push(String(err)))

/** 一次性把整棵树的行状态抓回来:深度用 padding-left 反推(6 + depth*12)。 */
const dump = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.tree-row')].map((row) => {
      const box = row.querySelector('input.tree-check')
      const pad = parseFloat(getComputedStyle(row).paddingLeft)
      return {
        id: Number(row.dataset.nodeId),
        depth: Math.round((pad - 6) / 12),
        name: row.querySelector('.tree-name')?.textContent?.trim() ?? '',
        kind: row.querySelector('.kind-chip')?.textContent?.trim() ?? '',
        hidden: row.classList.contains('hidden'),
        selected: row.classList.contains('selected'),
        hasBox: Boolean(box),
        inherited: box?.classList.contains('inherited') ?? false,
        partial: box?.classList.contains('partial') ?? false,
        checked: box?.checked ?? false,
        indeterminate: box?.indeterminate ?? false,
        title: box?.title ?? '',
        aria: box?.getAttribute('aria-label') ?? '',
      }
    }),
  )

const engineVisible = (id) =>
  page.evaluate((nodeId) => {
    const viewer = window.__glbDebug?.viewer
    const info = viewer?.getNodeInfo(nodeId)
    return info ? info.visible : null
  }, id)

/** 找第一个"有子行"的行下标。 */
const findParentIndex = (rows) =>
  rows.findIndex((row, i) => rows[i + 1] && rows[i + 1].depth > row.depth)

/** 取某行的全部后代行。 */
const descendantsOf = (rows, index) => {
  const base = rows[index].depth
  const out = []
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i].depth <= base) break
    out.push(rows[i])
  }
  return out
}

const clickBox = async (index) => {
  await page.locator('.tree-row').nth(index).locator('input.tree-check').click()
  await page.waitForTimeout(220)
}

await page.goto(`${BASE}/glb`, { waitUntil: 'networkidle' })

// —— 载入示例模型并完全展开 ——
await page.getByRole('button', { name: /DJI Mini 4 Pro/ }).first().click()
await page.waitForFunction(() => document.querySelectorAll('.tree-row').length > 4, undefined, {
  timeout: 30000,
})
await page.waitForTimeout(600)
await page.getByRole('button', { name: '展开全部' }).click()
await page.waitForTimeout(500)

const initial = await dump()

// —— 1. 每行都有复选框 ——
check(
  '每行一个复选框',
  initial.length > 0 && initial.every((row) => row.hasBox),
  `rows=${initial.length}`,
)

// —— 2. 默认全部勾选、无连坐/半选 ——
check(
  '默认全部勾选',
  initial.every((row) => row.checked && !row.hidden && !row.inherited && !row.indeterminate),
)

// —— 3. 取消勾选一个叶子网格 ——
const leafIndex = initial.map((row) => row.kind).lastIndexOf('网格')
check('找到叶子网格行', leafIndex >= 0, `index=${leafIndex} name=${initial[leafIndex]?.name}`)

const leaf = initial[leafIndex]
await clickBox(leafIndex)
const after = await dump()
const leafAfter = after[leafIndex]
check('取消勾选 → 复选框未选中且行变暗', !leafAfter.checked && leafAfter.hidden)
check('取消勾选 → 引擎对象 visible=false', (await engineVisible(leaf.id)) === false)
check('取消勾选 → 提示文案为"显示该部件"', leafAfter.title === '显示该部件', leafAfter.title)
check('取消勾选 → aria 文案为"显示 xx"', leafAfter.aria.startsWith('显示'), leafAfter.aria)

// —— 4. 再次勾选恢复 ——
await clickBox(leafIndex)
const restored = await dump()
check(
  '重新勾选 → 恢复可见',
  restored[leafIndex].checked && !restored[leafIndex].hidden && (await engineVisible(leaf.id)) === true,
)

// —— 5. 隐藏父节点 → 子树连坐(自有开关保留) ——
const parentIndex = findParentIndex(initial)
check('找到有子节点的行', parentIndex >= 0, `name=${initial[parentIndex]?.name}`)
const parent = initial[parentIndex]
const childIndex = parentIndex + 1
const child = initial[childIndex]

await clickBox(parentIndex)
const hiddenTree = await dump()
const kids = descendantsOf(hiddenTree, parentIndex)
check('隐藏父节点 → 父行变暗且未勾选', hiddenTree[parentIndex].hidden && !hiddenTree[parentIndex].checked)
check('隐藏父节点 → 子树全部连坐变暗', kids.length > 0 && kids.every((k) => k.hidden), `kids=${kids.length}`)
check(
  '子树行显示为"被父级隐藏"空心态(不是自己关的)',
  kids.every((k) => k.inherited && !k.checked && !k.indeterminate),
)
check('父节点引擎 visible=false', (await engineVisible(parent.id)) === false)
check('子节点自有开关被保留(引擎里仍为 true)', (await engineVisible(child.id)) === true)
check(
  '被连坐的提示文案区分于普通隐藏',
  kids[0].title === '被父级隐藏 · 勾选会一并恢复父级',
  kids[0].title,
)
await page.screenshot({ path: `${SHOT_DIR}/tree-inherited.png` })

// —— 6. 勾选被连坐的子节点 → 祖先链自动恢复 ——
await clickBox(childIndex)
const chainRestored = await dump()
check(
  '勾选被连坐的子节点 → 祖先链一并恢复',
  chainRestored[parentIndex].checked &&
    !chainRestored[parentIndex].hidden &&
    chainRestored[childIndex].checked &&
    !chainRestored[childIndex].hidden,
  `child="${child.name}"`,
)

// —— 7. 子树部分隐藏 → 父行半选 ——
const parentIndex2 = findParentIndex(chainRestored)
await clickBox(parentIndex2 + 1)
const partialTree = await dump()
check(
  '子树部分隐藏 → 父行半选',
  partialTree[parentIndex2].indeterminate &&
    partialTree[parentIndex2].checked &&
    partialTree[parentIndex2].partial,
  `title=${partialTree[parentIndex2].title}`,
)
await page.screenshot({ path: `${SHOT_DIR}/tree-partial.png` })
await clickBox(parentIndex2 + 1)
const partialCleared = await dump()
check(
  '子节点重新勾选 → 父行半选消失',
  !partialCleared[parentIndex2].indeterminate && !partialCleared[parentIndex2].partial,
)

// —— 8. 选中部件后再隐藏 → 选中态与检查器一并收起 ——
const otherMesh = partialCleared.findIndex((row, i) => row.kind === '网格' && i !== leafIndex)
const meshIndex = otherMesh >= 0 ? otherMesh : partialCleared.findIndex((row) => row.kind === '网格')
await page.locator('.tree-row').nth(meshIndex).click()
await page.waitForTimeout(220)
const selectedBefore = (await dump())[meshIndex].selected
await clickBox(meshIndex)
const afterHideSelected = await dump()
const inspectorOpen = await page.evaluate(() => Boolean(document.querySelector('.inspector .selected-name')))
check(
  '选中后再隐藏 → 清掉选中态',
  selectedBefore && !afterHideSelected[meshIndex].selected,
  JSON.stringify({ selectedBefore, after: afterHideSelected[meshIndex].selected }),
)
check('隐藏后检查器节点详情收起', !inspectorOpen)
await page.screenshot({ path: `${SHOT_DIR}/tree-checkbox.png` })

// —— 9. 可见性只影响被勾掉的那一支,其它网格不受影响 ——
const witness = afterHideSelected.find((row) => row.kind === '网格' && row.id !== afterHideSelected[meshIndex].id)
check(
  '其它网格未受影响',
  Boolean(witness) && witness.checked && !witness.hidden,
  witness ? `witness=${witness.name}` : 'no witness',
)

// —— 10. 隐藏子件不影响导出完整性(GLTFExporter onlyVisible:false) ——
const exportLeafIndex = afterHideSelected.findIndex(
  (row, i) => row.kind === '网格' && row.id !== afterHideSelected[meshIndex].id && descendantsOf(afterHideSelected, i).length === 0,
)
check('找到用于导出测试的叶子网格', exportLeafIndex >= 0, `name=${afterHideSelected[exportLeafIndex]?.name}`)
await clickBox(exportLeafIndex)
const exportLeafName = afterHideSelected[exportLeafIndex].name
let exportParentIndex = -1
for (let i = exportLeafIndex - 1; i >= 0; i -= 1) {
  if (afterHideSelected[i].depth < afterHideSelected[exportLeafIndex].depth) {
    exportParentIndex = i
    break
  }
}
await page.locator('.tree-row').nth(exportParentIndex).click()
await page.waitForTimeout(250)
const downloadPromise = page.waitForEvent('download', { timeout: 30000 })
await page.getByRole('button', { name: '⬇ 导出选中部件' }).click()
const download = await downloadPromise
const glbBytes = await readFile(await download.path())
const included = glbBytes.includes(Buffer.from(exportLeafName, 'utf8'))
check('导出的 GLB 仍包含被隐藏的子件', included, `${exportLeafName} · ${glbBytes.length} bytes`)
await clickBox(exportLeafIndex)

// —— 11. 零控制台报错 ——
check('零控制台报错', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(`\n结果:${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
