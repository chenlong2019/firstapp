import * as THREE from 'three'
import type { ObstacleBox } from './drone-sim'

/**
 * 飞行沙盒的场景辅助:地面网格、返航点标记、障碍物、航迹尾迹。
 *
 * 障碍物同时喂给仿真内核做避障判定(纯 AABB),所以可视化与物理用同一份数据,
 * 不会出现"看着撞上了但没刹停"这类不一致。
 */

export interface ObstacleSpec {
  name: string
  label: string
  x: number
  z: number
  width: number
  depth: number
  height: number
  color: number
  /** 底面离地高度(米)。默认 0 = 落地障碍物;>0 = 悬空障碍物(天桥等),机体上方测距用 */
  baseY?: number
}

/** 默认障碍物:两组建筑 + 一根正前方灯杆 + 三棵树 + 一道悬空天桥,都在起飞点 30 米内 */
export const DEFAULT_OBSTACLES: ObstacleSpec[] = [
  { name: 'BUILDING_A', label: '建筑 A', x: 16, z: -12, width: 9, depth: 9, height: 13, color: 0x2c3a44 },
  { name: 'BUILDING_B', label: '建筑 B', x: -20, z: 10, width: 11, depth: 15, height: 7, color: 0x2a3740 },
  // 正前方细柱(灯杆,直径 0.3 m):验证"正前方中线"盲区是否真的被消除(两条镜头视场在中线重叠)。
  // 放 16m:在 18m 量程内,又不至于挡住起飞点正前方的平飞测试路径
  { name: 'LAMP_POST', label: '灯杆', x: 0, z: -16, width: 0.3, depth: 0.3, height: 8, color: 0x44535f },
  // 悬空天桥:桥底离地 7.5 m,横跨起飞点后方(x 向 18 m 宽),用来演示机体上方的视觉测距
  { name: 'SKY_BRIDGE', label: '天桥', x: 0, z: 10.5, width: 18, depth: 6, height: 2, color: 0x3a4a55, baseY: 7.5 },
  { name: 'TREE_1', label: '树 1', x: 9, z: 14, width: 3.2, depth: 3.2, height: 6, color: 0x24443a },
  { name: 'TREE_2', label: '树 2', x: -10, z: -17, width: 2.8, depth: 2.8, height: 4.6, color: 0x21403a },
  { name: 'TREE_3', label: '树 3', x: 24, z: 7, width: 3, depth: 3, height: 5.4, color: 0x24443a },
]

const TRAIL_MAX_POINTS = 2400

export class DroneWorld {
  private readonly scene: THREE.Scene
  private readonly group = new THREE.Group()
  private readonly homeMarker = new THREE.Object3D()
  private readonly obstacles: THREE.Object3D[] = []
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = []
  private readonly trailPositions: Float32Array
  private trailLine: THREE.Line | null = null
  private trailCount = 0
  private readonly lastTrailPoint = new THREE.Vector3(Number.NaN, 0, 0)

  readonly collisionBoxes: ObstacleBox[] = []
  readonly specs: ObstacleSpec[]

