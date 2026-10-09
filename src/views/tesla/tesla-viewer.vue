<template>
  <main class="tesla-lab">
    <!-- ————— 3D 视口:Three.js 画布挂载点 ————— -->
    <div ref="viewportRef" class="viewport" aria-label="Tesla 模型视口"></div>

    <!-- ————— 顶部标题栏 ————— -->
    <header class="top-bar">
      <h1>Tesla Model 3 · 整车交互</h1>
      <span class="top-meta">{{ statusText }}</span>
      <a class="top-link" :href="TESLA_NODES_DOC_URL" target="_blank" rel="noopener">
        节点契约文档 ↗
      </a>
    </header>

    <!-- ————— 左侧控制面板 ————— -->
    <aside class="panel" aria-label="整车控制">
      <!-- 车门:四个门各自可调,左右开门方向由 rig 按镜像处理 -->
      <section class="section">
        <h3>车门 <small>0 → 58°</small></h3>
        <label v-for="door in DOOR_ROWS" :key="door.id" class="slider-row">
          <span class="slider-label">{{ door.label }}</span>
          <strong>{{ Math.round(doors[door.id] * TESLA_DOOR_OPEN_DEG) }}°</strong>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="doors[door.id]"
            @input="onDoorInput(door.id, $event)"
          />
        </label>
        <div class="button-row three">
          <button type="button" @click="setDoorRow('front', 1)">开前门</button>
          <button type="button" @click="setDoorRow('rear', 1)">开后门</button>
          <button type="button" :class="{ active: allDoorsOpen }" @click="toggleAllDoors">
            {{ allDoorsOpen ? '全部关闭' : '全部打开' }}
          </button>
        </div>
      </section>

      <!-- 后视镜:资产里只有前门两只 -->
      <section class="section">
        <h3>后视镜 <small>0 → 78°</small></h3>
        <label class="slider-row">
          <span class="slider-label">折叠</span>
          <strong>{{ Math.round(mirrorFold * TESLA_MIRROR_FOLD_DEG) }}°</strong>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            :value="mirrorFold"
            @input="onMirrorInput($event)"
          />
        </label>
        <div class="button-row two">
          <button type="button" @click="setMirrorFold(0)">展开</button>
          <button type="button" @click="setMirrorFold(1)">折叠</button>
        </div>
      </section>

      <!-- 行驶:转向 + 车速。轮子按 v/r 滚动,整车不做世界位移 -->
      <section class="section">
        <h3>行驶 <small>轮上演示</small></h3>
        <label class="slider-row">
          <span class="slider-label">前轮转向</span>
          <strong>{{ steering.toFixed(0) }}°</strong>
          <input
            type="range"
            :min="-TESLA_STEER_MAX_DEG"
            :max="TESLA_STEER_MAX_DEG"
            step="1"
            :value="steering"
            @input="onSteeringInput($event)"
          />
        </label>
        <label class="slider-row">
          <span class="slider-label">车速</span>
          <strong>{{ speed.toFixed(1) }} m/s</strong>
          <input
            type="range"
            min="-18"
            max="40"
            step="0.5"
            :value="speed"
            @input="onSpeedInput($event)"
          />
        </label>
        <div class="button-row three">
          <button type="button" @click="setSpeed(-4)">倒车</button>
          <button type="button" :class="{ active: speed === 0 }" @click="setSpeed(0)">停车</button>
          <button type="button" @click="setSpeed(14)">行驶</button>
        </div>
      </section>

      <!-- 灯光:每组灯是独立材质,可各自点亮 -->
      <section class="section">
        <h3>灯光 <small>自发光 + Bloom</small></h3>
        <div v-for="lamp in LAMP_ROWS" :key="lamp.group" class="toggle-row">
          <span>
            {{ lamp.label }}
            <em class="lamp-count">{{ lampCounts[lamp.group] }} 材质</em>
          </span>
          <div class="segmented two">
            <button
              type="button"
              :class="{ active: lamps[lamp.group] }"
              @click="setLamp(lamp.group, true)"
            >
              开
            </button>
            <button
              type="button"
              :class="{ active: !lamps[lamp.group] }"
              @click="setLamp(lamp.group, false)"
            >
              关
            </button>
          </div>
        </div>
        <label class="slider-row">
          <span class="slider-label">亮度</span>
          <strong>{{ brightness.toFixed(2) }}×</strong>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            :value="brightness"
            @input="onBrightnessInput($event)"
          />
        </label>
        <div class="button-row two">
          <button type="button" @click="setAllLamps(true)">全部点亮</button>
          <button type="button" @click="setAllLamps(false)">全部熄灭</button>
        </div>
      </section>

      <!-- 视角:相机预设 + 显示开关 -->
      <section class="section">
        <h3>视角</h3>
        <div class="button-row three">
          <button
            v-for="preset in VIEW_PRESETS"
            :key="preset.key"
            type="button"
            :class="{ active: viewPreset === preset.key }"
            @click="applyViewPreset(preset.key)"
          >
            {{ preset.label }}
          </button>
        </div>
        <div v-for="option in VIEW_OPTIONS" :key="option.key" class="toggle-row">
          <span>{{ option.label }}</span>
          <div class="segmented two">
            <button
              type="button"
              :class="{ active: views[option.key] }"
              @click="setViewOption(option.key, true)"
            >
              开
            </button>
            <button
              type="button"
              :class="{ active: !views[option.key] }"
              @click="setViewOption(option.key, false)"
            >
              关
            </button>
          </div>
        </div>
      </section>

      <!-- 模型信息:尺寸与各控制组绑到的节点数,便于确认契约没走样 -->
      <section v-if="modelInfo" class="section">
        <h3>模型信息</h3>
        <dl class="info-grid">
          <div>
            <dt>尺寸</dt>
            <dd>{{ modelInfo.size }}</dd>
          </div>
          <div>
            <dt>轮胎半径</dt>
            <dd>{{ modelInfo.wheelRadius }}</dd>
          </div>
          <div>
            <dt>可动节点</dt>
            <dd>{{ modelInfo.nodes }}</dd>
          </div>
          <div>
            <dt>帧率</dt>
            <dd>{{ fps > 0 ? `${fps} FPS` : '--' }}</dd>
          </div>
        </dl>
      </section>
    </aside>

    <!-- ————— 底部操作提示 ————— -->
    <div class="hint-bar">
      左键拖动旋转 · 滚轮缩放 · 右键平移 —— 车头朝 +Z,左侧为 +X,与节点契约一致
    </div>

    <!-- ————— 载入 / 失败浮层 ————— -->
    <div v-if="status.state === 'loading'" class="loading-card">
      <span class="spinner" aria-hidden="true"></span>
      <p>正在载入特斯拉模型</p>
      <div class="progress-track"><i :style="{ width: `${progressPercent}%` }"></i></div>
      <small>{{ progressText }}</small>
    </div>

    <div v-else-if="status.state === 'error'" class="error-card">
      <strong>载入失败</strong>
      <p>{{ status.message }}</p>
    </div>
  </main>
