<script setup lang="ts">
/**
 * three-engine 库调用示例页。
 *
 * 页面本身就是"消费方":所有能力都从库入口 `@/lib`(即打包后的 `three-engine`)导入,
 * 不碰 src/lib 里的任何内部文件。四个标签页对应库的四层用法,右侧是真实运行的实例,
 * 左侧是**与运行代码同源**的调用片段 —— 改这一页的代码就是改那段片段。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
} from 'vue'
import * as THREE from 'three'
// 演示 05 要自己造渲染器与轨道控制(证明注入生效),所以按值引入
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  CAMERA_MODE_LIST,
  DEFAULT_OBSTACLES,
  DroneSim,
  DroneWorld,
  GameInstance,
  GlbViewer,
  THREEViewer,
} from '@/lib'
import type {
  CameraMode,
  DroneSnapshot,
  GlbLoadStatus,
  GlbModelStats,
  PhotoShot,
  SimEvent,
} from '@/lib'
import CodeBlock from './CodeBlock.vue'

// ────────────────────────────────────────────────────────────────────────────
// 标签页定义:每层一段说明 + 一段可直接抄走的代码
// ────────────────────────────────────────────────────────────────────────────

/** 五个标签页的键(与 TABS 的 key 一一对应) */
type DemoTab = 'sim' | 'world' | 'sandbox' | 'glb' | 'inject'

/** 单个标签页的元数据:左侧说明文案 + 中间"与运行代码同源"的代码片段 */
interface TabMeta {
  key: DemoTab
  step: string
  title: string
  subtitle: string
  lead: string
  points: string[]
  file: string
  code: string
}

const TABS: TabMeta[] = [
  {
    // 01 纯逻辑层:DroneSim 的固定步长循环(零依赖,可跑在 Node / Worker)
    key: 'sim',
    step: '01',
    title: '纯逻辑层',
    subtitle: 'DroneSim · 零依赖',
    lead: '飞控状态机、电池模型、失效保护、摇杆归一化、避障判定全都在这一个类里,不引 three、不碰 DOM —— 可以直接丢进 Node 脚本或 Web Worker 跑。',
    points: [
      '状态只能由 step() 推进,与渲染帧率解耦(固定步长)',
      'snapshot() 返回纯数据快照,想怎么渲染都行',
      '本层依赖为 0,是唯一能单独在服务端运行的部分',
    ],
    file: '纯逻辑层 · 无渲染',
    code: `import { DroneSim } from 'three-engine'

// 零依赖:不引 three、不碰 DOM,Node / Web Worker 里同样能跑
const sim = new DroneSim()
sim.powerOn()                 // 上电 → 自检 → 传感器预热 → 待机
sim.autoTakeOff()             // 待机后一键起飞(未就绪时返回 false)

// 固定步长推进:仿真节奏与渲染帧率、时间倍速都无关
let acc = 0
function tick(deltaSeconds) {
  acc += deltaSeconds
  while (acc >= 1 / 60) {
    sim.step(1 / 60)
    acc -= 1 / 60
  }
}

// 状态是纯数据快照
const snap = sim.snapshot()
console.log(snap.phaseLabel, snap.altitude, snap.batteryPercent)

sim.setStick({ throttle: 0.3, pitch: 0.5 })   // 摇杆量(-1~1)
sim.forceBatteryLevel(18)                     // 强制电量,看低电告警/返航
sim.startRth('低电量')                        // 智能返航
sim.emergencyStop()                           // 停桨:空中会被拒绝,须先落地`,
  },
  {
    // 02 场景底座:THREEViewer + DroneWorld,渲染循环由调用方自己写
    key: 'world',
    step: '02',
    title: '场景底座',
    subtitle: 'THREEViewer + DroneWorld',
    lead: 'THREEViewer 负责渲染器/相机/灯光/轨道控制;DroneWorld 负责地面网格、返航点、障碍物与航迹。障碍物列表同时喂给仿真内核做 AABB 避障,可视化与物理共用一份数据。',
    points: [
      'THREEViewer 只建场景,渲染循环由调用方自己写',
      'three 是你的依赖:库不 import three,只用你传进去的实例',
      'DroneWorld.collisionBoxes 就是仿真侧判定用的 AABB',
    ],
    file: '场景底座 · 自建渲染循环',
    code: `import * as THREE from 'three'
import { THREEViewer, DroneWorld, DEFAULT_OBSTACLES } from 'three-engine'

const viewer = new THREEViewer(container)   // 渲染器 + 相机 + 灯光 + 轨道控制
await viewer.initialize()

const { scene, camera, renderer, controls } = viewer.getObject()
// 地面网格、返航点标记、障碍物、航迹尾迹(障碍物同时是避障 AABB)
const world = new DroneWorld(scene, DEFAULT_OBSTACLES)

// 自己建一个对象飞起来,把轨迹喂给 world
const marker = new THREE.Mesh(
  new THREE.SphereGeometry(0.25, 24, 16),
  new THREE.MeshStandardMaterial({ color: '#57e0c0', emissive: '#1d6b58' }),
)
scene.add(marker)

function loop() {
  requestAnimationFrame(loop)
  t += 1 / 60
  marker.position.set(Math.cos(t) * 12, 4 + Math.sin(t * 2) * 1.5, Math.sin(t) * 12)
  world.pushTrail(marker.position.x, marker.position.y, marker.position.z)
  viewer.setShadowFocus(marker.position.x, marker.position.z)  // 太阳跟着走,才不会飞出阴影范围
  controls?.update()
  renderer?.render(scene, camera)
}
loop()

world.setObstaclesVisible(false)   // 障碍物显隐
world.clearTrail()                 // 清空航迹
viewer.setAxesVisible(true)        // 世界坐标轴`,
  },
  {
    // 03 完整装配:GameInstance 一行起一个可渲染的飞行沙盒
    key: 'sandbox',
    step: '03',
    title: '完整装配',
    subtitle: 'GameInstance',
    lead: '把上面几层拼成一个可渲染的飞行沙盒:一行 new 出实例,内部自动装配仿真内核、模型机械、灯光、雷达并启动渲染循环。/dji 那个页面用的就是这个类。',
    points: [
      '模型解析是异步的:轮询 game.ready 变 true 再操作机械',
      'sim 是权威状态源,遥测与管理都从同一份状态读',
      '折叠机臂是机构动画,setArmFoldTarget 后要等它动到位',
    ],
    file: '完整装配 · 一行起场景',
    code: `import { GameInstance } from 'three-engine'

// 一行装配:渲染器 + 飞行仿真 + 模型机械 + 灯光 + 测距雷达 + 内建渲染循环
const game = new GameInstance(container)
const fly = game.droneFly!          // 模型载入后才有

// 模型是异步解析的,等 ready
await new Promise((resolve) => {
  const check = () => (game.ready ? resolve() : requestAnimationFrame(check))
  check()
})

fly.setCameraMode('fpv')      // orbit 观察者 | follow 跟随 | fpv 机载
fly.setArmFoldTarget(0)       // 0 展开机臂 / 1 收纳(机构动画,不是瞬变)
fly.sim.autoTakeOff()         // 仿真内核:起飞 / 降落 / 返航都在这
fly.setGimbalPitch(-45)       // 云台俯仰 −90°~+60°

// 遥测与快照
const { altitudeMeters, speedMetersPerSecond } = game.getDroneTelemetry()
const snap = game.getSnapshot()        // phaseLabel / batteryPercent / armFold …

// 云台取景拍照(与机载视角同一取景);录像是 startRecording()/stopRecording()
const shot = await fly.requestPhoto()  // { dataUrl, width, height } 或 null`,
  },
  {
    // 04 模型查看器:GlbViewer 加载任意 GLB 并做检查/高亮
    key: 'glb',
    step: '04',
    title: '模型查看器',
    subtitle: 'GlbViewer',
    lead: '面向任意 GLB 的通用查看器:模型树、画布点选与描边高亮、爆炸图、线框、骨骼动画时间轴、节点显隐、选中部件导出。它同样只依赖 three 与容器元素。',
    points: [
      'onStatus 回调给出 loading/ready/error 与进度',
      '含骨节的部件自动跳过爆炸图(骨节位移会覆盖爆炸偏移)',
      '骨骼动画是写时间 + 单帧求值,可以精确 seek 到某一刻',
    ],
    file: '模型查看器 · 通用 GLB',
    code: `import { GlbViewer } from 'three-engine'

const viewer = new GlbViewer(container)
viewer.onStatus = (status) => console.log(status.state, status.progress)
await viewer.init()

await viewer.loadFromUrl('/models/djiair_renamed.glb')
// 也可以:await viewer.loadFromFile(file)  ← 拖拽 / 文件选择框

viewer.setAutoRotate(true)
viewer.setSkeletonVisible(true)     // 骨骼辅助线
viewer.setWireframe(true)
viewer.setExplode(0.4)              // 爆炸图 0~1
viewer.setNodeVisible(nodeId, false)  // 按节点显隐

const stats = viewer.getStats()     // nodes / meshes / triangles / bones / animations
const anim = viewer.getAnimationState()
viewer.seek(1.2)                    // 骨骼动画时间轴(秒)
viewer.stepFrame(-1)                // 单帧步进
const result = await viewer.exportSelected()  // 导出选中部件为 GLB`,
  },
  {
    // 05 资源注入:scene / camera / renderer / controls 由调用方提供
    key: 'inject',
    step: '05',
    title: '资源注入',
    subtitle: 'THREEViewer · 自带四要素',
    lead: 'THREEViewer 的 scene / camera / renderer / controls 都可以由调用方传进去:传了的用你的,没传的照旧由它自己创建。要把沙盒塞进已有的 three 工程(渲染器、后处理、UI 都要自己掌控)时,这是唯一需要的开关。',
    points: [
      '四项各自可选:只传 controls、只传 camera 都行,未传项保持默认创建逻辑',
      '注入的实例归调用方所有:库不改它的参数、不 dispose、也不抢 canvas 的 DOM 归属',
      'environment: false 可跳过内置灯光 / 兜底地板 / 坐标轴(自带环境的大场景用)',
      'renderer.init() 幂等:已初始化过的渲染器会被直接复用,不会二次初始化',
    ],
    file: '场景底座 · 注入自己的四要素',
    code: `import * as THREE from 'three'
import { THREEViewer } from 'three-engine'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

// 1) 自己造四要素 —— 不传的那一项才由 THREEViewer 新建
const scene = new THREE.Scene()                    // 我自己的场景
scene.background = new THREE.Color('#101d24')      // 我的背景色不会被覆盖
const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 500)
camera.position.set(4.6, 3.2, 6.2)                 // 我的机位不会被改写
const renderer = new WebGPURenderer({ antialias: true })
await renderer.init()                              // 先 init 也行:库内部 init() 幂等
const controls = new OrbitControls(camera, renderer.domElement)

// 2) 传给 THREEViewer
const viewer = new THREEViewer(container, {
  scene, camera, renderer, controls,
  environment: false,   // 自带灯光/地面的场景可跳过内置环境
})
await viewer.initialize()

// 3) 用的就是你的实例:身份不变、参数不变
const got = viewer.getObject()
got.scene === scene && got.camera === camera       // true

// 想只注入一部分?其余照旧由库创建
const viewer2 = new THREEViewer(anotherHost, { camera })

// 4) 归属:注入的实例归调用方 —— 库不 dispose 它们,
//    只把自己挂上去的 canvas 在 destroy() 时摘下来
viewer.destroy()
await renderer.dispose()`,
  },
]

