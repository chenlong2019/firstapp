/**
 * 模型查看器:导入/解析模型 → 建模型树 → 拾取高亮 → 光照 / 后处理 / 动画 / 骨架 / 爆炸图。
 *
 * 处于应用层:直接驱动 THREEViewer(场景基础设施)与 PostEffects(后处理管线),
 * 是页面上"模型浏览器"的全部逻辑所在。
 * 对外导出 GlbViewer 类 + 一组纯数据类型/接口 + DEFAULT_LIGHT_SETTINGS。
 *
 * 模型格式解析全部委托给 model-loaders(glb/gltf/fbx/obj/stl/ply/dae 统一成 scene+animations),
 * 本文件只管"拿到 Object3D 之后"的事。类名与文件名沿用 GlbViewer/glb-viewer(页面路由也叫 /glb),
 * 但它已不只支持 GLB。
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import {
  displayNameOf,
  loadModelFromFiles,
  loadModelFromUrl,
  ModelLoadError,
} from './model-loaders'
import type { LoadedModel, ModelFormat } from './model-loaders'
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

/** 模型统计(页面"统计"面板展示用)。 */
export interface GlbModelStats {
  fileName: string
  nodes: number
  meshes: number
  triangles: number
  vertices: number
  materials: number
  textures: number
  animations: number
  /** 骨节数量(GLTF 里被 skin.joints 引用的节点,GLTFLoader 会把它们建成 Bone) */
  bones: number
  /** 模型包围盒尺寸(场景单位) */
  size: [number, number, number]
  radius: number
}

/** 单个节点的详情(选中后在页面信息面板展示)。 */
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

/** 视图显示开关(网格 / 坐标轴 / 自动旋转 / 线框)。 */
export interface GlbViewOptions {
  grid: boolean
  axes: boolean
  autoRotate: boolean
  wireframe: boolean
}

/** 动画循环方式(与 three 的 LoopRepeat / LoopOnce / LoopPingPong 对应)。 */
export type GlbAnimationLoopMode = 'repeat' | 'once' | 'pingpong'

/** 动画播放状态快照(每帧推给页面时间轴,无需页面轮询)。 */
export interface GlbAnimationState {
  names: string[]
  index: number
  playing: boolean
  duration: number
  speed: number
  /** 当前播放位置(秒),页面时间轴用 */
  time: number
  /** 单帧时长(秒):由轨道关键帧密度反推(烘焙动画即源帧率),逐帧步进用 */
  frameStep: number
  /** 循环方式 */
  loop: GlbAnimationLoopMode
}

/** 骨架信息(页面"骨骼"面板用)。 */
export interface GlbRigInfo {
  /** 骨节数量 */
  bones: number
  /** 骨架根骨节名(每条骨链一个,如四条机臂各一条) */
  roots: string[]
  /** 骨架容器节点名(骨节最近的"非骨节"祖先节点去重,通常是 RIG_* 空物体) */
  rigs: string[]
  /** 是否含骨骼(含则页面才显示骨骼相关控件) */
  hasSkeleton: boolean
  /** 骨架辅助线是否显示 */
  visible: boolean
}

/** 加载状态(推给页面 loading UI);progress 在资源未返回 content-length 时为 null。 */
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

/** 默认光照装置:环境光/主光/补光/轮廓光强度 + 曝光(值 0 表示关闭该光源)。 */
export const DEFAULT_LIGHT_SETTINGS: LightSettings = {
  ambient: 1.6,
  key: 2.2,
  fill: 0.7,
  rim: 0.9,
  exposure: 1,
}

// 页面光照滑块的上限(经 getLightLimits 暴露给 UI)
const AMBIENT_LIGHT_MAX = 4
const DIRECTIONAL_LIGHT_MAX = 6

const WIREFRAME_COLOR = 0x9fe8ff

// 骨架辅助线配色:骨节→子骨节为主色(亮青),骨节→它驱动的网格中心为暗色弱线
const RIG_BONE_COLOR = new THREE.Color(0x64f0d2)
const RIG_SPOKE_COLOR = new THREE.Color(0x2c6f68)
/** 骨节处的小圆点半径(相对模型半径的比例) */
const RIG_DOT_RATIO = 0.006