</template>

<script setup lang="ts">
/**
 * Tesla Model 3 整车交互页(路由 /tesla)。
 *
 * 职责:把 `public/models/2024_tesla_model_3_rigged.glb` 装进场景,并给出一块控制面板 ——
 * 四门开合、后视镜折叠、前轮转向、车轮滚动、四组灯光,外加相机预设与显示开关。
 *
 * 复用关系(本页只做"把状态与操作接起来",不自己碰 three 的渲染细节):
 * - `THREEViewer`:渲染器 / 相机 / 轨道控制 / 半球光与太阳(带阴影)/ 地板(three-engine 基础设施层)
 * - `PostEffects`:只启用 Bloom —— 车灯的自发光要靠泛光才会"亮起来";
 *   两个描边层传 `enabled: false` 关掉,这页没有选中态,不需要它们
 * - `TeslaRig`:按节点契约绑定可动节点,提供门 / 镜 / 转向 / 轮 / 灯的控制(three-engine/tesla-rig.ts)
 * - `model-loaders`:模型由 TeslaRig 内部经它加载,本页只关心进度回调
 *
 * 一个刻意的取舍:行驶只做"轮上演示"(车轮按 v/r 自转),整车不产生世界位移。
 * 位移、相机跟随属于上层玩法场景的职责,这页是"车辆状态控制台",不是驾驶模拟。
 */
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import * as THREE from 'three'
import { PMREMGenerator, type WebGPURenderer } from 'three/webgpu'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { THREEViewer } from '../../lib/three-engine/three-viewer'
import {
  PostEffects,
  DEFAULT_BLOOM_SETTINGS,
  DEFAULT_OUTLINE_SETTINGS,
  DEFAULT_HOVER_OUTLINE_SETTINGS,
} from '../../lib/three-engine/post-effects'
import {
  TeslaRig,
  TESLA_DOOR_IDS,
  TESLA_LAMP_GROUPS,
  TESLA_DOOR_OPEN_DEG,
  TESLA_MIRROR_FOLD_DEG,
  TESLA_STEER_MAX_DEG,
  TESLA_NODES_DOC_URL,
  TESLA_RIGGED_URL,
  type TeslaDoorId,
  type TeslaLampGroup,
} from '../../lib/three-engine/tesla-rig'

