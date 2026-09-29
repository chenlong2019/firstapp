import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { THREEViewer } from './three-viewer'
import {
  PostEffects,
  DEFAULT_BLOOM_SETTINGS,
  DEFAULT_OUTLINE_SETTINGS,
  DEFAULT_HOVER_OUTLINE_SETTINGS,
} from './post-effects'
import type { BloomSettings, HoverOutlineSettings, OutlineSettings } from './post-effects'
import type { WebGPURenderer } from 'three/webgpu'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/** 部件类型:仅用于模型树的图标与文案区分。 */
export type GlbNodeKind =
  'scene' | 'group' | 'mesh' | 'skinnedMesh' | 'points' | 'line' | 'light' | 'camera' | 'bone'

/** 模型树节点(纯数据,可直接被 Vue 渲染)。 */
export interface GlbTreeNode {
  id: number
  name: string
  kind: GlbNodeKind
  depth: number
  /** 子树内网格总数(含自身) */
  meshCount: number
  /** 子树内三角面总数(含自身) */
  triangles: number
  visible: boolean
  children: GlbTreeNode[]
}

export interface GlbModelStats {
  fileName: string
  nodes: number
  meshes: number
  triangles: number
  vertices: number
  materials: number
  textures: number
  animations: number
  /** 模型包围盒尺寸(场景单位) */
  size: [number, number, number]
  radius: number
}

export interface GlbNodeInfo {
  id: number
  name: string
  kind: GlbNodeKind
  path: string
  visible: boolean
  childCount: number
  meshCount: number
  triangles: number
  vertices: number
  materialNames: string[]
}

/** 光照装置强度(0 表示关闭该光源)。 */
export interface LightSettings {
  ambient: number
  key: number
  fill: number
  rim: number
  exposure: number
}

/** 选择来源:ui = 页面(模型树等)触发,pick = 3D 画布内拾取。 */
export type GlbSelectSource = 'ui' | 'pick'

export interface GlbViewOptions {
  grid: boolean
  axes: boolean
  autoRotate: boolean
  wireframe: boolean
}

export interface GlbAnimationState {
  names: string[]
  index: number
  playing: boolean
  duration: number
  speed: number
}

export interface GlbLoadStatus {
  state: 'idle' | 'loading' | 'ready' | 'error'
  fileName: string
  /** 0~1;资源未返回 content-length 时为 null */
  progress: number | null
  message: string
}

/** 选中部件导出结果。 */
export interface GlbExportResult {
  fileName: string
  bytes: number
}

export const DEFAULT_LIGHT_SETTINGS: LightSettings = {
  ambient: 1.6,
  key: 2.2,
  fill: 0.7,
  rim: 0.9,
  exposure: 1,
}

const AMBIENT_LIGHT_MAX = 4
const DIRECTIONAL_LIGHT_MAX = 6

const WIREFRAME_COLOR = 0x9fe8ff

/** 点击判定:位移与时长阈值(超过则视为拖拽旋转视角,不触发选中)。 */
const CLICK_MAX_DISTANCE_PX = 5
const CLICK_MAX_DURATION_MS = 600

function toMaterialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  if (Array.isArray(material)) return material
  return [material]
}

function kindOf(object: THREE.Object3D): GlbNodeKind {
  const candidate = object as THREE.Object3D & {
    isMesh?: boolean
    isSkinnedMesh?: boolean
    isPoints?: boolean
    isLine?: boolean
    isLight?: boolean
    isCamera?: boolean
    isBone?: boolean
  }
  if (candidate.isSkinnedMesh) return 'skinnedMesh'
  if (candidate.isMesh) return 'mesh'
  if (candidate.isPoints) return 'points'
  if (candidate.isLine) return 'line'
  if (candidate.isLight) return 'light'
  if (candidate.isCamera) return 'camera'
  if (candidate.isBone) return 'bone'
  return object.children.length > 0 ? 'group' : 'scene'
}

function countTriangles(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex()
  if (index) return Math.floor(index.count / 3)
  const position = geometry.getAttribute('position')
  if (!position) return 0
  return Math.floor(position.count / 3)
}

/**
 * GLB 查看器:导入 GLB → 浏览模型树 → 高亮部件 → 调整光照。
 * 场景基础设施(渲染器 / 相机 / 控制器)复用 THREEViewer,便于与 DJI 页面保持一致。
 */
export class GlbViewer {
  camera: THREE.PerspectiveCamera | null = null
  scene: THREE.Scene<THREE.Object3DEventMap> | null = null
  renderer: WebGPURenderer | null = null
  controls: OrbitControls<THREE.Camera> | null = null
  floor: THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.MeshStandardMaterial,
    THREE.Object3DEventMap
  > | null = null

  /** 回调:选中项变化;source 区分来源(3D 画布拾取 / 外部 UI),供页面决定是否定位模型树。 */
  onSelect: ((id: number | null, source: GlbSelectSource) => void) | null = null
  /** 回调:悬停项变化(3D 中鼠标划过部件),供页面同步模型树悬停态。 */
  onHover: ((id: number | null) => void) | null = null
  /** 回调:加载状态变化。 */
  onStatus: ((status: GlbLoadStatus) => void) | null = null