  constructor(scene: THREE.Scene, specs: ObstacleSpec[] = DEFAULT_OBSTACLES) {
    this.scene = scene
    this.specs = specs

    // —— 地面:超大底板 + 1 米细网格 + 100 米粗网格,给出明确尺度参照 ——
    const groundGeometry = new THREE.PlaneGeometry(4000, 4000)
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x0a1216,
      roughness: 0.95,
      metalness: 0.05,
    })
    this.disposables.push(groundGeometry, groundMaterial)
    const ground = new THREE.Mesh(groundGeometry, groundMaterial)
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.012
    ground.receiveShadow = true
    this.group.add(ground)

    const fineGrid = new THREE.GridHelper(200, 200, 0x1d3d42, 0x143033)
    fineGrid.position.y = 0
    this.tintGrid(fineGrid, 0.55)
    this.group.add(fineGrid)

    const coarseGrid = new THREE.GridHelper(2000, 20, 0x2f6f72, 0x1f4a4d)
    coarseGrid.position.y = 0.004
    this.tintGrid(coarseGrid, 0.75)
    this.group.add(coarseGrid)

    // —— 返航点标记:地面上一个 H 环 + 竖直光柱 ——
    const ringGeometry = new THREE.RingGeometry(1.1, 1.5, 40)
    ringGeometry.rotateX(-Math.PI / 2)
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x6ff0d0,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    this.disposables.push(ringGeometry, ringMaterial)
    const ring = new THREE.Mesh(ringGeometry, ringMaterial)
    ring.position.y = 0.02
    this.homeMarker.add(ring)

    const beaconGeometry = new THREE.CylinderGeometry(0.045, 0.045, 3, 8, 1, true)
    beaconGeometry.translate(0, 1.5, 0)
    const beaconMaterial = new THREE.MeshBasicMaterial({
      color: 0x6ff0d0,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })
    this.disposables.push(beaconGeometry, beaconMaterial)
    const beacon = new THREE.Mesh(beaconGeometry, beaconMaterial)
    beacon.position.y = 0.02
    this.homeMarker.add(beacon)
    this.group.add(this.homeMarker)

    // —— 障碍物(含悬空件:baseY > 0,如天桥) ——
    for (const spec of specs) {
      const baseY = spec.baseY ?? 0
      const geometry = new THREE.BoxGeometry(spec.width, spec.height, spec.depth)
      const material = new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: 0.8,
        metalness: 0.12,
      })
      this.disposables.push(geometry, material)
      const box = new THREE.Mesh(geometry, material)
      box.position.set(spec.x, baseY + spec.height / 2, spec.z)
      box.castShadow = true
      box.receiveShadow = true
      box.name = spec.name
      this.group.add(box)
      this.obstacles.push(box)

      this.collisionBoxes.push({
        name: spec.label,
        minX: spec.x - spec.width / 2,
        maxX: spec.x + spec.width / 2,
        minY: baseY,
        maxY: baseY + spec.height,
        minZ: spec.z - spec.depth / 2,
        maxZ: spec.z + spec.depth / 2,
        solid: true,
      })
    }

    // —— 航迹尾迹 ——
    this.trailPositions = new Float32Array(TRAIL_MAX_POINTS * 3)
    const trailGeometry = new THREE.BufferGeometry()
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3))
    trailGeometry.setDrawRange(0, 0)
    const trailMaterial = new THREE.LineBasicMaterial({
      color: 0x7fd8ff,
      transparent: true,
      opacity: 0.75,
      toneMapped: false,
    })
    this.disposables.push(trailGeometry, trailMaterial)
    this.trailLine = new THREE.Line(trailGeometry, trailMaterial)
    this.trailLine.frustumCulled = false
    this.group.add(this.trailLine)

    scene.add(this.group)
  }

  private tintGrid(grid: THREE.GridHelper, opacity: number): void {
    const material = grid.material as THREE.Material | THREE.Material[]
    const list = Array.isArray(material) ? material : [material]
    list.forEach((item) => {
      item.transparent = true
      item.opacity = opacity
      item.depthWrite = false
      this.disposables.push(item)
    })
  }

  /** 记录航迹:每移动 0.25 米落一个点,避免长航线把缓冲撑爆 */
  pushTrail(x: number, y: number, z: number): void {
    if (Number.isNaN(this.lastTrailPoint.x)) {
      this.lastTrailPoint.set(x, y, z)
    }
    const moved = Math.hypot(x - this.lastTrailPoint.x, y - this.lastTrailPoint.y, z - this.lastTrailPoint.z)
    if (moved < 0.25) return
    if (this.trailCount >= TRAIL_MAX_POINTS) return
    this.trailPositions[this.trailCount * 3] = x
    this.trailPositions[this.trailCount * 3 + 1] = y
    this.trailPositions[this.trailCount * 3 + 2] = z
    this.trailCount += 1
    this.lastTrailPoint.set(x, y, z)
    if (this.trailLine) {
      const attribute = this.trailLine.geometry.getAttribute('position') as THREE.BufferAttribute
      attribute.needsUpdate = true
      this.trailLine.geometry.setDrawRange(0, this.trailCount)
      this.trailLine.geometry.computeBoundingSphere()
    }
  }

  clearTrail(): void {
    this.trailCount = 0
    this.lastTrailPoint.set(Number.NaN, 0, 0)
    if (this.trailLine) {
      this.trailLine.geometry.setDrawRange(0, 0)
    }
  }

  setObstaclesVisible(visible: boolean): void {
    this.obstacles.forEach((obstacle) => {
      obstacle.visible = visible
    })
  }

  /**
   * 锥形视场检测(雷达/视觉传感器用):传感器是一台有视场的相机,不是一条无粗细的射线。
   *
   * 以 origin 为锥顶、axis 为瞄准轴、两个正交轴 u1/u2 上的半张角为 halfU1/halfU2,
   * 判断量程内哪些障碍物落在视场里,返回最近的距离与标签。
   * 判定方式:障碍 AABB 在锥坐标系里用"支撑半径"(Σ|d·axisᵢ|·halfᵢ)近似成盒,
   * 再做椭圆锥内部测试 (e1/(a·tanU1))² + (e2/(a·tanU2))² ≤ 1 —— 连续判定,
   * 于是不存在"两条采样射线之间漏掉细柱"的盲区。
   * 说明:只对障碍物 AABB 判定,不含地面(真机前视也不会把地面当成前方障碍)。
   * 与仿真内核的 AABB 避障相互独立:这里是"传感器测量",那里是"飞控保护"。
   */
  coneCast(
    origin: THREE.Vector3,
    axis: THREE.Vector3,
    u1: THREE.Vector3,
    u2: THREE.Vector3,
    tanU1: number,
    tanU2: number,
    maxDistance: number,
  ): { distance: number; label: string } | null {
    let best: { distance: number; label: string } | null = null
    for (const box of this.collisionBoxes) {
      const cx = (box.minX + box.maxX) / 2
      const cy = (box.minY + box.maxY) / 2
      const cz = (box.minZ + box.maxZ) / 2
      const hx = (box.maxX - box.minX) / 2
      const hy = (box.maxY - box.minY) / 2
      const hz = (box.maxZ - box.minZ) / 2
      // 盒沿任意方向的支撑半宽
      const projHalf = (dir: THREE.Vector3): number =>
        Math.abs(dir.x) * hx + Math.abs(dir.y) * hy + Math.abs(dir.z) * hz

      const vx = cx - origin.x
      const vy = cy - origin.y
      const vz = cz - origin.z
      const along = vx * axis.x + vy * axis.y + vz * axis.z
      const radiusAxis = projHalf(axis)
      const near = along - radiusAxis
      if (near > maxDistance) continue // 太远
      if (along + radiusAxis < 0) continue // 在锥顶后方

      const t1 = Math.abs(vx * u1.x + vy * u1.y + vz * u1.z) - projHalf(u1)
      const t2 = Math.abs(vx * u2.x + vy * u2.y + vz * u2.z) - projHalf(u2)
      const e1 = Math.max(0, t1)
      const e2 = Math.max(0, t2)
      const reference = Math.max(near, 0.05)
      if ((e1 / (reference * tanU1)) ** 2 + (e2 / (reference * tanU2)) ** 2 > 1) continue

      // 距离:取盒上距锥顶最近的一点,再沿瞄准轴投影 ——
      // ⚠️ 不能用支撑半径算距离:对"宽扁"的盒(天桥 18×2 m)会把沿轴厚度夸大好几米
      const qx = Math.min(Math.max(origin.x, box.minX), box.maxX)
      const qy = Math.min(Math.max(origin.y, box.minY), box.maxY)
      const qz = Math.min(Math.max(origin.z, box.minZ), box.maxZ)
      const distance = Math.max(
        0,
        (qx - origin.x) * axis.x + (qy - origin.y) * axis.y + (qz - origin.z) * axis.z,
      )
      if (!best || distance < best.distance) best = { distance, label: box.name }
    }
    return best
  }

  /** 把"起飞点"标记挪到指定位置(重新起飞时会更新返航点) */
  setHome(x: number, z: number): void {
    this.homeMarker.position.set(x, 0, z)
  }

  destroy(): void {
    this.scene.remove(this.group)
    this.disposables.forEach((item) => item.dispose())
    this.disposables.length = 0
    this.obstacles.length = 0
    this.collisionBoxes.length = 0
    this.trailLine = null
  }
}