/** 模板里直接用这几个常量与类型化表,免得在模板里写魔法值。 */
const DOOR_ROWS: Array<{ id: TeslaDoorId; label: string }> = [
  { id: 'fl', label: '左前门' },
  { id: 'fr', label: '右前门' },
  { id: 'rl', label: '左后门' },
  { id: 'rr', label: '右后门' },
]

const LAMP_ROWS: Array<{ group: TeslaLampGroup; label: string }> = [
  { group: 'head', label: '大灯' },
  { group: 'tail', label: '尾灯' },
  { group: 'ambient', label: '车内氛围灯' },
  { group: 'door', label: '门内 LED' },
]

/** 相机预设:key 决定机位方向,label 是按钮文案。 */
type ViewPresetKey = 'front' | 'side' | 'rear' | 'top' | 'quarter'
const VIEW_PRESETS: Array<{ key: ViewPresetKey; label: string }> = [
  { key: 'quarter', label: '3/4' },
  { key: 'front', label: '前' },
  { key: 'side', label: '侧' },
  { key: 'rear', label: '后' },
  { key: 'top', label: '顶' },
]

/** 机位方向向量(车体坐标系:车头 +Z、左 +X),相机距离在 applyViewPreset 里按车长算。 */
const PRESET_DIRECTION: Record<ViewPresetKey, THREE.Vector3> = {
  front: new THREE.Vector3(0, 0.36, 1),
  side: new THREE.Vector3(1, 0.34, 0),
  rear: new THREE.Vector3(0, 0.38, -1),
  top: new THREE.Vector3(0.02, 1, 0.03),
  quarter: new THREE.Vector3(0.78, 0.42, 0.9),
}

/** 显示开关项,key 对应下方 views 的字段。 */
type ViewOptionKey = 'grid' | 'axes' | 'autoRotate'
const VIEW_OPTIONS: Array<{ key: ViewOptionKey; label: string }> = [
  { key: 'grid', label: '地面网格' },
  { key: 'axes', label: '坐标轴' },
  { key: 'autoRotate', label: '自动旋转' },
]

/** 视口挂载点(模板 ref)与资源引用。 */
const viewportRef = ref<HTMLElement | null>(null)
let baseViewer: THREEViewer | null = null
let postEffects: PostEffects | null = null
let rig: TeslaRig | null = null
let grid: THREE.GridHelper | null = null
let frame = 0
let previousTime = 0
/** 车体包围盒(载入后算一次):相机成帧与预设距离都用它。 */
let carBox: THREE.Box3 | null = null

/** 载入状态机与进度。 */
const status = reactive<{ state: 'loading' | 'ready' | 'error'; message: string }>({
  state: 'loading',
  message: '',
})
const progress = ref<number | null>(null)
const fps = ref(0)

/**
 * 界面状态 —— 与 rig 内部状态一一镜像。
 * 方向是单向的:UI 改 → 调 rig 方法 → rig 写节点;rig 不反向推动 UI,
 * 所以这里不需要监听器,直接把用户操作同时写进两边即可。
 */