  private container: HTMLElement
  private baseViewer: THREEViewer | null = null
  private frame = 0
  private previousFrameTime = 0
  private destroyed = false

  // —— 光照装置 ——
  private ambientLight: THREE.HemisphereLight | null = null
  private keyLight: THREE.DirectionalLight | null = null
  private fillLight: THREE.DirectionalLight | null = null
  private rimLight: THREE.DirectionalLight | null = null
  private lightSettings: LightSettings = { ...DEFAULT_LIGHT_SETTINGS }

  // —— 场景辅助物 ——
  private grid: THREE.GridHelper | null = null

  // —— 后处理(泛光 + 选中/悬停描边) ——
  private postEffects: PostEffects | null = null
  private bloomSettings: BloomSettings = { ...DEFAULT_BLOOM_SETTINGS }
  private outlineSettings: OutlineSettings = { ...DEFAULT_OUTLINE_SETTINGS }
  private hoverOutlineSettings: HoverOutlineSettings = { ...DEFAULT_HOVER_OUTLINE_SETTINGS }

  // —— 模型与结构 ——
  private model: THREE.Object3D | null = null
  private fileName = ''
  private tree: GlbTreeNode[] = []
  private treeIndex = new Map<number, GlbTreeNode>()
  private nodeById = new Map<number, THREE.Object3D>()
  private idByObject = new WeakMap<THREE.Object3D, number>()
  private nextId = 0
  private stats: GlbModelStats | null = null

  // —— 高亮状态(选中与悬停都走后渲染描边,不修改材质) ——
  private selectedId: number | null = null
  private hoverId: number | null = null
  /** 网格的原始材质(线框切换后据此恢复)。 */
  private baseMaterialByMesh = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>()
  private wireframeMaterial: THREE.MeshBasicMaterial | null = null

  // —— 视图选项 ——
  private viewOptions: GlbViewOptions = {
    grid: true,
    axes: true,
    autoRotate: false,
    wireframe: false,
  }

  // —— 动画 ——
  private mixer: THREE.AnimationMixer | null = null
  private clips: THREE.AnimationClip[] = []
  private activeAction: THREE.AnimationAction | null = null
  private animationIndex = -1
  private animationPlaying = false
  private animationSpeed = 1

  // —— 爆炸图 ——
  private explodeParts: Array<{
    object: THREE.Object3D
    originalPosition: THREE.Vector3
    originalWorldCenter: THREE.Vector3
    direction: THREE.Vector3
  }> = []
  private explodeAmount = 0
  private explodeMaxOffset = 0

  // —— 交互 ——
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private pointerInside = false
  private frameParity = 0
  private pointerDown: { x: number; y: number; time: number } | null = null
  private readonly handlePointerDown = (event: PointerEvent): void => this.onPointerDown(event)
  private readonly handlePointerMove = (event: PointerEvent): void => this.onPointerMove(event)
  private readonly handlePointerUp = (event: PointerEvent): void => this.onPointerUp(event)
  private readonly handlePointerLeave = (): void => {
    this.pointerInside = false
    this.setHover(null)
  }
  private readonly handleDoubleClick = (event: MouseEvent): void => this.onDoubleClick(event)
  private readonly handleResize = (): void => this.onResize()

  constructor(container: HTMLElement) {
    this.container = container
  }

  async init(): Promise<void> {
    this.baseViewer = new THREEViewer(this.container)
    await this.baseViewer.initialize()
    if (this.destroyed) return

    const { camera, scene, renderer, controls, floor } = this.baseViewer.getObject()
    this.camera = camera
    this.scene = scene
    this.renderer = renderer
    this.controls = controls
    this.floor = floor
    if (this.controls) this.controls.autoRotateSpeed = 1.4

    this.spotExistingLights()
    this.createLights()
    this.createHelpers()
    this.createPostEffects()
    this.bindPointerEvents()
    this.applyLightSettings()
    window.addEventListener('resize', this.handleResize)
    this.startLoop()

    if (import.meta.env.DEV) {
      ;(
        window as unknown as {
          __glbDebug?: { viewer: GlbViewer; THREE: typeof THREE; postEffects: PostEffects | null }
        }
      ).__glbDebug = { viewer: this, THREE, postEffects: this.postEffects }
    }
  }

  // ————————————————————————————— 场景构建 —————————————————————————————

  /** THREEViewer 已创建了半球光与主平行光,这里取回引用以便调节强度。 */
  private spotExistingLights(): void {
    this.scene?.traverse((object) => {
      if ((object as THREE.HemisphereLight).isHemisphereLight) {
        this.ambientLight = object as THREE.HemisphereLight
      } else if ((object as THREE.DirectionalLight).isDirectionalLight) {
        this.keyLight = object as THREE.DirectionalLight
      }
    })
  }

  /** 在基础光照上补一盏侧补光和一盏轮廓光,构成可调的三点布光。 */
  private createLights(): void {
    if (!this.scene) return
    this.fillLight = new THREE.DirectionalLight('#cfe6ff', this.lightSettings.fill)
    this.fillLight.position.set(-6, 3, 5)
    this.scene.add(this.fillLight)

    this.rimLight = new THREE.DirectionalLight('#ffffff', this.lightSettings.rim)
    this.rimLight.position.set(-1, 5, -8)
    this.scene.add(this.rimLight)
  }