/** 骨架辅助线的一段(每帧刷新顶点用)。 */
type RigSegment =
  | { kind: 'bone'; from: THREE.Object3D; to: THREE.Object3D }
  | { kind: 'spoke'; from: THREE.Object3D; rest: THREE.Vector3 }
  | { kind: 'axis'; from: THREE.Object3D; axis: 0 | 1 | 2 }

// 骨架顶点刷新的复用临时量(每帧调用,不额外分配对象)
const rigOrigin = new THREE.Vector3()
const rigTarget = new THREE.Vector3()
const rigAxisX = new THREE.Vector3()
const rigAxisY = new THREE.Vector3()
const rigAxisZ = new THREE.Vector3()

/**
 * 判断一个对象是否是"骨节"。
 * GLTFLoader 会把 glTF 里被 skin.joints 引用的节点建成 THREE.Bone(见其 _markDefs),
 * 所以 isBone 是权威依据;再补一条命名兜底,兼容只导出层级(没有 skin 定义)的刚性骨架。
 */
function isBoneLike(object: THREE.Object3D): boolean {
  return (object as THREE.Bone).isBone === true || /(?:^|[_\-\s])bone$/i.test(object.name)
}

/** 点击判定:位移与时长阈值(超过则视为拖拽旋转视角,不触发选中)。 */
const CLICK_MAX_DISTANCE_PX = 5
const CLICK_MAX_DURATION_MS = 600

function toMaterialList(material: THREE.Material | THREE.Material[]): THREE.Material[] {
  if (Array.isArray(material)) return material
  return [material]
}

