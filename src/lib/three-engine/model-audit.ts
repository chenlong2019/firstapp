/**
 * 模型体检的**场景采集器**:遍历一棵已加载的 THREE 场景,采集指标并交给评分规则出报告。
 *
 * 职责:把场景里的几何/材质/纹理/骨骼/动画折算成 `AuditMetrics`(`collectMetricsFromScene`),
 *       再由 `auditFromMetrics` 产出问题清单与评分。
 * 位置:供 /glb 查看器的「模型体检」面板调用。**评分规则在 `model-audit-rules.ts`** ——
 *       那边不依赖 three,`glb-inspect.ts` 的字节口径也走同一套规则。
 * 导出:`auditScene()`、`collectMetricsFromScene()`;并从 rules 再导出指标/报告类型与阈值。
 *
 * 非直觉约定:
 * - 场景口径与字节口径的差异只应体现在**采集**上,评分必须一致;回归 verify-model-batch
 *   会拿同一条模型对比两条路。规模类差异较大时优先怀疑这里的采集是否漏算了什么。
 * - 纹理按 `uuid` 去重后再统计显存 —— 同一张贴图被多个材质引用是常态,不去重会翻好几倍。
 *   (注意:同一张图的 sRGB 与非 sRGB 用法在 GLTFLoader 里会克隆成两个 Texture,这里会算两次,
 *   与字节口径一致。)
 * - 显存按「RGBA8 + mipmap」粗估,量级正确即可,见 rules 的说明。
 * - drawcall 取渲染器实测值做展示(不参与评分);字节口径没有渲染器,那边恒为 0。
 */
import * as THREE from 'three'
import { auditFromMetrics } from './model-audit-rules'
import type { AuditMetrics, AuditReport } from './model-audit-rules'

export * from './model-audit-rules'

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

/**
 * 遍历 THREE 场景采集指标(不产出评分与问题清单)。
 *
 * 单独导出是为了让调用方能把「采集」与「评分」分开做 —— 例如只想看几个原始数字、
 * 或想在采集上做交叉校验(回归里用它对比字节口径的结果)。
 */
export function collectMetricsFromScene(
  scene: THREE.Object3D,
  renderInfo?: { calls: number },
): AuditMetrics {
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
  const animationNames = new Set<string>()
  for (const clip of root.animations ?? []) {
    animationNames.add(clip.name)
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
    animations: animationNames.size,
    animationSeconds: +animationSeconds.toFixed(2),
    drawCalls: renderInfo?.calls ?? 0,
    missingUvWithTexture,
    missingNormal,
    unindexedMeshes,
    size: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
  }
}

/**
 * 对场景做一次体检。
 *
 * @param input 场景与可选的渲染器实测数据
 * @returns 评分、指标与问题清单
 */
export function auditScene(input: AuditInput): AuditReport {
  const started = performance.now()
  const metrics = collectMetricsFromScene(input.scene, input.renderInfo)
  return auditFromMetrics(metrics, performance.now() - started)
}
