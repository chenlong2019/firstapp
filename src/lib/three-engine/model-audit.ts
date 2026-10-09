/**
 * 模型体检:量化「这份模型交付/上线会不会出问题」。
 *
 * 职责:遍历已加载的 three 场景,统计几何/材质/纹理/骨骼/动画指标,再按阈值规则产出
 *       问题清单与健康度评分。纯计算,不碰渲染器状态。
 * 位置:供 /glb 查看器的「模型体检」面板调用;结果同时用于回归断言。
 * 导出:`auditScene()`、相关类型与 `AUDIT_THRESHOLDS`。
 *
 * 非直觉约定:
 * - 纹理按 `uuid` 去重后再统计显存 —— 同一张贴图被多个材质引用是常态,不去重会翻好几倍。
 * - 显存按「RGBA8 + mipmap」粗估:压缩纹理(Draco/KTX2)会被高估,但量级正确,足以支撑"是否超标"的判断。
 * - drawcall 用渲染器实测值(renderer.info.render.calls)做**展示**,但绝不参与评分:
 *   实测值随渲染设置(后处理/阴影开关、是否正在拖拽)波动,同一模型两次体检能差出十几分。
 *   评分只看模型固有指标,保证可重复 —— 这也是回归脚本能锁住评分的前提。
 * - 评分为「100 减去扣分」,只做相对比较用,不是行业标准。
 */
import * as THREE from 'three'

/** 触发提醒的阈值,集中在这里便于调整与测试。 */
export const AUDIT_THRESHOLDS = {
  trianglesWarn: 100_000,
  trianglesError: 500_000,
  /** 单张纹理边长 */
  textureSizeWarn: 2048,
  textureSizeError: 4096,
  /** 纹理显存合计(MB) */
  textureMemoryWarn: 64,
  textureMemoryError: 128,
  drawCallsWarn: 150,
  drawCallsError: 300,
  materialsWarn: 100,
  nodesWarn: 2000,
} as const

export type AuditLevel = 'error' | 'warn' | 'info' | 'good'

export interface AuditIssue {
  id: string
  level: AuditLevel
  title: string
  detail: string
}

export interface AuditMetrics {
  nodes: number
  maxDepth: number
  meshes: number
  skinnedMeshes: number
  primitives: number
  triangles: number
  vertices: number
  materials: number
  transparentMaterials: number
  doubleSidedMaterials: number
  textures: number
  textureMemoryMB: number
  maxTextureSize: number
  bones: number
  animations: number
  animationSeconds: number
  drawCalls: number
  /** 缺少 UV 却带贴图的网格数 */
  missingUvWithTexture: number
  /** 缺少法线的网格数 */
  missingNormal: number
  /** 非索引几何数量 */
  unindexedMeshes: number
  /** 包围盒尺寸(世界坐标,单位与模型一致) */
  size: [number, number, number]
}

export interface AuditReport {
  score: number
  grade: 'A' | 'B' | 'C' | 'D'
  metrics: AuditMetrics
  issues: AuditIssue[]
  /** 体检耗时(ms) */
  durationMs: number
}

export interface AuditInput {
  scene: THREE.Object3D
  /** 渲染器实测数据(renderer.info),拿不到时传 undefined,drawcall 相关规则会跳过 */
  renderInfo?: { calls: number } | undefined
}

/** 材质统一成数组。 */
function toMaterials(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(material) ? material : [material]
}

/** 从材质的各个贴图槽位收集纹理(按 uuid 去重)。 */
function collectTextures(scene: THREE.Object3D): Map<string, THREE.Texture> {
  const found = new Map<string, THREE.Texture>()
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    for (const material of toMaterials(mesh.material)) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        const texture = value as THREE.Texture | null
        if (texture && (texture as THREE.Texture).isTexture) {
          found.set(texture.uuid, texture)
        }
      }
    }
  })
  return found
}

/** 单张贴图的显存估算(字节)。 */
function textureBytes(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined
  const width = image?.width ?? 0
  const height = image?.height ?? 0
  if (!width || !height) return 0
  // RGBA8 + mipmap(约多 1/3)
  return Math.round(width * height * 4 * 1.34)
}

