import * as THREE from 'three'
import { RenderPipeline, type WebGPURenderer } from 'three/webgpu'
import { pass, uniform } from 'three/tsl'
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import { outline } from 'three/examples/jsm/tsl/display/OutlineNode.js'

/** 泛光(Bloom)设置:阈值以上的亮部向四周发散光晕。 */
export interface BloomSettings {
  enabled: boolean
  /** 泛光强度 */
  strength: number
  /** 扩散半径 0~1 */
  radius: number
  /** 亮度阈值 0~1,越高只有越亮的区域参与泛光 */
  threshold: number
}

/** 后渲染描边(Outline)设置:对目标对象整体勾勒轮廓线。 */
export interface OutlineSettings {
  enabled: boolean
  /** 轮廓线粗细(像素比例) */
  thickness: number
  /** 边缘辉光/弥散强度 */
  glow: number
  /** 可见边缘颜色 */
  color: number
  /** 被模型遮挡部分的边缘颜色 */
  hiddenColor: number
}

/** 悬停描边设置:字段与选中描边一致,只是默认更细、更淡。 */
export type HoverOutlineSettings = OutlineSettings

export const DEFAULT_BLOOM_SETTINGS: BloomSettings = {
  enabled: true,
  strength: 0.7,
  radius: 0.5,
  threshold: 0.85,
}

export const DEFAULT_OUTLINE_SETTINGS: OutlineSettings = {
  enabled: true,
  thickness: 3.5,
  glow: 0.45,
  color: 0x9fe8ff,
  hiddenColor: 0x24333d,
}

/** 悬停描边默认值:青色、更细,和选中描边形成"预览 / 锁定"的层次。 */
export const DEFAULT_HOVER_OUTLINE_SETTINGS: HoverOutlineSettings = {
  enabled: true,
  thickness: 1.5,
  glow: 0.15,
  color: 0x4ad9ff,
  hiddenColor: 0x123039,
}

/**
 * 单层描边:把 OutlineNode 与它的 uniform 包在一起。
 *
 * OutlineNode 的粗细/辉光本身接受节点,但边缘颜色是内部硬编码的红/绿常量,
 * 必须在管线首次编译前把私有字段替换成 uniform,才能做到运行中调色而不重建管线。
 */
export class OutlineLayer {
  readonly node: ReturnType<typeof outline>
  enabled: boolean

  private readonly thicknessUniform = uniform(1)
  private readonly glowUniform = uniform(0)
  private readonly visibleColorUniform = uniform(new THREE.Color(0xffffff))
  private readonly hiddenColorUniform = uniform(new THREE.Color(0x000000))

  constructor(scene: THREE.Scene, camera: THREE.Camera, settings: OutlineSettings) {
    this.enabled = settings.enabled
    this.thicknessUniform.value = settings.thickness
    this.glowUniform.value = settings.glow
    this.visibleColorUniform.value.setHex(settings.color)
    this.hiddenColorUniform.value.setHex(settings.hiddenColor)

    this.node = outline(scene, camera, {
      selectedObjects: [],
      edgeThickness: this.thicknessUniform,
      edgeGlow: this.glowUniform,
    })

    const mutable = this.node as unknown as {
      _visibleEdgeColor: unknown
      _hiddenEdgeColor: unknown
    }
    mutable._visibleEdgeColor = this.visibleColorUniform
    mutable._hiddenEdgeColor = this.hiddenColorUniform
  }

  get texture() {
    return this.node.getTextureNode()
  }

  /** 更新设置;返回 enabled 是否发生变化(变化才需要重建输出节点)。 */
  update(settings: OutlineSettings): boolean {
    const enabledChanged = settings.enabled !== this.enabled
    this.enabled = settings.enabled
    this.thicknessUniform.value = settings.thickness
    this.glowUniform.value = settings.glow
    this.visibleColorUniform.value.setHex(settings.color)
    this.hiddenColorUniform.value.setHex(settings.hiddenColor)
    return enabledChanged
  }

  /**
   * 更新描边目标。OutlineNode 内部持有数组引用,
   * 必须原地修改而不是替换数组。
   */
  setObjects(objects: THREE.Object3D[]): void {
    const selection = this.node.selectedObjects
    selection.length = 0
    selection.push(...objects)
  }