  private createHelpers(): void {
    if (!this.scene) return
    // 单位网格:缩放后适配任意尺度模型(见 fitEnvironment)
    this.grid = new THREE.GridHelper(10, 20, 0x3d6b6f, 0x1f3a3e)
    const gridMaterial = this.grid.material as THREE.Material | THREE.Material[]
    toMaterialList(gridMaterial).forEach((material) => {
      material.transparent = true
      material.opacity = 0.55
    })
    this.grid.position.y = 0.001
    this.scene.add(this.grid)

    // 线框模式使用独立共享材质:WebGPU 的 WebGL2 回退后端不支持运行中切换 wireframe
    // (glDrawElements 报无效枚举,网格会消失),因此整体换材质而不是改 wireframe 属性
    this.wireframeMaterial = new THREE.MeshBasicMaterial({
      color: WIREFRAME_COLOR,
      wireframe: true,
      toneMapped: false,
    })
  }

  /**
   * 搭建后处理管线:场景 → 选中描边 → 悬停描边(OutlineNode)→ Bloom → 输出。
   * 环境不支持时降级为直接渲染(此时选中/悬停只在模型树上体现)。
   */
  private createPostEffects(): void {
    if (!this.renderer || !this.scene || !this.camera) return
    try {
      this.postEffects = new PostEffects(
        this.renderer,
        this.scene,
        this.camera,
        this.bloomSettings,
        this.outlineSettings,
        this.hoverOutlineSettings,
      )
    } catch (error) {
      console.warn('[GlbViewer] 后处理管线初始化失败,已降级为直接渲染:', error)
      this.postEffects = null
    }
  }

  private bindPointerEvents(): void {
    const element = this.renderer?.domElement
    if (!element) return
    element.addEventListener('pointerdown', this.handlePointerDown)
    element.addEventListener('pointermove', this.handlePointerMove)
    element.addEventListener('pointerup', this.handlePointerUp)
    element.addEventListener('pointerleave', this.handlePointerLeave)
    element.addEventListener('dblclick', this.handleDoubleClick)
  }

  // ————————————————————————————— 模型加载 —————————————————————————————

  private createLoader(): GLTFLoader {
    const loader = new GLTFLoader()
    // Draco / meshopt 压缩模型需要对应解码器,否则解析直接失败
    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('/draco/')
    loader.setDRACOLoader(dracoLoader)
    loader.setMeshoptDecoder(MeshoptDecoder)
    return loader
  }

  /** 从 URL 载入 GLB(示例模型走这条路径)。 */
  async loadFromUrl(url: string, fileName?: string): Promise<void> {
    const displayName = fileName ?? url.split('/').pop() ?? url
    this.emitStatus('loading', displayName, 0)
    try {
      const gltf = await this.createLoader().loadAsync(url, (event) => {
        const total = event.total || 0
        this.emitStatus('loading', displayName, total > 0 ? event.loaded / total : null)
      })
      await this.mount(gltf, displayName)
      this.emitStatus('ready', displayName, 1)
    } catch (error) {
      this.emitError(displayName, error)
    }
  }

  /** 从本地文件载入 GLB(拖拽或文件选择)。 */
  async loadFromFile(file: File): Promise<void> {
    this.emitStatus('loading', file.name, 0)
    const objectUrl = URL.createObjectURL(file)
    try {
      const gltf = await this.createLoader().loadAsync(objectUrl)
      await this.mount(gltf, file.name)
      this.emitStatus('ready', file.name, 1)
    } catch (error) {
      this.emitError(file.name, error)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  private emitStatus(
    state: GlbLoadStatus['state'],
    fileName: string,
    progress: number | null,
  ): void {
    this.onStatus?.({
      state,
      fileName,
      progress: state === 'ready' ? 1 : progress,
      message: state === 'loading' ? '正在解析模型…' : '',
    })
  }

  private emitError(fileName: string, error: unknown): void {
    const raw = error instanceof Error ? error.message : String(error)
    const message = /draco|meshopt|ktx/i.test(raw)
      ? `解析失败:模型使用了压缩扩展,请确认解码器可用(${raw})`
      : `解析失败:${raw}`
    this.onStatus?.({ state: 'error', fileName, progress: null, message })
  }

  /** 挂载新模型:清旧资源 → 归一化 → 建树 → 适配相机与环境。 */
  private async mount(
    gltf: { scene: THREE.Object3D; animations: THREE.AnimationClip[] },
    fileName: string,
  ): Promise<void> {
    if (!this.scene || this.destroyed) return
    this.clearHighlight()
    this.disposeModel()

    const root = gltf.scene
    root.name = root.name || fileName.replace(/\.(glb|gltf)$/i, '')
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.isMesh || (object as THREE.SkinnedMesh).isSkinnedMesh) {
        object.castShadow = true
        object.receiveShadow = true
        this.baseMaterialByMesh.set(mesh, mesh.material)
      }
    })