/** 统计场景指标。 */
function collectMetrics(scene: THREE.Object3D, renderInfo?: { calls: number }): AuditMetrics {
  let nodes = 0
  let meshes = 0
  let skinnedMeshes = 0
  let primitives = 0
  let triangles = 0
  let vertices = 0
  let bones = 0
  let missingUvWithTexture = 0
  let missingNormal = 0
  let unindexedMeshes = 0

  const materials = new Set<string>()
  let transparentMaterials = 0
  let doubleSidedMaterials = 0
  const countedMaterials = new Set<string>()

  const animatedSeconds = new Map<string, number>()

  scene.traverse((object) => {
    nodes++

    if ((object as THREE.Bone).isBone) bones++

    const mesh = object as THREE.Mesh
    if (!mesh.isMesh && !(object as THREE.Points).isPoints && !(object as THREE.Line).isLine) {
      return
    }

    const geometry = mesh.geometry as THREE.BufferGeometry | undefined
    if (!geometry) return

    if (mesh.isMesh) {
      meshes++
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinnedMeshes++
    }
    primitives++

    const position = geometry.getAttribute('position')
    if (position) vertices += position.count

    if (geometry.index) {
      const count = geometry.index.count
      triangles += Math.floor(count / 3)
    } else {
      unindexedMeshes++
      if (position) triangles += Math.floor(position.count / 3)
    }

    if (!geometry.getAttribute('normal')) missingNormal++

    const hasUv = Boolean(geometry.getAttribute('uv'))
    const materialList = mesh.material ? toMaterials(mesh.material) : []
    if (!hasUv && materialList.some((m) => Boolean((m as THREE.MeshStandardMaterial).map))) {
      missingUvWithTexture++
    }

    for (const material of materialList) {
      materials.add(material.uuid)
      if (!countedMaterials.has(material.uuid)) {
        countedMaterials.add(material.uuid)
        if (material.transparent) transparentMaterials++
        if (material.side === THREE.DoubleSide) doubleSidedMaterials++
      }
    }
  })

  const textures = collectTextures(scene)
  let textureMemory = 0
  let maxTextureSize = 0
  for (const texture of textures.values()) {
    textureMemory += textureBytes(texture)
    const image = texture.image as { width?: number; height?: number } | undefined
    maxTextureSize = Math.max(maxTextureSize, image?.width ?? 0, image?.height ?? 0)
  }

  // 动画时长:取最长的 clip
  let animationSeconds = 0
  const root = scene as THREE.Object3D & { animations?: THREE.AnimationClip[] }
  for (const clip of root.animations ?? []) {
    const current = animatedSeconds.get(clip.name) ?? 0
    if (clip.duration > current) animatedSeconds.set(clip.name, clip.duration)
    animationSeconds = Math.max(animationSeconds, clip.duration)
  }

  // 层级深度
  let maxDepth = 0
  const walk = (object: THREE.Object3D, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth)
    for (const child of object.children) walk(child, depth + 1)
  }
  walk(scene, 1)

  const box = new THREE.Box3().setFromObject(scene)
  const size = new THREE.Vector3()
  if (!box.isEmpty()) box.getSize(size)

  return {
    nodes,
    maxDepth,
    meshes,
    skinnedMeshes,
    primitives,
    triangles,
    vertices,
    materials: materials.size,
    transparentMaterials,
    doubleSidedMaterials,
    textures: textures.size,
    textureMemoryMB: +(textureMemory / 1024 / 1024).toFixed(1),
    maxTextureSize,
    bones,
    animations: animatedSeconds.size,
    animationSeconds: +animationSeconds.toFixed(2),
    drawCalls: renderInfo?.calls ?? 0,
    missingUvWithTexture,
    missingNormal,
    unindexedMeshes,
    size: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
  }
}