const doors = reactive<Record<TeslaDoorId, number>>({ fl: 0, fr: 0, rl: 0, rr: 0 })
const mirrorFold = ref(0)
const steering = ref(0)
const speed = ref(0)
const brightness = ref(1)
const lamps = reactive<Record<TeslaLampGroup, boolean>>({
  head: false,
  tail: false,
  ambient: false,
  door: false,
})
const views = reactive<Record<ViewOptionKey, boolean>>({
  grid: true,
  axes: false,
  autoRotate: false,
})
const viewPreset = ref<ViewPresetKey>('quarter')

/** 各灯组实际绑到的材质数(诊断:为 0 说明该组在模型里没匹配上)。 */
const lampCounts = reactive<Record<TeslaLampGroup, number>>({
  head: 0,
  tail: 0,
  ambient: 0,
  door: 0,
})

/** 四个门是否都已全开(决定"全部"按钮的文案与高亮)。 */
const allDoorsOpen = computed(() => TESLA_DOOR_IDS.every((id) => doors[id] >= 1))

/** 顶栏状态文案。 */
const statusText = computed(() => {
  if (status.state === 'loading') return '载入中…'
  if (status.state === 'error') return '载入失败'
  return `${VIEW_PRESETS.length} 机位 · 4 门 · 4 灯组`
})

/** 进度条宽度:未知进度给一段固定宽度,避免看着像卡死。 */
const progressPercent = computed(() =>
  progress.value === null ? 12 : Math.max(4, Math.round(progress.value * 100)),
)
const progressText = computed(() =>
  progress.value === null ? '解析中…' : `${Math.round(progress.value * 100)}%`,
)

/** 模型信息面板(载入后才有值)。 */
const modelInfo = ref<{ size: string; wheelRadius: string; nodes: string } | null>(null)

// ————————————————————————— 生命周期 —————————————————————————

onMounted(async () => {
  const container = viewportRef.value
  if (!container) return

  baseViewer = new THREEViewer(container)
  await baseViewer.initialize()
  const { scene, camera, renderer, controls } = baseViewer.getObject()
  if (!scene || !camera || !renderer || !controls) return

  // 相机初始就停在 3/4 机位,模型一出来就是好看的视角(载入后再按真实尺寸精调一次)
  camera.position.set(5.2, 2.9, 6.2)
  controls.target.set(0, 0.72, 0)
  controls.minDistance = 3
  controls.maxDistance = 40

  configureShadows(scene)
  createEnvironment(scene, renderer)
  createFillLights(scene)
  createGrid(scene)
  createPostEffects(renderer, scene, camera)

  try {
    rig = await TeslaRig.load(scene, TESLA_RIGGED_URL, {
      onProgress: (value) => {
        progress.value = value
      },
    })
  } catch (error) {
    status.state = 'error'
    status.message = error instanceof Error ? error.message : String(error)
    return
  }

  // 部分设备的 WebGPU 后端首次编译着色器较慢,这里等一帧再报就绪,避免刚显示就掉帧
  carBox = new THREE.Box3().setFromObject(rig.root)
  fitGridToCar()
  applyViewPreset('quarter')
  syncLampCounts()
  modelInfo.value = {
    size: `${rig.size.x.toFixed(2)} × ${rig.size.y.toFixed(2)} × ${rig.size.z.toFixed(2)} m`,
    wheelRadius: `${rig.wheelRadius.toFixed(3)} m`,
    nodes: '4 门 · 2 镜 · 2 转向 · 4 轮',
  }
  status.state = 'ready'

  startLoop()
})

onUnmounted(() => {
  window.cancelAnimationFrame(frame)
  frame = 0
  rig?.dispose()
  rig = null
  if (grid) {
    grid.geometry.dispose()
    const material = grid.material as THREE.Material | THREE.Material[]
    if (Array.isArray(material)) material.forEach((item) => item.dispose())
    else material.dispose()
    grid = null
  }
  postEffects?.dispose()
  postEffects = null
  // 基础场景归本页所有(不是注入的),销毁时一并释放渲染器与控制器
  baseViewer?.destroy()
  baseViewer = null
})

// ————————————————————————— 场景搭建 —————————————————————————

