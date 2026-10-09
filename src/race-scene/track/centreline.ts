/**
 * 赛道中心线抽象（track）：把“沿弧长参数化”的路径抽象成 Centreline 接口，并给出两种实现——
 * 圆弧中心线（跨海大桥桥面用）与任意折线中心线（地图数据用）。
 * 对外导出 CentrelineFrame、TrackProjection、Centreline 三个类型，以及
 * createCentreline 与 createPolylineCentreline。位置/弧长/横向偏移单位为米，
 * heading/yaw 为绕 +Y 的弧度；frame 为水平坐标系，只要求位置与朝向即可驾驶。
 */
import * as THREE from 'three'

/**
 * A station on a track centreline. `forward` and `lateral` are horizontal unit
 * vectors, so a map only has to supply positions and headings to be drivable.
 * Positions, arc lengths and lateral offsets are metres.
 */
export type CentrelineFrame = {
  position: THREE.Vector3
  /** Unit vector along the direction of travel. */
  forward: THREE.Vector3
  /** Unit vector across the track, to the right of `forward`. */
  lateral: THREE.Vector3
  /** Rotation about +Y that maps a model forward of +Z onto `forward`. */
  heading: number
  /** Rotation about +Y that maps a model length of +X onto `forward`. */
  yaw: number
}

/** 世界点到中心线的投影：沿弧长的距离与带符号的横向偏移（均为米）。 */
export type TrackProjection = { distance: number; lateral: number }

/**
 * Parametrised by arc length, so gameplay code never has to know whether the
 * map is a straight run, a circular bend, or something else added later.
 */
export type Centreline = {
  readonly length: number
  /** Closed centrelines loop, so distance wraps and a lap is meaningful. */
  readonly closed: boolean
  /** Frame at an arc length in metres measured from the start of the centreline. */
  frameAtDistance(distance: number): CentrelineFrame
  /** Nearest centreline point to a horizontal world position. */
  project(x: number, z: number): TrackProjection
}

/**
 * Circular arc centreline used by the water-sky bridge: the deck runs along the
 * local +X axis and bends by `turnDegrees` over its whole `length`.
 */
export function createCentreline(length: number, turnDegrees: number): Centreline {
  const theta = (turnDegrees * Math.PI) / 180
  // 极小转角按直线处理，避免半径趋于无穷时出现除零。
  const straight = Math.abs(theta) < 1e-6
  const radius = straight ? Infinity : length / theta
  const halfLength = length / 2
  const sign = straight ? 1 : Math.sign(radius)

  const frameAtDistance = (distance: number): CentrelineFrame => {
    const clamped = Math.min(Math.max(distance, 0), length)
    // 中点对应 angle=0，使桥面沿 +X 居中展开。
    const angle = straight ? 0 : (clamped / length - 0.5) * theta
    const position = straight
      ? new THREE.Vector3(clamped - halfLength, 0, 0)
      : new THREE.Vector3(radius * Math.sin(angle), 0, radius * (1 - Math.cos(angle)))
    const forward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle))
    const lateral = new THREE.Vector3(-Math.sin(angle), 0, Math.cos(angle))
    return {
      position,
      forward,
      lateral,
      heading: Math.atan2(forward.x, forward.z),
      yaw: -Math.atan2(forward.z, forward.x),
    }
  }

  const project = (x: number, z: number): TrackProjection => {
    if (straight) {
      return { distance: Math.min(Math.max(x + halfLength, 0), length), lateral: z }
    }
    // Offset from the arc centre, expressed relative to a positive radius so the
    // same formula covers bends in either direction.
    const offsetX = (x - 0) * sign
    const offsetZ = (z - radius) * sign
    const arcAngle = Math.atan2(offsetX, -offsetZ)
    const halfTurn = Math.abs(theta) / 2
    const clamped = Math.min(Math.max(arcAngle, -halfTurn), halfTurn)
    const distance = ((clamped + halfTurn) / Math.abs(theta)) * length
    const frame = frameAtDistance(distance)
    const lateral =
      (x - frame.position.x) * frame.lateral.x + (z - frame.position.z) * frame.lateral.z
    return { distance, lateral }
  }

  return { length, closed: false, frameAtDistance, project }
}

type Point2 = readonly [number, number]

/** Shortest signed angle from `a` to `b`. */
function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a))
}

/**
 * Centreline through an ordered list of world points. This is what lets a map be
 * data rather than code: any closed loop of points becomes a drivable track with
 * arc-length lookup and projection, without the vehicle knowing its shape.
 */
export function createPolylineCentreline(points: readonly Point2[], closed = true): Centreline {
  if (points.length < 2) throw new RangeError('a centreline needs at least two points')
  const vertices = points.map(([x, z]) => new THREE.Vector3(x, 0, z))
  // 闭合折线在末尾补回首点，使其成为可循环的 length 段闭环。
  if (closed) vertices.push(vertices[0].clone())
  const segments = vertices.length - 1
  const cumulative = [0]
  for (let i = 0; i < segments; i++)
    cumulative.push(cumulative[i] + vertices[i].distanceTo(vertices[i + 1]))
  const length = cumulative[segments]

  // Smooth per-vertex heading, taken from the neighbouring points so the frame
  // does not jump at every segment boundary.
  const headings: number[] = []
  for (let i = 0; i < vertices.length; i++) {
    const before = vertices[Math.max(0, i - 1)]
    const after = vertices[Math.min(vertices.length - 1, i + 1)]
    headings.push(Math.atan2(after.x - before.x, after.z - before.z))
  }
  if (closed) headings[vertices.length - 1] = headings[0]

  const frameAtDistance = (distance: number): CentrelineFrame => {
    // 闭合时把弧长映射回 [0, length)，兼容负距离的双向取模。
    const d = closed
      ? ((distance % length) + length) % length
      : Math.min(Math.max(distance, 0), length)
    let low = 0
    let high = segments - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (cumulative[mid] <= d) low = mid
      else high = mid - 1
    }
    const span = cumulative[low + 1] - cumulative[low]
    const t = span > 0 ? (d - cumulative[low]) / span : 0
    const position = vertices[low].clone().lerp(vertices[low + 1], t)
    const heading = headings[low] + angleDelta(headings[low], headings[low + 1]) * t
    const forward = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading))
    const lateral = new THREE.Vector3(-Math.cos(heading), 0, Math.sin(heading))
    return { position, forward, lateral, heading, yaw: -Math.atan2(forward.z, forward.x) }
  }

  const project = (x: number, z: number): TrackProjection => {
    let bestDistance = 0
    let bestSquared = Infinity
    for (let i = 0; i < segments; i++) {
      const a = vertices[i]
      const b = vertices[i + 1]
      const abx = b.x - a.x
      const abz = b.z - a.z
      const lengthSquared = abx * abx + abz * abz
      let t = lengthSquared > 0 ? ((x - a.x) * abx + (z - a.z) * abz) / lengthSquared : 0
      t = Math.min(Math.max(t, 0), 1)
      const dx = x - (a.x + abx * t)
      const dz = z - (a.z + abz * t)
      const squared = dx * dx + dz * dz
      if (squared < bestSquared) {
        bestSquared = squared
        bestDistance = cumulative[i] + t * Math.sqrt(lengthSquared)
      }
    }
    const frame = frameAtDistance(bestDistance)
    const lateral =
      (x - frame.position.x) * frame.lateral.x + (z - frame.position.z) * frame.lateral.z
    return { distance: bestDistance, lateral }
  }

  return { length, closed, frameAtDistance, project }
}
