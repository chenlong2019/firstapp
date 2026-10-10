/**
 * 模型体检的**评分规则**:指标 → 问题清单 → 健康度评分。
 *
 * 职责:定义指标结构、阈值表、扣分规则。纯计算,**不 import three、不碰 DOM**,因此
 *       既能被"遍历 THREE 场景"的采集器用,也能被"直读 GLB 字节"的采集器用。
 * 位置:`model-audit.ts`(场景口径)与 `glb-inspect.ts`(字节口径)都从这里取评分,保证唯一。
 * 导出:`auditFromMetrics()`、`AUDIT_THRESHOLDS`、`AuditMetrics` / `AuditReport` / `AuditIssue` / `AuditLevel`。
 *
 * 非直觉约定:
 * - 指标有两个来源(解析进内存的 THREE 场景、不解码直读的 GLB 容器),**评分只此一份**。
 *   两条路都必须经 `auditFromMetrics` 出分,否则"同一个模型换个入口看分数就不一样"。
 * - drawcall 用渲染器实测值做**展示**,但绝不参与评分:实测值随渲染设置(后处理/阴影开关、
 *   是否正在拖拽)波动,同一模型两次体检能差出十几分。评分只看模型固有指标,保证可重复
 *   —— 这也是回归脚本能锁住评分的前提。字节口径没有渲染器,`drawCalls` 恒为 0,不影响分。
 * - 纹理显存按「RGBA8 + mipmap」粗估:压缩纹理(KTX2/Draco)会被高估,但量级正确,
 *   足以支撑"是否超标"的判断。
 * - 评分为「100 减去扣分」,只做相对比较用,不是行业标准。
 */

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

  if (metrics.materials > t.materialsWarn) {
    issues.push({
      id: 'materials',
      level: 'warn',
      title: `${metrics.materials} 种材质`,
      detail: '材质种类多会抬高绘制批次,同类材质建议合并。',
    })
  }

  if (metrics.nodes > t.nodesWarn) {
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
 * 由**指标**直接产出体检报告 —— 评分与问题清单的唯一出口。
 *
 * @param metrics 已经采集好的指标
 * @param durationMs 采集耗时(调用方自己计时;不传则记 0)
 */
export function auditFromMetrics(metrics: AuditMetrics, durationMs = 0): AuditReport {
  const issues = collectIssues(metrics)

  const penalty = issues.reduce((sum, issue) => {
    if (issue.level === 'error') return sum + 18
    if (issue.level === 'warn') return sum + 7
    if (issue.level === 'info') return sum + 2
    return sum
  }, 0)

  const score = Math.max(0, Math.min(100, 100 - penalty))
  const grade: AuditReport['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D'

  return { score, grade, metrics, issues, durationMs }
}
