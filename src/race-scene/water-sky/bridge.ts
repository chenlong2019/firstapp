/**
 * 跨海大桥（water-sky 场景装饰）：一座自包含的程序化斜拉桥。
 * 桥面沿 createCentreline 生成的圆弧中心线走，路面、车道线、中央隔离带、
 * 桥塔、桥墩与斜拉索都沿同一条中心线扫出，几何与轨道数据因此不会错位。
 * 对外导出 createBridge 与 BridgeOptions；长度单位均为米，常量经 units.ts 的
 * fromLegacyUnits 由上游“旧单位”换算而来。无 DOM/渲染器依赖，可挂入任意宿主场景。
 */
import * as THREE from 'three'
import { createCentreline, type CentrelineFrame } from '../track/centreline'
import { SweepBuilder, boxProfile, cylinderBetween } from '../track/sweep'
import { createMedianTrees } from '../scenery/medianTrees'
import { createMedianLamps } from '../scenery/medianLamps'
import { fromLegacyUnits as legacy } from '../units'

/** Options for the lightweight procedural cable-stayed highway bridge. All lengths are metres. */
export interface BridgeOptions {
  /** World-space origin of the bridge. The default sits in front of the water horizon. */
  position?: readonly [number, number, number]
  /** Arc length of the deck centreline. */
  length?: number
  /** Total heading change along the deck in degrees. 0 keeps the bridge straight. */
  turn?: number
  /** Kerb-to-kerb carriageway width in metres. */
  deckWidth?: number
  deckHeight?: number
  towerHeight?: number
  /** Total traffic lanes across both directions; 4 gives two lanes each way. */
  laneCount?: number
  /** Width of the central median that carries the dividing barrier. */
  medianWidth?: number
  /** Replace the tall divider with a low planter and the supplied FBX trees. */
  plantedMedian?: boolean
  cableCount?: number
  /** Vertical distance from the roadway surface to the top of the outer railing. */
  railingHeight?: number
  /** Open the median barrier this far from each deck end, for a U-turn apron. */
  medianGapAtEnds?: number
  /** Cross-section resolution along the deck. */
  segments?: number
  color?: THREE.ColorRepresentation
}

// 车道标线几何：标线厚度 0.8、虚线周期 40、虚线长度 26，均由上游旧单位换算。
const MARKING_HEIGHT = legacy(0.8)
const DASH_CYCLE = legacy(40)
const DASH_LENGTH = legacy(26)

/**
 * Creates a stylised cable-stayed highway bridge as a self-contained THREE.Group.
 * The deck follows a circular arc (`turn`) and carries a two-way carriageway
 * with painted lane markings, a central median barrier and raised outer railings.
 * No vehicles are modelled. The module has no DOM or renderer dependencies, so it
 * can be added to the water-sky environment or any host scene.
 */