const activeTab = ref<DemoTab>('sim')
// 当前标签对应的元数据;未匹配时回退到首项,保证中间面板始终有内容
const current = computed(() => TABS.find((tab) => tab.key === activeTab.value) ?? TABS[0]!)

// ────────────────────────────────────────────────────────────────────────────
// 演示 01 · DroneSim(自带固定步长循环,不依赖渲染)
// ────────────────────────────────────────────────────────────────────────────

// 仿真固定步长 1/60 秒:推进量与渲染帧率、时间倍速都无关
const FIXED_STEP = 1 / 60
/** 状态机全相位(含返航/坠落/停桨等分支相位),相位条按它高亮 */
const PHASE_ORDER = [
  'powerOff',
  'selfCheck',
  'warmingUp',
  'standby',
  'motorsOn',
  'takingOff',
  'flying',
  'rth',
  'landing',
  'emergency',
  'stopped',
] as const

// 演示 01 状态:实例用 shallowRef(内部状态不需深响应,UI 全靠快照驱动)
const simRef = shallowRef<DroneSim | null>(null)
const simSnap = ref<DroneSnapshot | null>(null)
const simLog = ref<SimEvent[]>([])
const simRunning = ref(false)
const simMessage = ref('点“上电”开始:2.6 秒自检 + 2.4 秒预热后进入待机')
const simBattery = ref(100)

// 循环用非响应式句柄/计时器(放 ref 里会无谓触发渲染)
let simRaf = 0
let simLastTs = 0
let simAccumulator = 0
let simUiClock = 0
let simPendingTakeoff = false

/** 仿真主循环:按固定步长推进 step(),并每 100ms 刷新一次 UI */
function simTick(timestamp: number): void {
  simRaf = window.requestAnimationFrame(simTick)
  const sim = simRef.value
  if (!sim) return
  const delta = simLastTs ? Math.min((timestamp - simLastTs) / 1000, 0.5) : FIXED_STEP
  simLastTs = timestamp

  // 固定步长累加器:一帧最多补 240 步,防止切回标签页时"追帧"卡死
  simAccumulator += delta
  let steps = 0
  while (simAccumulator >= FIXED_STEP && steps < 240) {
    sim.step(FIXED_STEP)
    simAccumulator -= FIXED_STEP
    steps += 1
  }

  // 排队中的起飞:一旦进入待机就执行(autoTakeOff 未就绪时会返回 false)
  if (simPendingTakeoff && sim.phase === 'standby') {
    simPendingTakeoff = false
    simMessage.value = sim.autoTakeOff() ? '已起飞,自动上升至 1.2 米' : '起飞被拒绝(检查未通过)'
  }

  // UI 不必跟满 60fps,100ms 刷一次就够
  simUiClock += delta
  if (simUiClock >= 0.1) {
    simUiClock = 0
    const snap = sim.snapshot()
    simSnap.value = snap
    simLog.value = snap.events.slice(0, 7)
  }
}

/** 上电:进入"自检 → 预热 → 待机"流程 */
function simPowerOn(): void {
  const sim = simRef.value
  if (!sim) return
  sim.powerOn()
  simMessage.value = '已上电,开始自检'
}

/** 一键起飞:未上电则先上电并排队;待机/电机已启则直接起飞,否则排队等待 */
function simTakeoff(): void {
  const sim = simRef.value
  if (!sim) return
  if (sim.phase === 'powerOff' || sim.phase === 'stopped') {
    sim.powerOn()
    simPendingTakeoff = true
    simMessage.value = '已上电,等自检 + 预热走完自动起飞'
    return
  }
  if (sim.phase === 'standby' || sim.phase === 'motorsOn') {
    simMessage.value = sim.autoTakeOff()
      ? '已起飞,自动上升至 1.2 米'
      : '起飞被拒绝(起飞前检查未通过)'
    return
  }
  simPendingTakeoff = true
  simMessage.value = '已排队:当前阶段结束后立刻起飞'
}

/** 自动降落(会顺带取消排队中的起飞) */
function simLand(): void {
  const sim = simRef.value
  if (!sim) return
  simPendingTakeoff = false
  simMessage.value = sim.startLanding() ? '开始自动降落(落地 1.2 秒后停桨)' : '当前状态不能降落'
}

/** 停桨:空中会被拒绝,必须先降落 */
function simStopMotors(): void {
  const sim = simRef.value
  if (!sim) return
  simMessage.value = sim.emergencyStop() ? '电机已停止' : '空中拒绝停桨 —— 请先降落(看事件日志)'
}

/** 手动触发智能返航(仅飞行中可用) */
function simRth(): void {
  const sim = simRef.value
  if (!sim) return
  simMessage.value = sim.startRth('手动触发') ? '已触发智能返航' : '仅在飞行中可触发返航'
}

/** 重置仿真到初始态 */
function simReset(): void {
  const sim = simRef.value
  if (!sim) return
  simPendingTakeoff = false
  sim.reset()
  simMessage.value = '已重置'
}

/** 滑块强制电量:同步 UI 并把值推给仿真内核 */
function simSetBattery(value: number): void {
  simBattery.value = value
  simRef.value?.forceBatteryLevel(value)
}

/** 当前相位在 PHASE_ORDER 里的下标(未知相位回退 0),供相位条高亮 */
const simPhaseIndex = computed(() => {
  const phase = simSnap.value?.phase ?? 'powerOff'
  const index = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number])
  return index < 0 ? 0 : index
})

// ────────────────────────────────────────────────────────────────────────────
// 演示 02 · THREEViewer + DroneWorld(自己写渲染循环)
// ────────────────────────────────────────────────────────────────────────────

// 演示 02 响应式状态(实例与非响应式循环句柄见下方 let)
const worldHost = ref<HTMLElement | null>(null)
const worldReady = ref(false)
const worldError = ref('')
const worldObstaclesVisible = ref(true)
const worldAxesVisible = ref(false)
const worldFlying = ref(true)
const worldPosition = reactive({ x: 0, y: 0, z: 0 })
const worldPhase = ref(0)
// 模板里不要直接读实例变量(let 绑定在模板侧会被窄化成 null),统一用响应式状态暴露
const worldCounts = reactive({ obstacles: 0, boxes: 0 })

