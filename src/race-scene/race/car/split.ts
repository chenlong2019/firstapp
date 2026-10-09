import * as THREE from 'three'

/**
 * 把单个网格按三角形切成若干带名字的几何组。
 *
 * 在整体里的位置：race/car 的底层工具，被 body.ts 与 mirrors.ts 用来拆分那些被建模软件
 * 烘焙成一体的部件（如宝马覆盖两侧的车窗玻璃、横跨整车的外后视镜）。
 *
 * 对外导出：splitMesh、splitMeshIslands 与若干 TriangleKey（sideKey / quadrantKey / mirrorKey）。
 * 非直觉约定：切分先在世界空间进行，再除以 scale 折回 rig 根的单位——切出的碎片会被重新挂到
 * 带归一化缩放的 rig 根下，不折返就会偏离几百倍。
 */

/**
 * Cutting one mesh into named groups of triangles.
 *
 * Several of these models bake parts together: the BMW's cabin is a single glass
 * mesh covering both sides, and its mirrors are one mesh spanning the car. To
 * move one of those parts the mesh has to be cut, and the cut has to happen in
 * world space and then be folded back into the rig's units - the rig root
 * carries the normalising scale, and a piece parented back under it must be in
 * model units or it ends up hundreds of times too far away.
 */
/** 依据三角形质心与法线决定其所属分组名；返回 null 表示该三角形被丢弃。 */
export type TriangleKey = (centre: THREE.Vector3, normal: THREE.Vector3) => string | null

/** 按 +X / -X 分成左右两半。 */
export const sideKey: TriangleKey = (centre) => (centre.x < 0 ? 'left' : 'right')

/** Front and rear halves either side, for a mesh that holds four windows. */
export const quadrantKey =
  (splitZ: number): TriangleKey =>
  (centre, normal) => {
    // Side glass only: a cabin mesh also holds the windscreen and the rear
    // window, and those must not slide down with the doors.
    if (Math.abs(normal.x) < 0.6) return null
    return `${centre.x < 0 ? 'left' : 'right'}-${centre.z < splitZ ? 'rear' : 'front'}`
  }

/** Left and right halves of a mirror housing, hinged at its inner edge. */
export const mirrorKey = (splitZ: number): TriangleKey => sideKey

/** 拆分时保留并重建的顶点属性。 */
const ATTRIBUTES = ['position', 'normal', 'uv'] as const

/**
 * Splits `mesh` into one geometry per key the key function returns. Triangles
 * the key rejects are dropped from the result - they belong to a part this cut is
 * not about.
 */
/**
 * Splits a mesh into whole geometry islands, named by where each island sits.
 *
 * A model that ships its four doors as one mesh usually still has four separate
 * shells inside it: separate parts that happen to share one mesh buffer. Cutting
 * that by a plane slices whichever door straddles the line in half, and the half
 * then swings out with its neighbour. Following the geometry instead keeps every
 * door whole, and the island's own centre says which door it is.
 *
 * `nameOf` is asked once per island, with the island's centre in world space.
 */
