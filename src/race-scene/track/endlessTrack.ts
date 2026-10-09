/**
 * 无限延伸的程序化赛道（track）：逐段生成中心线，每段严格接续上一段的终点与朝向，
 * 因此曲线 C1 连续，几何可分块流式生成而不出现接缝。
 * 对外导出 createEndlessTrack，以及 TrackSegment、EndlessProfile、EndlessStats、EndlessTrack。
 * 约定：曲率单位为 1/米，弧长与长度单位为米，角度为度；mulberry32 保证同种子同赛道。
 * 非直觉约定：project 只扫描上次位置附近的段，代价与行驶距离无关；自交用空间索引+净空判定规避。
 */
import * as THREE from 'three'
import type { CentrelineFrame, TrackProjection } from './centreline'
import { fromLegacyUnits as legacy, LEGACY_UNITS_PER_METRE } from '../units'

/** 一段赛道：直线或圆弧，含符号曲率、长度、起点弧长与世界位姿。 */
export type TrackSegment = {
  kind: 'straight' | 'arc'
  /** Signed curvature in 1/metres; positive curves towards +X of the heading. */
  curvature: number
  length: number
  /** Arc length where the segment starts. */
  start: number
  /** World pose at the start of the segment. */
  x: number
  z: number
  heading: number
}

/** 生成画像：半径候选、转角角度、直线概率、朝向预算，以及防自交所需的净空与分离窗口。 */
export type EndlessProfile = {
  /** Corner radii in metres. Small radii are low speed corners. */
  radii: readonly number[]
  /** Above 1 this favours the small, technical end of `radii`. */
  radiiBias: number
  straight: readonly [number, number]
  /** Corner angle range in degrees. */
  cornerAngle: readonly [number, number]
  /** Chance the next segment is a straight rather than a corner. */
  straightChance: number
  /**
   * Heading budget in degrees. `drift` is the heading relative to the start of
   * the track, so a value below 180 keeps the route always heading roughly
   * forwards: it snakes, but it never turns back over itself.
   */
  maxDrift: number
  /**
   * Minimum distance between two stretches of road that are far apart in arc
   * length. This is what keeps the generated track from running through itself.
   */
  clearance: number
  /** Arc length window inside which two stretches may sit close: a hairpin leg. */
  separation: number
}

/** 已生成赛道的统计与生成过程计数（重抽、逃脱、被迫接受次数）。 */
export type EndlessStats = {
  segments: number
  corners: number
  /** Corners below approximately 27.52 metres radius, i.e. the technical ones. */
  lowSpeedCorners: number
  minRadius: number
  medianRadius: number
  averageCornerDegrees: number
  /** Share of corner arc length that belongs to a low speed corner. */
  lowSpeedShare: number
  /** Total generated centreline length in metres. */
  length: number
  /** Proposals thrown away because they ran through existing road. */
  redraws: number
  /** Segments that needed the systematic sweep instead of a lucky draw. */
  escapes: number
  /** Segments accepted even though they overlap, when no option was free. */
  forced: number
}

/** Corners below this radius count as low speed, i.e. the technical ones. */
const LOW_SPEED_RADIUS = legacy(120)
/** Spacing of the points that form the self-intersection index. */
const INDEX_STEP = legacy(12)
/** 判断“直线”的曲率阈值：绝对值小于它即按直线处理，避免除以极小曲率。 */
const STRAIGHT_CURVATURE = 1e-9 * LEGACY_UNITS_PER_METRE

/** 无限赛道句柄：按弧长取帧、投影、按需延长并给出统计。 */
export type EndlessTrack = {
  readonly seed: number
  readonly length: number
  readonly profile: EndlessProfile
  readonly segments: readonly TrackSegment[]
  /** Generate until at least `distance` of track exists. */
  ensureLength(distance: number): void
  frameAtDistance(distance: number): CentrelineFrame
  project(x: number, z: number): TrackProjection
  stats(): EndlessStats
}

/** Deterministic PRNG: the same seed always yields the same track. */
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const range = (values: readonly [number, number], t: number) =>
  values[0] + (values[1] - values[0]) * t
const wrapAngle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value))

