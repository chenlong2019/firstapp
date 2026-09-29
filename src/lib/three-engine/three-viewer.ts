import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { WebGPURenderer } from 'three/webgpu'

/**
 * 飞行沙盒的基础 Three.js/WebGPU 场景。
 *
 * three 0.186 的 WebGPURenderer 没有 `shadowMap.enabled` 这类全局开关 —— 只要灯光
 * `castShadow = true`、网格 `castShadow/receiveShadow` 打开,阴影就会自动渲染。
 * 这里把太阳做成"跟随飞机"的:阴影相机只有 ±42 米,跟着飞就不怕飞出阴影范围。
 */
export class THREEViewer {
  private readonly container: HTMLElement
  private renderer: WebGPURenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private controls: OrbitControls | null = null
  private floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null
  private axes: THREE.AxesHelper | null = null
  private keyLight: THREE.DirectionalLight | null = null
  private readonly shadowTarget = new THREE.Object3D()
  private animationFrame = 0
  private readonly resizeHandler = (): void => this.onResize()

  constructor(container: HTMLElement) {
    this.container = container
  }

  async initialize(): Promise<void> {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#0a141b')

    this.camera = new THREE.PerspectiveCamera(58, this.getAspect(), 0.1, 2000)
    this.camera.position.set(7.5, 4.2, 9.5)

    this.renderer = new WebGPURenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    await this.renderer.init()
    this.container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 2.2
    this.controls.maxDistance = 160
    this.controls.maxPolarAngle = Math.PI * 0.495
    this.controls.target.set(0, 1.2, 0)

    this.scene.add(new THREE.HemisphereLight('#cfe6ff', '#16222b', 1.5))
    const keyLight = new THREE.DirectionalLight('#fff3e0', 2.4)
    keyLight.position.set(18, 26, 14)
    // 阴影:范围跟着飞机走,所以只需覆盖飞机附近 ±42 米
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(2048, 2048)
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
    this.scene.add(keyLight)
    this.scene.add(this.shadowTarget)
    this.keyLight = keyLight

    // 兜底地板:铺得和外场地面一样大、压在外场地面之下,避免两层地面打架
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: '#0a1216', roughness: 0.95, metalness: 0.05 }),
    )
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = -0.02
    this.floor.receiveShadow = true
    this.scene.add(this.floor)

    this.axes = new THREE.AxesHelper(1.6)
    this.axes.position.y = 0.01
    this.axes.visible = false
    this.scene.add(this.axes)

    window.addEventListener('resize', this.resizeHandler)
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

  private onResize(): void {
    if (!this.camera || !this.renderer) return
    this.camera.aspect = this.getAspect()
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
  }

  destroy(): void {
    window.cancelAnimationFrame(this.animationFrame)
    window.removeEventListener('resize', this.resizeHandler)
    this.controls?.dispose()

    if (this.floor) {
      this.floor.geometry.dispose()
      this.floor.material.dispose()
      this.scene?.remove(this.floor)
    }
    if (this.axes) this.scene?.remove(this.axes)
    this.renderer?.dispose()
    this.renderer?.domElement.remove()

    this.axes = null
    this.floor = null
    this.controls = null
    this.renderer = null
    this.scene = null
    this.camera = null
  }
}