// 演示 02 的实例/循环句柄:不进响应式,避免无谓更新
let worldViewer: THREEViewer | null = null
let worldWorld: DroneWorld | null = null
let worldMarker: THREE.Mesh | null = null
let worldRaf = 0
let worldLastTs = 0
let worldClock = 0
let worldToken = 0

/** 装配场景底座:建 viewer / DroneWorld / 飞行标记,并自建渲染循环 */
async function mountWorldDemo(): Promise<void> {
  const host = worldHost.value
  if (!host) return
  const token = ++worldToken
  worldReady.value = false
  worldError.value = ''
  worldClock = 0
  worldPhase.value = 0

  const viewer = new THREEViewer(host)
  await viewer.initialize()
  if (token !== worldToken) {
    viewer.destroy()
    return
  }
  worldViewer = viewer

  const { scene, camera, renderer, controls } = viewer.getObject()
  if (!scene || !camera || !renderer) {
    worldError.value = '渲染器初始化失败'
    return
  }
  // 与库配套的场景辅助:地面、返航点、障碍物、航迹(带默认障碍物)
  const world = new DroneWorld(scene, DEFAULT_OBSTACLES)
  worldWorld = world
  worldCounts.obstacles = world.specs.length
  worldCounts.boxes = world.collisionBoxes.length

  // three 是使用方自己的依赖:要加自己的对象,直接 import three 就行
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 24, 16),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#57e0c0'),
      emissive: new THREE.Color('#1d6b58'),
      emissiveIntensity: 1.6,
      roughness: 0.4,
    }),
  )
  marker.castShadow = true
  scene.add(marker)
  worldMarker = marker

  viewer.setAxesVisible(worldAxesVisible.value)
  world.setObstaclesVisible(worldObstaclesVisible.value)
  worldReady.value = true

  const render = (timestamp: number): void => {
    worldRaf = window.requestAnimationFrame(render)
    const delta = worldLastTs ? Math.min((timestamp - worldLastTs) / 1000, 0.2) : FIXED_STEP
    worldLastTs = timestamp
    if (worldFlying.value) worldClock += delta

    marker.position.set(
      Math.cos(worldClock * 0.55) * 12,
      4 + Math.sin(worldClock * 1.1) * 1.5,
      Math.sin(worldClock * 0.55) * 12,
    )
    // 每移动 0.25 米落一个点(内部节流),不会把缓冲撑爆
    world.pushTrail(marker.position.x, marker.position.y, marker.position.z)
    viewer.setShadowFocus(marker.position.x, marker.position.z)
    controls?.update()
    renderer.render(scene, camera)

    worldPhase.value += delta
    if (worldPhase.value >= 0.1) {
      worldPhase.value = 0
      worldPosition.x = Number(marker.position.x.toFixed(2))
      worldPosition.y = Number(marker.position.y.toFixed(2))
      worldPosition.z = Number(marker.position.z.toFixed(2))
    }
  }
  worldLastTs = 0
  worldRaf = window.requestAnimationFrame(render)
}

/** 拆解演示 02:停循环、释放自建对象、销毁 viewer 与 world */
function unmountWorldDemo(): void {
  worldToken += 1
  window.cancelAnimationFrame(worldRaf)
  worldRaf = 0
  worldReady.value = false
  worldMarker?.geometry.dispose()
  ;(worldMarker?.material as THREE.Material | undefined)?.dispose()
  worldMarker = null
  worldWorld?.destroy()
  worldWorld = null
  worldViewer?.destroy()
  worldViewer = null
}

/** 切换障碍物显隐 */
function worldToggleObstacles(): void {
  worldObstaclesVisible.value = !worldObstaclesVisible.value
  worldWorld?.setObstaclesVisible(worldObstaclesVisible.value)
}

/** 切换世界坐标轴显隐 */
function worldToggleAxes(): void {
  worldAxesVisible.value = !worldAxesVisible.value
  worldViewer?.setAxesVisible(worldAxesVisible.value)
}

/** 清空航迹尾迹 */
function worldClearTrail(): void {
  worldWorld?.clearTrail()
}

// ────────────────────────────────────────────────────────────────────────────
// 演示 03 · GameInstance(完整飞行沙盒)
// ────────────────────────────────────────────────────────────────────────────

// 演示 03 响应式状态:相机模式 / 遥测 / 快照 / 拍照结果 / 提示文案
const sandboxHost = ref<HTMLElement | null>(null)
const sandboxReady = ref(false)
const sandboxError = ref('')
const sandboxMode = ref<CameraMode>('orbit')
const sandboxSnapshot = ref<DroneSnapshot | null>(null)
const sandboxTelemetry = reactive({ altitudeMeters: 0, speedMetersPerSecond: 0, isFlying: false })
const sandboxFps = ref(0)
const sandboxMessage = ref('展开机臂 → 一键起飞,和真机流程一致')
const sandboxPhoto = ref<PhotoShot | null>(null)
const sandboxShooting = ref(false)

// 演示 03 的实例/轮询句柄:game 与轮询 timer 不进响应式
let sandboxGame: GameInstance | null = null
let sandboxToken = 0
let sandboxPoll = 0
let sandboxPendingTakeoff = false

/** 装配完整沙盒:new GameInstance 即自动建场景,靠轮询 game.ready 等模型就绪 */
async function mountSandboxDemo(): Promise<void> {
  const host = sandboxHost.value
  if (!host) return
  const token = ++sandboxToken
  sandboxReady.value = false
  sandboxError.value = ''
  sandboxSnapshot.value = null
  sandboxPhoto.value = null

  const game = new GameInstance(host) // 构造即开始装配 + 启动渲染循环
  sandboxGame = game

  // 模型是异步载入的:轮询 game.ready(内部是 droneFly.rig 是否存在)
  sandboxPoll = window.setInterval(() => {
    if (token !== sandboxToken || sandboxGame !== game) return
    sandboxReady.value = game.ready
    sandboxFps.value = game.getFps()
    const snap = game.getSnapshot()
    sandboxSnapshot.value = snap
    const telemetry = game.getDroneTelemetry()
    sandboxTelemetry.altitudeMeters = Number(telemetry.altitudeMeters.toFixed(2))
    sandboxTelemetry.speedMetersPerSecond = Number(telemetry.speedMetersPerSecond.toFixed(2))
    sandboxTelemetry.isFlying = telemetry.isFlying

    // 起飞流程编排:上电 → 展开机臂 → 等起飞前检查全部通过 → 起飞
    // 注意"机臂已展开"这项检查同时要求桨叶展开 ≥98%(桨叶张开是慢速率动画),
    // 所以不能只看 armFold,要看真实的 checklist。
    const fly = game.droneFly
    const sim = fly?.sim
    if (sandboxPendingTakeoff && fly && sim) {
      if (sim.phase === 'powerOff' || sim.phase === 'stopped') {
        fly.setArmFoldTarget(0)
        sim.powerOn()
      } else if (sim.armFold > 0.02) {
        fly.setArmFoldTarget(0)
      } else if (sim.phase === 'standby') {
        const blocked = sim.checklist.filter((item) => item.blocking && !item.ok)
        if (blocked.length === 0) {
          sandboxPendingTakeoff = false
          sandboxMessage.value = sim.autoTakeOff()
            ? '起飞:自动上升至 1.2 米'
            : '起飞被拒绝(检查未通过)'
        } else {
          sandboxMessage.value = `等待起飞前检查:${blocked.map((item) => item.label).join('、')}`
        }
      }
    }
  }, 200)
}

/** 拆解演示 03:停轮询、销毁实例 */
function unmountSandboxDemo(): void {
  sandboxToken += 1
  window.clearInterval(sandboxPoll)
  sandboxPoll = 0
  sandboxPendingTakeoff = false
  sandboxGame?.destroy()
  sandboxGame = null
  sandboxReady.value = false
}

/** 切换相机模式(orbit 观察者 / follow 跟随 / fpv 机载) */
function sandboxSetMode(mode: CameraMode): void {
  sandboxMode.value = mode
  sandboxGame?.droneFly?.setCameraMode(mode)
  sandboxMessage.value = `相机切换到「${CAMERA_MODE_LIST.find((item) => item.key === mode)?.label ?? mode}」视角`
}

/** 收纳/展开机臂:按当前 armFold 反向设置机构目标 */
function sandboxToggleArms(): void {
  const fly = sandboxGame?.droneFly
  const sim = fly?.sim
  if (!fly || !sim) return
  const fold = sim.armFold > 0.5 ? 0 : 1
  fly.setArmFoldTarget(fold)
  sandboxMessage.value = fold === 0 ? '展开机臂中…' : '收纳机臂中…'
}

