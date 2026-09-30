/**
 * 解析 GLB JSON chunk,检查机臂折叠/自转/骨骼架节点的烘焙变换与层级。
 * 用途:诊断重导出模型后"展开/收起位置不对"的问题。
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'public/models/djiair_renamed.glb'
const buf = readFileSync(path)
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
let off = 12
let json = null
while (off < buf.byteLength) {
  const len = dv.getUint32(off, true)
  const type = dv.getUint32(off + 4, true)
  if (type === 0x4e4f534a) {
    json = JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)))
    break
  }
  off += 8 + len
}
if (!json) { console.log('no JSON chunk'); process.exit(1) }

const nodes = json.nodes ?? []
const nameOf = (i) => nodes[i]?.name ?? `#${i}`

// 自底向上收集父链
const parent = new Map()
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))
const chain = (i) => {
  const list = [i]
  let cur = i
  while (parent.has(cur)) { cur = parent.get(cur); list.push(cur) }
  return list.reverse()
}

const interesting = (name) =>
  /CTRL_Arm|CTRL_Prop|ARM_|RIG_|CTRL_DJI_Root|CTRL_Gimbal|GEAR_|ROTOR_|MOTOR_|PROP_.*Blade|SRC_GeometryRoot|ARMATURE|Armature|Bone/i.test(name)

const deg = (r) => Number(((r * 180) / Math.PI).toFixed(2))
const fmtQ = (q) => `x=${deg(q[0])}° y=${deg(q[1])}° z=${deg(q[2])}° w=${Number(q[3].toFixed(3))}`
const fmtT = (t) => `[${t.map((v) => Number(v.toFixed(3))).join(', ')}]`

console.log(`nodes: ${nodes.length}, meshes: ${(json.meshes ?? []).length}, skins: ${(json.skins ?? []).length}`)
for (const s of json.skins ?? []) {
  console.log(`skin "${s.name ?? '?'}": skeleton=${nameOf(s.skeleton ?? -1)}, joints=${s.joints.length}`)
}

// 打印所有interesting节点的层级链与变换
const seen = new Set()
for (const [i, n] of nodes.entries()) {
  if (!n.name || !interesting(n.name)) continue
  if (seen.has(i)) continue
  const link = chain(i).map(nameOf).join(' / ')
  const trs = []
  if (n.translation) trs.push(`T=${fmtT(n.translation)}`)
  if (n.rotation) trs.push(`R=${fmtQ(n.rotation)}`)
  if (n.scale) trs.push(`S=${fmtT(n.scale)}`)
  if (n.matrix) trs.push(`MATRIX=${JSON.stringify(n.matrix.map((v) => Number(v.toFixed(3))))}`)
  console.log(`\n[${i}] ${n.name}`)
  console.log(`  chain: ${link}`)
  console.log(`  ${trs.length ? trs.join('  ') : '(identity, no TRS)'}`)
  if (n.mesh !== undefined) console.log(`  mesh: ${json.meshes[n.mesh]?.name ?? '(unnamed)'}`)
  seen.add(i)
}

// 关键:CTRL_Arm_*_Fold 的子树里有哪些 named 节点(确认机臂网格挂在哪)
console.log('\n===== 折叠节点子树 =====')
for (const [i, n] of nodes.entries()) {
  if (!/^CTRL_Arm_/.test(n.name ?? '')) continue
  const walk = (j, depth) => {
    console.log(`${'  '.repeat(depth)}${nodes[j].name ?? `#${j}`}${nodes[j].mesh !== undefined ? ' (mesh)' : ''}`)
    for (const c of nodes[j].children ?? []) walk(c, depth + 1)
  }
  console.log(`\n${n.name}:`)
  walk(i, 1)
}

// CTRL_DJI_Root 与 RIG 根的直接子节点
console.log('\n===== 顶级与关键节点子树(深度2) =====')
for (const [i, n] of nodes.entries()) {
  if (!/^(CTRL_DJI_Root|RIG_DJI_Arms_Props|SRC_GeometryRoot)$/.test(n.name ?? '')) continue
  const walk = (j, depth) => {
    console.log(`${'  '.repeat(depth)}${nodes[j].name ?? `#${j}`}${nodes[j].mesh !== undefined ? ' (mesh)' : ''}`)
    if (depth >= 2) return
    for (const c of nodes[j].children ?? []) walk(c, depth + 1)
  }
  console.log(`\n${n.name}:`)
  walk(i, 1)
}
