import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export class UseLibDemo {
  private container: HTMLElement
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private cube: THREE.Mesh | null = null
  private floor: THREE.Mesh | null = null
  private gridHelper: THREE.GridHelper | null = null
  private controls: OrbitControls | null = null
  private animateId: number | null = null

  constructor(container: HTMLElement) {
    this.container = container
  }

  async init(): Promise<void> {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)

    const width = this.container.clientWidth
    const height = this.container.clientHeight

    this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)
    this.camera.position.set(4, 4, 5)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(width, height)
    this.container.appendChild(this.renderer.domElement)

    // 轨道控制器
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.05
    this.controls.minDistance = 1
    this.controls.maxDistance = 30

    // 灯光
    const dirLight = new THREE.DirectionalLight(0xffffff, 1)
    dirLight.position.set(3, 5, 4)
    this.scene.add(dirLight)
    const ambientLight = new THREE.AmbientLight(0x404040)
    this.scene.add(ambientLight)

    // ========== 地板 + 网格坐标系 ==========
    // 地板平面
    const floorGeo = new THREE.PlaneGeometry(20, 20)
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.8,
      metalness: 0.1,
    })
    this.floor = new THREE.Mesh(floorGeo, floorMat)
    this.floor.rotation.x = -Math.PI / 2 // 放平，XZ地面
    this.scene.add(this.floor)

    // 网格辅助线，20m*20m，每格1米
    this.gridHelper = new THREE.GridHelper(20, 20, 0x4444ff, 0x888888)
    this.scene.add(this.gridHelper)

    // 坐标轴 X红 Y绿 Z蓝
    const axesHelper = new THREE.AxesHelper(8)
    this.scene.add(axesHelper)
    // =======================================

    // 正方体
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial({ color: 0xff4444 })
    this.cube = new THREE.Mesh(geometry, material)
    this.cube.position.y = 0.5 // 放在地板上，方块高度1，底部贴地
    this.scene.add(this.cube)

    window.addEventListener('resize', this.onResize.bind(this))
    this.animate()
  }

  private animate(): void {
    this.animateId = requestAnimationFrame(this.animate.bind(this))

    if (this.cube) {
      this.cube.rotation.x += 0.01
      this.cube.rotation.y += 0.01
    }
    this.controls?.update()

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }
  }

  private onResize(): void {
    if (!this.camera || !this.renderer) return
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
  }

  async destroy(): Promise<void> {
    if (this.animateId !== null) {
      cancelAnimationFrame(this.animateId)
    }
    window.removeEventListener('resize', this.onResize.bind(this))

    this.controls?.dispose()

    if (this.cube) {
      this.cube.geometry.dispose()
      if (Array.isArray(this.cube.material)) {
        this.cube.material.forEach((mat) => mat.dispose())
      } else {
        this.cube.material.dispose()
      }
      this.scene?.remove(this.cube)
    }

    // 销毁地板
    if (this.floor) {
      this.floor.geometry.dispose()
      if (!Array.isArray(this.floor.material)) this.floor.material.dispose()
      this.scene?.remove(this.floor)
    }

    if (this.gridHelper) {
      this.scene?.remove(this.gridHelper)
    }

    if (this.renderer) {
      this.renderer.dispose()
      this.container.removeChild(this.renderer.domElement)
    }

    this.scene = null
    this.camera = null
    this.renderer = null
    this.cube = null
    this.floor = null
    this.gridHelper = null
    this.controls = null
  }
}