/** 一键起飞:只置排队标志,真正的"上电 → 展开 → 起飞"由轮询编排 */
function sandboxTakeoff(): void {
  const fly = sandboxGame?.droneFly
  if (!fly) return
  sandboxPendingTakeoff = true
  sandboxMessage.value = '准备中:上电 → 展开机臂 → 起飞'
}

/** 降落(并取消排队中的起飞) */
function sandboxLand(): void {
  const sim = sandboxGame?.droneFly?.sim
  if (!sim) return
  sandboxPendingTakeoff = false
  sandboxMessage.value = sim.startLanding() ? '开始降落' : '当前状态不能降落'
}

/** 云台拍照:requestPhoto() 返回 { dataUrl, width, height } 或 null */
async function sandboxPhotoShoot(): Promise<void> {
  const fly = sandboxGame?.droneFly
  if (!fly || sandboxShooting.value) return
  sandboxShooting.value = true
  sandboxMessage.value = '拍照:渲染前把相机摆到云台位姿,渲染后拷屏'
  const shot = await fly.requestPhoto()
  sandboxPhoto.value = shot
  sandboxShooting.value = false
  sandboxMessage.value = shot ? `已拍下 ${shot.width}×${shot.height} 的云台取景照片` : '拍照失败'
}

/** 复位:收起机臂并重置仿真内核 */
function sandboxReset(): void {
  const fly = sandboxGame?.droneFly
  if (!fly) return
  sandboxPendingTakeoff = false
  fly.setArmFoldTarget(1)
  fly.sim.reset()
  sandboxMessage.value = '已复位(机臂收起)'
}

// ────────────────────────────────────────────────────────────────────────────
// 演示 04 · GlbViewer
// ────────────────────────────────────────────────────────────────────────────

// 演示用 GLB 资源(public/models 下),查看器与拍照演示共用同一模型
const SAMPLE_URL = '/models/djiair_renamed.glb'

// 演示 04 响应式状态:加载状态、模型统计、各显示开关
const glbHost = ref<HTMLElement | null>(null)
const glbReady = ref(false)
const glbError = ref('')
const glbStatus = reactive<GlbLoadStatus>({
  state: 'idle',
  fileName: '',
  progress: null,
  message: '',
})
const glbStats = ref<GlbModelStats | null>(null)
const glbFps = ref(0)
const glbAutoRotate = ref(false)
const glbSkeleton = ref(false)
const glbWireframe = ref(false)
const glbExplode = ref(0)
const glbExplodeAvailable = ref(false)

// 演示 04 的实例/轮询句柄
let glbViewer: GlbViewer | null = null
let glbToken = 0
let glbPoll = 0

/** 装配 GLB 查看器:init 后轮询 FPS/统计,并加载示例模型 */
async function mountGlbDemo(): Promise<void> {
  const host = glbHost.value
  if (!host) return
  const token = ++glbToken
  glbReady.value = false
  glbError.value = ''
  glbStats.value = null

  const viewer = new GlbViewer(host)
  glbViewer = viewer
  viewer.onStatus = (status) => {
    if (token !== glbToken) return
    Object.assign(glbStatus, status)
  }

  try {
    await viewer.init()
  } catch (error) {
    glbError.value = error instanceof Error ? error.message : String(error)
    return
  }
  if (token !== glbToken) {
    viewer.destroy()
    return
  }

  glbPoll = window.setInterval(() => {
    if (token !== glbToken || glbViewer !== viewer) return
    glbFps.value = viewer.getFps()
    glbStats.value = viewer.getStats()
    glbExplodeAvailable.value = viewer.isExplodeAvailable()
  }, 400)

  glbReady.value = true
  try {
    await viewer.loadFromUrl(SAMPLE_URL)
  } catch (error) {
    glbError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 拆解演示 04:停轮询、销毁查看器、重置加载状态 */
function unmountGlbDemo(): void {
  glbToken += 1
  window.clearInterval(glbPoll)
  glbPoll = 0
  glbViewer?.destroy()
  glbViewer = null
  glbReady.value = false
  Object.assign(glbStatus, { state: 'idle', fileName: '', progress: null, message: '' })
}

/** 重新加载示例模型 */
async function glbReload(): Promise<void> {
  if (!glbViewer) return
  glbError.value = ''
  try {
    await glbViewer.loadFromUrl(SAMPLE_URL)
  } catch (error) {
    glbError.value = error instanceof Error ? error.message : String(error)
  }
}

/** 切换自动旋转 */
function glbToggleAutoRotate(): void {
  glbAutoRotate.value = !glbAutoRotate.value
  glbViewer?.setAutoRotate(glbAutoRotate.value)
}

/** 切换骨骼辅助线 */
function glbToggleSkeleton(): void {
  glbSkeleton.value = !glbSkeleton.value
  glbViewer?.setSkeletonVisible(glbSkeleton.value)
}

/** 切换线框显示 */
function glbToggleWireframe(): void {
  glbWireframe.value = !glbWireframe.value
  glbViewer?.setWireframe(glbWireframe.value)
}

/** 设置爆炸图强度(0~1) */
function glbSetExplode(value: number): void {
  glbExplode.value = value
  glbViewer?.setExplode(value)
}

/** 重置视角 */
function glbResetView(): void {
  glbViewer?.resetView()
}

// ────────────────────────────────────────────────────────────────────────────
// 演示 05 · 资源注入(scene / camera / renderer / controls 由调用方提供)
// ────────────────────────────────────────────────────────────────────────────

// 注入模式:四要素全注入 / 只注入 camera / 全部由库新建
const INJECT_MODE_LIST = [
  { key: 'inject' as const, label: '四要素全部注入' },
  { key: 'partial' as const, label: '只注入 camera' },
  { key: 'internal' as const, label: '全部由库新建' },
]

type InjectMode = (typeof INJECT_MODE_LIST)[number]['key']

/** 注入相机时我们设的机位 / 库默认相机机位(用于校验谁的参数被保留) */
const CAMERA_OWN_POS = new THREE.Vector3(4.6, 3.2, 6.2)
const CAMERA_DEFAULT_POS = new THREE.Vector3(7.5, 4.2, 9.5)

// 演示 05 响应式状态:注入模式、内置环境开关、校验结果、提示文案
const injectHost = ref<HTMLElement | null>(null)
const injectReady = ref(false)
const injectError = ref('')
const injectMode = ref<InjectMode>('inject')
const injectEnvironment = ref(false)
const injectNote = ref('')
/** 模板里不要直接读实例变量,统一用响应式状态暴露 */
const injectInfo = reactive({
  scene: false,
  camera: false,
  renderer: false,
  controls: false,
  identity: false,
  cameraUntouched: false,
  canvasInHost: false,
  sceneChildren: 0,
  builtInLights: 0,
  /** 本页自己调用了多少次 renderer.render()(three 的 info.drawCalls 会被内部循环重置,不能用) */
  frames: 0,
})

// 演示 05 的实例/循环句柄 + 本页自有的四要素(归调用方,须由本页释放)
let injectViewer: THREEViewer | null = null
// 下面四个是「调用方自己的」资源:库只借用,不释放 —— 生命周期由本页面自己管
let injectScene: THREE.Scene | null = null
let injectCamera: THREE.PerspectiveCamera | null = null
let injectRenderer: WebGPURenderer | null = null
let injectControls: OrbitControls | null = null
let injectMesh: THREE.Mesh | null = null
let injectRaf = 0
let injectLastTs = 0
let injectToken = 0
let injectUiClock = 0
let injectFrames = 0

/**
 * 由调用方创建自己的四要素;没造的那一项留给库新建。
 * - inject:四要素全注入
 * - partial:只注入 camera(演示混合归属 —— 其余三项走库的默认创建逻辑)
 * - internal:一项都不注入(与不传参数时完全一致)
 */
function createOwnResources(mode: InjectMode): void {
  injectScene = mode === 'inject' ? new THREE.Scene() : null
  if (injectScene) injectScene.background = new THREE.Color('#101d24')

  injectCamera = mode === 'internal' ? null : new THREE.PerspectiveCamera(52, 1, 0.1, 500)
  injectCamera?.position.set(CAMERA_OWN_POS.x, CAMERA_OWN_POS.y, CAMERA_OWN_POS.z)

  injectRenderer = mode === 'inject' ? new WebGPURenderer({ antialias: true }) : null
  // 也可以不 init:THREEViewer 内部会补(renderer.init() 幂等)
  if (injectRenderer) injectRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  // 轨道控制必须挂在某个 canvas 上,所以只有自带渲染器时才谈得上注入控制器
  injectControls =
    injectRenderer && injectCamera
      ? new OrbitControls(injectCamera, injectRenderer.domElement)
      : null
  if (injectControls) {
    injectControls.enableDamping = true
    injectControls.target.set(0, 1.1, 0)
  }
}

/** 装配注入演示:按模式建自有资源 → 传给 THREEViewer → 校验身份/机位/归属 */
async function mountInjectDemo(): Promise<void> {
  const host = injectHost.value
  if (!host) return
  const token = ++injectToken
  injectReady.value = false
  injectError.value = ''
  injectLastTs = 0
  injectUiClock = 0
  injectFrames = 0

  createOwnResources(injectMode.value)

  // 注入的渲染器如果已初始化过,库内部的 init() 会复用(不会二次初始化)
  if (injectRenderer) await injectRenderer.init()
  if (token !== injectToken) return

  const viewer = new THREEViewer(host, {
    scene: injectScene ?? undefined,
    camera: injectCamera ?? undefined,
    renderer: injectRenderer ?? undefined,
    controls: injectControls ?? undefined,
    environment: injectEnvironment.value,
  })
  await viewer.initialize()
  if (token !== injectToken) {
    viewer.destroy()
    return
  }
  injectViewer = viewer

  const objects = viewer.getObject()
  const scene = objects.scene
  const camera = objects.camera
  const renderer = objects.renderer
  if (!scene || !camera || !renderer) {
    injectError.value = '场景初始化失败'
    return
  }

  injectInfo.scene = injectScene !== null && scene === injectScene
  injectInfo.camera = injectCamera !== null && camera === injectCamera
  injectInfo.renderer = injectRenderer !== null && renderer === injectRenderer
  injectInfo.controls = injectControls !== null && objects.controls === injectControls
  // 身份校验:注入项必须「就是我传进去的那个实例」,未注入项必须由库建出来
  injectInfo.identity =
    injectMode.value === 'inject'
      ? injectInfo.scene && injectInfo.camera && injectInfo.renderer && injectInfo.controls
      : injectMode.value === 'partial'
        ? injectInfo.camera && !injectInfo.scene && !injectInfo.renderer && !injectInfo.controls
        : !injectInfo.scene && !injectInfo.camera && !injectInfo.renderer && !injectInfo.controls
  // 机位该是谁的,就还是谁的:注入用我们设的,未注入用库默认的
  const expected = injectCamera ? CAMERA_OWN_POS : CAMERA_DEFAULT_POS
  injectInfo.cameraUntouched = camera.position.distanceTo(expected) < 1e-6
  injectInfo.canvasInHost = host.contains(renderer.domElement)

  // 往场景里加一个自己的物体:注入与否它都该正常显示
  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.62, 0.2, 128, 24),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color('#5ad7ff'),
      emissive: new THREE.Color('#1a5c78'),
      emissiveIntensity: 1.2,
      roughness: 0.28,
      metalness: 0.35,
    }),
  )
  mesh.position.y = 1.1
  mesh.castShadow = true
  scene.add(mesh)
  injectMesh = mesh

  injectInfo.sceneChildren = scene.children.length
  // 内置环境会不会建:数一遍半球光/平行光(注入场景里也该有库建的环境,除非关掉)
  let lights = 0
  scene.traverse((object) => {
    if ((object as THREE.Light).isLight) lights += 1
  })
  injectInfo.builtInLights = lights
  const envNote = injectEnvironment.value
    ? '内置环境(灯光/兜底地板/坐标轴)由库创建'
    : '内置环境已关闭 —— 场景里只有你自己的物体'
  injectNote.value =
    injectMode.value === 'inject'
      ? `scene / camera / renderer / controls 全部来自注入;${envNote}`
      : injectMode.value === 'partial'
        ? `只注入了 camera,其余三项(含控制器)照旧由库创建;${envNote}`
        : `没有注入任何资源:四要素与整个环境全部由库新建;${envNote}`
  injectReady.value = true

  const render = (timestamp: number): void => {
    injectRaf = window.requestAnimationFrame(render)
    const delta = injectLastTs ? Math.min((timestamp - injectLastTs) / 1000, 0.2) : FIXED_STEP
    injectLastTs = timestamp
    mesh.rotation.y += delta * 0.7
    mesh.rotation.x += delta * 0.3

    const current = viewer.getObject()
    current.controls?.update()
    if (current.scene && current.camera && current.renderer) {
      current.renderer.render(current.scene, current.camera)
      injectFrames += 1
    }

    injectUiClock += delta
    if (injectUiClock >= 0.4) {
      injectUiClock = 0
      injectInfo.sceneChildren = current.scene?.children.length ?? 0
      injectInfo.frames = injectFrames
    }
  }
  injectRaf = window.requestAnimationFrame(render)
}