/**
 * 把太阳的阴影相机收到车身上。
 *
 * THREEViewer 默认给的是 ±42 m 的阴影范围(为飞行沙盒准备的),用在一辆 4.7 m 的车上,
 * 2048² 的阴影贴图会被摊在 84 m 见方里 —— 每像素约 4 cm,车底投影会糊成一团。
 * 这里收到 ±6 m(每像素约 0.6 cm),阴影边缘立刻立起来。
 */
function configureShadows(scene: THREE.Scene): void {
  scene.traverse((object) => {
    const light = object as THREE.DirectionalLight
    if (!light.isDirectionalLight || !light.castShadow) return
    const shadowCamera = light.shadow.camera
    shadowCamera.left = -6
    shadowCamera.right = 6
    shadowCamera.top = 6
    shadowCamera.bottom = -6
    shadowCamera.near = 4
    shadowCamera.far = 60
    shadowCamera.updateProjectionMatrix()
  })
  // sun 的默认位置是 (18, 26, 14):以原点为中心的 ±6 m 盒子覆盖不到车,把它拉近一些
  baseViewer?.setShadowFocus(0, 0)
}

/** 补光:一盏冷色侧补光 + 一盏轮廓光,让车漆的高光有层次(不投影,省开销)。 */
function createFillLights(scene: THREE.Scene): void {
  const fill = new THREE.DirectionalLight(0xcfe6ff, 1.2)
  fill.position.set(-6, 4, 5)
  scene.add(fill)

  const rim = new THREE.DirectionalLight(0xffffff, 0.9)
  rim.position.set(-2, 5, -7)
  scene.add(rim)
}

/**
 * 环境贴图(IBL):用 RoomEnvironment 生成一张室内照明环境的预滤波贴图挂到 scene.environment。
 *
 * 没有它,车漆只有几盏直射光、金属度和反射都无处安放 —— 玻璃尤其吃亏:一层暗色半透明,
 * 看不出任何"玻璃"质感。挂上后车漆出现高光流动、玻璃有了明确的反射源(rig 里已把
 * 玻璃的 envMapIntensity 抬高),观感立刻从"哑光塑料"变成"漆面 + 玻璃"。
 * WebGPURenderer 配套的 PMREMGenerator 从 three/webgpu 导入,用法与 WebGL 版一致。
 */
function createEnvironment(scene: THREE.Scene, renderer: WebGPURenderer): void {
  const pmrem = new PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()
}

/** 地面网格:THREEViewer 内置环境里只有地板没有网格,这里补一个。 */
function createGrid(scene: THREE.Scene): void {
  grid = new THREE.GridHelper(20, 20, 0x3d6b6f, 0x1f3a3e)
  const material = grid.material as THREE.Material
  material.transparent = true
  material.opacity = 0.5
  grid.position.y = 0.002
  scene.add(grid)
}

/** 网格铺开范围按车长取整,车小网格就不该铺得漫无边际。 */
function fitGridToCar(): void {
  if (!grid || !carBox) return
  const size = carBox.getSize(new THREE.Vector3())
  const span = Math.max(size.x, size.z)
  grid.scale.setScalar(Math.max(1, span / 4))
}

/**
 * 建后处理管线。这页只用 Bloom:车灯点亮后靠泛光才会"糊"出光晕。
 * 阈值刻意高于共用默认(0.85 → 1.9):贴膜玻璃上有 >1.0 的过曝高光带
 * (直射太阳的镜面反射,真实玻璃在强光下也会过曝),默认阈值会把这层
 * 白带炸成一大团白雾;而车灯的自发光峰值 1.2~5.2,大灯/尾灯在默认亮度下
 * 仍高于 1.9 保留光晕,氛围灯/门内 LED 在低亮度时不起晕属可接受取舍。
 * 两个描边层传 disabled(这页没有选中 / 悬停态),失败时降级为直接渲染。
 */
function createPostEffects(
  renderer: NonNullable<ReturnType<THREEViewer['getObject']>['renderer']>,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): void {
  try {
    postEffects = new PostEffects(
      renderer,
      scene,
      camera,
      { ...DEFAULT_BLOOM_SETTINGS, threshold: 1.9, strength: 0.6 },
      { ...DEFAULT_OUTLINE_SETTINGS, enabled: false },
      { ...DEFAULT_HOVER_OUTLINE_SETTINGS, enabled: false },
    )
  } catch (error) {
    console.warn('[TeslaViewer] 后处理管线初始化失败,已降级为直接渲染:', error)
    postEffects = null
  }
}

