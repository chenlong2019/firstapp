/**
 * 云台链结构探针:打印 GIMBAL 相关节点层级、TRS、是否为 skin joint,
 * 以及云台安装座(BODY_Fixed_GimbalHousing)与 pod 的相对位置。
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
const nodes = json.nodes ?? []
const nameOf = (i) => nodes[i]?.name ?? `#${i}`
const parent = new Map()
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))
const chain = (i) => {
  const list = [i]
  let cur = i
  while (parent.has(cur)) { cur = parent.get(cur); list.push(cur) }
  return list.reverse()
}

// skin joints 集合
// 收集所有 skin joint 索引,打印时据此标注哪些节点是骨骼关节
const joints = new Set()
for (const s of json.skins ?? []) s.joints.forEach((j) => joints.add(j))
// 所有 mesh 节点名
const meshNodes = new Set(nodes.map((n, i) => (n.mesh !== undefined ? i : -1)).filter((i) => i >= 0))

const deg = (r) => Number(((r * 180) / Math.PI).toFixed(2))
const fmtQ = (q) => `x=${deg(q[0])}° y=${deg(q[1])}° z=${deg(q[2])}° w=${Number(q[3].toFixed(3))}`
const fmtT = (t) => `[${t.map((v) => Number(v.toFixed(3))).join(', ')}]`

// 云台子树完整打印
const roots = nodes
  .map((n, i) => ({ n, i }))
  .filter(({ n }) => /GIMBAL|Gimbal|gimbal/i.test(n.name ?? ''))

const printed = new Set()
const walk = (i, depth) => {
  if (printed.has(i)) return
  printed.add(i)
  const n = nodes[i]
  const trs = []
  if (n.translation) trs.push(`T=${fmtT(n.translation)}`)
  if (n.rotation) trs.push(`R=${fmtQ(n.rotation)}`)
  if (n.scale) trs.push(`S=${fmtT(n.scale)}`)
  if (n.matrix) trs.push(`MATRIX`)
  const tags = []
  if (joints.has(i)) tags.push('JOINT')
  if (n.mesh !== undefined) tags.push('mesh')
  console.log(`${'  '.repeat(depth)}[${i}] ${n.name ?? ''}${tags.length ? ' <' + tags.join(',') + '>' : ''}  ${trs.join('  ') || '(identity)'}`)
  for (const c of n.children ?? []) walk(c, depth + 1)
}

// 找每个 gimbal 相关节点的顶级祖先,从祖先开始整树打印(限一次)
// 从每个 gimbal 节点的顶级祖先整树打印一次,避免重复又不漏层级
const tops = new Set(roots.map(({ i }) => chain(i)[0]))
console.log('===== 云台相关节点整树 =====')
for (const t of tops) {
  const n = nodes[t]
  console.log(`\n--- 顶级: ${n.name ?? t} ---`)
  walk(t, 0)
}

// BODY_Fixed_GimbalHousing 安装座
console.log('\n===== 安装座/相关 BODY 节点 =====')
for (const [i, n] of nodes.entries()) {
  if (!/Housing|Pod|Camera/i.test(n.name ?? '')) continue
  const trs = []
  if (n.translation) trs.push(`T=${fmtT(n.translation)}`)
  if (n.rotation) trs.push(`R=${fmtQ(n.rotation)}`)
  if (n.scale) trs.push(`S=${fmtT(n.scale)}`)
  console.log(`[${i}] ${n.name} <${joints.has(i) ? 'JOINT,' : ''}${n.mesh !== undefined ? 'mesh' : 'node'}>  chain=${chain(i).map(nameOf).join('/')}  ${trs.join('  ') || '(identity)'}`)
}