export function createBridge(options: BridgeOptions = {}): THREE.Group {
  const length = Math.max(legacy(200), options.length ?? legacy(2600))
  const turn = Number.isFinite(options.turn) ? (options.turn as number) : 42
  const deckHeight = options.deckHeight ?? legacy(48)
  const towerHeight = Math.max(legacy(40), options.towerHeight ?? legacy(200))
  const deckWidth = Math.max(legacy(24), options.deckWidth ?? legacy(96))
  const laneCount = Math.max(2, Math.round(options.laneCount ?? 4))
  const medianWidth = Math.min(
    deckWidth * 0.3,
    Math.max(legacy(2), options.medianWidth ?? legacy(6)),
  )
  const cableCount = Math.max(3, Math.floor(options.cableCount ?? 5))
  const railingHeight = Math.max(legacy(2), options.railingHeight ?? legacy(7))
  const medianGapAtEnds = Math.max(0, options.medianGapAtEnds ?? 0)
  const segments = Math.max(8, Math.floor(options.segments ?? Math.round(length / legacy(12))))

  const lanesPerDirection = Math.max(1, Math.round(laneCount / 2))
  // 路肩宽度取桥面宽的 5%，并夹在旧单位 2.5–6 之间。
  const shoulder = Math.min(legacy(6), Math.max(legacy(2.5), deckWidth * 0.05))
  const innerEdge = medianWidth / 2
  const outerEdge = deckWidth / 2 - shoulder
  const laneWidth = (outerEdge - innerEdge) / lanesPerDirection
  // Two stacked slabs: the girder top sits inside the wearing course and the
  // markings are embedded in it, so no two coplanar faces share a depth.
  const deckTop = deckHeight + legacy(3)
  const roadTop = deckTop + legacy(1)
  const roadBottom = roadTop - legacy(1.6)
  const markingY = roadTop + legacy(0.15) - MARKING_HEIGHT / 2
  const markingBottom = markingY - MARKING_HEIGHT / 2
  const markingTop = markingY + MARKING_HEIGHT / 2
  const kerbTop = roadTop + legacy(1.2)
  const railingTop = roadTop + railingHeight
  const medianTop = options.plantedMedian
    ? roadTop + legacy(1.5)
    : roadTop + railingHeight - legacy(1)

  const group = new THREE.Group()
  group.name = 'cable-stayed-highway-bridge'
  group.position.fromArray([...(options.position ?? [0, 0, legacy(-900)])])

  const concrete = new THREE.MeshStandardMaterial({
    color: options.color ?? 0xe9eef0,
    emissive: 0x8b9fa8,
    emissiveIntensity: 0.45,
    roughness: 0.62,
    metalness: 0.02,
  })
  const edge = new THREE.MeshStandardMaterial({
    color: 0xb8c4c7,
    emissive: 0x6f8992,
    emissiveIntensity: 0.35,
    roughness: 0.52,
    metalness: 0.12,
  })
  const cableMaterial = new THREE.MeshStandardMaterial({
    color: 0xe8eff0,
    emissive: 0x8c9ea6,
    emissiveIntensity: 0.32,
    roughness: 0.3,
    metalness: 0.16,
  })
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.95, metalness: 0 })
  const whitePaint = new THREE.MeshStandardMaterial({
    color: 0xf1f1e6,
    emissive: 0x33363a,
    emissiveIntensity: 0.35,
    roughness: 0.72,
    metalness: 0,
  })
  const yellowPaint = new THREE.MeshStandardMaterial({
    color: 0xe4bd45,
    emissive: 0x4a3a0f,
    emissiveIntensity: 0.35,
    roughness: 0.72,
    metalness: 0,
  })

  // The deck and anything that drives on it share this one centreline, so the
  // road surface and the track data can never drift apart.
  const centreline = createCentreline(length, turn)
  const frames: CentrelineFrame[] = []
  for (let i = 0; i <= segments; i++)
    frames.push(centreline.frameAtDistance((i / segments) * length))

  // Deck girder, then the asphalt wearing course laid over it.
  const girder = new THREE.Mesh(
    new SweepBuilder()
      .add(frames, boxProfile(0, deckWidth, deckHeight - legacy(3), deckHeight + legacy(3)), true)
      .geometry(),
    concrete,
  )
  girder.name = 'bridge-deck'
  // The deck receives the car's shadow; it does not cast onto itself, which is
  // the classic source of shadow acne on a large flat surface.
  girder.receiveShadow = true
  group.add(girder)

  const roadway = new THREE.Mesh(
    new SweepBuilder().add(frames, boxProfile(0, deckWidth, roadBottom, roadTop), true).geometry(),
    asphalt,
  )
  roadway.name = 'bridge-roadway'
  roadway.receiveShadow = true
  group.add(roadway)

  // Lane markings: solid outer edge lines, plus dashed dividers batched into one
  // geometry, all swept so they follow the curve.
  const white = new SweepBuilder()
  white.add(frames, boxProfile(outerEdge, legacy(1.6), markingBottom, markingTop), true)
  white.add(frames, boxProfile(-outerEdge, legacy(1.6), markingBottom, markingTop), true)
  // 1e-9 抵消浮点误差，避免桥长恰为整数倍周期时少画一段虚线。
  const dashCount = Math.max(1, Math.floor(length / DASH_CYCLE + 1e-9))
  const dashInset = (DASH_CYCLE - DASH_LENGTH) / 2
  for (let lane = 1; lane < lanesPerDirection; lane++) {
    const offset = innerEdge + laneWidth * lane
    for (const sign of [1, -1]) {
      for (let d = 0; d < dashCount; d++) {
        // Centre each dash inside its cycle so the pattern is symmetric about
        // the bridge midpoint rather than starting flush with the deck end.
        const start = d * DASH_CYCLE + dashInset
        const dashFrames: CentrelineFrame[] = []
        for (let step = 0; step <= 2; step++) {
          const arc = start + DASH_LENGTH * (step / 2)
          dashFrames.push(centreline.frameAtDistance(arc))
        }
        white.add(
          dashFrames,
          boxProfile(sign * offset, legacy(1.4), markingBottom, markingTop),
          true,
        )
      }
    }
  }
  const whiteMarkings = new THREE.Mesh(white.geometry(), whitePaint)
  whiteMarkings.name = 'bridge-marking-white'
  group.add(whiteMarkings)

  const yellow = new SweepBuilder()
  yellow.add(
    frames,
    boxProfile(innerEdge + legacy(1.3), legacy(1.3), markingBottom, markingTop),
    true,
  )
  yellow.add(
    frames,
    boxProfile(-(innerEdge + legacy(1.3)), legacy(1.3), markingBottom, markingTop),
    true,
  )
  const yellowMarkings = new THREE.Mesh(yellow.geometry(), yellowPaint)
  yellowMarkings.name = 'bridge-marking-yellow'
  group.add(yellowMarkings)

  // Central median barrier.
  // The median can stop short of each end, which turns the two carriageways into
  // a closed circuit: out on one side, U-turn, back on the other.
  const medianFrames: CentrelineFrame[] = []
  if (medianGapAtEnds > 0) {
    const span = Math.max(length - medianGapAtEnds * 2, legacy(1))
    const count = Math.max(8, Math.round((segments * span) / length))
    for (let i = 0; i <= count; i++)
      medianFrames.push(centreline.frameAtDistance(medianGapAtEnds + (i / count) * span))
  } else {
    medianFrames.push(...frames)
  }
  const median = new THREE.Mesh(
    new SweepBuilder()
      .add(medianFrames, boxProfile(0, medianWidth * 0.72, roadTop - legacy(0.6), medianTop), true)
      .geometry(),
    edge,
  )
  median.name = 'median-barrier'
  median.receiveShadow = true
  group.add(median)

  if (options.plantedMedian) {
    const planting = new THREE.Mesh(
      new SweepBuilder()
        .add(
          medianFrames,
          boxProfile(
            0,
            medianWidth * 0.72 - legacy(0.6),
            medianTop - legacy(0.3),
            medianTop + legacy(0.08),
          ),
          true,
        )
        .geometry(),
      new THREE.MeshStandardMaterial({ color: 0x405329, roughness: 1 }),
    )
    planting.name = 'median-planting-bed'
    planting.receiveShadow = true
    group.add(planting)
    group.add(
      createMedianTrees({
        centreline,
        groundY: medianTop + legacy(0.08),
        height: 5.2,
        spacing: 14,
        endInset: Math.max(medianGapAtEnds, legacy(12)),
        exclusions: [0.24, 0.76].map((t) => ({ distance: t * length, radius: legacy(28) })),
      }),
    )
    group.add(
      createMedianLamps({
        centreline,
        groundY: medianTop + legacy(0.08),
        height: 8,
        treeSpacing: 14,
        endInset: Math.max(medianGapAtEnds, legacy(12)),
        exclusions: [0.24, 0.76].map((t) => ({ distance: t * length, radius: legacy(28) })),
      }),
    )
  }

  // Outer kerb wall with a horizontal rail on top, raised above the roadway.
  const parapet = new SweepBuilder()
  const railing = new SweepBuilder()
  const edgeOffset = deckWidth * 0.5 - legacy(1.2)
  for (const sign of [1, -1]) {
    parapet.add(
      frames,
      boxProfile(sign * edgeOffset, legacy(1.6), roadTop - legacy(0.6), kerbTop),
      true,
    )
    railing.add(
      frames,
      boxProfile(sign * edgeOffset, legacy(2.6), railingTop - legacy(1.4), railingTop),
      true,
    )
  }
  const parapetMesh = new THREE.Mesh(parapet.geometry(), edge)
  parapetMesh.name = 'bridge-parapet'
  parapetMesh.castShadow = true
  parapetMesh.receiveShadow = true
  group.add(parapetMesh)
  const railingMesh = new THREE.Mesh(railing.geometry(), edge)
  railingMesh.name = 'bridge-railing'
  railingMesh.castShadow = true
  railingMesh.receiveShadow = true
  group.add(railingMesh)

  // 两座桥塔的归一化弧长位置（0 为桥头，1 为桥尾）。
  const towerTs = [0.24, 0.76]
  const towerTop = roadTop + towerHeight
  const legOffset = deckWidth * 0.5 + legacy(7)
  const pylonBase = legacy(-2)
  for (const t of towerTs) {
    const frame = centreline.frameAtDistance(t * length)
    for (const side of [1, -1]) {
      const columnHeight = towerTop - pylonBase
      const column = new THREE.Mesh(
        new THREE.BoxGeometry(legacy(15), columnHeight, legacy(12)),
        concrete,
      )
      column.name = 'bridge-tower'
      column.castShadow = true
      column.receiveShadow = true
      column.rotation.y = frame.yaw
      column.position.set(
        frame.position.x + frame.lateral.x * side * legOffset,
        pylonBase + columnHeight * 0.5,
        frame.position.z + frame.lateral.z * side * legOffset,
      )
      group.add(column)
      const base = new THREE.Mesh(new THREE.BoxGeometry(legacy(24), legacy(8), legacy(20)), edge)
      base.name = 'pylon-footing'
      base.rotation.y = frame.yaw
      base.position.set(column.position.x, pylonBase + legacy(2), column.position.z)
      group.add(base)
    }
    const portal = new THREE.Mesh(
      new THREE.BoxGeometry(legacy(18), legacy(4.5), legOffset * 2 + legacy(4)),
      edge,
    )
    portal.name = 'tower-crossbeam'
    portal.rotation.y = frame.yaw
    portal.position.set(frame.position.x, deckHeight + legacy(16), frame.position.z)
    group.add(portal)
    const cap = new THREE.Mesh(
      new THREE.BoxGeometry(legacy(22), legacy(9), legOffset * 2 + legacy(16)),
      concrete,
    )
    cap.name = 'tower-cap'
    cap.rotation.y = frame.yaw
    cap.position.set(frame.position.x, towerTop + legacy(2), frame.position.z)
    group.add(cap)
  }

  // Piers under the deck keep the silhouette grounded over the water.
  const pierTop = deckTop - legacy(0.5)
  const pierHeight = pierTop + legacy(1)
  // 各桥墩的归一化弧长位置（0 为桥头，1 为桥尾）；塔位处同样落墩。
  const pierTs = [0.05, 0.12, 0.19, 0.24, 0.33, 0.42, 0.58, 0.67, 0.76, 0.81, 0.88, 0.95]
  for (const t of pierTs) {
    const frame = centreline.frameAtDistance(t * length)
    const pier = new THREE.Mesh(
      new THREE.CylinderGeometry(deckWidth * 0.055, deckWidth * 0.072, pierHeight, 12),
      concrete,
    )
    pier.name = 'bridge-pier'
    pier.position.set(frame.position.x, pierTop - pierHeight * 0.5, frame.position.z)
    group.add(pier)
    const foot = new THREE.Mesh(
      new THREE.CylinderGeometry(deckWidth * 0.09, deckWidth * 0.105, legacy(4), 16),
      edge,
    )
    foot.name = 'pier-footing'
    foot.position.set(frame.position.x, legacy(-1), frame.position.z)
    group.add(foot)
  }

  // Stay cables fan from each pylon leg to anchors on the outer deck edge. They
  // are few and thick on purpose: a cable only a pixel or two wide aliases into a
  // flicker over the asphalt while the camera orbits.
  const anchorZ = deckWidth * 0.5 + legacy(0.6)
  const anchorY = roadTop - legacy(1.2)
  // 斜拉索锚固点相对桥塔沿弧长的最大偏移比例：±20% 全长。
  const spanT = 0.2
  for (const t of towerTs) {
    const towerFrame = centreline.frameAtDistance(t * length)
    for (const side of [1, -1]) {
      for (let i = 1; i <= cableCount; i++) {
        const offsetT = (i / (cableCount + 1)) * spanT
        for (const direction of [1, -1]) {
          const anchorFrame = centreline.frameAtDistance((t + direction * offsetT) * length)
          const anchor = new THREE.Vector3(
            anchorFrame.position.x + anchorFrame.lateral.x * side * anchorZ,
            anchorY,
            anchorFrame.position.z + anchorFrame.lateral.z * side * anchorZ,
          )
          const top = new THREE.Vector3(
            towerFrame.position.x + towerFrame.lateral.x * side * legOffset,
            towerTop - legacy(10) - (i % 2) * legacy(3),
            towerFrame.position.z + towerFrame.lateral.z * side * legOffset,
          )
          // Cables scale with the span: on a long bridge the deck is small in
          // frame, and anything under about two pixels aliases into a shimmer.
          const cable = cylinderBetween(top, anchor, legacy(3.6), cableMaterial)
          cable.name = 'stay-cable'
          group.add(cable)
          const block = new THREE.Mesh(new THREE.BoxGeometry(legacy(5), legacy(4), legacy(6)), edge)
          block.name = 'cable-anchor'
          block.rotation.y = anchorFrame.yaw
          block.position.set(
            anchorFrame.position.x + anchorFrame.lateral.x * side * (anchorZ - legacy(1.6)),
            anchorY,
            anchorFrame.position.z + anchorFrame.lateral.z * side * (anchorZ - legacy(1.6)),
          )
          group.add(block)
        }
      }
    }
  }

  // Dimensions the geometry was actually built with, for hosts and QA.
  group.userData.bridge = {
    length,
    turn,
    deckWidth,
    deckHeight,
    towerHeight,
    laneCount,
    laneWidth,
    medianWidth,
    shoulder,
    roadTop,
    railingTop,
    cableCount,
    segments,
    medianGapAtEnds,
    // 圆弧弦长 = 2R·sin(θ/2)，R 为桥面半径；直线桥（|turn|<1e-5）退化为 length。
    straightChord:
      2 *
      Math.abs(Math.sin((turn * Math.PI) / 180 / 2)) *
      (Math.abs(turn) < 1e-5 ? length : length / ((turn * Math.PI) / 180)),
  }
  return group
}