/** 载入后回读各灯组的材质数,填进面板(为 0 时能一眼看出契约对不上)。 */
function syncLampCounts(): void {
  if (!rig) return
  for (const group of TESLA_LAMP_GROUPS) lampCounts[group] = rig.getLampMaterialCount(group)
}

// ————————————————————————— 主循环 —————————————————————————

/**
 * 渲染循环:推进车辆状态 → 更新轨道控制 → 出图。
 * 单帧上限 0.1 s,切标签页回来时车轮不会一次转过一大圈。
 */
function startLoop(): void {
  const render = (timestamp: number): void => {
    frame = window.requestAnimationFrame(render)
    const delta = previousTime ? Math.min((timestamp - previousTime) / 1000, 0.1) : 1 / 60
    previousTime = timestamp

    rig?.update(delta)
    const viewer = baseViewer?.getObject()
    if (!viewer) return
    viewer.controls?.update()

    if (!viewer.scene || !viewer.camera || !viewer.renderer) return
    if (postEffects) postEffects.pipeline.render()
    else viewer.renderer.render(viewer.scene, viewer.camera)

    updateFps(timestamp)
  }
  previousTime = performance.now()
  frame = window.requestAnimationFrame(render)
}

/** 帧率统计(0.5 s 一次)。 */
let fpsFrames = 0
let fpsStart = 0
function updateFps(timestamp: number): void {
  fpsFrames += 1
  if (!fpsStart) fpsStart = timestamp
  const elapsed = timestamp - fpsStart
  if (elapsed < 500) return
  fps.value = Math.round((fpsFrames * 1000) / elapsed)
  fpsFrames = 0
  fpsStart = timestamp
}

// ————————————————————————— 车门 —————————————————————————

/** 拖动某个门的滑块。 */
function onDoorInput(id: TeslaDoorId, event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  doors[id] = value
  rig?.setDoor(id, value)
}

/** 一键开 / 关前门或后门。 */
function setDoorRow(row: 'front' | 'rear', open: number): void {
  const ids: TeslaDoorId[] = row === 'front' ? ['fl', 'fr'] : ['rl', 'rr']
  for (const id of ids) doors[id] = open
  rig?.setDoorRow(row, open)
}

/** 四个门一起开 / 关(按当前是否全开来决定方向)。 */
function toggleAllDoors(): void {
  const next = allDoorsOpen.value ? 0 : 1
  for (const id of TESLA_DOOR_IDS) doors[id] = next
  rig?.setAllDoors(next)
}

// ————————————————————————— 后视镜 —————————————————————————

/**
 * 设置后视镜折叠度(0 = 展开,1 = 全折)。
 * 拖动滑块与点按钮都走这里,避免两处各写一遍状态同步。
 */
function setMirrorFold(value: number): void {
  mirrorFold.value = value
  rig?.setAllMirrors(value)
}

/** 拖动后视镜滑块。 */
function onMirrorInput(event: Event): void {
  setMirrorFold(Number((event.target as HTMLInputElement).value))
}

// ————————————————————————— 行驶 —————————————————————————

/** 拖动转向滑块(正值左转,与 rig 的约定一致)。 */
function onSteeringInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  steering.value = value
  rig?.setSteering(value)
}

/** 拖动车速滑块。 */
function onSpeedInput(event: Event): void {
  setSpeed(Number((event.target as HTMLInputElement).value))
}

/** 设车速(同时更新面板显示)。 */
function setSpeed(value: number): void {
  speed.value = value
  rig?.setSpeed(value)
}

// ————————————————————————— 灯光 —————————————————————————

/** 开关一组灯。 */
function setLamp(group: TeslaLampGroup, on: boolean): void {
  lamps[group] = on
  rig?.setLamp(group, on)
}

/** 四组灯一起开 / 关。 */
function setAllLamps(on: boolean): void {
  for (const group of TESLA_LAMP_GROUPS) setLamp(group, on)
}