/** 判断 object 是否落在 ancestor 的子树里(含自身);父子链任意深。 */
function isDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object
  while (current) {
    if (current === ancestor) return true
    current = current.parent
  }
  return false
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
  /** "只看当前部件"的隔离目标;null = 未开启。 */
  private isolatedId: number | null = null
  /**
   * 进入隔离前的可见性快照。
   * 必须存快照而不是"退出时全部设回 true":用户可能本来就手关了几个部件,
   * 一刀切恢复成可见会把他的显隐设置抹掉。
   */
  private isolateSnapshot: Map<THREE.Object3D, boolean> | null = null
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
  private animationLoop: GlbAnimationLoopMode = 'repeat'
  /** 每帧向页面推送播放进度(时间轴平滑),页面不必等 400ms 轮询 */
  onAnimationTick: ((state: GlbAnimationState) => void) | null = null

  // —— 骨架辅助线(自绘:骨节 → 子骨节 / 骨节 → 它驱动的网格中心) ——
  private rigGroup: THREE.Group | null = null
  private rigLines: THREE.LineSegments | null = null
  private rigDots: THREE.Points | null = null
  /** 骨架可见性必须存状态字段:updateRig() 每帧按它写 group.visible */
  private rigVisible = false
  /** 参与连线的骨节(顺序即缓冲区顶点顺序) */
  private rigBones: THREE.Object3D[] = []
  /** 骨节 → 骨架根(祖先中没有骨节的骨节) */
  private rigRoots: THREE.Object3D[] = []
  /** 骨架线段的构成(每帧按它写顶点) */
  private rigSegments: RigSegment[] = []
  private rigLinePositions: THREE.BufferAttribute | null = null
  /** 骨节局部短轴的长度(按模型尺寸定) */
  private rigTickLength = 0.01

  // —— 爆炸图 ——
  private explodeParts: Array<{
    object: THREE.Object3D
    originalPosition: THREE.Vector3
    originalWorldCenter: THREE.Vector3
    direction: THREE.Vector3
  }> = []
  private explodeAmount = 0
  private explodeMaxOffset = 0

  /** 整机包围球半径(每次载入算一次):缩放上限以它为基准,保证"拉远永远能看全整机"。 */
  private modelRadius = 1

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

  /**
   * 从 URL 载入模型(内置示例,或同目录带外部资源的模型)。
   * 格式由扩展名决定,解析细节全部委托 model-loaders。
   */
  async loadFromUrl(url: string, fileName?: string): Promise<void> {
    const displayName = fileName ?? displayNameOf(url)
    this.emitStatus('loading', displayName, 0)
    try {
      const model = await loadModelFromUrl(url, fileName, {
        onProgress: (progress) => this.emitStatus('loading', displayName, progress),
      })
      await this.mount(model, model.fileName)
      this.emitStatus('ready', model.fileName, 1)
    } catch (error) {
      this.emitError(displayName, error)
    }
  }

  /**
   * 从一组本地文件载入模型(拖拽或文件选择)。
   * 多选是"外部资源"支持的关键:.mtl / 贴图 / .bin 一起选中才能被解析到,
   * 只选模型本体时贴图会走默认材质(不报错,但外观不完整)。
   */
  async loadFromFiles(files: File[]): Promise<void> {
    const list = Array.from(files)
    const label = list[0]?.name ?? '模型'
    this.emitStatus('loading', label, 0)
    try {
      const model = await loadModelFromFiles(list, {
        onProgress: (progress) => this.emitStatus('loading', label, progress),
      })
      await this.mount(model, model.fileName)
      this.emitStatus('ready', model.fileName, 1)
    } catch (error) {
      this.emitError(label, error)
    }
  }

  /** 单文件载入(兼容旧调用点)。 */
  async loadFromFile(file: File): Promise<void> {
    await this.loadFromFiles([file])
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
    // 加载层已把失败分成"选错文件"与"文件本身有问题"两类,前者原样提示(用户看得懂),
    // 后者才需要带上底层解析信息
    if (error instanceof ModelLoadError) {
      const message =
        error.code === 'parse' ? `解析失败:${error.message}` : error.message
      this.onStatus?.({ state: 'error', fileName, progress: null, message })
      return
    }
    const raw = error instanceof Error ? error.message : String(error)
    const message = /draco|meshopt|ktx/i.test(raw)
      ? `解析失败:模型使用了压缩扩展,请确认解码器可用(${raw})`
      : `解析失败:${raw}`
    this.onStatus?.({ state: 'error', fileName, progress: null, message })
  }

  /** 挂载新模型:清旧资源 → 归一化 → 建树 → 适配相机与环境。 */
  private async mount(model: LoadedModel, fileName: string): Promise<void> {
    if (!this.scene || this.destroyed) return
    this.clearHighlight()
    this.disposeModel()

    const root = model.scene
    // 根节点名:模型自带就用自带的,否则用文件名去掉扩展名(文件名可能是 .fbx/.obj/.stl…)
    root.name = root.name || fileName.replace(/\.[^.]+$/, '')
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
    // 缩放范围要用整机半径做基准,必须在 fitCameraToBox 之前量好
    this.modelRadius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3)
    this.fitEnvironment(box)
    this.buildTree()
    // 骨架要在统计与动画之前建好:统计要报骨节数,动画辅助线要在静止姿态下量测
    this.buildRig()
    this.collectStats(model.animations.length)
    this.setupExplodeParts()
    this.setupAnimations(model.animations)
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
    let bones = 0

    this.model.traverse((object) => {
      nodes += 1
      if (isBoneLike(object)) bones += 1
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
      bones,
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
      time: this.activeAction?.time ?? 0,
      frameStep: this.getFrameStep(),
      loop: this.animationLoop,
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

    this.applyZoomRange(radius, distance)

    this.controls.target.copy(sphere.center)
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance)
    // near/far 随观察距离自适应:模型尺度可能跨几个数量级,固定值会 z-fighting 或被裁掉
    this.camera.near = Math.max(distance / 600, 0.0005)
    this.camera.far = Math.max(distance * 12, 200)
    this.camera.updateProjectionMatrix()
    this.controls.update()
  }

  /**
   * 让 OrbitControls 的缩放范围跟随模型尺度。
   *
   * OrbitControls 出厂值是 min 2.2 / max 160,按"米级"场景写死的;而 FBX 常以**厘米**为单位
   * (人物包围球半径可达上百),取景所需距离会超过 maxDistance —— 相机被夹到 maxDistance 上
   * (等于被塞进模型内部),此时滚轮拉远毫无反应,表现为"加载完几乎不能缩放"。
   * 故:下限按当前取景半径(凑近看小部件),上限按整机半径(拉远永远能看全整机)。
   */
  private applyZoomRange(radius: number, distance: number): void {
    if (!this.controls) return
    const modelRadius = Math.max(this.modelRadius, radius)
    const min = Math.max(radius * 0.05, modelRadius * 0.01, 0.0005)
    const max = Math.max(distance * 5, modelRadius * 12, min * 20)
    this.controls.minDistance = min
    this.controls.maxDistance = max
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
    // 手动改显隐意味着用户不再要"只看某个部件":先退出隔离再按他的意思改,
    // 否则会出现"只看 A 却冒出一个 B"的矛盾画面
    if (this.isolatedId !== null) this.isolate(null)
    object.visible = visible
    const node = this.treeIndex.get(id)
    if (node) node.visible = visible
    if (!visible) this.dropInvisibleHighlight()
  }

  // ————————————————————————————— 只看当前部件(隔离) —————————————————————————————

  /** 当前被"只看"的节点 id;未开启隔离时为 null。 */
  getIsolatedId(): number | null {
    return this.isolatedId
  }

  /** 是否处于"只看当前部件"模式。 */
  isIsolated(): boolean {
    return this.isolatedId !== null
  }

  /**
   * 只看某个部件:除"该部件及其祖先链"之外的部件全部隐藏;传 null 退出隔离。
   *
   * 祖先链必须留着可见 —— three.js 里父级不可见会连坐整棵子树,
   * 把祖先也关掉的话目标部件自己也会跟着消失。
   * 退出时按快照恢复(而不是全设可见),这样用户先前的显隐设置原样保留。
   */
  isolate(id: number | null): void {
    if (id !== null && !this.nodeById.has(id)) return
    // 换目标:先把上一次的隐藏还原,再基于"真实可见性"重新隔离
    this.restoreIsolateSnapshot()

    if (id === null) {
      this.isolatedId = null
      this.syncTreeVisibility()
      this.dropInvisibleHighlight()
      return
    }
    const target = this.nodeById.get(id)
    this.isolatedId = target ? id : null
    if (!target || !this.model) return

    const keep = new Set<THREE.Object3D>()
    let current: THREE.Object3D | null = target
    while (current) {
      keep.add(current)
      if (current === this.model) break
      current = current.parent
    }

    const snapshot = new Map<THREE.Object3D, boolean>()
    this.model.traverse((child) => {
      snapshot.set(child, child.visible)
      if (keep.has(child) || isDescendantOf(child, target)) return
      child.visible = false
    })
    // "只看"就要真看得见:目标自己或某个祖先本来就被人手关掉时,这里一并打开
    // (原始可见性已在快照里,退出时照旧还原)
    keep.forEach((object) => {
      object.visible = true
    })
    this.isolateSnapshot = snapshot
    this.syncTreeVisibility()
    this.dropInvisibleHighlight()
  }

  /** 把隔离前的可见性快照写回,并丢弃快照。 */
  private restoreIsolateSnapshot(): void {
    if (!this.isolateSnapshot) return
    this.isolateSnapshot.forEach((visible, object) => {
      object.visible = visible
    })
    this.isolateSnapshot = null
  }

  /** 把对象上的 visible 回写到树节点(隔离会直接改对象,树节点得跟上)。 */
  private syncTreeVisibility(): void {
    this.nodeById.forEach((object, id) => {
      const node = this.treeIndex.get(id)
      if (node) node.visible = object.visible
    })
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
   * 记录每个单元的静止位置与"单元中心 → 模型中心"方向。
   * 含蒙皮网格或骨节的单元不参与:蒙皮会被位移破坏,而骨节的变换每帧由动画写回,
   * 爆炸偏移会被下一帧覆盖(模型改成"骨节驱动"后,机臂那一支就属于这类,整支一起动是正确行为)。
   */
  private setupExplodeParts(): void {
    this.explodeParts = []
    this.explodeAmount = 0
    this.explodeMaxOffset = 0
    if (!this.model) return

    const usable = (part: THREE.Object3D): boolean => !this.containsSkinnedMesh(part)
    let parts = [...this.model.children]
    if (parts.length <= 1) parts = parts.flatMap((child) => [...child.children])
    parts = parts.filter(usable)
    // 排除骨架后若只剩一个单元(整机挂在单个"机身"节点下),再下钻一层拿到真正的部件
    if (parts.length <= 1 && parts[0]) {
      const deeper = [...parts[0].children].filter(usable)
      if (deeper.length > 1) parts = deeper
    }
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

  // ————————————————————————————— 骨架辅助线 —————————————————————————————

  /**
   * 依据加载后的骨骼层级自绘骨架辅助线,三类线段:
   * ① 骨节 → 子骨节(骨架主干,亮青);
   * ② 骨节 → 它驱动的网格中心(暗色辐射线,静止姿态下量一次局部坐标,之后随骨节刚性跟随);
   * ③ 每根骨节的局部 X/Y/Z 短轴(红绿蓝),用来直观看出骨骼在转动。
   *
   * 不用 THREE.SkeletonHelper:它只画 bone→bone,且把 root 当骨架根(这里骨架常与机身
   * 并列挂在场景根下),也看不到"这根骨头带着哪些网格"。
   */
  private buildRig(): void {
    this.disposeRig()
    if (!this.model || !this.scene) return

    const bones: THREE.Object3D[] = []
    this.model.traverse((object) => {
      if (isBoneLike(object)) bones.push(object)
    })
    if (bones.length === 0) return
    this.model.updateMatrixWorld(true)

    const segments: Array<
      | { kind: 'bone'; from: THREE.Object3D; to: THREE.Object3D }
      | { kind: 'spoke'; from: THREE.Object3D; rest: THREE.Vector3 }
      | { kind: 'axis'; from: THREE.Object3D; axis: 0 | 1 | 2 }
    > = []

    bones.forEach((bone) => {
      bone.children.forEach((child) => {
        if (isBoneLike(child)) segments.push({ kind: 'bone', from: bone, to: child })
      })
      // 离这根骨节最近(中间没有别的骨节)的网格 = 它实际驱动的几何
      const driven: THREE.Mesh[] = []
      bone.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh) return
        if (this.nearestBoneAncestor(object) !== bone) return
        driven.push(mesh)
      })
      driven.forEach((mesh) => {
        const box = new THREE.Box3().setFromObject(mesh)
        if (box.isEmpty()) return
        const center = box.getCenter(new THREE.Vector3())
        segments.push({ kind: 'spoke', from: bone, rest: bone.worldToLocal(center) })
      })
      segments.push({ kind: 'axis', from: bone, axis: 0 })
      segments.push({ kind: 'axis', from: bone, axis: 1 })
      segments.push({ kind: 'axis', from: bone, axis: 2 })
    })

    const axisColors: Record<0 | 1 | 2, THREE.Color> = {
      0: new THREE.Color(0xff6b6b),
      1: new THREE.Color(0x8effa1),
      2: new THREE.Color(0x7fb2ff),
    }
    const positions = new Float32Array(segments.length * 2 * 3)
    const colors = new Float32Array(segments.length * 2 * 3)
    segments.forEach((segment, index) => {
      const color =
        segment.kind === 'bone'
          ? RIG_BONE_COLOR
          : segment.kind === 'spoke'
            ? RIG_SPOKE_COLOR
            : axisColors[segment.axis]
      for (let vertex = 0; vertex < 2; vertex += 1) {
        const offset = (index * 2 + vertex) * 3
        colors[offset] = color.r
        colors[offset + 1] = color.g
        colors[offset + 2] = color.b
      }
    })

    const geometry = new THREE.BufferGeometry()
    const positionAttribute = new THREE.BufferAttribute(positions, 3)
    positionAttribute.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('position', positionAttribute)
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    // 动态顶点:关掉视锥剔除,免得包围盒不更新时整条链被裁掉
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY)

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false, // 骨架做成"透视"效果,被机身挡住也能看见
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    })
    this.rigLines = new THREE.LineSegments(geometry, material)
    this.rigLines.frustumCulled = false
    // 与 depthTest:false 配合,骨架在所有实体之后绘制,始终可见
    this.rigLines.renderOrder = 5
    this.rigGroup = new THREE.Group()
    this.rigGroup.name = 'GLB_SkeletonHelper'
    this.rigGroup.visible = this.rigVisible
    this.rigGroup.add(this.rigLines)
    this.scene.add(this.rigGroup)

    this.rigBones = bones
    this.rigRoots = bones.filter((bone) => {
      let parent = bone.parent
      while (parent) {
        if (isBoneLike(parent)) return false
        parent = parent.parent
      }
      return true
    })
    this.rigSegments = segments
    this.rigLinePositions = positionAttribute

    const size = new THREE.Box3().setFromObject(this.model).getSize(new THREE.Vector3())
    this.rigTickLength = Math.max(size.length() * 0.02, 0.0005)
    this.updateRig()
  }

  /** 沿父级链找最近的骨节祖先(自身不算)。 */
  private nearestBoneAncestor(object: THREE.Object3D): THREE.Object3D | null {
    let current = object.parent
    while (current) {
      if (isBoneLike(current)) return current
      current = current.parent
    }
    return null
  }

  /** 每帧刷新骨架顶点(可见性由状态字段统一应用,不可见时不做任何计算)。 */
  private updateRig(): void {
    if (!this.rigGroup) return
    this.rigGroup.visible = this.rigVisible
    if (!this.rigVisible || !this.rigLinePositions || !this.model) return

    // 动画写的是骨骼的局部变换,这里先把世界矩阵刷到当前姿态再取点
    this.model.updateMatrixWorld(true)
    const array = this.rigLinePositions.array as Float32Array
    const tick = this.rigTickLength
    let cursor = 0
    const write = (x: number, y: number, z: number): void => {
      array[cursor] = x
      array[cursor + 1] = y
      array[cursor + 2] = z
      cursor += 3
    }

    this.rigSegments.forEach((segment) => {
      const matrix = segment.from.matrixWorld
      rigOrigin.setFromMatrixPosition(matrix)
      write(rigOrigin.x, rigOrigin.y, rigOrigin.z)
      if (segment.kind === 'bone') {
        rigTarget.setFromMatrixPosition(segment.to.matrixWorld)
        write(rigTarget.x, rigTarget.y, rigTarget.z)
      } else if (segment.kind === 'spoke') {
        rigTarget.copy(segment.rest).applyMatrix4(matrix)
        write(rigTarget.x, rigTarget.y, rigTarget.z)
      } else {
        matrix.extractBasis(rigAxisX, rigAxisY, rigAxisZ)
        const axis = segment.axis === 0 ? rigAxisX : segment.axis === 1 ? rigAxisY : rigAxisZ
        write(rigOrigin.x + axis.x * tick, rigOrigin.y + axis.y * tick, rigOrigin.z + axis.z * tick)
      }
    })

    this.rigLinePositions.needsUpdate = true
  }

  private disposeRig(): void {
    if (this.rigLines) {
      this.rigLines.geometry.dispose()
      toMaterialList(this.rigLines.material).forEach((material) => material.dispose())
      this.rigGroup?.remove(this.rigLines)
      this.rigLines = null
    }
    if (this.rigGroup) {
      this.scene?.remove(this.rigGroup)
      this.rigGroup = null
    }
    this.rigBones = []
    this.rigRoots = []
    this.rigSegments = []
    this.rigLinePositions = null
  }

  /** 骨架辅助线开关。 */
  setSkeletonVisible(visible: boolean): void {
    this.rigVisible = visible
    this.updateRig()
  }

  isSkeletonVisible(): boolean {
    return this.rigVisible
  }

  getRigInfo(): GlbRigInfo {
    const rigs: string[] = []
    this.rigRoots.forEach((bone) => {
      let parent = bone.parent
      while (parent && isBoneLike(parent)) parent = parent.parent
      const name = parent?.name || '骨架'
      if (!rigs.includes(name)) rigs.push(name)
    })
    return {
      bones: this.rigBones.length,
      roots: this.rigRoots.map((bone) => bone.name || '骨架'),
      rigs,
      hasSkeleton: this.rigBones.length > 0,
      visible: this.rigVisible,
    }
  }

  /** 是否含骨骼(含则页面才显示骨骼相关控件)。 */
  hasSkeleton(): boolean {
    return this.rigBones.length > 0
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
    if (this.mixer) {
      this.mixer.stopAllAction()
      this.mixer.removeEventListener('finished', this.handleActionFinished)
      this.mixer.uncacheRoot(this.mixer.getRoot())
    }
    this.mixer = clips.length > 0 && this.model ? new THREE.AnimationMixer(this.model) : null
    if (this.mixer) {
      // LoopOnce 播完后 three 只是停住,自己不发状态;补一条事件让页面按钮回到"播放"
      this.mixer.addEventListener('finished', this.handleActionFinished)
    }
    if (clips.length > 0) this.playAnimation(0)
  }

  private readonly handleActionFinished = (): void => {
    this.animationPlaying = false
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
    this.applyLoopMode()
    this.mixer.update(0)
  }

  /** 当前 clip 的单帧时长:取关键帧最密的轨道反推(烘焙动画等于源帧率)。 */
  getFrameStep(): number {
    const clip = this.activeAction?.getClip() ?? this.clips[this.animationIndex]
    if (!clip || clip.duration <= 0) return 1 / 30
    let maxKeys = 2
    clip.tracks.forEach((track) => {
      maxKeys = Math.max(maxKeys, track.times.length)
    })
    return clip.duration / (maxKeys - 1)
  }

  setAnimationPlaying(playing: boolean): void {
    if (!this.activeAction) return
    if (playing) {
      const duration = this.activeAction.getClip().duration
      // 单次播放在结尾停住(clampWhenFinished)后再点播放 = 从头来一遍;
      // 中途暂停时不能 reset,否则会丢掉当前进度
      if (this.activeAction.time >= duration - 1e-4) this.activeAction.reset()
      this.activeAction.paused = false
    }
    this.animationPlaying = playing
    this.activeAction.paused = !playing
    this.mixer?.update(0)
  }

  setAnimationSpeed(speed: number): void {
    this.animationSpeed = speed
    if (this.activeAction) this.activeAction.setEffectiveTimeScale(speed)
  }

  /**
   * 跳到指定时间(秒)。写 action.time 后用 update(0) 求值一次:
   * 暂停状态下也能立刻把骨骼摆到目标姿态(时间轴拖拽 / 单帧步进都靠它)。
   */
  seek(time: number): void {
    if (!this.activeAction) return
    const duration = this.activeAction.getClip().duration
    this.activeAction.time = THREE.MathUtils.clamp(time, 0, duration)
    this.mixer?.update(0)
  }

  /** 逐帧步进(自动暂停,和视频播放器一致)。 */
  stepFrame(direction: number): void {
    if (!this.activeAction) return
    const step = this.getFrameStep()
    this.setAnimationPlaying(false)
    this.seek(this.activeAction.time + Math.sign(direction) * step)
  }

  /** 循环方式:循环 / 单次(停在末帧)/ 往返(折叠↔展开来回)。 */
  setLoopMode(mode: GlbAnimationLoopMode): void {
    this.animationLoop = mode
    this.applyLoopMode()
  }

  private applyLoopMode(): void {
    const action = this.activeAction
    if (!action) return
    if (this.animationLoop === 'once') {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
    } else if (this.animationLoop === 'pingpong') {
      action.setLoop(THREE.LoopPingPong, Number.POSITIVE_INFINITY)
      action.clampWhenFinished = false
    } else {
      action.setLoop(THREE.LoopRepeat, Number.POSITIVE_INFINITY)
      action.clampWhenFinished = false
    }
  }

  /** 从头播放当前 clip。 */
  restartAnimation(): void {
    if (!this.activeAction) return
    this.activeAction.time = 0
    this.setAnimationPlaying(true)
  }

  // ————————————————————————————— 主循环 —————————————————————————————

  private startLoop(): void {
    const render = (timestamp: number): void => {
      this.frame = window.requestAnimationFrame(render)
      this.updateFps(timestamp)
      // 单帧步进上限 0.1s:标签页切回或卡顿后不会一次跳太多,避免动画爆冲
      const delta = this.previousFrameTime
        ? Math.min((timestamp - this.previousFrameTime) / 1000, 0.1)
        : 1 / 60
      this.previousFrameTime = timestamp

      this.updateHover()
      if (this.mixer && this.animationPlaying) this.mixer.update(delta)
      // 骨架辅助线要在 mixer 之后刷新,否则量到的是上一帧的姿态
      this.updateRig()
      if (this.mixer && this.activeAction && this.animationPlaying) {
        this.onAnimationTick?.(this.getAnimationState())
      }
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
    // 隔离状态随模型一起失效:快照里的对象即将被释放,留着会对已释放节点写 visible
    this.isolatedId = null
    this.isolateSnapshot = null
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
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.handleActionFinished)
      this.mixer.stopAllAction()
      this.mixer.uncacheRoot(this.mixer.getRoot())
    }
    this.mixer = null
    this.clips = []
    this.activeAction = null
    this.animationPlaying = false
    this.animationIndex = -1
    this.disposeRig()
    this.explodeParts = []
    this.explodeAmount = 0
    this.modelRadius = 1
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