/** 拆解演示 05:销毁 viewer,并释放本页自有的四要素 */
function unmountInjectDemo(): void {
  injectToken += 1
  window.cancelAnimationFrame(injectRaf)
  injectRaf = 0
  injectReady.value = false
  injectViewer?.destroy()
  injectViewer = null

  // 注入的资源归调用方所有 → 由本页面自己释放(库绝不会替我们 dispose)
  injectMesh?.geometry.dispose()
  ;(injectMesh?.material as THREE.Material | undefined)?.dispose()
  injectMesh = null
  injectControls?.dispose()
  injectControls = null
  void injectRenderer?.dispose()
  injectRenderer = null
  injectScene = null
  injectCamera = null

  injectInfo.scene = false
  injectInfo.camera = false
  injectInfo.renderer = false
  injectInfo.controls = false
  injectInfo.identity = false
  injectInfo.cameraUntouched = false
  injectInfo.canvasInHost = false
  injectInfo.sceneChildren = 0
  injectInfo.builtInLights = 0
  injectInfo.frames = 0
}

/** 重建注入演示:先拆再装(切模式 / 切环境都走这里) */
async function remountInjectDemo(reason: string): Promise<void> {
  unmountInjectDemo()
  injectNote.value = reason
  await nextTick()
  await mountInjectDemo()
}

/** 切换注入模式(需重建场景) */
async function injectSetMode(mode: InjectMode): Promise<void> {
  if (mode === injectMode.value) return
  injectMode.value = mode
  await remountInjectDemo('切换资源来源…')
}

/** 切换内置环境(灯光 / 地板 / 坐标轴),需重建场景生效 */
async function injectToggleEnvironment(): Promise<void> {
  injectEnvironment.value = !injectEnvironment.value
  await remountInjectDemo(injectEnvironment.value ? '开启内置环境…' : '关闭内置环境…')
}

// ────────────────────────────────────────────────────────────────────────────
// 标签切换:同一时刻只保留一个 WebGPU 渲染器(切走即销毁)
// ────────────────────────────────────────────────────────────────────────────

/** 按标签拆除对应演示的运行时资源 */
function teardown(tab: DemoTab): void {
  if (tab === 'world') unmountWorldDemo()
  if (tab === 'sandbox') unmountSandboxDemo()
  if (tab === 'glb') unmountGlbDemo()
  if (tab === 'inject') unmountInjectDemo()
}

/** 激活标签:sim 只建一次实例,其余标签按需挂载 */
async function activate(tab: DemoTab): Promise<void> {
  await nextTick()
  if (tab === 'sim') {
    if (!simRef.value) {
      simRef.value = new DroneSim()
      simRaf = window.requestAnimationFrame(simTick)
    }
    simRunning.value = true
    return
  }
  if (tab === 'world') await mountWorldDemo()
  if (tab === 'sandbox') await mountSandboxDemo()
  if (tab === 'glb') await mountGlbDemo()
  if (tab === 'inject') await mountInjectDemo()
}

/** 切换标签:先拆旧面板再改 activeTab(新面板的挂载交给 watch) */
async function selectTab(tab: DemoTab): Promise<void> {
  if (tab === activeTab.value) return
  teardown(activeTab.value)
  activeTab.value = tab
}

// 标签变化即挂载对应演示(同一时刻只保留一个 WebGPU 渲染器)
watch(activeTab, async (tab) => {
  await activate(tab)
})

// 首屏默认激活纯逻辑层(唯一不依赖 WebGL 的标签,起得最快)
onMounted(async () => {
  await activate('sim')
})

// 卸载时停掉纯逻辑层循环,并拆除所有三维演示
onBeforeUnmount(() => {
  window.cancelAnimationFrame(simRaf)
  simRef.value = null
  teardown('world')
  teardown('sandbox')
  teardown('glb')
  teardown('inject')
})

// ────────────────────────────────────────────────────────────────────────────
// 显示辅助
// ────────────────────────────────────────────────────────────────────────────

// 事件级别 → 中文标签,供事件日志显示
const EVENT_LEVEL_LABEL: Record<string, string> = {
  info: '信息',
  success: '成功',
  warn: '警告',
  error: '错误',
}

/** 秒数格式化为 mm:ss(事件日志用) */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/** 高度条百分比:以 30m 为满量程(与模板里 "30 m 量程" 标注一致) */
const simAltitudePercent = computed(() =>
  Math.min(100, Math.max(0, ((simSnap.value?.altitude ?? 0) / 30) * 100)),
)
</script>