/** 拖动亮度滑块。 */
function onBrightnessInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  brightness.value = value
  rig?.setBrightness(value)
}

// ————————————————————————— 视角 —————————————————————————

/**
 * 切到某个预设机位:按车长算出合适的观察距离,把相机放到该方向的球面上,再对准车辆中心。
 * 相机与 controls.target 一起改,否则轨道控制的旋转中心还停在旧位置,拖一下就飞了。
 */
function applyViewPreset(key: ViewPresetKey): void {
  viewPreset.value = key
  const viewer = baseViewer?.getObject()
  if (!viewer?.camera || !viewer.controls || !carBox) return

  const center = carBox.getCenter(new THREE.Vector3())
  const radius = carBox.getBoundingSphere(new THREE.Sphere()).radius
  // 距离取包围球半径的 2.3 倍:52° 视场下车身大约占到画面的六成,留出转动余量
  const distance = Math.max(radius * 2.3, 5)
  const direction = PRESET_DIRECTION[key].clone().normalize()

  viewer.controls.target.copy(center)
  viewer.camera.position.copy(center).addScaledVector(direction, distance)
  viewer.camera.lookAt(center)
  viewer.controls.update()
}

/** 打开 / 关闭显示项。 */
function setViewOption(key: ViewOptionKey, value: boolean): void {
  views[key] = value
  const controls = baseViewer?.getObject().controls
  if (key === 'grid') {
    if (grid) grid.visible = value
  } else if (key === 'axes') {
    baseViewer?.setAxesVisible(value)
  } else if (controls) {
    controls.autoRotate = value
    controls.autoRotateSpeed = 1.2
  }
}
</script>

<style scoped lang="scss">
/* ————— 页面根容器与视口(画布由 THREEViewer 注入) ————— */
.tesla-lab {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 620px;
  overflow: hidden;
  color: #ecfaf6;
  background: #071116;
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
}
.viewport {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.viewport :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}

/* ————— 顶栏 ————— */
.top-bar {
  position: absolute;
  top: 16px;
  left: 50%;
  z-index: 6;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 16px;
  background: rgb(7 17 22 / 88%);
  border: 1px solid rgb(121 230 202 / 34%);
  border-radius: 22px;
  box-shadow: 0 12px 30px rgb(0 0 0 / 30%);
  backdrop-filter: blur(10px);
  transform: translateX(-50%);
}
.top-bar h1 {
  margin: 0;
  color: #d8fff5;
  font:
    700 12px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.top-meta {
  color: #638f88;
  font:
    500 9px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: nowrap;
}
.top-link {
  color: #bfe8de;
  font:
    500 9px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  text-decoration: none;
  padding: 4px 10px;
  background: rgb(30 63 65 / 55%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 12px;
  transition: 0.15s ease;
}
.top-link:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
  border-color: rgb(121 230 202 / 45%);
}

/* ————— 控制面板 ————— */
.panel {
  position: absolute;
  top: 16px;
  left: 16px;
  bottom: 56px;
  z-index: 5;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 268px;
  padding: 12px 13px;
  overflow-y: auto;
  color: #d8fff5;
  background: rgb(7 17 22 / 88%);
  border: 1px solid rgb(121 230 202 / 30%);
  border-radius: 6px;
  box-shadow: 0 12px 30px rgb(0 0 0 / 26%);
  backdrop-filter: blur(10px);
}
.panel::-webkit-scrollbar {
  width: 5px;
}
.panel::-webkit-scrollbar-thumb {
  background: rgb(121 230 202 / 25%);
  border-radius: 3px;
}

.section {
  flex: none;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid rgb(121 230 202 / 14%);
}
.section:last-child {
  padding-bottom: 0;
  margin-bottom: 0;
  border-bottom: none;
}
.section h3 {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin: 0 0 9px;
  color: #9ff1dc;
  font:
    700 9.5px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.1em;
}
.section h3 small {
  color: #4d7771;
  font-size: 8px;
  font-weight: 500;
  letter-spacing: 0.04em;
}

/* 滑块行:标签在左、数值在右、滑块独占一行 */
.slider-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  align-items: center;
  margin-bottom: 8px;
}
.slider-label {
  color: #bfe8de;
  font:
    500 10px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  white-space: nowrap;
}
.slider-row strong {
  color: #9ff1dc;
  font:
    600 9.5px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.slider-row input[type='range'] {
  grid-column: 1 / -1;
  width: 100%;
  height: 3px;
  margin: 3px 0 0;
  appearance: none;
  background: rgb(121 230 202 / 20%);
  border-radius: 2px;
  outline: none;
}
.slider-row input[type='range']::-webkit-slider-thumb {
  width: 12px;
  height: 12px;
  appearance: none;
  background: #79e6ca;
  border: 1px solid #b4ffeb;
  border-radius: 50%;
  cursor: pointer;
  transition: 0.12s ease;
}
.slider-row input[type='range']::-webkit-slider-thumb:hover {
  background: #9ff1dc;
  box-shadow: 0 0 8px rgb(121 230 202 / 55%);
}

/* 开关行:文字在左、二选一按钮在右 */
.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  color: #bfe8de;
  font:
    500 10px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
}
.lamp-count {
  margin-left: 4px;
  color: #4d7771;
  font:
    400 8px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  font-style: normal;
}