    this.scene.add(root)
    this.model = root
    this.fileName = fileName

    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root)
    this.fitEnvironment(box)
    this.buildTree()
    this.collectStats(gltf.animations.length)
    this.setupExplodeParts()
    this.setupAnimations(gltf.animations)
    this.fitCameraToBox(box)
  }

  /** 让地面/网格/坐标轴贴合模型尺度与位置(模型坐标系任意,不能假定原点在地面)。 */
  private fitEnvironment(box: THREE.Box3): void {
    const size = box.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z, size.y, 0.001)
    const baseSize = span / 8 // 单位尺寸 → 场景尺寸
    const groundY = Number.isFinite(box.min.y) ? box.min.y : 0

    if (this.floor) {
      this.floor.scale.setScalar(baseSize / 2)
      this.floor.position.y = groundY - 0.002
    }
    if (this.grid) {
      this.grid.scale.setScalar(baseSize)
      this.grid.position.y = groundY
    }
    const axes = this.baseViewer?.getObject().axes
    if (axes) axes.position.y = groundY + 0.004
  }

  // ————————————————————————————— 模型树 —————————————————————————————

  private buildTree(): void {
    this.tree = []
    this.treeIndex.clear()
    this.nodeById.clear()
    this.idByObject = new WeakMap()
    this.nextId = 0
    if (this.model) this.tree = [this.createTreeNode(this.model, 0)]
  }

  private createTreeNode(object: THREE.Object3D, depth: number): GlbTreeNode {
    const id = this.nextId++
    this.nodeById.set(id, object)
    this.idByObject.set(object, id)

    const mesh = object as THREE.Mesh
    const geometry = mesh.geometry
    const isMeshLike = Boolean(mesh.isMesh || (object as THREE.SkinnedMesh).isSkinnedMesh)
    let triangles = 0
    if (isMeshLike && geometry) triangles = countTriangles(geometry)

    const children = object.children.map((child) => this.createTreeNode(child, depth + 1))
    const node: GlbTreeNode = {
      id,
      name: object.name || `${kindOf(object)}#${id}`,
      kind: kindOf(object),
      depth,
      meshCount: (isMeshLike ? 1 : 0) + children.reduce((sum, child) => sum + child.meshCount, 0),
      triangles: triangles + children.reduce((sum, child) => sum + child.triangles, 0),
      visible: object.visible,
      children,
    }
    this.treeIndex.set(id, node)
    return node
  }

  private collectStats(animationCount: number): void {
    if (!this.model) return
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    let nodes = 0
    let meshes = 0
    let triangles = 0
    let vertices = 0

    this.model.traverse((object) => {
      nodes += 1
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh) return
      meshes += 1
      const geometry = mesh.geometry
      if (geometry) {
        triangles += countTriangles(geometry)
        const position = geometry.getAttribute('position')
        if (position) vertices += position.count
      }
      const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      meshMaterials.forEach((material) => {
        if (!material) return
        materials.add(material)
        Object.values(material as unknown as Record<string, unknown>).forEach((value) => {
          if (value instanceof THREE.Texture) textures.add(value)
        })
      })
    })

    const box = new THREE.Box3().setFromObject(this.model)
    const size = box.getSize(new THREE.Vector3())
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    this.stats = {
      fileName: this.fileName,
      nodes,
      meshes,
      triangles,
      vertices,
      materials: materials.size,
      textures: textures.size,
      animations: animationCount,
      size: [size.x, size.y, size.z],
      radius: sphere.radius,
    }
  }

  // ————————————————————————————— 需要对外暴露的读取接口 —————————————————————————————

  getTree(): GlbTreeNode[] {
    return this.tree
  }

  getStats(): GlbModelStats | null {
    return this.stats
  }

  getLightSettings(): LightSettings {
    return { ...this.lightSettings }
  }

  getViewOptions(): GlbViewOptions {
    return { ...this.viewOptions }
  }

  getFps(): number {
    return this.fps
  }

  getAnimationState(): GlbAnimationState {
    return {
      names: this.clips.map((clip) => clip.name || '未命名动画'),
      index: this.animationIndex,
      playing: this.animationPlaying,
      duration: this.activeAction?.getClip().duration ?? 0,
      speed: this.animationSpeed,
    }
  }

  isHoveringModel(): boolean {
    return this.hoverId !== null
  }

  /** 当前选中节点 id(未选中为 null)。 */
  getSelectedId(): number | null {
    return this.selectedId
  }

  /** 当前悬停节点 id(未悬停为 null)。 */
  getHoverId(): number | null {
    return this.hoverId
  }

  getNodeInfo(id: number | null): GlbNodeInfo | null {
    if (id === null) return null
    const node = this.treeIndex.get(id)
    const object = this.nodeById.get(id)
    if (!node || !object) return null

    const materials = new Set<string>()
    let vertices = 0
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh && !(child as THREE.SkinnedMesh).isSkinnedMesh) return
      const geometry = mesh.geometry
      const position = geometry?.getAttribute('position')
      if (position) vertices += position.count
      toMaterialList(mesh.material).forEach((material) => {
        if (material?.name) materials.add(material.name)
      })
    })

    return {
      id,
      name: node.name,
      kind: node.kind,
      path: this.getNodePath(id),
      visible: object.visible,
      childCount: object.children.length,
      meshCount: node.meshCount,
      triangles: node.triangles,
      vertices,
      materialNames: [...materials].slice(0, 12),
    }
  }

  private getNodePath(id: number): string {
    const object = this.nodeById.get(id)
    if (!object) return ''
    const segments: string[] = []
    let current: THREE.Object3D | null = object
    while (current) {
      const currentId = this.idByObject.get(current)
      const node = currentId === undefined ? null : this.treeIndex.get(currentId)
      segments.unshift(node?.name ?? current.name ?? current.type)
      current = current.parent
      if (current === this.model?.parent) break
    }
    return segments.join(' / ')
  }

  // ————————————————————————————— 导出 —————————————————————————————

  /**
   * 把当前选中节点(含整个子树)导出为 GLB 文件并触发浏览器下载。
   * - 材质一律使用原始基材质:线框模式下也不会把共享线框材质写进文件
   * - 世界变换烘焙到导出根节点,部件在导出文件中的位置与查看器中一致
   * 返回导出信息;未选中部件或导出失败返回 null(失败原因打印到控制台)。
   */
  async exportSelected(): Promise<GlbExportResult | null> {
    const object = this.selectedId === null ? null : this.nodeById.get(this.selectedId)
    if (!object) return null

    // 克隆体与原模型共享材质引用:线框模式下先把基材质装回原模型再克隆,
    // 克隆完立刻恢复线框(同步执行,渲染循环不会插进来,画面无闪烁)
    const wasWireframe = this.viewOptions.wireframe
    if (wasWireframe) this.applyBaseMaterials()
    const clone = object.clone(true)
    if (wasWireframe) this.refreshModelMaterials()

    // 把世界变换烘焙到克隆根节点:Object3D.clone 保留的是相对父级的局部变换
    object.updateWorldMatrix(true, false)
    clone.matrix.copy(object.matrixWorld)
    clone.matrix.decompose(clone.position, clone.quaternion, clone.scale)

    try {
      const exporter = new GLTFExporter()
      // onlyVisible:false —— 显隐只是查看状态,导出必须完整包含子树,
      // 否则勾掉几个部件再导出会静默丢内容(GLTFExporter 默认只导可见节点)
      const glb = await exporter.parseAsync(clone, { binary: true, onlyVisible: false })
      const blob = new Blob([glb as ArrayBuffer], { type: 'model/gltf-binary' })
      const safeName = (object.name || 'part').replace(/[\\/:*?"<>|]/g, '_')
      const fileName = `${safeName}.glb`
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 5000)
      return { fileName, bytes: blob.size }
    } catch (error) {
      console.warn('[GlbViewer] 导出选中部件失败:', error)
      return null
    }
  }

  /** 把全部网格恢复为基材质(导出前用,避免线框材质被克隆进导出文件)。 */
  private applyBaseMaterials(): void {
    this.model?.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh) return
      const base = this.baseMaterialByMesh.get(mesh)
      if (base) mesh.material = base
    })
  }

  // ————————————————————————————— 高亮 —————————————————————————————

  /**
   * 选中部件并高亮:通过后处理 OutlineNode 对整个节点做后渲染描边,
   * 不修改任何材质,因此与线框模式/动画/蒙皮完全兼容。
   */
  select(id: number | null, options: { focus?: boolean; source?: GlbSelectSource } = {}): void {
    const source = options.source ?? 'ui'
    if (id !== null && !this.nodeById.has(id)) return
    if (this.selectedId === id) {
      if (id !== null && options.focus) this.focusNode(id)
      // 即使选中项没变,也要把来源抛出去,页面才能对"再次点中的部件"重新定位
      this.onSelect?.(id, source)
      return
    }

    this.selectedId = id
    this.syncOutlineTargets()
    if (id !== null && options.focus) this.focusNode(id)
    this.onSelect?.(id, source)
  }

  /**
   * 把当前选中/悬停节点同步给后处理描边层。
   * 悬停对象若正好是被选中的对象则不再描边,避免两层轮廓线叠在一起发花。
   */
  private syncOutlineTargets(): void {
    if (!this.postEffects) return
    const selected = this.selectedId === null ? null : (this.nodeById.get(this.selectedId) ?? null)
    const hovered =
      this.hoverId === null || this.hoverId === this.selectedId
        ? null
        : (this.nodeById.get(this.hoverId) ?? null)
    this.postEffects.setSelection(selected ? [selected] : [])
    this.postEffects.setHover(hovered ? [hovered] : [])
  }

  private clearHighlight(): void {
    this.selectedId = null
    this.hoverId = null
    this.syncOutlineTargets()
  }

  /** 外部(模型树行悬停)驱动的悬停提示,与 3D 内鼠标划过共用同一套描边逻辑。 */
  hover(id: number | null): void {
    this.setHover(id)
  }

  private setHover(id: number | null): void {
    if (this.hoverId === id) return
    this.hoverId = id
    this.syncOutlineTargets()
    const element = this.renderer?.domElement
    if (element) element.style.cursor = id !== null ? 'pointer' : 'default'
    this.onHover?.(id)
  }

  // ————————————————————————————— 拾取 —————————————————————————————

  private onPointerDown(event: PointerEvent): void {
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() }
  }

  private onPointerMove(event: PointerEvent): void {
    this.pointerInside = true
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )
  }

  private onPointerUp(event: PointerEvent): void {
    const down = this.pointerDown
    this.pointerDown = null
    if (!down) return
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y)
    if (moved > CLICK_MAX_DISTANCE_PX || performance.now() - down.time > CLICK_MAX_DURATION_MS)
      return

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )
    const hit = this.pick()
    if (!hit) {
      this.select(null, { source: 'pick' })
      return
    }
    const id = this.idByObject.get(hit.object)
    if (id !== undefined) this.select(id, { source: 'pick' })
  }

  private onDoubleClick(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )
    const hit = this.pick()
    if (!hit) return
    const id = this.idByObject.get(hit.object)
    if (id !== undefined) {
      this.select(id, { focus: true, source: 'pick' })
    }
  }

  /** 射线拾取模型最近的可交互网格(隐藏部件不可拾取)。 */
  private pick(): THREE.Intersection<THREE.Object3D> | null {
    if (!this.model || !this.camera) return null
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObject(this.model, true)
    for (const hit of hits) {
      if (this.isPickable(hit.object)) return hit
    }
    return null
  }

  private isPickable(object: THREE.Object3D): boolean {
    let current: THREE.Object3D | null = object
    while (current) {
      if (!current.visible) return false
      if (current === this.model) return true
      current = current.parent
    }
    return true
  }

  private updateHover(): void {
    // 指针不在画布上时不干预:悬停态由 pointerleave 与模型树 hover() 共同管理
    if (!this.pointerInside || !this.model) return
    this.frameParity = (this.frameParity + 1) % 2
    if (this.frameParity !== 0) return // 隔帧检测,避免大模型指针移动时开销过高
    const hit = this.pick()
    const id = hit ? (this.idByObject.get(hit.object) ?? null) : null
    this.setHover(id)
  }

  // ————————————————————————————— 视角 / 视图选项 —————————————————————————————

  /** 把相机放到能完整看到目标的位置。 */
  focusNode(id: number | null): void {
    const object = id === null ? this.model : (this.nodeById.get(id) ?? null)
    if (!object) return
    object.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(object)
    if (box.isEmpty()) return
    this.fitCameraToBox(box, 1.7)
  }

  resetView(): void {
    if (!this.model) return
    const box = new THREE.Box3().setFromObject(this.model)
    this.fitCameraToBox(box, 1.6)
  }

  private fitCameraToBox(box: THREE.Box3, factor = 1.6): void {
    if (!this.camera || !this.controls) return
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    const radius = Math.max(sphere.radius, 0.0005)
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5)
    const distance = (radius * factor) / Math.sin(halfFov)
    const direction = new THREE.Vector3(1, 0.72, 1).normalize()

    this.controls.target.copy(sphere.center)
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance)
    this.camera.near = Math.max(distance / 600, 0.0005)
    this.camera.far = Math.max(distance * 12, 200)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  setGridVisible(visible: boolean): void {
    this.viewOptions.grid = visible
    if (this.grid) this.grid.visible = visible
  }

  setAxesVisible(visible: boolean): void {
    this.viewOptions.axes = visible
    const axes = this.baseViewer?.getObject().axes
    if (axes) axes.visible = visible
  }

  setAutoRotate(enabled: boolean): void {
    this.viewOptions.autoRotate = enabled
    if (this.controls) this.controls.autoRotate = enabled
  }

  /** 线框模式:整体切换到共享线框材质( textures 暂时隐藏,便于观察拓扑)。 */
  setWireframe(enabled: boolean): void {
    if (this.viewOptions.wireframe === enabled) return
    this.viewOptions.wireframe = enabled
    // 选中/悬停描边走后处理、不受材质影响,无需清除;这里只重排网格材质
    this.refreshModelMaterials()
  }

  /** 依据线框模式重排全部网格材质。 */
  private refreshModelMaterials(): void {
    if (!this.model) return
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh) return
      if (this.viewOptions.wireframe && this.wireframeMaterial) {
        mesh.material = this.wireframeMaterial
        return
      }
      const base = this.baseMaterialByMesh.get(mesh)
      if (base) mesh.material = base
    })
  }

  /**
   * 只改这一个节点自己的 visible 开关。子树跟随父级一起不可见是 three.js 的固有行为,
   * 这里不做递归改写,各个部件的开关状态才能被独立保留下来(父级重新勾上时原样恢复)。
   */
  setNodeVisible(id: number, visible: boolean): void {
    const object = this.nodeById.get(id)
    if (!object) return
    object.visible = visible
    const node = this.treeIndex.get(id)
    if (node) node.visible = visible
    if (!visible) this.dropInvisibleHighlight()
  }

  /** 隐藏之后,落在整棵子树里的选中/悬停都不再可见,清掉以免描边挂在看不见的部件上。 */
  private dropInvisibleHighlight(): void {
    const stale = (id: number | null): boolean => {
      if (id === null) return false
      const object = this.nodeById.get(id)
      return object !== undefined && !this.isPickable(object)
    }
    if (stale(this.selectedId)) this.select(null)
    if (stale(this.hoverId)) this.setHover(null)
  }

  // ————————————————————————————— 爆炸图 —————————————————————————————

  /**
   * 载入模型后采集爆炸单元:以模型根节点直接子级为单位(只有一个子级时下钻一层),
   * 记录每个单元的静止位置与"单元中心 → 模型中心"方向。蒙皮网格会破坏骨骼绑定,不参与。
   */
  private setupExplodeParts(): void {
    this.explodeParts = []
    this.explodeAmount = 0
    this.explodeMaxOffset = 0
    if (!this.model) return

    let parts = [...this.model.children]
    if (parts.length <= 1) parts = parts.flatMap((child) => [...child.children])
    parts = parts.filter((part) => !this.containsSkinnedMesh(part))
    if (parts.length <= 1) return

    this.model.updateMatrixWorld(true)
    const modelBox = new THREE.Box3().setFromObject(this.model)
    const modelCenter = modelBox.getCenter(new THREE.Vector3())
    const radius = modelBox.getBoundingSphere(new THREE.Sphere()).radius
    this.explodeMaxOffset = radius * 0.9

    parts.forEach((part) => {
      const box = new THREE.Box3().setFromObject(part)
      if (box.isEmpty()) return
      const center = box.getCenter(new THREE.Vector3())
      const direction = center.clone().sub(modelCenter)
      // 与模型中心重合的单元没有确定的外扩方向,跳过
      if (direction.lengthSq() < 1e-10) return
      direction.normalize()
      this.explodeParts.push({
        object: part,
        originalPosition: part.position.clone(),
        originalWorldCenter: center,
        direction,
      })
    })
  }

  private containsSkinnedMesh(object: THREE.Object3D): boolean {
    let found = false
    object.traverse((child) => {
      if ((child as THREE.SkinnedMesh).isSkinnedMesh || (child as THREE.Bone).isBone) found = true
    })
    return found
  }

  /** 设置爆炸程度(0=合体,1=完全炸开),各单元沿自身中心相对模型中心的方向外扩。 */
  setExplode(amount: number): void {
    const clamped = THREE.MathUtils.clamp(amount, 0, 1)
    this.explodeAmount = clamped
    if (!this.model) return
    this.model.updateMatrixWorld(true)
    this.explodeParts.forEach((part) => {
      const parent = part.object.parent
      if (!parent) return
      if (clamped === 0) {
        part.object.position.copy(part.originalPosition)
        return
      }
      // 目标世界坐标 = 静止世界中心 + 方向 × 偏移;再换算回父级局部坐标写 position
      const worldTarget = part.originalWorldCenter
        .clone()
        .addScaledVector(part.direction, clamped * this.explodeMaxOffset)
      parent.updateWorldMatrix(true, false)
      part.object.position.copy(parent.worldToLocal(worldTarget))
    })
  }

  /** 当前爆炸程度(0~1)。 */
  getExplodeAmount(): number {
    return this.explodeAmount
  }

  /** 模型是否支持爆炸图(可拆单元 ≥ 2)。 */
  isExplodeAvailable(): boolean {
    return this.explodeParts.length >= 2
  }

  // ————————————————————————————— 光照 —————————————————————————————

  setLightSettings(partial: Partial<LightSettings>): void {
    this.lightSettings = { ...this.lightSettings, ...partial }
    this.applyLightSettings()
  }

  resetLightSettings(): LightSettings {
    this.lightSettings = { ...DEFAULT_LIGHT_SETTINGS }
    this.applyLightSettings()
    return this.getLightSettings()
  }

  private applyLightSettings(): void {
    const { ambient, key, fill, rim, exposure } = this.lightSettings
    if (this.ambientLight) this.ambientLight.intensity = ambient
    if (this.keyLight) {
      this.keyLight.intensity = key
      this.keyLight.visible = key > 0
    }
    if (this.fillLight) {
      this.fillLight.intensity = fill
      this.fillLight.visible = fill > 0
    }
    if (this.rimLight) {
      this.rimLight.intensity = rim
      this.rimLight.visible = rim > 0
    }
    if (this.renderer) this.renderer.toneMappingExposure = exposure
  }

  getLightLimits(): { ambientMax: number; directionalMax: number } {
    return { ambientMax: AMBIENT_LIGHT_MAX, directionalMax: DIRECTIONAL_LIGHT_MAX }
  }

  // ————————————————————————————— 后处理 —————————————————————————————

  getBloomSettings(): BloomSettings {
    return { ...this.bloomSettings }
  }

  getOutlineSettings(): OutlineSettings {
    return { ...this.outlineSettings }
  }

  getHoverOutlineSettings(): HoverOutlineSettings {
    return { ...this.hoverOutlineSettings }
  }

  setBloomSettings(partial: Partial<BloomSettings>): void {
    this.bloomSettings = { ...this.bloomSettings, ...partial }
    this.postEffects?.setBloom(this.bloomSettings)
  }

  setOutlineSettings(partial: Partial<OutlineSettings>): void {
    this.outlineSettings = { ...this.outlineSettings, ...partial }
    this.postEffects?.setOutline(this.outlineSettings)
  }

  setHoverOutlineSettings(partial: Partial<HoverOutlineSettings>): void {
    this.hoverOutlineSettings = { ...this.hoverOutlineSettings, ...partial }
    this.postEffects?.setHoverOutline(this.hoverOutlineSettings)
  }

  resetPostFxSettings(): {
    bloom: BloomSettings
    outline: OutlineSettings
    hoverOutline: HoverOutlineSettings
  } {
    this.bloomSettings = { ...DEFAULT_BLOOM_SETTINGS }
    this.outlineSettings = { ...DEFAULT_OUTLINE_SETTINGS }
    this.hoverOutlineSettings = { ...DEFAULT_HOVER_OUTLINE_SETTINGS }
    this.postEffects?.setBloom(this.bloomSettings)
    this.postEffects?.setOutline(this.outlineSettings)
    this.postEffects?.setHoverOutline(this.hoverOutlineSettings)
    return {
      bloom: { ...this.bloomSettings },
      outline: { ...this.outlineSettings },
      hoverOutline: { ...this.hoverOutlineSettings },
    }
  }

  // ————————————————————————————— 动画 —————————————————————————————

  private setupAnimations(clips: THREE.AnimationClip[]): void {
    this.clips = clips
    this.animationIndex = -1
    this.animationPlaying = false
    this.activeAction = null
    if (this.mixer) this.mixer.stopAllAction()
    this.mixer = clips.length > 0 && this.model ? new THREE.AnimationMixer(this.model) : null
    if (clips.length > 0) this.playAnimation(0)
  }

  playAnimation(index: number): void {
    if (!this.mixer || !this.clips[index]) return
    const action = this.mixer.clipAction(this.clips[index])
    this.activeAction?.stop()
    action.reset()
    action.paused = false
    action.play()
    this.activeAction = action
    this.animationIndex = index
    this.animationPlaying = true
  }

  setAnimationPlaying(playing: boolean): void {
    if (!this.activeAction) return
    this.animationPlaying = playing
    this.activeAction.paused = !playing
  }

  setAnimationSpeed(speed: number): void {
    this.animationSpeed = speed
    if (this.activeAction) this.activeAction.setEffectiveTimeScale(speed)
  }

  // ————————————————————————————— 主循环 —————————————————————————————

  private startLoop(): void {
    const render = (timestamp: number): void => {
      this.frame = window.requestAnimationFrame(render)
      this.updateFps(timestamp)
      const delta = this.previousFrameTime
        ? Math.min((timestamp - this.previousFrameTime) / 1000, 0.1)
        : 1 / 60
      this.previousFrameTime = timestamp

      this.updateHover()
      if (this.mixer && this.animationPlaying) this.mixer.update(delta)
      this.controls?.update()
      if (!this.scene || !this.camera) return
      if (this.postEffects) this.postEffects.pipeline.render()
      else this.renderer?.render(this.scene, this.camera)
    }
    this.animationStart = performance.now()
    this.frame = window.requestAnimationFrame(render)
  }

  private fps = 0
  private fpsFrames = 0
  private animationStart = 0

  private updateFps(timestamp: number): void {
    this.fpsFrames += 1
    const elapsed = timestamp - this.animationStart
    if (elapsed < 500) return
    this.fps = Math.round((this.fpsFrames * 1000) / elapsed)
    this.fpsFrames = 0
    this.animationStart = timestamp
  }

  private onResize(): void {
    if (!this.camera || !this.renderer) return
    const width = this.container.clientWidth
    const height = Math.max(this.container.clientHeight, 1)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  // ————————————————————————————— 释放 —————————————————————————————

  private disposeModel(): void {
    if (!this.model) return
    const materials = new Set<THREE.Material>()
    const textures = new Set<THREE.Texture>()
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      // 线框模式下网格挂的是共享材质,基材质要从记录里取,避免误释放共享材质/漏释放基材质
      const materialSource = this.baseMaterialByMesh.get(mesh) ?? mesh.material
      toMaterialList(materialSource ?? []).forEach((material) => {
        if (!material) return
        materials.add(material)
        Object.values(material as unknown as Record<string, unknown>).forEach((value) => {
          if (value instanceof THREE.Texture) textures.add(value)
        })
      })
    })
    materials.forEach((material) => material.dispose())
    textures.forEach((texture) => texture.dispose())
    this.scene?.remove(this.model)
    this.model = null
    this.mixer = null
    this.clips = []
    this.activeAction = null
    this.explodeParts = []
    this.explodeAmount = 0
    this.stats = null
    this.tree = []
    this.treeIndex.clear()
    this.nodeById.clear()
    this.idByObject = new WeakMap()
    this.clearHighlight()
  }

  destroy(): void {
    this.destroyed = true
    window.cancelAnimationFrame(this.frame)
    window.removeEventListener('resize', this.handleResize)

    const element = this.renderer?.domElement
    element?.removeEventListener('pointerdown', this.handlePointerDown)
    element?.removeEventListener('pointermove', this.handlePointerMove)
    element?.removeEventListener('pointerup', this.handlePointerUp)
    element?.removeEventListener('pointerleave', this.handlePointerLeave)
    element?.removeEventListener('dblclick', this.handleDoubleClick)

    this.clearHighlight()
    this.disposeModel()

    if (this.grid) {
      this.grid.geometry.dispose()
      toMaterialList(this.grid.material).forEach((material) => material.dispose())
      this.scene?.remove(this.grid)
      this.grid = null
    }
    this.postEffects?.dispose()
    this.postEffects = null
    this.wireframeMaterial?.dispose()
    this.wireframeMaterial = null
    if (this.fillLight) this.scene?.remove(this.fillLight)
    if (this.rimLight) this.scene?.remove(this.rimLight)
    this.fillLight = null
    this.rimLight = null

    this.baseViewer?.destroy()
    this.baseViewer = null
    this.controls = null
    this.renderer = null
    this.scene = null
    this.camera = null
    this.floor = null
  }
}