<template>
  <main class="demo-page">
    <!-- 顶部:标题与跨页快捷入口 -->
    <header class="demo-head">
      <div class="head-brand">
        <h1>three-engine 库调用示例</h1>
        <p>
          同一个包的四层用法:纯逻辑 → 场景底座 → 完整装配 → 模型查看器。右侧是真实运行的实例,
          左侧的片段与它同源,可直接抄进你的工程。
        </p>
      </div>
      <nav class="head-links">
        <router-link to="/dji">完整沙盒 /dji</router-link>
        <router-link to="/glb">模型查看器 /glb</router-link>
      </nav>
    </header>

    <div class="demo-body">
      <!-- 左侧:示例选择器 + "作为依赖包使用"的安装提示 -->
      <aside class="step-list">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="step-item"
          type="button"
          :class="{ active: tab.key === activeTab }"
          :data-testid="`tab-${tab.key}`"
          @click="selectTab(tab.key)"
        >
          <span class="step-no">{{ tab.step }}</span>
          <span class="step-text">
            <strong>{{ tab.title }}</strong>
            <small>{{ tab.subtitle }}</small>
          </span>
        </button>

        <div class="install-card">
          <p class="install-title">作为依赖包使用</p>
          <code class="install-cmd">npm i three-engine three</code>
          <code class="install-cmd subtle">npm i -D @types/three</code>
          <p class="install-note">
            本仓库内等价写法:<code>import … from '@/lib'</code>(同一份入口文件)。 打包命令
            <code>npm run build:lib</code> → <code>dist-lib/</code>。
          </p>
        </div>
      </aside>

      <!-- 中间:当前示例的说明 + 与运行代码同源的代码块 -->
      <section class="code-panel">
        <h2>
          <span class="h2-no">{{ current.step }}</span>
          {{ current.title }}
        </h2>
        <p class="lead">{{ current.lead }}</p>
        <ul class="points">
          <li v-for="point in current.points" :key="point">{{ point }}</li>
        </ul>
        <CodeBlock :code="current.code" :title="current.file" />
      </section>

      <!-- 右侧:与标签对应的真实运行面板(每个标签一个分支) -->
      <section class="live-panel">
        <!-- ————— 01 纯逻辑层 ————— -->
        <div v-if="activeTab === 'sim'" class="live-inner">
          <div class="live-head">
            <span class="live-tag">DroneSim · 无渲染</span>
            <span class="live-hint">不依赖 canvas,这个面板里没有三维画面</span>
          </div>

          <p class="live-message" data-testid="sim-message">{{ simMessage }}</p>

          <div class="phase-track">
            <span
              v-for="(phase, index) in PHASE_ORDER"
              :key="phase"
              class="phase-cell"
              :class="{ done: index < simPhaseIndex, now: index === simPhaseIndex }"
              :title="simSnap?.phaseLabel ?? phase"
            >
              {{ phase }}
            </span>
          </div>

          <div class="gauge-grid">
            <div class="gauge">
              <span class="gauge-label">阶段</span>
              <span class="gauge-value" data-testid="sim-phase">{{
                simSnap?.phaseLabel ?? '—'
              }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">模式</span>
              <span class="gauge-value">{{ simSnap?.modeLabel ?? '—' }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">高度</span>
              <span class="gauge-value" data-testid="sim-altitude">
                {{ (simSnap?.altitude ?? 0).toFixed(2) }} m
              </span>
            </div>
            <div class="gauge">
              <span class="gauge-label">水平速度</span>
              <span class="gauge-value">{{ (simSnap?.horizontalSpeed ?? 0).toFixed(2) }} m/s</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">电量</span>
              <span class="gauge-value">{{ (simSnap?.batteryPercent ?? 0).toFixed(0) }} %</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">距返航点</span>
              <span class="gauge-value">{{ (simSnap?.distanceToHome ?? 0).toFixed(2) }} m</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">电机负载</span>
              <span class="gauge-value">{{ ((simSnap?.motorLoad ?? 0) * 100).toFixed(0) }} %</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">卫星</span>
              <span class="gauge-value">{{ (simSnap?.satellites ?? 0).toFixed(0) }}</span>
            </div>
          </div>

          <div class="alt-bar">
            <div class="alt-fill" :style="{ height: `${simAltitudePercent}%` }"></div>
            <span class="alt-mark">30 m 量程</span>
          </div>

          <div class="control-row">
            <button type="button" data-testid="sim-power" @click="simPowerOn">上电</button>
            <button type="button" class="primary" data-testid="sim-takeoff" @click="simTakeoff">
              一键起飞
            </button>
            <button type="button" data-testid="sim-land" @click="simLand">自动降落</button>
            <button type="button" data-testid="sim-rth" @click="simRth">智能返航</button>
            <button type="button" data-testid="sim-stop" @click="simStopMotors">停桨</button>
            <button type="button" data-testid="sim-reset" @click="simReset">重置</button>
          </div>

          <label class="slider-row">
            <span>强制电量 {{ simBattery }}%</span>
            <input
              type="range"
              min="5"
              max="100"
              step="1"
              :value="simBattery"
              @input="simSetBattery(Number(($event.target as HTMLInputElement).value))"
            />
          </label>

          <div class="log">
            <p class="log-title">事件日志 · snapshot().events</p>
            <ul data-testid="sim-log">
              <li v-for="event in simLog" :key="event.id" :class="`lv-${event.level}`">
                <span class="log-time">{{ formatClock(event.time) }}</span>
                <span class="log-level">{{ EVENT_LEVEL_LABEL[event.level] ?? event.level }}</span>
                <span class="log-text">{{ event.text }}</span>
              </li>
            </ul>
          </div>
        </div>

        <!-- ————— 02 场景底座 ————— -->
        <div v-else-if="activeTab === 'world'" class="live-inner flush">
          <div ref="worldHost" class="canvas-host" data-testid="world-canvas"></div>
          <div v-if="!worldReady" class="canvas-overlay">正在初始化渲染器…</div>
          <div v-if="worldError" class="canvas-overlay error">{{ worldError }}</div>
          <div class="canvas-toolbar">
            <button
              type="button"
              :class="{ active: worldObstaclesVisible }"
              @click="worldToggleObstacles"
            >
              障碍物
            </button>
            <button type="button" :class="{ active: worldAxesVisible }" @click="worldToggleAxes">
              坐标轴
            </button>
            <button
              type="button"
              :class="{ active: worldFlying }"
              @click="worldFlying = !worldFlying"
            >
              {{ worldFlying ? '暂停飞行' : '继续飞行' }}
            </button>
            <button type="button" @click="worldClearTrail">清空航迹</button>
            <span class="toolbar-readout" data-testid="world-readout">
              marker ({{ worldPosition.x }}, {{ worldPosition.y }}, {{ worldPosition.z }}) · 障碍物
              {{ worldCounts.obstacles }} 个 · AABB {{ worldCounts.boxes }} 个
            </span>
          </div>
        </div>

        <!-- ————— 03 完整装配 ————— -->
        <div v-else-if="activeTab === 'sandbox'" class="live-inner flush">
          <div ref="sandboxHost" class="canvas-host" data-testid="sandbox-canvas"></div>
          <div v-if="!sandboxReady" class="canvas-overlay" data-testid="sandbox-overlay">
            正在载入模型 · GameInstance.ready …
          </div>
          <div v-if="sandboxError" class="canvas-overlay error">{{ sandboxError }}</div>

          <div class="canvas-toolbar wrap">
            <button
              v-for="mode in CAMERA_MODE_LIST"
              :key="mode.key"
              type="button"
              :class="{ active: sandboxMode === mode.key }"
              :data-testid="`sandbox-mode-${mode.key}`"
              @click="sandboxSetMode(mode.key)"
            >
              {{ mode.label }}
            </button>
            <span class="toolbar-sep"></span>
            <button
              type="button"
              class="primary"
              data-testid="sandbox-takeoff"
              @click="sandboxTakeoff"
            >
              一键起飞
            </button>
            <button type="button" data-testid="sandbox-land" @click="sandboxLand">降落</button>
            <button type="button" @click="sandboxToggleArms">机臂收纳 / 展开</button>
            <button
              type="button"
              data-testid="sandbox-photo"
              :disabled="sandboxShooting"
              @click="sandboxPhotoShoot"
            >
              {{ sandboxShooting ? '拍照中…' : '拍照' }}
            </button>
            <button type="button" @click="sandboxReset">复位</button>
          </div>

          <div class="hud-strip" data-testid="sandbox-hud">
            <span class="hud-message">{{ sandboxMessage }}</span>
            <span class="hud-item" data-testid="sandbox-altitude">
              高度 {{ sandboxTelemetry.altitudeMeters }} m
            </span>
            <span class="hud-item">速度 {{ sandboxTelemetry.speedMetersPerSecond }} m/s</span>
            <span class="hud-item"
              >电量 {{ (sandboxSnapshot?.batteryPercent ?? 0).toFixed(0) }} %</span
            >
            <span class="hud-item"
              >机臂 {{ (sandboxSnapshot?.armFold ?? 1) > 0.5 ? '收纳' : '展开' }}</span
            >
            <span class="hud-item">FPS {{ sandboxFps }}</span>
          </div>

          <div v-if="sandboxPhoto" class="shot-strip">
            <img :src="sandboxPhoto.dataUrl" alt="云台取景照片" data-testid="sandbox-shot" />
            <div class="shot-meta">
              <strong>requestPhoto() 返回值</strong>
              <span>dataUrl(base64 PNG)</span>
              <span>{{ sandboxPhoto.width }} × {{ sandboxPhoto.height }}</span>
              <a :href="sandboxPhoto.dataUrl" :download="`lib-demo-${Date.now()}.png`">下载这张</a>
            </div>
          </div>
        </div>

        <!-- ————— 04 模型查看器 ————— -->
        <div v-else-if="activeTab === 'glb'" class="live-inner flush">
          <div ref="glbHost" class="canvas-host" data-testid="glb-canvas"></div>
          <div v-if="!glbReady" class="canvas-overlay" data-testid="glb-overlay">
            正在初始化查看器…
          </div>
          <div v-if="glbError" class="canvas-overlay error">{{ glbError }}</div>

          <div class="canvas-toolbar wrap">
            <button type="button" data-testid="glb-reload" @click="glbReload">重新载入模型</button>
            <button type="button" :class="{ active: glbAutoRotate }" @click="glbToggleAutoRotate">
              自动旋转
            </button>
            <button
              type="button"
              data-testid="glb-skeleton"
              :class="{ active: glbSkeleton }"
              @click="glbToggleSkeleton"
            >
              骨骼辅助线
            </button>
            <button type="button" :class="{ active: glbWireframe }" @click="glbToggleWireframe">
              线框
            </button>
            <button type="button" @click="glbResetView">重置视角</button>
          </div>

          <label class="slider-row dark">
            <span>爆炸图 {{ (glbExplode * 100).toFixed(0) }}%</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              :value="glbExplode"
              :disabled="!glbExplodeAvailable"
              @input="glbSetExplode(Number(($event.target as HTMLInputElement).value))"
            />
          </label>

          <div class="hud-strip">
            <span class="hud-message" data-testid="glb-status">
              {{ glbStatus.state }} · {{ glbStatus.fileName || '未载入' }}
              <template v-if="glbStatus.progress !== null">
                · {{ (glbStatus.progress * 100).toFixed(0) }}%
              </template>
            </span>
            <span class="hud-item">FPS {{ glbFps }}</span>
          </div>

          <div class="gauge-grid tight" data-testid="glb-stats">
            <div class="gauge">
              <span class="gauge-label">节点</span>
              <span class="gauge-value" data-testid="glb-nodes">{{ glbStats?.nodes ?? '—' }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">网格</span>
              <span class="gauge-value">{{ glbStats?.meshes ?? '—' }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">三角面</span>
              <span class="gauge-value">{{ glbStats?.triangles?.toLocaleString() ?? '—' }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">骨节</span>
              <span class="gauge-value" data-testid="glb-bones">{{ glbStats?.bones ?? '—' }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">动画</span>
              <span class="gauge-value">{{ glbStats?.animations ?? '—' }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">材质 / 贴图</span>
              <span class="gauge-value"
                >{{ glbStats?.materials ?? '—' }} / {{ glbStats?.textures ?? '—' }}</span
              >
            </div>
          </div>
        </div>

        <!-- ————— 05 资源注入 ————— -->
        <div v-else class="live-inner flush">
          <div ref="injectHost" class="canvas-host" data-testid="inject-canvas"></div>
          <div v-if="!injectReady" class="canvas-overlay" data-testid="inject-overlay">
            正在装配场景…
          </div>
          <div v-if="injectError" class="canvas-overlay error">{{ injectError }}</div>

          <div class="canvas-toolbar wrap">
            <button
              v-for="mode in INJECT_MODE_LIST"
              :key="mode.key"
              type="button"
              :class="{ active: injectMode === mode.key }"
              :data-testid="`inject-mode-${mode.key}`"
              @click="injectSetMode(mode.key)"
            >
              {{ mode.label }}
            </button>
            <span class="toolbar-sep"></span>
            <button
              type="button"
              data-testid="inject-env"
              :class="{ active: injectEnvironment }"
              @click="injectToggleEnvironment"
            >
              内置环境(灯光/地板/坐标轴)
            </button>
          </div>

          <div class="hud-strip" data-testid="inject-hud">
            <span class="hud-message">{{ injectNote }}</span>
            <span class="hud-item">已渲染 {{ injectInfo.frames }} 帧</span>
          </div>

          <div class="gauge-grid tight" data-testid="inject-readout">
            <div class="gauge">
              <span class="gauge-label">scene</span>
              <span class="gauge-value" data-testid="inject-scene">
                {{ injectInfo.scene ? '注入' : '库新建' }}
              </span>
            </div>
            <div class="gauge">
              <span class="gauge-label">camera</span>
              <span class="gauge-value" data-testid="inject-camera">
                {{ injectInfo.camera ? '注入' : '库新建' }}
              </span>
            </div>
            <div class="gauge">
              <span class="gauge-label">renderer</span>
              <span class="gauge-value" data-testid="inject-renderer">
                {{ injectInfo.renderer ? '注入' : '库新建' }}
              </span>
            </div>
            <div class="gauge">
              <span class="gauge-label">controls</span>
              <span class="gauge-value" data-testid="inject-controls">
                {{ injectInfo.controls ? '注入' : '库新建' }}
              </span>
            </div>
            <div class="gauge">
              <span class="gauge-label">场景内对象</span>
              <span class="gauge-value" data-testid="inject-children">{{
                injectInfo.sceneChildren
              }}</span>
            </div>
            <div class="gauge">
              <span class="gauge-label">灯光数量</span>
              <span class="gauge-value" data-testid="inject-lights">{{
                injectInfo.builtInLights
              }}</span>
            </div>
          </div>

          <ul class="check-list" data-testid="inject-checks">
            <li :class="{ ok: injectInfo.identity }">
              <template v-if="injectMode === 'inject'">
                身份校验:getObject() 拿到的就是我传进去的那四个实例
              </template>
              <template v-else-if="injectMode === 'partial'">
                身份校验:注入的 camera 被原样使用,其余三项由库新建
              </template>
              <template v-else>身份校验:四项全部由库新建(与不传参数时一致)</template>
            </li>
            <li :class="{ ok: injectInfo.cameraUntouched }">
              {{
                injectInfo.camera
                  ? '注入相机的机位未被改写(仍是 4.60, 3.20, 6.20)'
                  : '未注入相机 → 库用自己的默认机位 (7.50, 4.20, 9.50)'
              }}
            </li>
            <li :class="{ ok: injectInfo.canvasInHost }">
              渲染器 canvas 已在容器内(库只接管它没挂过的 canvas)
            </li>
          </ul>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
/* ————— 页面外框与顶栏 ————— */
.demo-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  /* 原为 min-height: 100vh —— 现在页面挂在 App.vue 的 .route-host(菜单栏以下的区域)里,
     再用视口高度会把整页撑高、把顶部菜单栏挤出屏幕。改成 0,高度由外层 100% 决定,
     内部 .demo-body(flex:1 + min-height:0)与各列滚动条负责容纳超出的内容。 */
  min-height: 0;
  color: #d3ece6;
  background:
    radial-gradient(1200px 600px at 15% -10%, rgb(23 62 66 / 55%), transparent 60%),
    radial-gradient(900px 500px at 95% 0%, rgb(18 44 58 / 45%), transparent 55%), #060f13;
  font-family: ui-sans-serif, system-ui, 'Segoe UI', 'Microsoft YaHei', sans-serif;
}

.demo-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid rgb(121 230 202 / 14%);
}

.head-brand h1 {
  margin: 0 0 6px;
  color: #ecfffa;
  font-size: 19px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.head-brand p {
  margin: 0;
  max-width: 760px;
  color: #7fa8a2;
  font-size: 12px;
  line-height: 1.7;
}

.head-links {
  display: flex;
  gap: 8px;
  flex: none;
}

.head-links a {
  padding: 6px 12px;
  color: #9fe0cf;
  border: 1px solid rgb(121 230 202 / 26%);
  border-radius: 999px;
  font-size: 11px;
  text-decoration: none;
  transition: all 0.15s ease;
}

.head-links a:hover {
  color: #061014;
  background: #7de6ca;
}

.demo-body {
  flex: 1;
  display: grid;
  grid-template-columns: 208px minmax(0, 1fr) minmax(0, 1.12fr);
  gap: 16px;
  min-height: 0;
  padding: 16px 24px 22px;
}

/* ————— 左侧步骤 ————— */

.step-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  color: #8fc4ba;
  border: 1px solid rgb(121 230 202 / 14%);
  border-radius: 8px;
  background: rgb(12 28 34 / 62%);
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.step-item:hover {
  border-color: rgb(121 230 202 / 38%);
}

.step-item.active {
  color: #ecfffa;
  border-color: #7de6ca;
  background: rgb(23 62 62 / 72%);
  box-shadow: 0 0 0 1px rgb(121 230 202 / 22%) inset;
}

.step-no {
  flex: none;
  color: #7de6ca;
  font:
    700 12px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.step-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.step-text strong {
  font-size: 12px;
  font-weight: 600;
}

.step-text small {
  color: #5f8b86;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.install-card {
  margin-top: auto;
  padding: 10px;
  border: 1px dashed rgb(121 230 202 / 22%);
  border-radius: 8px;
}

.install-title {
  margin: 0 0 7px;
  color: #7de6ca;
  font:
    600 10px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}

.install-cmd {
  display: block;
  padding: 5px 7px;
  margin-bottom: 5px;
  color: #d9f5ee;
  background: #0a1a1f;
  border-radius: 4px;
  font:
    400 10px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  overflow-wrap: anywhere;
}

.install-cmd.subtle {
  color: #7fa8a2;
}

.install-note {
  margin: 7px 0 0;
  color: #5f8b86;
  font-size: 10px;
  line-height: 1.65;
}

.install-note code {
  color: #9fe0cf;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

/* ————— 中间代码 ————— */

.code-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.code-panel h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: #ecfffa;
  font-size: 15px;
  font-weight: 620;
}

.h2-no {
  color: #7de6ca;
  font:
    700 12px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.lead {
  margin: 0;
  color: #86ada7;
  font-size: 12px;
  line-height: 1.75;
}

.points {
  margin: 0;
  padding-left: 16px;
  color: #6f9d97;
  font-size: 11px;
  line-height: 1.8;
}

.points li::marker {
  color: #3f7a72;
}

/* ————— 右侧实时 ————— */

.live-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid rgb(121 230 202 / 16%);
  border-radius: 10px;
  background: rgb(8 20 25 / 76%);
  overflow: hidden;
}

.live-inner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
  flex: 1;
}

.live-inner.flush {
  padding: 0;
  position: relative;
}

.live-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.live-tag {
  color: #7de6ca;
  font:
    600 10px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.08em;
}

.live-hint {
  color: #527d78;
  font-size: 10px;
}

.live-message {
  margin: 0;
  padding: 7px 9px;
  color: #bfe6dd;
  border-left: 2px solid #7de6ca;
  background: rgb(121 230 202 / 7%);
  border-radius: 0 5px 5px 0;
  font-size: 11px;
  line-height: 1.6;
}

.phase-track {
  display: grid;
  grid-template-columns: repeat(11, minmax(0, 1fr));
  gap: 3px;
}

.phase-cell {
  padding: 4px 2px;
  color: #456c67;
  border: 1px solid rgb(121 230 202 / 10%);
  border-radius: 4px;
  background: rgb(10 24 29 / 70%);
  font:
    500 8px/1.3 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
}

.phase-cell.done {
  color: #6fae9f;
  border-color: rgb(121 230 202 / 24%);
}

.phase-cell.now {
  color: #06140f;
  background: #7de6ca;
  border-color: #7de6ca;
  font-weight: 700;
}

.gauge-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.gauge-grid.tight {
  padding: 0 12px 12px;
}

.gauge {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 8px;
  border: 1px solid rgb(121 230 202 / 12%);
  border-radius: 6px;
  background: rgb(11 26 32 / 72%);
  min-width: 0;
}

.gauge-label {
  color: #5d8a85;
  font-size: 9.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gauge-value {
  color: #dcf6ef;
  font:
    600 12px/1.2 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0 12px 12px;
  list-style: none;
}

.check-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #7d9d98;
  font:
    400 10px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.check-list li::before {
  content: '○';
  color: #4d6f6b;
}

.check-list li.ok {
  color: #a9e9d6;
}

.check-list li.ok::before {
  content: '✓';
  color: #57e0c0;
}

.alt-bar {
  position: relative;
  height: 7px;
  border: 1px solid rgb(121 230 202 / 14%);
  border-radius: 4px;
  background: rgb(9 22 27 / 80%);
  overflow: hidden;
}

.alt-fill {
  height: 100%;
  background: linear-gradient(90deg, #2f7f6d, #7de6ca);
  transition: height 0.12s linear;
}

.alt-mark {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  color: #59837e;
  font:
    500 8px/1 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  letter-spacing: 0.06em;
}

.control-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.control-row button,
.canvas-toolbar button {
  padding: 5px 11px;
  color: #9fe0cf;
  border: 1px solid rgb(121 230 202 / 24%);
  border-radius: 5px;
  background: rgb(13 32 38 / 82%);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.14s ease;
}

.control-row button:hover,
.canvas-toolbar button:hover {
  border-color: #7de6ca;
  color: #eafff9;
}

.control-row button.primary,
.canvas-toolbar button.primary {
  color: #06140f;
  background: #7de6ca;
  border-color: #7de6ca;
  font-weight: 600;
}

.canvas-toolbar button.active {
  color: #06140f;
  background: #7de6ca;
  border-color: #7de6ca;
  font-weight: 600;
}

.canvas-toolbar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #7fa8a2;
  font-size: 10.5px;
}

.slider-row.dark {
  padding: 8px 12px;
  border-top: 1px solid rgb(121 230 202 / 10%);
}

.slider-row input {
  flex: 1;
  min-width: 0;
  accent-color: #7de6ca;
}

.log {
  flex: 1;
  min-height: 96px;
  display: flex;
  flex-direction: column;
  border: 1px solid rgb(121 230 202 / 12%);
  border-radius: 6px;
  overflow: hidden;
}

.log-title {
  margin: 0;
  padding: 6px 8px;
  color: #7de6ca;
  border-bottom: 1px solid rgb(121 230 202 / 12%);
  background: rgb(16 36 42 / 62%);
  font:
    600 9.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.log ul {
  flex: 1;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  overflow: auto;
  max-height: 168px;
}

.log li {
  display: flex;
  gap: 7px;
  padding: 3px 8px;
  font:
    400 10px/1.55 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}

.log-time {
  color: #4e7a74;
  flex: none;
}

.log-level {
  flex: none;
  color: #6fae9f;
}

.log-text {
  color: #b7d8d1;
  min-width: 0;
}

.log li.lv-warn .log-level {
  color: #e6c884;
}

.log li.lv-error .log-level {
  color: #ff8f8f;
}

.log li.lv-success .log-level {
  color: #7de6ca;
}

/* ————— 画布与工具条 ————— */

.canvas-host {
  position: relative;
  flex: 1;
  min-height: 340px;
  width: 100%;
}

.canvas-host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.canvas-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #7fa8a2;
  background: rgb(6 15 19 / 72%);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  pointer-events: none;
}

.canvas-overlay.error {
  color: #ff9b9b;
}

.canvas-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid rgb(121 230 202 / 12%);
  background: rgb(10 24 29 / 86%);
}

.canvas-toolbar.wrap {
  flex-wrap: wrap;
}

.canvas-toolbar button {
  flex: none;
}

.toolbar-sep {
  width: 1px;
  align-self: stretch;
  margin: 0 3px;
  background: rgb(121 230 202 / 16%);
}

.toolbar-readout {
  margin-left: auto;
  color: #5f8b86;
  font:
    400 9.5px/1.4 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hud-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid rgb(121 230 202 / 10%);
  background: rgb(9 21 26 / 80%);
  font-size: 10.5px;
}

.hud-message {
  flex: 1;
  min-width: 180px;
  color: #bfe6dd;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hud-item {
  color: #7de6ca;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: nowrap;
}

.shot-strip {
  display: flex;
  gap: 10px;
  padding: 0 12px 12px;
}

.shot-strip img {
  width: 150px;
  border: 1px solid rgb(121 230 202 / 22%);
  border-radius: 6px;
  display: block;
}

.shot-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: #7fa8a2;
  font-size: 10.5px;
  line-height: 1.5;
}

.shot-meta strong {
  color: #dcf6ef;
  font-size: 11px;
}

.shot-meta a {
  color: #7de6ca;
  width: fit-content;
}

/* ————— 窄屏:右侧实时面板换行到底部 ————— */
@media (max-width: 1280px) {
  .demo-body {
    grid-template-columns: 180px minmax(0, 1fr);
  }

  .live-panel {
    grid-column: 1 / -1;
    min-height: 520px;
  }
}
</style>
