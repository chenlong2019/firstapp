/**
 * 深入诊断:蒙皮关系、关节列表、出厂姿态下铰链→桨心方向(判断展开/收纳)、
 * 以及折叠节点局部 Y 在世界系的方向(验证"绕局部 Y 折叠"假设是否还成立)。
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

// —— 迷你变换合成器(glTF: 矩阵 = T·R·S,R 为 XYZW 四元数) ——
const qFromXYZW = ([x, y, z, w]) => ({ x, y, z, w })
const qMul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})
const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
const qRotVec = (q, v) => {
  // v' = q * v * q^-1
  const t = {
    x: 2 * (q.y * v.z - q.z * v.y),
    y: 2 * (q.z * v.x - q.x * v.z),
    z: 2 * (q.x * v.y - q.y * v.x),
  }
  return {
    x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y),
    y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z),
    z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x),
  }
}
const vecAdd = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
const scl = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s })

const parent = new Map()
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))
const localQ = (n) => (n.rotation ? qFromXYZW(n.rotation) : { x: 0, y: 0, z: 0, w: 1 })
const localT = (n) => (n.translation ? { x: n.translation[0], y: n.translation[1], z: n.translation[2] } : { x: 0, y: 0, z: 0 })
const localS = (n) => (n.scale ? { x: n.scale[0], y: n.scale[1], z: n.scale[2] } : { x: 1, y: 1, z: 1 })

// 世界四元数与位置(沿父链合成,含缩放比例用于长度换算)
const memo = new Map()
const worldOf = (i) => {
  if (memo.has(i)) return memo.get(i)
  const n = nodes[i]
  const q = localQ(n)
  const t = localT(n)
  let pQ, pT, pS
  if (parent.has(i)) {
    ;({ q: pQ, t: pT, s: pS } = worldOf(parent.get(i)))
  } else {
    pQ = { x: 0, y: 0, z: 0, w: 1 }
    pT = { x: 0, y: 0, z: 0 }
    pS = 1
  }
  const s = pS * (localS(n).x)
  // 父系缩放作用于平移
  const wt = vecAdd(pT, scl(qRotVec(pQ, t), pS))
  const wq = qMul(pQ, q)
  const out = { q: wq, t: wt, s }
  memo.set(i, out)
  return out
}

const byName = new Map()
nodes.forEach((n, i) => n.name && byName.set(n.name, i))

// —— 1. 蒙皮关系 ——
console.log('===== skin.joints =====')
for (const skin of json.skins ?? []) {
  console.log(skin.joints.map((j) => nodes[j].name ?? `#${j}`).join(', '))
}
console.log('\n===== 带 skin 引用的网格节点 =====')
for (const [i, n] of nodes.entries()) {
  if (n.mesh !== undefined && n.skin !== undefined) console.log(`${n.name} -> skin#${n.skin}`)
}

// —— 2. 出厂姿态:铰链→桨心 方位角(世界系,前=-Z) ——
console.log('\n===== 出厂姿态 铰链→桨心 =====')
const deg = (r) => ((r * 180) / Math.PI).toFixed(2)
for (const pos of ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']) {
  const hingeI = byName.get(`CTRL_Arm_${pos}_Fold`)
  const propI = byName.get(`CTRL_Prop_${pos}_Spin`)
  const boneI = byName.get(`ARM_${pos}_Fold_Bone`)
  if (hingeI === undefined || propI === undefined) continue
  const h = worldOf(hingeI)
  const p = worldOf(propI)
  const b = worldOf(boneI)
  const dx = p.t.x - h.t.x
  const dz = p.t.z - h.t.z
  const az = Math.atan2(dz, dx)
  // 收纳方向:前臂 +Z(机尾),后臂 -Z(机头)
  const targetAz = pos.startsWith('Front') ? Math.atan2(1, 0) : Math.atan2(-1, 0)
  const worldYOfBoneLocalY = qRotVec(b.q, { x: 0, y: 1, z: 0 })
  const worldYOfCtrlLocalY = qRotVec(h.q, { x: 0, y: 1, z: 0 })
  console.log(`${pos}: hinge=(${h.t.x.toFixed(2)},${h.t.y.toFixed(2)},${h.t.z.toFixed(2)})  prop=(${p.t.x.toFixed(2)},${p.t.y.toFixed(2)},${p.t.z.toFixed(2)})`)
  console.log(`   方位角 atan2(z,x)=${deg(az)}°  收纳方向=${deg(targetAz)}°  差值=${deg(az - targetAz)}°  距离=${Math.hypot(dx, dz).toFixed(2)}`)
  console.log(`   bone 局部Y 的世界方向=(${worldYOfBoneLocalY.x.toFixed(3)},${worldYOfBoneLocalY.y.toFixed(3)},${worldYOfBoneLocalY.z.toFixed(3)})`)
  console.log(`   ctrl 局部Y 的世界方向=(${worldYOfCtrlLocalY.x.toFixed(3)},${worldYOfCtrlLocalY.y.toFixed(3)},${worldYOfCtrlLocalY.z.toFixed(3)})`)
}

// —— 3. 电机轴(CTRL_Prop 局部Y)与自转节点装配 ——
console.log('\n===== 电机轴检查 =====')
for (const pos of ['FrontLeft', 'FrontRight', 'RearLeft', 'RearRight']) {
  const propI = byName.get(`CTRL_Prop_${pos}_Spin`)
  if (propI === undefined) continue
  const p = worldOf(propI)
  const axis = qRotVec(p.q, { x: 0, y: 1, z: 0 })
  console.log(`${pos}: 电机轴世界方向=(${axis.x.toFixed(3)},${axis.y.toFixed(3)},${axis.z.toFixed(3)})  位置=(${p.t.x.toFixed(2)},${p.t.y.toFixed(2)},${p.t.z.toFixed(2)}) 缩放=${p.s}`)
}