/* 分段按钮(开 / 关)与操作按钮行 */
.segmented.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3px;
  width: 82px;
}
.button-row {
  display: grid;
  gap: 4px;
  margin-top: 4px;
}
.button-row.two {
  grid-template-columns: repeat(2, 1fr);
}
.button-row.three {
  grid-template-columns: repeat(3, 1fr);
}
.segmented button,
.button-row button {
  padding: 5px 0;
  color: #bfe8de;
  background: rgb(30 63 65 / 55%);
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 3px;
  font:
    500 9px/1.2 ui-sans-serif,
    system-ui,
    sans-serif;
  cursor: pointer;
  transition: 0.15s ease;
  white-space: nowrap;
}
.segmented button:hover,
.button-row button:hover {
  color: #eafff8;
  background: rgb(48 92 92 / 65%);
  border-color: rgb(121 230 202 / 45%);
}
.segmented button.active,
.button-row button.active {
  color: #06201d;
  background: #79e6ca;
  border-color: #b4ffeb;
  font-weight: 600;
}

/* 模型信息网格 */
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 8px;
  margin: 0;
}
.info-grid div {
  min-width: 0;
}
.info-grid dt {
  color: #557873;
  font:
    400 8px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.info-grid dd {
  margin: 1px 0 0;
  overflow: hidden;
  color: #d8fff5;
  font:
    500 9.5px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ————— 底部提示 ————— */
.hint-bar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  z-index: 5;
  padding: 6px 14px;
  color: #638f88;
  background: rgb(7 17 22 / 82%);
  border: 1px solid rgb(121 230 202 / 18%);
  border-radius: 14px;
  font:
    400 9px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
  transform: translateX(-50%);
  white-space: nowrap;
}

/* ————— 载入 / 失败浮层 ————— */
.loading-card,
.error-card {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 8;
  padding: 22px 30px;
  text-align: center;
  background: rgb(7 17 22 / 92%);
  border: 1px solid rgb(121 230 202 / 34%);
  border-radius: 8px;
  box-shadow: 0 18px 40px rgb(0 0 0 / 40%);
  transform: translate(-50%, -50%);
}
.loading-card p,
.error-card p {
  margin: 0 0 10px;
  color: #bfe8de;
  font:
    500 11px/1.4 ui-sans-serif,
    system-ui,
    sans-serif;
}
.error-card strong {
  display: block;
  margin-bottom: 6px;
  color: #ff9d8a;
  font:
    700 12px/1.3 ui-sans-serif,
    system-ui,
    sans-serif;
}
.loading-card small {
  color: #638f88;
  font:
    400 9px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.spinner {
  display: block;
  width: 22px;
  height: 22px;
  margin: 0 auto 12px;
  border: 2px solid rgb(121 230 202 / 25%);
  border-top-color: #79e6ca;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.progress-track {
  width: 190px;
  height: 3px;
  margin: 0 auto 8px;
  overflow: hidden;
  background: rgb(121 230 202 / 16%);
  border-radius: 2px;
}
.progress-track i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #4ad9ff, #79e6ca);
  transition: width 0.2s ease;
}
</style>
