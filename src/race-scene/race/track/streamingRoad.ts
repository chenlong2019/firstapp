// 本文件负责"无尽赛道"路面的流式生成：按固定长度把路面切成块，只保留车前后一定范围内的块，
// 于是无论开多远，几何体总量都保持恒定。
// 位置：race-scene/race/track，被 endlessMap 使用，依赖 track/sweep 的扫掠建面工具。
// 对外导出：createStreamingRoad 工厂，以及 StreamingRoad / StreamingRoadOptions 两个类型。
// 非直觉约定：尺寸与弧长单位为米；分块边界取整弧长，相邻块共享端部框架，故路面无缝；
// 车道虚线与桥墩按"全局弧长"排布，跨块不会重新起算。
import * as THREE from 'three'
import { SweepBuilder, boxProfile, cylinderBetween } from '../../track/sweep'
import type { CentrelineFrame } from '../../track/centreline'
import type { EndlessTrack } from '../../track/endlessTrack'
import { fromLegacyUnits as legacy } from '../../units'

/** Positions, dimensions and streaming distances are metres. */
/** 流式路面构建参数：轨道、世界原点、路面高度、半宽、分块长度，以及前后要保留的距离（均为米）。 */
export type StreamingRoadOptions = {
  track: EndlessTrack
  origin: THREE.Vector3
  /** World height of the road surface. */
  surfaceY: number
  /** Half of the paved width. */
  halfWidth: number
  chunkLength: number
  /** How much road to keep built ahead of and behind the car. */
  ahead: number
  behind: number
}

/** 流式路面句柄：持有场景分组，按车的弧长位置更新（生成/回收分块），可查询统计与释放资源。 */
export type StreamingRoad = {
  group: THREE.Group
  update(distance: number): void
  stats(): { chunks: number; triangles: number; meshes: number }
  dispose(): void
}

// 虚线周期 / 线长 / 采样步长原以"旧单位"给出，这里统一换算成米。
const DASH_CYCLE = legacy(40)
const DASH_LENGTH = legacy(26)
const SAMPLE_STEP = legacy(8)

/**
 * Builds the generated road in fixed length chunks and retires the ones the car
 * has left behind, so driving forever costs a constant amount of geometry.
 * Chunk boundaries fall on exact arc lengths, so neighbouring chunks share their
 * end frames and the surface has no seam.
 */