/** 按指标产出问题清单。评分只用模型固有指标 —— 渲染层的实测值会波动,不能进评分。 */
function collectIssues(metrics: AuditMetrics): AuditIssue[] {
  const issues: AuditIssue[] = []
  const t = AUDIT_THRESHOLDS

  if (metrics.triangles > t.trianglesError) {
    issues.push({
      id: 'triangles',
      level: 'error',
      title: `三角面 ${metrics.triangles.toLocaleString()} 面,偏高`,
      detail: '移动端与低端显卡上会明显掉帧,建议减面或做 LOD。',
    })
  } else if (metrics.triangles > t.trianglesWarn) {
    issues.push({
      id: 'triangles',
      level: 'warn',
      title: `三角面 ${metrics.triangles.toLocaleString()} 面`,
      detail: '桌面端没问题,移动端需留意;可考虑简化后再发布。',
    })
  } else {
    issues.push({
      id: 'triangles',
      level: 'good',
      title: `三角面 ${metrics.triangles.toLocaleString()} 面,轻量`,
      detail: '几何量级健康。',
    })
  }

  if (metrics.textureMemoryMB > t.textureMemoryError) {
    issues.push({
      id: 'texture-memory',
      level: 'error',
      title: `纹理显存约 ${metrics.textureMemoryMB} MB`,
      detail: '远超常见设备的单模型预算,首屏会出现长时间白屏与显存告警。',
    })
  } else if (metrics.textureMemoryMB > t.textureMemoryWarn) {
    issues.push({
      id: 'texture-memory',
      level: 'warn',
      title: `纹理显存约 ${metrics.textureMemoryMB} MB`,
      detail: '偏大,建议降低分辨率或改用压缩纹理格式。',
    })
  } else {
    issues.push({
      id: 'texture-memory',
      level: 'good',
      title: `纹理显存约 ${metrics.textureMemoryMB} MB`,
      detail: '在合理范围内。',
    })
  }

  if (metrics.maxTextureSize > t.textureSizeError) {
    issues.push({
      id: 'texture-size',
      level: 'error',
      title: `存在 ${metrics.maxTextureSize}px 的超大贴图`,
      detail: '单张 4K 以上贴图会显著拖慢加载与解码。',
    })
  } else if (metrics.maxTextureSize > t.textureSizeWarn) {
    issues.push({
      id: 'texture-size',
      level: 'warn',
      title: `最大贴图 ${metrics.maxTextureSize}px`,
      detail: '若模型在屏幕上显示不大,降到 1024 通常看不出差别。',
    })
  } else if (metrics.textures > 0) {
    issues.push({
      id: 'texture-size',
      level: 'good',
      title: `最大贴图 ${metrics.maxTextureSize}px`,
      detail: '贴图尺寸合理。',
    })
  }

  if (metrics.missingUvWithTexture > 0) {
    issues.push({
      id: 'missing-uv',
      level: 'error',
      title: `${metrics.missingUvWithTexture} 个网格有贴图却没有 UV`,
      detail: '贴图无法正确映射,渲染出来会是纯色或错位。',
    })
  }

  if (metrics.missingNormal > 0) {
    issues.push({
      id: 'missing-normal',
      level: 'warn',
      title: `${metrics.missingNormal} 个网格缺少法线属性`,
      detail: '光照会不自然;可在加载时补算法线,或在导出前烘焙。',
    })
  }

  if (metrics.unindexedMeshes > 0) {
    issues.push({
      id: 'unindexed',
      level: 'info',
      title: `${metrics.unindexedMeshes} 个网格没有使用索引`,
      detail: '顶点被重复存储,索引化通常能省 20%~40% 顶点数据。',
    })
  }

  if (metrics.materials > AUDIT_THRESHOLDS.materialsWarn) {
    issues.push({
      id: 'materials',
      level: 'warn',
      title: `${metrics.materials} 种材质`,
      detail: '材质种类多会抬高绘制批次,同类材质建议合并。',
    })
  }

  if (metrics.nodes > AUDIT_THRESHOLDS.nodesWarn) {
    issues.push({
      id: 'nodes',
      level: 'info',
      title: `${metrics.nodes} 个节点`,
      detail: '层级过深或多节点会拖慢矩阵更新,必要时可合并。',
    })
  }

  return issues
}

/**
 * 对场景做一次体检。
 *
 * @param input 场景与可选的渲染器实测数据
 * @returns 评分、指标与问题清单
 */
export function auditScene(input: AuditInput): AuditReport {
  const started = performance.now()
  const metrics = collectMetrics(input.scene, input.renderInfo)
  const issues = collectIssues(metrics)

  const penalty = issues.reduce((sum, issue) => {
    if (issue.level === 'error') return sum + 18
    if (issue.level === 'warn') return sum + 7
    if (issue.level === 'info') return sum + 2
    return sum
  }, 0)

  const score = Math.max(0, Math.min(100, 100 - penalty))
  const grade: AuditReport['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D'

  return {
    score,
    grade,
    metrics,
    issues,
    durationMs: performance.now() - started,
  }
}
