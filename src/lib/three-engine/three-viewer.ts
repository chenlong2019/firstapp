/**
 * 飞行沙盒的基础 Three.js/WebGPU 场景容器。
 *
 * 处于渲染基础设施层:建/管 渲染器、相机、轨道控制器与内置环境(灯光/地板/坐标轴),
 * 上层(glb-viewer、DJI 页面)在其上加载模型、接后处理与交互。
 * 对外导出 THREEViewer 类与 THREEViewerOptions(场景四要素均可由调用方注入)。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { WebGPURenderer } from 'three/webgpu'

/**
 * THREEViewer 可注入的外部资源。
 *
 * 四项各自可选:**没传的才由本类创建**(不传任何一项时与老版本行为逐字节一致)。
 * 传进来的实例视作「调用方所有」—— 本类不改它的参数、不 dispose 它、也不动它的 DOM 归属
 * (渲染器 canvas 只在它本来没挂在任何父节点上时,才会被挂进容器)。
 */
export interface THREEViewerOptions {
  /** 外部场景。不传则新建(深蓝背景 #0a141b);传入时不覆盖它的背景 */
  scene?: THREE.Scene
  /** 外部透视相机。不传则新建(58° 视场,位于 (7.5, 4.2, 9.5));传入时不改它的投影与位置 */
  camera?: THREE.PerspectiveCamera
  /** 外部渲染器。不传则新建 WebGPURenderer(antialias,像素比上限 2);传入时不改它的像素比 */
  renderer?: WebGPURenderer
  /** 外部轨道控制器。不传则新建(阻尼 / 距离与俯仰限制 / target (0, 1.2, 0));传入时不改它的参数 */
  controls?: OrbitControls
  /**
   * 是否创建内置环境:半球光、跟随飞机的太阳光(带阴影)、兜底地板、坐标轴。默认 true。
   * 注入自带灯光与地面的大场景时设 false,避免重复一套。
   */
  environment?: boolean
}

/**
 * 飞行沙盒的基础 Three.js/WebGPU 场景。
 *
 * three 0.186 的 WebGPURenderer 没有 `shadowMap.enabled` 这类全局开关 —— 只要灯光
 * `castShadow = true`、网格 `castShadow/receiveShadow` 打开,阴影就会自动渲染。
 * 这里把太阳做成"跟随飞机"的:阴影相机只有 ±42 米,跟着飞就不怕飞出阴影范围。
 *
 * 场景四要素(scene / camera / renderer / controls)均可由调用方注入,见 THREEViewerOptions:
 * 未注入的项才新建 —— 所以既能把沙盒塞进已有的 three 工程,也能什么都不管直接 new。
 */
export class THREEViewer {
  private readonly container: HTMLElement
  private readonly options: THREEViewerOptions
  private renderer: WebGPURenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private controls: OrbitControls | null = null
  private floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  private axes: THREE.AxesHelper | null = null
  private keyLight: THREE.DirectionalLight | null = null
  private readonly shadowTarget = new THREE.Object3D()
  /** 本类创建的场景对象:注入外部 scene 时,销毁要一并摘干净,别在调用方场景里留残留 */
  private readonly ownObjects: THREE.Object3D[] = []
  /** 渲染器 canvas 是否由本类挂进容器(只在它原本没有父节点时才会挂) */
  private attachedDomElement = false
  private animationFrame = 0
  private readonly resizeHandler = (): void => this.onResize()

  constructor(container: HTMLElement, options: THREEViewerOptions = {}) {
    this.container = container
    // 拷贝一份:之后调用方改自己的对象也不影响这里的判断
    this.options = { ...options }
  }

  async initialize(): Promise<void> {
    // 未注入才新建(默认场景自带深蓝背景);注入的场景保持原样,不覆盖它的背景
    const scene = this.options.scene ?? createDefaultScene()
    this.scene = scene

    this.camera = this.options.camera ?? createDefaultCamera(this.getAspect())

    const renderer = this.options.renderer ?? createDefaultRenderer()
    this.renderer = renderer
    this.applySize()
    // init() 幂等(内部缓存 promise):注入的渲染器若已初始化过,这里直接复用
    await renderer.init()

    // 内置渲染器必然未挂载 → 挂进容器;注入的渲染器若已被挂到别处,不抢它的 DOM
    if (!renderer.domElement.parentElement) {
      this.container.appendChild(renderer.domElement)
      this.attachedDomElement = true
    }

    this.controls = this.options.controls ?? createDefaultControls(this.camera, renderer.domElement)

    if (this.options.environment ?? true) this.buildEnvironment(scene)

    window.addEventListener('resize', this.resizeHandler)
  }