export function splitMeshIslands(
  mesh: THREE.Mesh,
  scale: number,
  nameOf: (centre: THREE.Vector3) => string | null,
): Map<string, THREE.BufferGeometry> {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const normalAttribute = geometry.getAttribute('normal')
  const index = geometry.getIndex()
  if (!position) return new Map()
  const triangles = Math.floor((index ? index.count : position.count) / 3)
  const vertexAt = (triangle: number, corner: number) =>
    index ? index.getX(triangle * 3 + corner) : triangle * 3 + corner
  // Union-find over the vertices: two vertices that share a triangle share an
  // island, and an island is what a door shell is.
  const parent = new Int32Array(position.count)
  for (let vertex = 0; vertex < parent.length; vertex++) parent[vertex] = vertex
  const find = (value: number) => {
    let root = value
    while (parent[root] !== root) root = parent[root]
    while (parent[value] !== root) {
      const next = parent[value]
      parent[value] = root
      value = next
    }
    return root
  }
  const union = (a: number, b: number) => {
    const rootA = find(a),
      rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }
  for (let triangle = 0; triangle < triangles; triangle++) {
    union(vertexAt(triangle, 0), vertexAt(triangle, 1))
    union(vertexAt(triangle, 1), vertexAt(triangle, 2))
  }
  const matrix = mesh.matrixWorld
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
  const point = new THREE.Vector3()
  // First pass: where each island sits, so it can be named once.
  const sums = new Map<number, THREE.Vector3>()
  const counts = new Map<number, number>()
  for (let triangle = 0; triangle < triangles; triangle++) {
    const root = find(vertexAt(triangle, 0))
    const sum = sums.get(root) ?? new THREE.Vector3()
    for (let corner = 0; corner < 3; corner++) {
      const vertex = vertexAt(triangle, corner)
      point
        .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        .applyMatrix4(matrix)
      sum.add(point)
    }
    sums.set(root, sum)
    counts.set(root, (counts.get(root) ?? 0) + 3)
  }
  const names = new Map<number, string | null>()
  for (const [root, sum] of sums)
    names.set(root, nameOf(sum.clone().divideScalar(counts.get(root) ?? 1)))
  // Second pass: hand every triangle to its island's group.
  const groups = new Map<string, Record<string, number[]>>()
  const normal = new THREE.Vector3()
  for (let triangle = 0; triangle < triangles; triangle++) {
    const key = names.get(find(vertexAt(triangle, 0)))
    if (key == null) continue
    let group = groups.get(key)
    if (!group) {
      group = {}
      for (const name of ATTRIBUTES) if (geometry.getAttribute(name)) group[name] = []
      groups.set(key, group)
    }
    for (const name of ATTRIBUTES) {
      const attribute = geometry.getAttribute(name)
      if (!attribute) continue
      const target = group[name]
      for (let corner = 0; corner < 3; corner++) {
        const vertex = vertexAt(triangle, corner)
        if (name === 'position') {
          point
            .set(attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex))
            .applyMatrix4(matrix)
            .divideScalar(scale)
          target.push(point.x, point.y, point.z)
        } else if (name === 'normal') {
          point
            .set(attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex))
            .applyMatrix3(normalMatrix)
            .normalize()
          target.push(point.x, point.y, point.z)
        } else {
          for (let component = 0; component < attribute.itemSize; component++)
            target.push((attribute as THREE.BufferAttribute).getComponent(vertex, component))
        }
      }
    }
  }
  const result = new Map<string, THREE.BufferGeometry>()
  for (const [key, group] of groups) {
    const piece = new THREE.BufferGeometry()
    for (const name of ATTRIBUTES) {
      const attribute = geometry.getAttribute(name)
      if (!attribute || !group[name]) continue
      piece.setAttribute(
        name,
        new THREE.BufferAttribute(
          new Float32Array(group[name]),
          attribute.itemSize,
          attribute.normalized,
        ),
      )
    }
    result.set(key, piece)
  }
  void normal // normal 在本函数中并未使用，void 只为显式说明，避免被当成遗漏。
  return result
}
/**
 * 按 keyOf 把网格拆成一组命名几何；keyOf 返回 null 的三角形被丢弃。
 *
 * @param mesh 源网格
 * @param scale rig 根的归一化比例，用于把世界坐标折回模型单位
 * @param keyOf 分组判定函数（按三角形质心与法线）
 * @returns 分组名到几何的映射
 */
export function splitMesh(
  mesh: THREE.Mesh,
  scale: number,
  keyOf: TriangleKey,
): Map<string, THREE.BufferGeometry> {
  const geometry = mesh.geometry
  const position = geometry.getAttribute('position')
  const normalAttribute = geometry.getAttribute('normal')
  const index = geometry.getIndex()
  if (!position) return new Map()
  const triangles = Math.floor((index ? index.count : position.count) / 3)
  const matrix = mesh.matrixWorld
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
  const groups = new Map<string, Record<string, number[]>>()
  const point = new THREE.Vector3()
  const normal = new THREE.Vector3()
  for (let triangle = 0; triangle < triangles; triangle++) {
    const vertices = [0, 1, 2].map((offset) =>
      index ? index.getX(triangle * 3 + offset) : triangle * 3 + offset,
    )
    const centre = new THREE.Vector3()
    for (const vertex of vertices) {
      point
        .set(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        .applyMatrix4(matrix)
      centre.add(point.clone().divideScalar(3))
    }
    if (normalAttribute) {
      normal.set(0, 0, 0)
      for (const vertex of vertices) {
        point
          .set(
            normalAttribute.getX(vertex),
            normalAttribute.getY(vertex),
            normalAttribute.getZ(vertex),
          )
          .applyMatrix3(normalMatrix)
          .normalize()
        normal.add(point)
      }
      normal.normalize()
    } else {
      normal.set(0, 1, 0)
    }
    const key = keyOf(centre, normal)
    if (key === null) continue
    let group = groups.get(key)
    if (!group) {
      group = {}
      for (const name of ATTRIBUTES) if (geometry.getAttribute(name)) group[name] = []
      groups.set(key, group)
    }
    for (const name of ATTRIBUTES) {
      const attribute = geometry.getAttribute(name)
      if (!attribute) continue
      const target = group[name]
      for (const vertex of vertices) {
        if (name === 'position') {
          point
            .set(attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex))
            .applyMatrix4(matrix)
            .divideScalar(scale)
          target.push(point.x, point.y, point.z)
        } else if (name === 'normal') {
          point
            .set(attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex))
            .applyMatrix3(normalMatrix)
            .normalize()
          target.push(point.x, point.y, point.z)
        } else {
          for (let component = 0; component < attribute.itemSize; component++) {
            target.push((attribute as THREE.BufferAttribute).getComponent(vertex, component))
          }
        }
      }
    }
  }
  const result = new Map<string, THREE.BufferGeometry>()
  for (const [key, group] of groups) {
    const piece = new THREE.BufferGeometry()
    for (const name of ATTRIBUTES) {
      const attribute = geometry.getAttribute(name)
      if (!attribute || !group[name]) continue
      piece.setAttribute(
        name,
        new THREE.BufferAttribute(
          new Float32Array(group[name]),
          attribute.itemSize,
          attribute.normalized,
        ),
      )
    }
    result.set(key, piece)
  }
  return result
}