/**
 * Endless, procedurally generated centreline built one segment at a time. Each
 * segment starts exactly where the previous one ended with the same heading, so
 * the track is C1 continuous and geometry can stream in chunks without seams.
 * Projection only scans segments near the last known position, so the cost stays
 * flat however far the player drives.
 */
export function createEndlessTrack(options: {
  seed: number
  profile?: Partial<EndlessProfile>
  origin?: readonly [number, number]
  heading?: number
}): EndlessTrack {
  const profile: EndlessProfile = {
    // A technical mix: the bias below pulls most draws to the tight, low speed
    // end, and a couple of medium corners give the track some rhythm.
    radii: [52, 66, 80, 96, 118, 150].map(legacy),
    radiiBias: 1.35,
    straight: [legacy(60), legacy(190)],
    cornerAngle: [45, 130],
    straightChance: 0.3,
    maxDrift: 150,
    clearance: legacy(92),
    separation: legacy(620),
    ...options.profile,
  }
  const random = mulberry32(options.seed)
  const segments: TrackSegment[] = []
  const [originX, originZ] = options.origin ?? [0, 0]
  let drift = 0
  let lastProjected = 0
  let redraws = 0
  let escapes = 0
  let forced = 0

  // Spatial index of the road generated so far, sampled at a fixed arc length
  // step. It answers one question: does this candidate segment run through
  // road that already exists? Points carry their arc length so a hairpin may
  // still bring its own return leg close without being rejected.
  const occupancy = new Map<string, { x: number; z: number; distance: number }[]>()
  // 空间索引格子边长取 ≥8 旧单位且不小于净空，使 3×3 邻域即可覆盖最近的路。
  const cell = Math.max(legacy(8), profile.clearance)
  const bucketKey = (cx: number, cz: number) => `${cx}:${cz}`
  const indexSegment = (segment: TrackSegment) => {
    const steps = Math.max(1, Math.round(segment.length / INDEX_STEP))
    for (let i = 0; i <= steps; i++) {
      const distance = segment.start + (segment.length * i) / steps
      const point = pose(segment, distance - segment.start)
      const key = bucketKey(Math.floor(point.x / cell), Math.floor(point.z / cell))
      const entry = { x: point.x, z: point.z, distance }
      const bucket = occupancy.get(key)
      if (bucket) bucket.push(entry)
      else occupancy.set(key, [entry])
    }
  }
  /**
   * Distance from the candidate to the nearest road that is far away in arc
   * length, capped at `limit`. Local neighbours are ignored: that is what lets
   * a hairpin bring its own return leg close.
   */
  const clearanceTo = (candidate: TrackSegment, limit: number) => {
    let closest = limit
    const steps = Math.max(2, Math.round(candidate.length / INDEX_STEP))
    for (let i = 0; i <= steps; i++) {
      const local = (candidate.length * i) / steps
      const point = pose(candidate, local)
      const distance = candidate.start + local
      const cx = Math.floor(point.x / cell)
      const cz = Math.floor(point.z / cell)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const bucket = occupancy.get(bucketKey(cx + ox, cz + oz))
          if (!bucket) continue
          for (const other of bucket) {
            if (Math.abs(other.distance - distance) < profile.separation) continue
            const dx = other.x - point.x
            const dz = other.z - point.z
            closest = Math.min(closest, Math.sqrt(dx * dx + dz * dz))
          }
        }
      }
    }
    return closest
  }
  const blocked = (candidate: TrackSegment, clearance: number) =>
    clearanceTo(candidate, clearance) < clearance

  const pose = (segment: TrackSegment, distance: number) => {
    const heading = segment.heading + segment.curvature * distance
    if (Math.abs(segment.curvature) < STRAIGHT_CURVATURE) {
      return {
        x: segment.x + Math.sin(segment.heading) * distance,
        z: segment.z + Math.cos(segment.heading) * distance,
        heading,
      }
    }
    return {
      x: segment.x + (Math.cos(segment.heading) - Math.cos(heading)) / segment.curvature,
      z: segment.z + (Math.sin(heading) - Math.sin(segment.heading)) / segment.curvature,
      heading,
    }
  }

  const append = () => {
    const last = segments[segments.length - 1]
    const start = last ? last.start + last.length : 0
    const base = last
      ? pose(last, last.length)
      : { x: originX, z: originZ, heading: options.heading ?? 0 }
    const driftDegrees = (drift * 180) / Math.PI
    const straight = (length: number): TrackSegment => ({
      kind: 'straight',
      curvature: 0,
      length,
      start,
      x: base.x,
      z: base.z,
      heading: base.heading,
    })
    const arc = (radius: number, direction: number, degrees: number): TrackSegment => {
      const curvature = direction / radius
      return {
        kind: 'arc',
        curvature,
        length: Math.abs((degrees * Math.PI) / 180 / curvature),
        start,
        x: base.x,
        z: base.z,
        heading: base.heading,
      }
    }
    const draw = (): TrackSegment => {
      if (random() < profile.straightChance && Math.abs(driftDegrees) < profile.maxDrift * 0.5) {
        return straight(range(profile.straight, random()))
      }
      // Power bias: exponents above 1 push the draw towards the tight end of
      // the radius list, which is what makes the track technical rather than
      // a mix of sweepers and hairpins.
      const pick = Math.pow(random(), profile.radiiBias)
      const radius =
        profile.radii[Math.min(profile.radii.length - 1, Math.floor(pick * profile.radii.length))]
      let degrees = range(profile.cornerAngle, random())
      // The heading budget is a hard limit, not a suggestion: a corner is
      // turned the other way, or shortened, before it can push the route past
      // the budget. Because `drift` is the heading relative to the start of the
      // track, that keeps a forward component in every step, and a route that
      // always moves forwards cannot loop back through itself.
      let direction = random() < 0.5 ? 1 : -1
      const limit = profile.maxDrift * 0.55
      if (direction * driftDegrees > 0) {
        const room = limit - direction * driftDegrees
        if (room < profile.cornerAngle[0]) direction = -direction
        else degrees = Math.min(degrees, room)
      }
      return arc(radius, direction, degrees)
    }
    // Redraw until the new piece does not cut through road that already
    // exists. Random draws come first; if they keep failing the option space is
    // swept directly, and only then is the clearance relaxed. The result is a
    // pure function of the seed and the accepted segments, so a seed always
    // rebuilds the same track.
    let candidate: TrackSegment | null = null
    // 随机重抽最多 8 次；仍失败则改用系统化扫掠（见下）。
    for (let attempt = 0; attempt < 8 && !candidate; attempt++) {
      const proposal = draw()
      if (blocked(proposal, profile.clearance)) redraws++
      else candidate = proposal
    }
    if (!candidate) {
      escapes++
      // Tight corners first, so landing in the sweep still keeps the character
      // technical; straights come last as a way out of a crowded pocket.
      const options: TrackSegment[] = []
      for (const radius of profile.radii) {
        for (const direction of [1, -1]) {
          for (const degrees of [130, 95, 65]) options.push(arc(radius, direction, degrees))
        }
      }
      for (const length of [profile.straight[0], range(profile.straight, 0.5), profile.straight[1]])
        options.push(straight(length))
      for (const slack of [1, 0.7, 0.45]) {
        candidate = options.find((option) => !blocked(option, profile.clearance * slack)) ?? null
        if (candidate) break
      }
    }
    if (!candidate) {
      // Nothing in the sweep fits: sample wider and keep the roomiest option,
      // so a crowded pocket gets the least bad road rather than a random one.
      forced++
      let best = draw()
      let room = clearanceTo(best, profile.clearance)
      // 兜底：再随机采样 48 次取净空最大者，避免在拥挤处完全卡死。
      for (let attempt = 0; attempt < 48; attempt++) {
        const proposal = draw()
        const candidateRoom = clearanceTo(proposal, profile.clearance)
        if (candidateRoom > room) {
          best = proposal
          room = candidateRoom
        }
      }
      candidate = best
    }
    const accepted = candidate
    if (accepted.kind === 'arc') drift += accepted.curvature * accepted.length
    segments.push(accepted)
    indexSegment(accepted)
  }

  const totalLength = () =>
    segments.length ? segments[segments.length - 1].start + segments[segments.length - 1].length : 0

  const ensureLength = (distance: number) => {
    while (totalLength() < distance) append()
  }

  const indexAt = (distance: number) => {
    let low = 0
    let high = segments.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (segments[mid].start <= distance) low = mid
      else high = mid - 1
    }
    return low
  }

  const frameAtDistance = (distance: number): CentrelineFrame => {
    const clamped = Math.max(distance, 0)
    ensureLength(clamped + legacy(1))
    const segment = segments[indexAt(clamped)]
    const local = Math.min(clamped - segment.start, segment.length)
    const point = pose(segment, local)
    const forward = new THREE.Vector3(Math.sin(point.heading), 0, Math.cos(point.heading))
    const lateral = new THREE.Vector3(-Math.cos(point.heading), 0, Math.sin(point.heading))
    return {
      position: new THREE.Vector3(point.x, 0, point.z),
      forward,
      lateral,
      heading: point.heading,
      yaw: -Math.atan2(forward.z, forward.x),
    }
  }

  const closest = (segment: TrackSegment, x: number, z: number) => {
    let along: number
    if (Math.abs(segment.curvature) < STRAIGHT_CURVATURE) {
      along =
        (x - segment.x) * Math.sin(segment.heading) + (z - segment.z) * Math.cos(segment.heading)
    } else {
      // Arc centre: start - right / curvature, with right = (-cos h, sin h).
      const centreX = segment.x + Math.cos(segment.heading) / segment.curvature
      const centreZ = segment.z - Math.sin(segment.heading) / segment.curvature
      const sign = Math.sign(segment.curvature)
      const ux = (x - centreX) * sign
      const uz = (z - centreZ) * sign
      along = wrapAngle(Math.atan2(uz, -ux) - segment.heading) / segment.curvature
    }
    const clamped = Math.min(Math.max(along, 0), segment.length)
    const point = pose(segment, clamped)
    const dx = x - point.x
    const dz = z - point.z
    const lateral = dx * -Math.cos(point.heading) + dz * Math.sin(point.heading)
    return { distance: segment.start + clamped, lateral, squared: dx * dx + dz * dz }
  }

  const project = (x: number, z: number): TrackProjection => {
    // Only seed the very first segment: extending here would append a segment
    // per query, and the vehicle projects its position every physics step.
    ensureLength(legacy(1))
    // 只检查上次位置前后各 8 段；若横向偏移过大再全量扫描（见下）。
    const from = Math.max(0, lastProjected - 8)
    const to = Math.min(segments.length - 1, lastProjected + 8)
    let best = closest(segments[from], x, z)
    let bestIndex = from
    for (let i = from + 1; i <= to; i++) {
      const candidate = closest(segments[i], x, z)
      if (candidate.squared < best.squared) {
        best = candidate
        bestIndex = i
      }
    }
    // Far from the local window (a reset or a teleport): scan everything once.
    // 横向偏移超过 400 旧单位视为复位或传送，做一次全量扫描。
    if (Math.abs(best.lateral) > legacy(400)) {
      for (let i = 0; i < segments.length; i++) {
        const candidate = closest(segments[i], x, z)
        if (candidate.squared < best.squared) {
          best = candidate
          bestIndex = i
        }
      }
    }
    lastProjected = bestIndex
    return { distance: best.distance, lateral: best.lateral }
  }

  const stats = (): EndlessStats => {
    const corners = segments.filter((segment) => segment.kind === 'arc')
    const radii = corners.map((segment) => 1 / Math.abs(segment.curvature)).sort((a, b) => a - b)
    let cornerLength = 0
    let lowSpeedLength = 0
    let degrees = 0
    for (const segment of corners) {
      cornerLength += segment.length
      degrees += (Math.abs(segment.curvature) * segment.length * 180) / Math.PI
      if (1 / Math.abs(segment.curvature) < LOW_SPEED_RADIUS) lowSpeedLength += segment.length
    }
    return {
      segments: segments.length,
      corners: corners.length,
      lowSpeedCorners: radii.filter((radius) => radius < LOW_SPEED_RADIUS).length,
      minRadius: radii.length ? radii[0] : 0,
      medianRadius: radii.length ? radii[Math.floor(radii.length / 2)] : 0,
      averageCornerDegrees: corners.length ? degrees / corners.length : 0,
      lowSpeedShare: cornerLength ? lowSpeedLength / cornerLength : 0,
      length: totalLength(),
      redraws,
      escapes,
      forced,
    }
  }

  return {
    seed: options.seed,
    profile,
    segments,
    get length() {
      return totalLength()
    },
    ensureLength,
    frameAtDistance,
    project,
    stats,
  }
}