export function createStreamingRoad(options: StreamingRoadOptions): StreamingRoad {
  const { track, origin, surfaceY, halfWidth, chunkLength } = options
  const group = new THREE.Group()
  group.name = 'generated-road'
  group.userData.chunkLengthMetres = chunkLength
  const chunks = new Map<number, THREE.Group>()

  const concrete = new THREE.MeshStandardMaterial({
    color: 0xd9dee0,
    emissive: 0x6f8992,
    emissiveIntensity: 0.3,
    roughness: 0.66,
    metalness: 0.02,
  })
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.95, metalness: 0 })
  const paint = new THREE.MeshStandardMaterial({
    color: 0xf1f1e6,
    emissive: 0x33363a,
    emissiveIntensity: 0.3,
    roughness: 0.72,
    metalness: 0,
  })
  const edge = new THREE.MeshStandardMaterial({
    color: 0xb8c4c7,
    emissive: 0x6f8992,
    emissiveIntensity: 0.3,
    roughness: 0.52,
    metalness: 0.12,
  })

  const worldFrame = (distance: number): CentrelineFrame => {
    const frame = track.frameAtDistance(distance)
    frame.position.x += origin.x
    frame.position.z += origin.z
    frame.position.y = surfaceY
    return frame
  }

  const sampleFrames = (from: number, to: number): CentrelineFrame[] => {
    // 每块至少采样 2 个横截面，保证扫掠几何总有可用的起止框架。
    const steps = Math.max(2, Math.round((to - from) / SAMPLE_STEP))
    const frames: CentrelineFrame[] = []
    for (let i = 0; i <= steps; i++) frames.push(worldFrame(from + ((to - from) * i) / steps))
    return frames
  }

  const buildChunk = (index: number): THREE.Group => {
    const from = index * chunkLength
    const to = from + chunkLength
    const frames = sampleFrames(from, to)
    const chunk = new THREE.Group()
    chunk.name = `road-chunk-${index}`

    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, name: string) => {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = name
      // Anything that is road surface takes the car's shadow; anything standing
      // above the surface throws one. Set here rather than matched by name
      // later, and inert while the renderer's shadow map is off.
      const surface = /surface|deck|line|marking|kerb/i.test(name)
      mesh.receiveShadow = true
      mesh.castShadow = !surface
      chunk.add(mesh)
    }

    // Girder, wearing course, kerbs and raised rails, in that order.
    add(
      new SweepBuilder()
        .add(frames, boxProfile(0, halfWidth * 2, legacy(-7), legacy(-1)), true)
        .geometry(),
      concrete,
      'road-deck',
    )
    add(
      new SweepBuilder()
        .add(frames, boxProfile(0, halfWidth * 2, legacy(-1.6), 0), true)
        .geometry(),
      asphalt,
      'road-surface',
    )
    add(
      new SweepBuilder()
        .add(
          frames,
          boxProfile(halfWidth - legacy(2), legacy(1.6), legacy(-0.65), legacy(0.15)),
          true,
        )
        .geometry(),
      paint,
      'edge-line',
    )
    add(
      new SweepBuilder()
        .add(
          frames,
          boxProfile(-(halfWidth - legacy(2)), legacy(1.6), legacy(-0.65), legacy(0.15)),
          true,
        )
        .geometry(),
      paint,
      'edge-line',
    )
    for (const side of [1, -1]) {
      add(
        new SweepBuilder()
          .add(
            frames,
            boxProfile(side * (halfWidth - legacy(0.8)), legacy(1.6), legacy(-0.6), legacy(1.2)),
            true,
          )
          .geometry(),
        edge,
        'road-kerb',
      )
      add(
        new SweepBuilder()
          .add(
            frames,
            boxProfile(side * (halfWidth - legacy(1)), legacy(2.6), legacy(5.6), legacy(7)),
            true,
          )
          .geometry(),
        edge,
        'road-railing',
      )
    }

    // Dashes are positioned by global arc length so the pattern carries across
    // chunk boundaries instead of restarting at each seam.
    const dashes = new SweepBuilder()
    // Metre conversion must not move an exact chunk boundary into another cycle.
    const first = Math.ceil(from / DASH_CYCLE - 1e-9)
    const last = Math.floor((to - DASH_LENGTH) / DASH_CYCLE + 1e-9)
    for (let cycle = first; cycle <= last; cycle++) {
      const start = cycle * DASH_CYCLE + (DASH_CYCLE - DASH_LENGTH) / 2
      dashes.add(
        sampleFrames(start, start + DASH_LENGTH),
        boxProfile(0, legacy(1.4), legacy(-0.65), legacy(0.15)),
        true,
      )
    }
    add(dashes.geometry(), paint, 'centre-line')

    // Pillars carry the viaduct down to the water, one per second chunk section.
    const pillarSpacing = legacy(150)
    for (
      let station = Math.ceil(from / pillarSpacing - 1e-9);
      station <= Math.floor(to / pillarSpacing + 1e-9);
      station++
    ) {
      const distance = station * pillarSpacing
      const frame = worldFrame(distance)
      // 桥墩从桥面下方约 7、伸到水面附近的 -2（均为旧单位高度值）。
      const top = new THREE.Vector3(frame.position.x, surfaceY - legacy(7), frame.position.z)
      const bottom = new THREE.Vector3(frame.position.x, legacy(-2), frame.position.z)
      const pillar = cylinderBetween(bottom, top, halfWidth * 0.12, concrete)
      pillar.name = 'road-pillar'
      chunk.add(pillar)
      const footing = new THREE.Mesh(
        new THREE.CylinderGeometry(halfWidth * 0.2, halfWidth * 0.23, legacy(4), 14),
        edge,
      )
      footing.position.set(frame.position.x, legacy(-1), frame.position.z)
      footing.name = 'pillar-footing'
      chunk.add(footing)
    }
    return chunk
  }

  const disposeChunk = (chunk: THREE.Group) => {
    chunk.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return
      ;(object as THREE.Mesh).geometry.dispose()
    })
    chunk.removeFromParent()
  }

  const update = (distance: number) => {
    const wanted = new Set<number>()
    const first = Math.floor((distance - options.behind) / chunkLength)
    const last = Math.floor((distance + options.ahead) / chunkLength)
    for (let index = Math.max(0, first); index <= last; index++) wanted.add(index)
    for (const [index, chunk] of chunks) {
      if (wanted.has(index)) continue
      disposeChunk(chunk)
      chunks.delete(index)
    }
    for (const index of wanted) {
      if (chunks.has(index)) continue
      const chunk = buildChunk(index)
      chunks.set(index, chunk)
      group.add(chunk)
    }
  }

  return {
    group,
    update,
    stats() {
      let meshes = 0
      let triangles = 0
      group.traverse((object) => {
        if (!(object as THREE.Mesh).isMesh) return
        meshes++
        const geometry = (object as THREE.Mesh).geometry
        triangles += (geometry.index?.count ?? geometry.attributes.position.count) / 3
      })
      return { chunks: chunks.size, meshes, triangles: Math.round(triangles) }
    },
    dispose() {
      for (const chunk of chunks.values()) disposeChunk(chunk)
      chunks.clear()
      for (const material of [concrete, asphalt, paint, edge]) material.dispose()
    },
  }
}