  /** 内置环境:半球光 + 跟随飞机的太阳光(投影) + 兜底地板 + 坐标轴 */
  private buildEnvironment(scene: THREE.Scene): void {
    const hemisphere = new THREE.HemisphereLight('#cfe6ff', '#16222b', 1.5)
    scene.add(hemisphere)
    this.ownObjects.push(hemisphere)

    const keyLight = new THREE.DirectionalLight('#fff3e0', 2.4)
    keyLight.position.set(18, 26, 14)
    // 阴影:范围跟着飞机走,所以只需覆盖飞机附近 ±42 米
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
    // 阴影偏移量:抑制自阴影条纹(acne)与漏光(未初始化时两值可微调)
    keyLight.shadow.bias = -0.0006
    keyLight.shadow.normalBias = 0.02
    const shadowCamera = keyLight.shadow.camera
    shadowCamera.left = -42
    shadowCamera.right = 42
    shadowCamera.top = 42
    shadowCamera.bottom = -42
    shadowCamera.near = 1
    shadowCamera.far = 140
    shadowCamera.updateProjectionMatrix()
    keyLight.target = this.shadowTarget
    scene.add(keyLight)
    scene.add(this.shadowTarget)
    this.ownObjects.push(keyLight, this.shadowTarget)
    this.keyLight = keyLight

    // 兜底地板:铺得和外场地面一样大、压在外场地面之下,避免两层地面打架
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: '#0a1216', roughness: 0.95, metalness: 0.05 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.02
    floor.receiveShadow = true
    scene.add(floor)
    this.ownObjects.push(floor)
    this.floor = floor

    const axes = new THREE.AxesHelper(1.6)
    axes.position.y = 0.01
    axes.visible = false
    scene.add(axes)
    this.ownObjects.push(axes)
    this.axes = axes
  }

  /** 把太阳与阴影范围挪到世界坐标 (x, z) 附近 —— 每帧用飞机位置调用 */
  setShadowFocus(x: number, z: number): void {
    if (!this.keyLight) return
    this.keyLight.position.set(x + 18, 26, z + 14)
    this.shadowTarget.position.set(x, 0, z)
    this.shadowTarget.updateMatrixWorld()
    this.keyLight.updateMatrixWorld()
  }

  setAxesVisible(visible: boolean): void {
    if (this.axes) this.axes.visible = visible
  }

  /** 取出本查看器使用的场景对象(未初始化时各项为 null)。 */
  getObject() {
    return {
      camera: this.camera,
      scene: this.scene,
      renderer: this.renderer,
      controls: this.controls,
      floor: this.floor,
      axes: this.axes,
    }
  }

  private getAspect(): number {
    return this.container.clientWidth / Math.max(this.container.clientHeight, 1)
  }

  /** 按容器尺寸设置画布大小;注入的渲染器在容器尺寸未就绪(0×0)时不覆盖它原有尺寸 */
  private applySize(): void {
    const renderer = this.renderer
    if (!renderer) return
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (this.options.renderer && (width === 0 || height === 0)) return
    renderer.setSize(width, height)
  }

  private onResize(): void {
    if (!this.camera || !this.renderer) return
    // 注入的相机由调用方自己管投影参数
    if (!this.options.camera) {
      this.camera.aspect = this.getAspect()
      this.camera.updateProjectionMatrix()
    }
    this.applySize()
  }

  destroy(): void {
    window.cancelAnimationFrame(this.animationFrame)
    window.removeEventListener('resize', this.resizeHandler)
    // 注入的控制器归调用方所有,只由它自己 dispose
    if (!this.options.controls) this.controls?.dispose()

    for (const object of this.ownObjects) this.scene?.remove(object)
    this.ownObjects.length = 0
    if (this.floor) {
      this.floor.geometry.dispose()
      this.floor.material.dispose()
    }

    // 注入的渲染器同样归调用方所有:不 dispose,只把本类挂上去的 canvas 摘下来
    if (!this.options.renderer) this.renderer?.dispose()
    if (this.attachedDomElement) this.renderer?.domElement.remove()

    this.attachedDomElement = false
    this.keyLight = null
    this.axes = null
    this.floor = null
    this.controls = null
    this.renderer = null
    this.scene = null
    this.camera = null
  }
}

/** 未注入场景时的默认场景:深蓝背景,贴近沙盒页面基调 */
function createDefaultScene(): THREE.Scene {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#0a141b')
  return scene
}

/** 未注入相机时的默认相机 */
function createDefaultCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(58, aspect, 0.1, 2000)
  camera.position.set(7.5, 4.2, 9.5)
  return camera
}

/** 未注入渲染器时的默认渲染器 */
function createDefaultRenderer(): WebGPURenderer {
  const renderer = new WebGPURenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  return renderer
}

/** 未注入控制器时的默认轨道控制 */
function createDefaultControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
): OrbitControls {
  const controls = new OrbitControls(camera, domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 2.2
  controls.maxDistance = 160
  // 略小于 90°:限制极角,避免相机转到水平面以下钻入地面
  controls.maxPolarAngle = Math.PI * 0.495
  controls.target.set(0, 1.2, 0)
  return controls
}
