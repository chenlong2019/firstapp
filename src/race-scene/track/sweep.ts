/**
 * 扫掠建模（track）：把一条二维截面（横向偏移, 高度）沿一串中心线帧扫成三维几何体，
 * 用于桥面、路面、护栏等沿路径延伸的部件。
 * 对外导出 SweepBuilder 类、boxProfile 与 cylinderBetween 两个辅助函数，以及 Point 类型。
 * 约定：世界点 = 帧位置（米）+ lateral×横偏（米），高度也为米；截面点须逆时针排列，
 * 生成的四边形才朝外；闭合截面会补两端封盖。顶点沿扫掠方向共享、但截面棱之间不共享，
 * 因此路面平滑而转角保持锐利。
 */
import * as THREE from 'three'
import type { CentrelineFrame } from './centreline'

/** 截面点：[横向偏移, 高度]，单位为米。 */
export type Point = readonly [number, number]

/**
 * Sweeps a 2D profile along a run of centreline frames. Profile points are
 * (offset across the track, height) and must be ordered counter-clockwise so the
 * generated quads face outwards. Vertices are shared along the sweep but not
 * between profile edges, so a road reads smooth while its corners stay sharp.
 */
export class SweepBuilder {
  private readonly positions: number[] = []
  private readonly indices: number[] = []

  add(frames: CentrelineFrame[], profile: readonly Point[], closed: boolean): this {
    const edges: [Point, Point][] = []
    for (let j = 0; j < profile.length - 1; j++) edges.push([profile[j], profile[j + 1]])
    if (closed) edges.push([profile[profile.length - 1], profile[0]])
    for (const [a, b] of edges) {
      const base = this.positions.length / 3
      for (const frame of frames) {
        this.positions.push(
          frame.position.x + frame.lateral.x * a[0],
          frame.position.y + a[1],
          frame.position.z + frame.lateral.z * a[0],
          frame.position.x + frame.lateral.x * b[0],
          frame.position.y + b[1],
          frame.position.z + frame.lateral.z * b[0],
        )
      }
      // 每个截面棱带生成两列顶点，按 (i, i+2, i+1)/(i+1, i+2, i+3) 组成朝外的四边形。
      for (let i = 0; i < frames.length - 1; i++) {
        const p0 = base + i * 2
        this.indices.push(p0, p0 + 2, p0 + 1, p0 + 1, p0 + 2, p0 + 3)
      }
    }
    if (!closed) return this
    // Cap the tube ends so a road is not hollow when seen from the side.
    for (const [index, end] of [
      [0, false],
      [frames.length - 1, true],
    ] as [number, boolean][]) {
      const frame = frames[index]
      const base = this.positions.length / 3
      for (const [u, y] of profile) {
        this.positions.push(
          frame.position.x + frame.lateral.x * u,
          frame.position.y + y,
          frame.position.z + frame.lateral.z * u,
        )
      }
      for (let j = 1; j < profile.length - 1; j++) {
        // 两端封盖的三角形绕序相反，保证法线都朝管外。
        if (end) this.indices.push(base, base + j + 1, base + j)
        else this.indices.push(base, base + j, base + j + 1)
      }
    }
    return this
  }

  geometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3))
    geometry.setIndex(this.indices)
    geometry.computeVertexNormals()
    return geometry
  }
}

/** Axis aligned box profile: a rectangle across the track between two heights. */
export function boxProfile(centre: number, width: number, bottom: number, top: number): Point[] {
  const left = centre - width / 2
  const right = centre + width / 2
  return [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ]
}

/** Cylinder between two world points, used for pillars and cables. */
export function cylinderBetween(
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(b, a)
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, direction.length(), 8),
    material,
  )
  mesh.position.copy(a).add(b).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return mesh
}