  /** 目标数量(调试/测试用)。 */
  get objectCount(): number {
    return this.node.selectedObjects.length
  }

  dispose(): void {
    this.setObjects([])
    this.node.dispose()
  }
}

/**
 * 基于 TSL 节点的后处理管线(WebGPURenderer 专用,WebGL2 回退后端同样可用):
 *
 * ```
 * 场景颜色 → 选中描边合成 → 悬停描边合成 → Bloom 叠加 → 输出
 * ```
 *
 * 选中与悬停各用一层 `OutlineNode`(颜色/粗细独立),均为后渲染效果,
 * 不修改任何材质,因此与线框模式、蒙皮、动画完全兼容。
 * 渲染循环里用 `pipeline.render()` 取代 `renderer.render()`。
 */
export class PostEffects {
  readonly pipeline: RenderPipeline
  /** 选中对象描边层 */
  readonly selection: OutlineLayer
  /** 悬停对象描边层 */
  readonly hover: OutlineLayer

  private readonly sceneColor: ReturnType<ReturnType<typeof pass>['getTextureNode']>
  private readonly bloomNode: ReturnType<typeof bloom>
  private bloomEnabled = true

  constructor(
    renderer: WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    bloomSettings: BloomSettings,
    outlineSettings: OutlineSettings,
    hoverOutlineSettings: HoverOutlineSettings = DEFAULT_HOVER_OUTLINE_SETTINGS,
  ) {
    const scenePass = pass(scene, camera)
    this.sceneColor = scenePass.getTextureNode('output')

    this.bloomNode = bloom(
      this.sceneColor,
      bloomSettings.strength,
      bloomSettings.radius,
      bloomSettings.threshold,
    )
    this.bloomEnabled = bloomSettings.enabled

    this.selection = new OutlineLayer(scene, camera, outlineSettings)
    this.hover = new OutlineLayer(scene, camera, hoverOutlineSettings)

    this.pipeline = new RenderPipeline(renderer, this.compose())
  }

  /**
   * 组装输出节点:场景色 → 选中描边 → 悬停描边 → Bloom。
   * 描边纹理在非边缘处为黑色,用"场景 × (1-边缘) + 边缘"做替换式合成。
   */
  private compose() {
    const withSelection = this.selection.enabled
      ? this.sceneColor.mul(this.selection.texture.rgb.oneMinus()).add(this.selection.texture.rgb)
      : this.sceneColor
    const withHover = this.hover.enabled
      ? withSelection.mul(this.hover.texture.rgb.oneMinus()).add(this.hover.texture.rgb)
      : withSelection
    return this.bloomEnabled ? withHover.add(this.bloomNode) : withHover
  }

  /** enabled 切换需要重建输出节点;纯数值调节只改 uniform。 */
  private rebuild(): void {
    this.pipeline.outputNode = this.compose()
    this.pipeline.needsUpdate = true
  }

  setBloom(settings: BloomSettings): void {
    const enabledChanged = settings.enabled !== this.bloomEnabled
    this.bloomEnabled = settings.enabled
    this.bloomNode.strength.value = settings.strength
    this.bloomNode.radius.value = settings.radius
    this.bloomNode.threshold.value = settings.threshold
    if (enabledChanged) this.rebuild()
  }

  /** 选中对象描边设置。 */
  setOutline(settings: OutlineSettings): void {
    if (this.selection.update(settings)) this.rebuild()
  }

  /** 悬停对象描边设置。 */
  setHoverOutline(settings: HoverOutlineSettings): void {
    if (this.hover.update(settings)) this.rebuild()
  }

  /** 设置被描边(选中)的对象。 */
  setSelection(objects: THREE.Object3D[]): void {
    this.selection.setObjects(objects)
  }

  /** 设置被描边(悬停预览)的对象。 */
  setHover(objects: THREE.Object3D[]): void {
    this.hover.setObjects(objects)
  }

  dispose(): void {
    this.selection.dispose()
    this.hover.dispose()
    this.bloomNode.dispose()
    this.pipeline.dispose()
  }
}
