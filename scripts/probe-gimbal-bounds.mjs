/**
 * 云台网格顶点范围探针:读 GLB 二进制 accessor min/max,
 * 计算云台各网格与安装座在 CTRL_DJI_Root 空间的实际位置(出厂姿态)。
 */
import { readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'public/models/djiair_renamed.glb'
const buf = readFileSync(path)
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
let off = 12
let json = null
let binOffset = 0
let bin = null
while (off < buf.byteLength) {
  const len = dv.getUint32(off, true)
  const type = dv.getUint32(off + 4, true)
  if (type === 0x4e4f534a) {
    json = JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)))
  } else if (type === 0x004e4942) {
    bin = buf.subarray(off + 8, off + 8 + len)
    binOffset = off + 8
  }
  off += 8 + len
}
const accessors = json.accessors ?? []
const nodes = json.nodes ?? []
const meshes = json.meshes ?? []

// 沿链合成平移(节点均无旋转对云台网格;通用实现 T·R·S)
const qFromXYZW = ([x, y, z, w]) => ({ x, y, z, w })
const qMul = (a, b) => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
})
const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
const qRotVec = (q, v) => {
  const t = { x: 2 * (q.y * v[2] - q.z * v[1]), y: 2 * (q.z * v[0] - q.x * v[2]), z: 2 * (q.x * v[1] - q.y * v[0]) }
  return [
    v[0] + q.w * t.x + (q.y * t.z - q.z * t.y),
    v[1] + q.w * t.y + (q.z * t.x - q.x * t.z),
    v[2] + q.w * t.z + (q.x * t.y - q.y * t.x),
  ]
}
const parent = new Map()
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)))

// 用 accessor min/max 近似网格在节点空间的包围盒,再变换到根空间
function nodeWorldBounds(nodeIndex) {
  const n = nodes[nodeIndex]
  // 收集链上的 TRS(从根到该节点)
  const list = [nodeIndex]
  let cur = nodeIndex
  while (parent.has(cur)) { cur = parent.get(cur); list.push(cur) }
  let acc = null // {min,max} 累计
  // 从根往下变换:逐层 t + R*(bounds)
  let min = null
  let max = null
  // 先取该节点所有 primitive 的 POSITION min/max(节点空间)
  if (n.mesh !== undefined) {
    for (const prim of meshes[n.mesh].primitives ?? []) {
      const accIdx = prim.attributes?.POSITION
      if (accIdx === undefined) continue
      const a = accessors[accIdx]
      if (!a.min || !a.max) continue
      if (!min) { min = [...a.min]; max = [...a.max] }
      else for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k]); max[k] = Math.max(max[k], a.max[k]) }
    }
  }
  if (!min) return null
  // 从根到节点应用 TRS
  for (let idx = list.length - 1; idx >= 0; idx--) {
    const nn = nodes[list[idx]]
    const t = nn.translation ?? [0, 0, 0]
    const q = nn.rotation ? qFromXYZW(nn.rotation) : { x: 0, y: 0, z: 0, w: 1 }
    const s = nn.scale ?? [1, 1, 1]
    // 先缩放
    let lo = min.map((v, k) => v * s[k])
    let hi = max.map((v, k) => v * s[k])
    // 再旋转(8 个角)
    const corners = []
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z])
    const rc = corners.map((c) => qRotVec(q, c))
    lo = [0, 1, 2].map((k) => Math.min(...rc.map((c) => c[k])))
    hi = [0, 1, 2].map((k) => Math.max(...rc.map((c) => c[k])))
    min = lo.map((v, k) => v + t[k])
    max = hi.map((v, k) => v + t[k])
  }
  return { min: min.map((v) => Number(v.toFixed(2))), max: max.map((v) => Number(v.toFixed(2))) }
}

// 要清算包围盒的网格名——云台活动件 + 机身安装座,用于判断活动范围是否撞到座
const targets = [
  'GIMBAL_BlackCameraShell',
  'GIMBAL_CameraHousing',
  'GIMBAL_CameraLensFrame',
  'SENSOR_Glass_GimbalLens',
  'BODY_Fixed_GimbalHousing_Center',
  'BODY_Fixed_GimbalMount_Right',
  'BODY_Main_Fuselage',
  'SENSOR_Glass_Downward',
]
// [1] 各目标网格在根空间的包围盒(不含整机摆放);min/max 为模型内部单位
console.log('===== CTRL_DJI_Root 空间的网格包围盒(min/max) =====')
for (const [i, n] of nodes.entries()) {
  if (!targets.includes(n.name)) continue
  const b = nodeWorldBounds(i)
  if (b) console.log(`${n.name}: min=${JSON.stringify(b.min)} max=${JSON.stringify(b.max)}`)
}
