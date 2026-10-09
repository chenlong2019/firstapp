/**
 * 海湾竞速场景的挂载入口(上游 race.html 页面脚本的 SPA 移植)。
 *
 * 对外只导出 `mountRace(host)`:在 host 内装配渲染器、地图、车辆、无人机、天气、HUD
 * 与全部交互,返回 `{ dispose }`;渲染循环与 window/document 级监听用 AbortController
 * 统一收口,反复进出路由不会叠加实例。无头检查用的 `window.__RACE__` 也在函数体内定义。
 * 单位约定:本文件几何量以米计,`fromLegacyUnits` 仅用于换算上游按旧单位标定的常量。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { createWaterSkyEnvironment } from '../water-sky/environment'
import { sunDirectionFor } from '../water-sky/materials/sky'
import { createTrackSurface } from './track/trackSurface'
import { createMap } from './maps'
import { loadCar, type CarRig } from './car/loadCar'
import { createCarLights, type CarLights } from './car/lights'
import { createVehicle, type Vehicle } from './car/vehicle'
import { createAutopilot, type Autopilot } from './car/autopilot'
import { createSunShadow, type SunShadow } from './lighting/sunShadow'
import {
  createCarBody,
  type BodyProbe,
  type BodyTargets,
  type CarBody,
  type BodyPartName,
} from './car/body'
import { createModelTree, type ModelTree } from './modelTree'
import { createBoarding, type Boarding } from './character/boarding'
import { DOOR_IDS, type DoorId } from './car/definition'
import { createCarMirrors, type CarMirrors } from './car/mirrors'
import { createChaseCamera } from './camera/chaseCamera'
import { createKeyboardInput } from './input/keyboard'
import { RainShader } from './postprocessing/rain'
import { createWetRoad, type WetRoad } from './weather/wetRoad'
import { createRainImpacts, type RainImpacts } from './weather/rainImpacts'
import type { MedianLampGroup } from '../scenery/medianLamps'
import { CAMERA, CARS, UNITS_PER_METRE, VEHICLE, carById, metres } from './config'
import { fromLegacyUnits } from '../units'
import './race.css'
import { createSceneControl } from '../control/sceneControl'
import { connectSceneBridge } from '../control/browserBridge'
import {
  createRaceDrone,
  type DroneCameraFocus,
  type RaceDroneFlight,
  type RaceDroneState,
} from './drone-control'

/** 场景卸载句柄:路由切走时调用。 */
export interface RaceSceneHandle {
  dispose: () => void
}

/**
 * 挂载海湾竞速场景。
 *
 * 上游实现是 race.html 的页面脚本(模块顶层直接执行)。移植到 SPA 后改成可挂载 /
 * 可卸载的入口:Vue 路由反复进出时不会叠加渲染循环与全局监听。
 * `host` 是已经渲染好全部 `#race-*` 元素的容器;传空则退回整页查找。
 *
 * 下方函数体沿用上游排版(保持缩进不重排),便于日后与上游 diff 对照。
 */
export function mountRace(host: HTMLElement = document.body): RaceSceneHandle {
  // 固定物理步长 1/120 s:主循环按累积时间补步,帧率高低不改变仿真结果(见 frame 的 accumulator)
  const STEP = 1 / 120
  const params = new URLSearchParams(location.search)
  const viewport = (host.querySelector<HTMLDivElement>('#race-viewport') ??
    document.querySelector<HTMLDivElement>('#race-viewport'))!
  const status = (host.querySelector<HTMLDivElement>('#race-status') ??
    document.querySelector<HTMLDivElement>('#race-status'))!
  /** 渲染循环句柄:dispose 时统一收口 */
  let running = true
  let rafId = 0
  /** 挂在 document / window 上的监听器:元素级的监听随 DOM 移除自动失效,这两个必须显式注销 */
  const globalSignals = new AbortController()
  const globalSignal = globalSignals.signal
  const readout = {
    speed: document.querySelector<HTMLElement>('#hud-speed')!,
    steer: document.querySelector<HTMLElement>('#hud-steer')!,
    distance: document.querySelector<HTMLElement>('#hud-distance')!,
    wheels: document.querySelector<HTMLElement>('#hud-wheels')!,
    map: document.querySelector<HTMLElement>('#hud-map')!,
    assist: document.querySelector<HTMLElement>('#hud-assist')!,
    time: document.querySelector<HTMLElement>('#hud-time')!,
    lights: document.querySelector<HTMLElement>('#hud-lights')!,
    auto: document.querySelector<HTMLElement>('#hud-auto')!,
    fps: document.querySelector<HTMLElement>('#hud-fps')!,
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // On from the start: three compiles the shadow sampling into a material's
  // program, so enabling the shadow map after the first frames would leave every
  // already-compiled material - the deck, the bridge - without it. `?shadows=0`
  // still skips the shadow pass itself by not giving the sun a shadow camera.
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // A displayed frame renders the scene multiple times for reflections/compositing.
  // All those cameras share the same sun shadow map; refresh it once per frame.
  renderer.shadowMap.autoUpdate = false
  renderer.toneMapping = THREE.LinearToneMapping
  renderer.toneMappingExposure = 1
  viewport.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const DRIVING_CAMERA_NEAR = fromLegacyUnits(1) // 上游近裁剪面常量:1 旧单位 ≈ 0.23 m
  const camera = new THREE.PerspectiveCamera(
    CAMERA.baseFov,
    1,
    DRIVING_CAMERA_NEAR,
    fromLegacyUnits(25000),
  )

  // The car is a PBR model with metallic paint; without an environment it renders
  // almost black. Water and sky are shader materials and ignore scene.environment.
  //
  // What goes in here matters: this used to be a RoomEnvironment - a synthetic
  // studio - so every reflection on the car (paint, glass, mirror pods) was a
  // reflection of a room that is nowhere in the scene. It cannot be picked either,
  // which is what makes it read as "a layer of something that does not belong".
  // It is built from the scene's own sky instead, once the sky exists below.
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environmentIntensity = 0.55

  // Bloom chain: render -> exposure -> bloom -> output.
  //
  // three.js skips tone mapping when it draws into a render target, so without
  // the exposure pass every brightness in the buffer would be unexposed linear
  // light, where the night sky already sits at 1.0 and the whole frame blooms.
  // Multiplying by the live exposure first puts the threshold in the units the
  // eye sees, so 0.72 means brighter than the night sky, which is what makes the
  // lamps the only thing that spills. Night only: in daylight the sky is over
  // that threshold too and the whole frame hazes over.
  const ExposureShader = {
    name: 'ExposureShader',
    uniforms: { tDiffuse: { value: null }, exposure: { value: 1 } },
    vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
    fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float exposure;
    varying vec2 vUv;
    void main() {
      gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * exposure, 1.0);
    }
  `,
  }

  // How hard the selection glow is allowed to hit. The first version bloomed at a
  // strength of about 1.4 with the shells exporting 1.6x the colour, which read as
  // a torch rather than a highlight: a part picked out of a tree wants to be
  // unmistakable, not blinding.
  let glowIntensity = Number(params.get('glow') ?? 0.6)
  if (!Number.isFinite(glowIntensity)) glowIntensity = 0.6
  glowIntensity = THREE.MathUtils.clamp(glowIntensity, 0, 2)
  let bloomEnabled = params.get('bloom') !== '0'
  let bloomStrength = Number(params.get('bloomStrength') ?? 0.55)
  if (!Number.isFinite(bloomStrength)) bloomStrength = 0.55
  bloomStrength = THREE.MathUtils.clamp(bloomStrength, 0, 3)

  const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    samples: 4,
  })
  const composer = new EffectComposer(renderer, composerTarget)
  const exposurePass = new ShaderPass(ExposureShader)
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), bloomStrength, 0.62, 0.72)
  // Rain is added while the frame is still linear and before bloom, so drops near
  // a lamp or headlight participate in the same spill as the light itself.
  const rainPass = new ShaderPass(RainShader)

  // The selection glow. Bloom is what makes a part read as lit rather than
  // painted, and the night chain is the wrong place to ask for it: it only runs
  // after dark, and it blooms the whole picture. So the highlighted meshes are
  // drawn into a scene of their own - one bright shell each, no lights, no sky -
  // through a second composer with its own UnrealBloomPass, and the result is
  // added to the main chain just before the output pass. Narrow, works in
  // daylight, and a part behind the bodywork still glows, which is the point of
  // picking it out of a tree.
  const glowScene = new THREE.Scene()
  const glowComposer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }),
  )
  glowComposer.renderToScreen = false
  glowComposer.addPass(new RenderPass(glowScene, camera))
  const glowBloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.3, 0.5, 0.12)
  glowComposer.addPass(glowBloomPass)
  const GlowCompositeShader = {
    name: 'GlowCompositeShader',
    uniforms: {
      tDiffuse: { value: null },
      glowMap: { value: null },
      glowAmount: { value: 0 },
    },
    vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
    fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D glowMap;
    uniform float glowAmount;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 glow = texture2D(glowMap, vUv).rgb;
      gl_FragColor = vec4(base.rgb + glow * glowAmount, base.a);
    }
  `,
  }
  const glowComposite = new ShaderPass(GlowCompositeShader)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(exposurePass)
  composer.addPass(rainPass)
  composer.addPass(bloomPass)
  composer.addPass(glowComposite)
  composer.addPass(new OutputPass())

  // Day or night: the scene lights are dimmed and the sun drops at night, so the
  // car lamps read the way they do after dark. ?night=1 or the N key.
  // Three times of day, because a sunset is not a dark night: the sun sits on
  // the horizon, the clouds catch it, and the water reflects the whole thing.
  // `?time=dusk` is the sunset; `?night=1` still means night.
  type TimeOfDay = 'day' | 'dusk' | 'night'
  const requestedTime = params.get('time')
  let timeOfDay: TimeOfDay =
    requestedTime === 'day' || requestedTime === 'dusk' || requestedTime === 'night'
      ? requestedTime
      : params.get('night') === '1'
        ? 'night'
        : 'day'
  const nightMode = () => timeOfDay === 'night'
  let rainEnabled = params.get('rain') === '1'
  let rainIntensity = Number(params.get('rainIntensity') ?? 0.65)
  if (!Number.isFinite(rainIntensity)) rainIntensity = 0.65
  rainIntensity = THREE.MathUtils.clamp(rainIntensity, 0, 1)
  let rainDensity = Number(params.get('rainDensity') ?? 1)
  if (!Number.isFinite(rainDensity)) rainDensity = 1
  rainDensity = THREE.MathUtils.clamp(rainDensity, 0, 2)
  const rainActive = () => rainEnabled && rainIntensity > 0.01
  // Assigned once the rig exists: applyTimeOfDay runs before that.
  let syncHeadlights: (() => void) | null = null
  let syncStreetLighting: (() => void) | null = null
  let syncWeatherSurfaces: (() => void) | null = null
  const environment = createWaterSkyEnvironment({
    waterSize: fromLegacyUnits(24000),
    waterSegments: 320,
    skyRadius: fromLegacyUnits(24000),
    reflection: params.get('reflection') !== '0',
    // The endless map drives forever, so the sea has to come along: a fixed plane
    // runs out after a minute or two and the background falls away to bare sky.
    // `?follow=0` puts it back for a side by side look.
    follow: params.get('follow') !== '0',
  })
  scene.add(environment.root)

  const daylight = environment.root.getObjectByName('daylight') as THREE.DirectionalLight | null
  const skyFill = environment.root.getObjectByName('sky-fill') as THREE.HemisphereLight | null
  // Declared before `applyTimeOfDay`, which runs at module init and tells the
  // shadow where the sun is.
  let sunShadow: SunShadow | null = null
  // How dark the night is, as a multiplier on the night exposure and lights. One
  // is the tuned default; the panel slider moves it.
  let nightBrightness = Number(params.get('nightBrightness') ?? 1)
  if (!Number.isFinite(nightBrightness)) nightBrightness = 1
  nightBrightness = Math.max(0.3, Math.min(2, nightBrightness))
  const nightScale = () => (timeOfDay === 'night' ? nightBrightness : 1)

  /**
   * Reflections that match the world: the scene's own sky over its own sea. Cheap
   * (one PMREM render) and rebuilt only when the sky actually changes - day, dusk,
   * night - so the car reflects a blue sky at noon and an orange one at sunset.
   */
  const reflectionScene = new THREE.Scene()
  const reflectionSky = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    environment.materials.sky,
  )
  reflectionScene.add(reflectionSky)
  const reflectionSea = new THREE.Mesh(
    new THREE.CircleGeometry(40, 32),
    new THREE.MeshBasicMaterial({ color: 0x14302f, toneMapped: false }),
  )
  reflectionSea.rotation.x = -Math.PI / 2
  reflectionSea.position.y = -0.4
  reflectionScene.add(reflectionSea)
  let environmentTarget: THREE.WebGLRenderTarget | null = null
  const refreshEnvironment = () => {
    const previous = environmentTarget
    environmentTarget = pmrem.fromScene(reflectionScene, 0.04)
    scene.environment = environmentTarget.texture
    previous?.dispose()
  }

  const applyTimeOfDay = () => {
    const exposure = { day: 1, dusk: 0.62, night: 0.22 }[timeOfDay] * nightScale()
    // The balance matters more than the absolute level: with the old sun-to-ambient
    // ratio the direct light was only about a tenth of the deck's brightness, so a
    // physically correct shadow could only darken it by a tenth - which reads as
    // "the car has no shadow". The sun now carries roughly a third of it, and the
    // environment and sky fill came down to keep the deck's overall level similar.
    const weatherScale = rainActive() ? 1 : 0
    const environmentLight =
      { day: 0.24, dusk: 0.17, night: 0.08 }[timeOfDay] *
      nightScale() *
      (weatherScale ? { day: 1.28, dusk: 1.14, night: 1 }[timeOfDay] : 1)
    const rawSun = { day: 4.8, dusk: 2.4, night: 0.22 }[timeOfDay]
    const sun = rawSun * (weatherScale ? { day: 0.34, dusk: 0.48, night: 0.9 }[timeOfDay] : 1)
    const fill = { day: 0.3, dusk: 0.2, night: 0.08 }[timeOfDay] * nightScale()
    // The sun drops to the horizon at dusk and the sky is told to go warm; the
    // clouds then light from below, which is what a sunset actually is.
    const sunHeight = { day: 0.58, dusk: 0.13, night: 0.18 }[timeOfDay]
    const sunset = { day: 0, dusk: 1, night: 0 }[timeOfDay]
    renderer.toneMappingExposure = exposure
    scene.environmentIntensity = environmentLight
    if (daylight) daylight.intensity = sun
    if (skyFill) skyFill.intensity = fill
    environment.setParams({ sunHeight, sunset, cloudDensity: weatherScale ? 0.94 : 0.76 })
    // The sky just changed, so the reflections on the car have to change with it.
    refreshEnvironment()
    // The shadow camera has to agree with where the sky puts the sun.
    sunShadow?.setDirection(sunDirectionFor(sunHeight))
    syncHeadlights?.()
    syncStreetLighting?.()
    syncWeatherSurfaces?.()
  }
  applyTimeOfDay()

  // Bloom is a night effect, and only worth a pass chain when there is light to
  // spill: car lamps lit, wet road highlights, the sun at the horizon.
  const bloomActive = () => bloomEnabled && nightMode() && bloomPass.strength > 0

  // The map owns its visual content and its driving surface. Swapping maps means
  // swapping this object; the vehicle only ever sees the resulting track.
  const map = createMap(params.get('map'), { seed: Number(params.get('seed') ?? 1) })
  // Which car is on the road. Part of the URL so a link is a whole scene, and a
  // switch reloads the page: the models are 13-45 MB, and a reload is the only
  // way to free the old one without leaking its textures.
  const car = carById(params.get('car'))
  // Corner assist is on by default: the reference player pins the throttle.
  const assistEnabled = params.get('assist') !== '0'
  scene.add(map.visual)
  // The bridge and circuit maps own a low central planter. Its tree assets load in
  // the background so the car can become drivable immediately; the scenery group
  // is still part of the map visual and never enters the vehicle model tree.
  const medianTreeGroup = map.visual.getObjectByName('median-trees') as THREE.Group | null
  const medianLamps = map.visual.getObjectByName('median-street-lamps') as
    MedianLampGroup | undefined
  syncStreetLighting = () => {
    medianLamps?.setTimeOfDay(timeOfDay)
  }
  syncStreetLighting() // Also handles ?time=dusk / ?night=1 before the GLB finishes loading.
  document.title = `${car.label} · ${map.name} · 驾驶测试`

  // On the bridge map the track centreline is the same one the deck was swept
  // along, so the driving surface and the rendered road cannot drift apart.
  const track = createTrackSurface({
    centreline: map.centreline,
    origin: map.origin,
    surfaceY: map.surfaceY,
    lateralMin: map.lateralMin,
    lateralMax: map.lateralMax,
    startDistance: map.startDistance,
  })
  // Wet asphalt is part of the map materials, not a screen filter: these shaders
  // know where lane paint and puddles are. The impact pool follows the car on the
  // same centreline, so drops land on drivable road rather than on guardrails.
  const rainImpacts = createRainImpacts({ track })
  scene.add(rainImpacts.object)
  const wetRoad = createWetRoad({
    root: map.visual,
    scene,
    surfaceY: map.surfaceY,
  })
  wetRoad.setExclusions([rainImpacts.object])
  syncWeatherSurfaces = () => {
    wetRoad.setRain(rainActive(), rainIntensity)
    rainImpacts.setEnabled(rainActive(), rainIntensity)
    rainImpacts.setDensity(rainDensity)
    rainImpacts.setBrightness(
      THREE.MathUtils.clamp(1 / Math.max(renderer.toneMappingExposure, 0.01), 0.8, 3),
    )
  }
  syncWeatherSurfaces()

  // 可操控的大疆无人机:飞控内核 + 机械装配层,默认随车悬停,按 U 接管操控。
  const drone = createRaceDrone({
    url: '/models/djiair_renamed.glb',
    size: metres(0.42),
    offset: new THREE.Vector3(metres(-2.7), metres(2.8), metres(3.2)),
    signal: globalSignal,
    // 箭头函数体在按键那一刻才求值,绕开后面 const 的暂时性死区
    onIdleFlightKey: () =>
      showDroneToast(
        '先按 U（或点右上角「设置」→「接管操控」）接管无人机,键盘才会驱动它（接管后 W/S/A/D 也能飞）',
      ),
  })
  drone.setEnabled(params.get('drone') !== '0')
  scene.add(drone.root)

  // 以下装配句柄在 boot() 载入完成前都为 null,所有使用处都需判空
  let rig: CarRig | null = null
  let vehicle: Vehicle | null = null
  let chase: ReturnType<typeof createChaseCamera> | null = null
  let lights: CarLights | null = null
  let mirrors: CarMirrors | null = null
  let carBody: CarBody | null = null
  // Mirror shells this scene must not shine the environment back off. The BMW's
  // mirror pods are one white metal mesh, so its reflection reads as a sheet of
  // sky stuck to the pod instead of a mirror in a housing.
  let mirrorShells: MirrorShell[] = []
  // What the switch means depends on the car, so its default does too. A model
  // whose mirror glass is its own mesh (the Omoda, the Lamborghini) gets a mirror
  // that is what the glass is for. The BMW has no separable glass, and its one
  // white shell reflecting the sky reads as a sheet over the whole pod, so it
  // starts matte. `?mirrorReflection=0|1` overrides either way.
  let mirrorReflection = params.has('mirrorReflection')
    ? params.get('mirrorReflection') === '1'
    : Boolean(car.mirrorGlass)
  let keyboard: ReturnType<typeof createKeyboardInput> | null = null
  let modelTree: ModelTree | null = null
  let boarding: Boarding | null = null
  // Set while the boarding camera is in charge, so the view is handed back once.
  let boardingCameraHeld = false
  // What says which part the tree or a click is pointing at: a glowing shell around
  // it, breathing, and a box outline for the cases the shell cannot cover.
  let highlightHelper: THREE.Box3Helper | null = null
  const glowShells: {
    mesh: THREE.Mesh
    material: THREE.ShaderMaterial
    thickness: number
    source: THREE.Mesh
  }[] = []
  /** Above this many meshes the glow would be hundreds of extra draw calls. */
  const GLOW_MESH_LIMIT = 80
  let autopilot: Autopilot | null = null
  // ?auto=1 drives itself from the first frame, which is the way to show the
  // scene off without holding a key.
  let autopilotOn = params.get('auto') === '1'
  let paused = false
  let hazardsOn = false
  // Chase camera by default; a mouse drag hands the view to the user.
  let freeCamera = false
  /**
   * 镜头看谁。刻意与"谁在被操控"解耦:接管无人机不会把镜头锁死,
   * 一边开车一边把镜头怼在飞机上、或者反过来,都成立。
   *
   * - `car`   车辆追尾,或用户拖鼠标后的自由视角(`freeCamera`)
   * - `drone` 吊在无人机后上方的跟拍
   * - `fpv`   机载视角:相机就架在云台镜片上,朝向即云台光轴
   */
  let cameraFocus: DroneCameraFocus = 'car'
  /** 累计的未消化帧时间(秒),按固定步长 STEP 分批喂给物理,避免帧率影响仿真 */
  let accumulator = 0
  let previous = performance.now()
  // Frame rate, smoothed over a window rather than per frame: a single frame's
  // delta jumps around far too much to read, and the DOM should not be written
  // 120 times a second.
  let fps = 0
  let fpsFrames = 0
  let fpsWindow = 0
  /** Last frame's delta, for passes that are driven from `render()`. */
  let lastFrameDelta = 1 / 60

  // Settings panel. The switches rewrite the URL and reload, except day/night,
  // which is a live change, so the panel always shows what the address bar says
  // instead of keeping its own copy of the state.
  const panel = document.querySelector<HTMLElement>('#race-panel')!
  const settingsButton = document.querySelector<HTMLButtonElement>('#race-settings')!
  /**
   * 新版 lib.dom 里 `HTMLElement.hidden` 的类型是 `boolean | 'until-found'`,
   * 直接参与逻辑运算会把联合类型带出去。开关面板只关心"现在藏没藏着",
   * 所以统一收敛成布尔值:`'until-found'` 也算藏着。
   */
  const isHidden = (element: HTMLElement) => element.hidden !== false
  const setPanelOpen = (open: boolean) => {
    panel.hidden = !open
    settingsButton.setAttribute('aria-expanded', String(open))
  }
  settingsButton.addEventListener('click', () => setPanelOpen(isHidden(panel)))
  document.querySelector('#race-close')!.addEventListener('click', () => {
    setPanelOpen(false)
    settingsButton.focus()
  })
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') setPanelOpen(false)
    },
    { signal: globalSignal },
  )
  /** 改地址栏参数并整页重载:需要重载资源的开关(地图/车辆等)走这条路 */
  const withParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(location.search)
    if (value === null) next.delete(key)
    else next.set(key, value)
    location.search = next.toString()
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-map]')) {
    button.classList.toggle('is-active', button.dataset.map === map.id)
    button.addEventListener('click', () => withParam('map', button.dataset.map ?? null))
  }
  const carRow = document.querySelector<HTMLElement>('#race-car-row')!
  for (const option of CARS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = option.label
    button.classList.toggle('is-active', option.id === car.id)
    button.addEventListener('click', () =>
      withParam('car', option.id === CARS[0].id ? null : option.id),
    )
    carRow.append(button)
  }
  const seedInput = document.querySelector<HTMLInputElement>('#race-seed')!
  seedInput.value = String(map.generator?.seed ?? Number(params.get('seed') ?? 1))
  document
    .querySelector('#race-seed-apply')!
    .addEventListener('click', () => withParam('seed', seedInput.value || '1'))
  // The model tree: the GLB as a list of nodes, and the other half of the pick.
  const treePanel = document.querySelector<HTMLElement>('#race-tree')!
  const treeToggle = document.querySelector<HTMLButtonElement>('#race-tree-toggle')!
  const treeClose = document.querySelector<HTMLButtonElement>('#race-tree-close')!
  const treeSearch = document.querySelector<HTMLInputElement>('#race-tree-search')!
  const treeHost = document.querySelector<HTMLElement>('#race-tree-host')!
  const treeCount = document.querySelector<HTMLElement>('#race-tree-count')!
  modelTree = createModelTree({
    host: treeHost,
    search: treeSearch,
    // A row click selects the same part a scene click would: outlined in the
    // scene, described in the label at the bottom, no second round trip.
    onSelect: (object) => selectPart(object),
  })
  const setTreeOpen = (open: boolean) => {
    treePanel.hidden = !open
    treeToggle.setAttribute('aria-expanded', String(open))
    host.classList.toggle('tree-open', open)
    rewriteParam('tree', open ? '1' : null)
  }
  treeToggle.addEventListener('click', () => setTreeOpen(isHidden(treePanel)))
  treeClose.addEventListener('click', () => setTreeOpen(false))
  const mirrorReflectionBox = document.querySelector<HTMLInputElement>('#race-mirror-reflection')!
  mirrorReflectionBox.checked = mirrorReflection
  mirrorReflectionBox.addEventListener('change', () => {
    mirrorReflection = mirrorReflectionBox.checked
    applyMirrorReflection()
    mirrors?.setEnabled(mirrorReflection)
    rewriteParam('mirrorReflection', mirrorReflection ? '1' : null)
  })
  const assistBox = document.querySelector<HTMLInputElement>('#race-assist')!
  assistBox.checked = assistEnabled
  assistBox.addEventListener('change', () => withParam('assist', assistBox.checked ? null : '0'))
  const reflectionBox = document.querySelector<HTMLInputElement>('#race-reflection')!
  reflectionBox.checked = params.get('reflection') !== '0'
  reflectionBox.addEventListener('change', () =>
    withParam('reflection', reflectionBox.checked ? null : '0'),
  )
  const headlightBox = document.querySelector<HTMLInputElement>('#race-headlights')!
  const syncHeadlightBox = () => {
    if (lights) headlightBox.checked = lights.state().headlights
  }
  headlightBox.addEventListener('change', () => {
    lights?.setHeadlights(headlightBox.checked)
  })
  const hazardsBox = document.querySelector<HTMLInputElement>('#race-hazards')!
  const syncHazards = () => {
    hazardsBox.checked = hazardsOn
  }
  hazardsBox.addEventListener('change', () => {
    hazardsOn = hazardsBox.checked
  })
  syncHazards()
  // Bloom and its strength only change the pass chain, so they apply live instead
  // of reloading the page like the map switches do. They still go into the address
  // bar, because the look of a night shot is worth sharing.
  const bloomBox = document.querySelector<HTMLInputElement>('#race-bloom')!
  const bloomRange = document.querySelector<HTMLInputElement>('#race-bloom-strength')!
  const bloomValue = document.querySelector<HTMLElement>('#race-bloom-value')!
  const glowRange = document.querySelector<HTMLInputElement>('#race-glow-strength')!
  const glowValue = document.querySelector<HTMLElement>('#race-glow-value')!
  /** 只就地改地址栏、不重载:只影响渲染/材质的实时开关走这条路(与 withParam 相对) */
  const rewriteParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(location.search)
    if (value === null) next.delete(key)
    else next.set(key, value)
    history.replaceState(
      null,
      '',
      `${location.pathname}${next.toString() ? '?' + next.toString() : ''}`,
    )
  }
  const droneToast = document.querySelector<HTMLElement>('#race-drone-toast')!
  let droneToastTimer = 0
  let droneToastDisposed = false
  /**
   * 场景里的短提示(误按飞行键、接管失败、机载视角不可用…)。
   * 这些都必须"说出来":否则从用户视角看就是点了没反应。
   */
  const showDroneToast = (text: string) => {
    if (!text || droneToastDisposed) return
    droneToast.textContent = text
    droneToast.hidden = false
    window.clearTimeout(droneToastTimer)
    droneToastTimer = window.setTimeout(() => {
      droneToast.hidden = true
    }, 3600)
  }

  const droneBox = document.querySelector<HTMLInputElement>('#race-drone')!
  const droneFocusButton = document.querySelector<HTMLButtonElement>('#race-drone-focus')!
  const dronePilotButton = document.querySelector<HTMLButtonElement>('#race-drone-pilot')!
  const droneTakeoffButton = document.querySelector<HTMLButtonElement>('#race-drone-takeoff')!
  const droneLandButton = document.querySelector<HTMLButtonElement>('#race-drone-land')!
  const droneRthButton = document.querySelector<HTMLButtonElement>('#race-drone-rth')!
  const droneStatus = document.querySelector<HTMLElement>('#race-drone-status')!
  const droneCamCar = document.querySelector<HTMLButtonElement>('#race-drone-cam-car')!
  const droneCamDrone = document.querySelector<HTMLButtonElement>('#race-drone-cam-drone')!
  const droneCamFpv = document.querySelector<HTMLButtonElement>('#race-drone-cam-fpv')!
  const droneHud = document.querySelector<HTMLElement>('#race-drone-hud')!
  const droneHudPhase = document.querySelector<HTMLElement>('#drone-hud-phase')!
  const droneHudAltitude = document.querySelector<HTMLElement>('#drone-hud-altitude')!
  const droneHudSpeed = document.querySelector<HTMLElement>('#drone-hud-speed')!
  const droneHudBattery = document.querySelector<HTMLElement>('#drone-hud-battery')!
  const droneHudHeading = document.querySelector<HTMLElement>('#drone-hud-heading')!
  const droneHudAttitude = document.querySelector<HTMLElement>('#drone-hud-attitude')!
  const droneHudHome = document.querySelector<HTMLElement>('#drone-hud-home')!
  const droneHudWarning = document.querySelector<HTMLElement>('#drone-hud-warning')!
  const droneHudGimbal = document.querySelector<HTMLElement>('#drone-hud-gimbal')!
  const droneStickBars = {
    throttle: document.querySelector<HTMLElement>('#drone-hud-stick-throttle')!,
    yaw: document.querySelector<HTMLElement>('#drone-hud-stick-yaw')!,
    pitch: document.querySelector<HTMLElement>('#drone-hud-stick-pitch')!,
    roll: document.querySelector<HTMLElement>('#drone-hud-stick-roll')!,
  }

  /** 机头方位角(度)→ 八向罗盘:读起来比纯数字直观 */
  const COMPASS_POINTS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  const compassPoint = (deg: number) =>
    COMPASS_POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!

  const syncDronePanel = () => {
    const state = drone.state()
    droneBox.checked = state.enabled
    droneFocusButton.disabled = state.status !== 'ready' || !state.enabled
    dronePilotButton.disabled = !drone.canPilot() || !state.enabled
    dronePilotButton.textContent = state.piloting ? '交还操控' : '接管操控'
    dronePilotButton.classList.toggle('active', state.piloting)
    const flying = state.piloting
    // 起飞不要求先接管:没接管时点它会顺带接管。已经在天上就没必要再起飞。
    const airborne = drone.flight()?.airborne ?? false
    droneTakeoffButton.disabled = !state.enabled || state.status !== 'ready' || airborne
    droneLandButton.disabled = !flying || !airborne
    droneRthButton.disabled = !flying || !airborne
    droneStatus.textContent =
      state.status === 'error'
        ? '模型载入失败，重新勾选可重试'
        : !state.enabled
          ? '已隐藏'
          : state.status === 'ready'
            ? flying
              ? '已接管 · 键盘已交给无人机（W/S 前后、A/D 转向、Z/X 升降；U 交还）'
              : '车辆右前方悬停，随车移动'
            : '正在载入无人机…（载入完成后才能接管）'
    syncCameraButtons()
  }
  /** 摇杆量画成上下两根半格:值有正负,从中线往两边长 */
  const applyStickBar = (bar: HTMLElement, value: number) => {
    const amount = Math.min(1, Math.abs(value))
    bar.style.top = value < 0 ? '50%' : 'auto'
    bar.style.bottom = value >= 0 ? '50%' : 'auto'
    bar.style.height = `${amount * 50}%`
    bar.style.background = amount > 0.01 ? '#48d597' : 'transparent'
  }
  /** 接管飞行时的实时读数;未接管就整块收起来,不占画面 */
  const syncDroneHud = () => {
    const flight = drone.flight()
    droneHud.hidden = !flight
    if (!flight) return
    droneHudPhase.textContent = `${flight.phaseLabel} · ${flight.modeLabel}`
    droneHudAltitude.textContent = `${flight.altitude.toFixed(1)} m`
    droneHudSpeed.textContent = `${flight.horizontalSpeed.toFixed(1)} m/s`
    droneHudBattery.textContent = `${flight.batteryPercent.toFixed(0)}%`
    droneHudHeading.textContent = `${compassPoint(flight.heading)} ${flight.heading.toFixed(0)}°`
    droneHudAttitude.textContent = `俯仰 ${flight.tiltPitch.toFixed(1)}° · 横滚 ${flight.tiltRoll.toFixed(1)}°`
    droneHudHome.textContent = `返航点 ${flight.distanceToHome.toFixed(0)} m · ${flight.satelliteCount} 星`
    // 摇杆量每帧刷新:HUD 上的四根条子就是"按键有没有真的进来"的证据
    applyStickBar(droneStickBars.throttle, flight.stick.throttle)
    applyStickBar(droneStickBars.yaw, flight.stick.yaw)
    applyStickBar(droneStickBars.pitch, flight.stick.pitch)
    applyStickBar(droneStickBars.roll, flight.stick.roll)
    droneHudGimbal.textContent = `${flight.gimbalPitch.toFixed(0)}°`
    droneHudWarning.textContent = flight.warning
    droneHudWarning.hidden = !flight.warning
  }
  /** 相机三挡按钮的选中态与可用性 */
  const syncCameraButtons = () => {
    const state = drone.state()
    const visible = state.visible
    droneCamCar.classList.toggle('is-active', cameraFocus === 'car')
    droneCamDrone.classList.toggle('is-active', cameraFocus === 'drone')
    droneCamFpv.classList.toggle('is-active', cameraFocus === 'fpv')
    droneCamCar.disabled = false
    droneCamDrone.disabled = !visible
    // 云台要模型在场景里才谈得上取景
    droneCamFpv.disabled = !visible || state.status !== 'ready'
  }
  const loadDrone = () => {
    const loading = drone.load()
    syncDronePanel()
    void loading.then(() => {
      syncDronePanel()
      // 无人机模型是此刻才进场景的,先编译它的着色器再让玩家看见(见 warmUpShaders)。
      // 运行期不挂起主循环 —— 会变成画面冻住。
      void warmUpShaders(false)
    })
  }

  // —— 接管时的跟随相机:吊在无人机后上方,平滑跟随 ——
  const droneCameraTarget = new THREE.Vector3()
  const droneCameraDesired = new THREE.Vector3()
  const droneCameraForward = new THREE.Vector3()
  let droneCameraReady = false
  const updateDroneCamera = (delta: number) => {
    const pose = drone.cameraPose()
    droneCameraForward.set(Math.sin(pose.heading), 0, Math.cos(pose.heading))
    droneCameraDesired.copy(pose.position).addScaledVector(droneCameraForward, -metres(3.4))
    droneCameraDesired.y += metres(1.5)
    if (!droneCameraReady) {
      camera.position.copy(droneCameraDesired)
      droneCameraTarget.copy(pose.position)
      droneCameraReady = true
    } else {
      camera.position.lerp(droneCameraDesired, 1 - Math.exp(-5 * delta))
      droneCameraTarget.lerp(pose.position, 1 - Math.exp(-9 * delta))
    }
    camera.fov = CAMERA.baseFov
    camera.updateProjectionMatrix()
    camera.lookAt(droneCameraTarget)
  }
  const dronePiloting = () => drone.piloting()

  // —— 机载视角:相机就架在云台镜片上,朝向即云台光轴 ——
  /**
   * 沿光轴前移的取景偏移(米)。这个模型是按真机尺寸(0.42 m)摆进场景的,
   * 所以偏移只有几厘米就够把鼻尖让出画面。
   */
  const GIMBAL_CAMERA_OFFSET = metres(0.035)
  const gimbalCameraScratch = new THREE.Object3D()
  /** 云台俯仰杆:按住 T / F 时为 -1 / +1,每帧连续走 */
  let gimbalHold: -1 | 0 | 1 = 0
  /** 云台俯仰角速度(度/秒) */
  const GIMBAL_RATE = 34
  /**
   * 把相机摆到机载视角。返回 false 表示云台还不可用(模型没载完),
   * 调用方应退回跟拍,免得把相机丢在上一帧的位置上。
   */
  const updateDroneFpvCamera = (): boolean => {
    if (!drone.gimbalCameraPose(gimbalCameraScratch, GIMBAL_CAMERA_OFFSET)) return false
    camera.position.copy(gimbalCameraScratch.position)
    camera.quaternion.copy(gimbalCameraScratch.quaternion)
    // 视场角固定在基准值(车辆视角会随车速拉到 speedFov,云台相机不该跟着变)
    camera.fov = CAMERA.baseFov
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    return true
  }

  /** 把镜头交给无人机(跟拍)。它不改变无人机是否被操控,只改镜头 */
  const enterDroneCamera = () => {
    cameraFocus = 'drone'
    freeCamera = false
    controls.enabled = false
    droneCameraReady = false
    syncCameraButtons()
  }

  /** 把镜头切成机载视角(相机上云台) */
  const enterDroneFpvCamera = (): boolean => {
    if (!drone.state().visible) return false
    // 先试一次:云台不可用时不切,免得镜头卡在一个不会更新的位姿上
    if (!updateDroneFpvCamera()) return false
    cameraFocus = 'fpv'
    freeCamera = false
    controls.enabled = false
    syncCameraButtons()
    return true
  }

  /** 相机模式的唯一收口:键盘、按钮、调试出口都走这里 */
  const setCameraFocus = (value: DroneCameraFocus): DroneCameraFocus => {
    if (value === 'fpv') {
      if (enterDroneFpvCamera()) return cameraFocus
      value = 'drone'
    }
    if (value === 'drone') {
      // 跟拍要有机可跟;飞机藏着的时候退回车辆视角
      if (!drone.state().visible) value = 'car'
      else enterDroneCamera()
    }
    if (value === 'car') enterChaseCamera()
    return cameraFocus
  }

  /**
   * 接管 / 交还无人机的键盘操控。
   *
   * 接管 = **操控权交接**:接管期间键盘整体归无人机(驾驶键 W/S/A/D 与方向键借调
   * 过去,见 drone-control 的 CAR_KEY_AXES),交还时立刻还给汽车。同一时刻操控权
   * 只有一份,不会出现"按了 W 车和飞机一起动"。
   *
   * 但车本身**不被暂停**:接管不动 `paused`、不动自动驾驶,车辆物理照常推进
   * (滑行、自动驾驶、车身动画都在),只是不吃键盘。这里另外做一件事——把镜头
   * 交给无人机,因为刚接管时你多半想看它。
   */
  const toggleDronePilot = () => {
    if (!dronePiloting()) {
      if (!drone.canPilot()) {
        const loading = drone.state().status !== 'ready'
        droneStatus.textContent = loading
          ? '正在载入无人机…（载入完成后才能接管）'
          : '无人机已隐藏，先勾选「显示无人机」'
        showDroneToast(
          loading
            ? '无人机模型还在载入,载入完成后才能接管'
            : '无人机被隐藏了,先在「设置」里勾上「显示无人机」',
        )
        return
      }
      if (!drone.setPiloting(true)) {
        // 接管失败(飞控自检没过)必须说出来,否则看起来就是"点了没反应"
        const reason = drone.snapshot().warnings[0] ?? '飞控未通过起飞前检查'
        droneStatus.textContent = `接管失败：${reason}`
        showDroneToast(`接管失败：${reason}`)
        syncDronePanel()
        return
      }
      // 刚接管时多半想看飞机,但**不锁死镜头**:C / M 随时能切走
      if (!setCameraFocus('drone')) setCameraFocus('car')
      syncDronePanel()
      // 读数卡立刻挂上,不等下一帧(低帧率下这一帧可能要等半秒)
      syncDroneHud()
      showDroneToast(
        '键盘已交给无人机：W/S 前后 · A/D 左右转 · Z/X 升降（I/K/J/L 同样可用），交还后汽车恢复驾驶',
      )
      return
    }
    drone.setPiloting(false)
    syncDronePanel()
    syncDroneHud()
    // 交还后镜头回车辆;车本身一直没被暂停过,不需要"恢复"
    setCameraFocus('car')
    showDroneToast('键盘已还给汽车：W/A/S/D 恢复驾驶')
  }

  droneBox.addEventListener('change', () => {
    drone.setEnabled(droneBox.checked)
    rewriteParam('drone', droneBox.checked ? null : '0')
    if (droneBox.checked) loadDrone()
    else {
      // 藏了飞机就别让镜头继续跟着它
      if (cameraFocus === 'drone') enterChaseCamera()
      syncDronePanel()
    }
  })
  dronePilotButton.addEventListener('click', toggleDronePilot)
  /** 起飞:还没接管就先接管(接管本身会飞到悬停高度),已接管就直接起飞 */
  droneTakeoffButton.addEventListener('click', () => {
    if (!drone.piloting()) {
      toggleDronePilot()
      return
    }
    drone.autoTakeOff()
    syncDroneHud()
  })
  droneLandButton.addEventListener('click', () => {
    drone.startLanding()
    syncDroneHud()
  })
  droneRthButton.addEventListener('click', () => {
    drone.startRth()
    syncDroneHud()
  })
  // 镜头三挡:与"谁在被操控"无关,所以车辆/无人机两套按键之外单独给按钮
  droneCamCar.addEventListener('click', () => setCameraFocus('car'))
  droneCamDrone.addEventListener('click', () => setCameraFocus('drone'))
  droneCamFpv.addEventListener('click', () => {
    if (setCameraFocus('fpv') !== 'fpv') {
      droneStatus.textContent = '机载视角暂不可用（云台未就绪）'
      showDroneToast('机载视角暂不可用:云台还没准备好,等模型载完再试')
    }
  })
  droneFocusButton.addEventListener('click', () => {
    if (!drone.state().visible) return
    // 只是把镜头摆到无人机上,不干预车辆:车照开,飞机照飞
    freeCamera = true
    cameraFocus = 'car'
    controls.enabled = true
    const pose = drone.cameraPose()
    controls.target.copy(pose.position)
    const offset = new THREE.Vector3(metres(0.4), metres(0.25), metres(0.55))
    camera.position.copy(controls.target).add(offset)
    camera.fov = CAMERA.baseFov
    camera.updateProjectionMatrix()
    camera.lookAt(controls.target)
    camera.updateMatrixWorld()
    setPanelOpen(false)
    render()
  })
  syncDronePanel()
  // The tree starts open only when the link asks for it, which is also how it is
  // shared: ?tree=1.
  setTreeOpen(params.get('tree') === '1')
  // The selection glow is a matter of taste, so it gets the same treatment as the
  // night bloom: live, and written into the link. Zero means no glow at all - the
  // selection falls back to the thin outline box, which is also the escape hatch at
  // `?outline=1`.
  const syncGlowPanel = () => {
    glowRange.value = glowIntensity.toFixed(2)
    glowValue.textContent = glowIntensity.toFixed(2)
  }
  glowRange.addEventListener('input', () => {
    glowIntensity = THREE.MathUtils.clamp(Number(glowRange.value), 0, 2)
    syncGlowPanel()
    rewriteParam('glow', Math.abs(glowIntensity - 0.6) < 0.001 ? null : glowIntensity.toFixed(2))
    // Anything selected right now has to change with the dial: the shells are built
    // from the intensity, so the selection is made again.
    const selected = modelTree?.selected() ?? null
    if (selected) selectPart(selected)
  })
  syncGlowPanel()
  const syncBloomPanel = () => {
    bloomBox.checked = bloomEnabled
    bloomRange.disabled = !bloomEnabled
    bloomRange.value = bloomPass.strength.toFixed(2)
    bloomValue.textContent = bloomPass.strength.toFixed(2)
  }
  bloomBox.addEventListener('change', () => {
    bloomEnabled = bloomBox.checked
    rewriteParam('bloom', bloomBox.checked ? null : '0')
    syncBloomPanel()
  })
  bloomRange.addEventListener('input', () => {
    bloomPass.strength = Number(bloomRange.value)
    rewriteParam(
      'bloomStrength',
      Math.abs(bloomPass.strength - 0.55) < 0.001 ? null : bloomPass.strength.toFixed(2),
    )
    syncBloomPanel()
  })
  syncBloomPanel()
  // Rain is a live post-process. Its look is tied to exposure and bloom, so the
  // checkbox also refreshes the time-of-day values without reloading the scene.
  const rainBox = document.querySelector<HTMLInputElement>('#race-rain')!
  const rainRange = document.querySelector<HTMLInputElement>('#race-rain-strength')!
  const rainValue = document.querySelector<HTMLElement>('#race-rain-value')!
  const rainDensityInput = document.querySelector<HTMLInputElement>('#race-rain-density')!
  const rainDensityValue = document.querySelector<HTMLElement>('#race-rain-density-value')!
  const syncRainPanel = () => {
    rainBox.checked = rainEnabled
    rainRange.disabled = !rainEnabled
    rainRange.value = rainIntensity.toFixed(2)
    rainValue.textContent = rainIntensity.toFixed(2)
    rainDensityInput.disabled = !rainEnabled
    rainDensityInput.value = rainDensity.toFixed(2)
    rainDensityValue.textContent = rainDensity.toFixed(2)
  }
  const setRain = (enabled: boolean, intensity = rainIntensity) => {
    const weatherChanged =
      rainActive() !== (enabled && THREE.MathUtils.clamp(intensity, 0, 1) > 0.01)
    rainEnabled = enabled
    rainIntensity = THREE.MathUtils.clamp(intensity, 0, 1)
    rainPass.enabled = rainActive()
    rainPass.uniforms.intensity.value = rainIntensity
    if (weatherChanged) applyTimeOfDay()
    else syncWeatherSurfaces?.()
    rewriteParam('rain', rainEnabled ? '1' : null)
    rewriteParam(
      'rainIntensity',
      rainEnabled && Math.abs(rainIntensity - 0.65) > 0.001 ? rainIntensity.toFixed(2) : null,
    )
    syncRainPanel()
  }
  rainBox.addEventListener('change', () => setRain(rainBox.checked))
  rainRange.addEventListener('input', () => setRain(rainEnabled, Number(rainRange.value)))
  rainDensityInput.addEventListener('input', () => {
    rainDensity = THREE.MathUtils.clamp(Number(rainDensityInput.value), 0, 2)
    rainImpacts.setDensity(rainDensity)
    rewriteParam('rainDensity', Math.abs(rainDensity - 1) < 0.001 ? null : rainDensity.toFixed(2))
    syncRainPanel()
  })
  rainPass.enabled = rainActive()
  rainPass.uniforms.intensity.value = rainIntensity
  rainImpacts.setDensity(rainDensity)
  syncRainPanel()
  // Autopilot. It is a driving mode rather than a render switch, so it applies
  // live, and a key press always takes the wheel back.
  const autoBox = document.querySelector<HTMLInputElement>('#race-auto')!
  const updateAutoReadout = () => {
    readout.auto.textContent = autopilotOn ? '开 · 沿赛道行驶' : '关'
  }
  const setAutopilot = (on: boolean) => {
    autopilotOn = on
    rewriteParam('auto', on ? '1' : null)
    autoBox.checked = on
    updateAutoReadout()
  }
  autoBox.addEventListener('change', () => setAutopilot(autoBox.checked))
  autoBox.checked = autopilotOn
  updateAutoReadout()
  // Water: these are water-material uniforms, so a change shows on the next
  // so they apply live and still go into the link.
  const waterParams = environment.getParams()
  const windInput = document.querySelector<HTMLInputElement>('#race-wind')!
  const windValue = document.querySelector<HTMLElement>('#race-wind-value')!
  const waveInput = document.querySelector<HTMLInputElement>('#race-wave')!
  const waveValue = document.querySelector<HTMLElement>('#race-wave-value')!
  const rippleInput = document.querySelector<HTMLInputElement>('#race-ripple')!
  const rippleValue = document.querySelector<HTMLElement>('#race-ripple-value')!
  const initialWind = Number(params.get('wind') ?? waterParams.wind)
  const initialWave = Number(params.get('wave') ?? waterParams.intensity)
  const initialRipple = Number(params.get('ripple') ?? waterParams.ripple)
  const syncWaterPanel = () => {
    const current = environment.getParams()
    windInput.value = current.wind.toFixed(2)
    windValue.textContent = current.wind.toFixed(2)
    waveInput.value = current.intensity.toFixed(2)
    waveValue.textContent = current.intensity.toFixed(2)
    rippleInput.value = current.ripple.toFixed(2)
    rippleValue.textContent = current.ripple.toFixed(2)
  }
  if (
    Number.isFinite(initialWind) ||
    Number.isFinite(initialWave) ||
    Number.isFinite(initialRipple)
  ) {
    environment.setParams({
      ...(Number.isFinite(initialWind) ? { wind: Math.max(-1, Math.min(1, initialWind)) } : {}),
      ...(Number.isFinite(initialWave) ? { intensity: Math.max(0, Math.min(1, initialWave)) } : {}),
      ...(Number.isFinite(initialRipple)
        ? { ripple: Math.max(0.4, Math.min(2.5, initialRipple)) }
        : {}),
    })
  }
  windInput.addEventListener('input', () => {
    environment.setParams({ wind: Number(windInput.value) })
    rewriteParam(
      'wind',
      Math.abs(Number(windInput.value) - 0.35) < 0.001 ? null : Number(windInput.value).toFixed(2),
    )
    syncWaterPanel()
  })
  waveInput.addEventListener('input', () => {
    environment.setParams({ intensity: Number(waveInput.value) })
    rewriteParam(
      'wave',
      Math.abs(Number(waveInput.value) - 0.45) < 0.001 ? null : Number(waveInput.value).toFixed(2),
    )
    syncWaterPanel()
  })
  rippleInput.addEventListener('input', () => {
    environment.setParams({ ripple: Number(rippleInput.value) })
    rewriteParam(
      'ripple',
      Math.abs(Number(rippleInput.value) - 1) < 0.001 ? null : Number(rippleInput.value).toFixed(2),
    )
    syncWaterPanel()
  })
  syncWaterPanel()
  // Body animations. Live switches, written into the link like the water sliders.
  // A model that has no mirrors, no sunroof or no rear doors reports zero parts
  // and the switch is disabled rather than pretending.
  const windowsBox = document.querySelector<HTMLInputElement>('#race-windows')!
  const mirrorsBox = document.querySelector<HTMLInputElement>('#race-mirrors')!
  const sunroofBox = document.querySelector<HTMLInputElement>('#race-sunroof')!
  const boardingButton = document.querySelector<HTMLButtonElement>('#race-board')!
  boardingButton.disabled = true
  boardingButton.addEventListener('click', () => {
    if (!boarding) return
    const started = boarding.start()
    if (started) boardingCamera()
    boardingButton.textContent = started ? '重新播放（回到车外）' : '正在载入人物…'
  })
  const doorBoxes: Record<DoorId, HTMLInputElement> = {
    fl: document.querySelector<HTMLInputElement>('#race-door-fl')!,
    fr: document.querySelector<HTMLInputElement>('#race-door-fr')!,
    rl: document.querySelector<HTMLInputElement>('#race-door-rl')!,
    rr: document.querySelector<HTMLInputElement>('#race-door-rr')!,
  }
  // ?doors=fl,rr opens a set of doors from the link. Doors are four independent
  // targets, so they get one parameter rather than four.
  const doorsFromLink = (params.get('doors') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name): name is DoorId => (DOOR_IDS as readonly string[]).includes(name))
  const openDoorsInLink = () => DOOR_IDS.filter((id) => doorBoxes[id].checked).join(',')
  const syncBodyPanel = () => {
    const state = carBody?.state()
    const parts = state?.parts ?? { windows: 0, mirrors: 0, sunroof: 0, doors: 0 }
    const targets = state?.targets ?? { windows: false, mirrors: false, sunroof: false }
    const doorTargets = state?.doorTargets ?? { fl: false, fr: false, rl: false, rr: false }
    const available = carBody?.doorIds() ?? []
    windowsBox.disabled = parts.windows === 0
    mirrorsBox.disabled = parts.mirrors === 0
    sunroofBox.disabled = parts.sunroof === 0
    windowsBox.checked = targets.windows
    mirrorsBox.checked = targets.mirrors
    sunroofBox.checked = targets.sunroof
    for (const id of DOOR_IDS) {
      doorBoxes[id].disabled = !available.includes(id)
      doorBoxes[id].checked = doorTargets[id]
    }
  }
  const wireBodySwitch = (box: HTMLInputElement, part: BodyPartName) => {
    box.addEventListener('change', () => {
      carBody?.set({ [part]: box.checked } as Partial<BodyTargets>)
      rewriteParam(part, box.checked ? '1' : null)
      syncBodyPanel()
    })
  }
  wireBodySwitch(windowsBox, 'windows')
  wireBodySwitch(mirrorsBox, 'mirrors')
  wireBodySwitch(sunroofBox, 'sunroof')
  for (const id of DOOR_IDS) {
    doorBoxes[id].addEventListener('change', () => {
      carBody?.setDoors({ [id]: doorBoxes[id].checked })
      const open = openDoorsInLink()
      rewriteParam('doors', open || null)
      syncBodyPanel()
    })
  }
  syncBodyPanel()
  const timeButton = document.querySelector<HTMLButtonElement>('#race-time')!
  // Night brightness. Live, and written into the link so a dark night is
  // shareable.
  const nightInput = document.querySelector<HTMLInputElement>('#race-night-brightness')!
  const nightValue = document.querySelector<HTMLElement>('#race-night-brightness-value')!
  const syncNightPanel = () => {
    nightInput.value = nightBrightness.toFixed(2)
    nightValue.textContent = nightBrightness.toFixed(2)
  }
  nightInput.addEventListener('input', () => {
    nightBrightness = Math.max(0.3, Math.min(2, Number(nightInput.value)))
    applyTimeOfDay()
    rewriteParam(
      'nightBrightness',
      Math.abs(nightBrightness - 1) < 0.001 ? null : nightBrightness.toFixed(2),
    )
    syncNightPanel()
  })
  syncNightPanel()

  const TIME_ORDER: TimeOfDay[] = ['day', 'dusk', 'night']
  const TIME_LABEL: Record<TimeOfDay, string> = { day: '白天', dusk: '黄昏', night: '黑夜' }
  const cycleTime = () => {
    timeOfDay = TIME_ORDER[(TIME_ORDER.indexOf(timeOfDay) + 1) % TIME_ORDER.length]
    applyTimeOfDay()
    updateTimeReadout()
    syncTimeControl()
  }
  const syncTimeControl = () => {
    const next = TIME_ORDER[(TIME_ORDER.indexOf(timeOfDay) + 1) % TIME_ORDER.length]
    timeButton.textContent = `切到${TIME_LABEL[next]}`
  }
  timeButton.addEventListener('click', cycleTime)
  syncTimeControl()

  const resize = () => {
    const width = viewport.clientWidth
    const height = viewport.clientHeight
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    glowComposer.setSize(width, height)
    rainPass.uniforms.resolution.value.set(width, height)
    camera.aspect = width / Math.max(height, 1)
    camera.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(viewport)

  // Free look: drag to orbit the car, right drag (or two fingers) to pan, wheel to
  // zoom. A drag takes the camera off the chase rig until C puts it back.
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = true
  // Allow inspection of small GLB parts as well as whole vehicles.
  controls.minDistance = metres(0.05)
  controls.maxDistance = metres(600)
  controls.enabled = false
  const cameraAim = new THREE.Vector3()
  const enterFreeCamera = () => {
    // Taking over OrbitControls must not repaint the current view. Its target is
    // derived from the camera's actual aim instead of snapping back to the car.
    if (!freeCamera) {
      camera.getWorldDirection(cameraAim)
      const aimDistance = vehicle
        ? Math.max(metres(8), camera.position.distanceTo(vehicle.state.position))
        : metres(12)
      controls.target.copy(camera.position).addScaledVector(cameraAim, aimDistance)
      // 拖鼠标＝用户要自己掌镜,那就从无人机跟拍手里把镜头收回来
      cameraFocus = 'car'
      freeCamera = true
      controls.enabled = true
      controls.update()
      syncCameraButtons()
    }
  }
  const enterChaseCamera = () => {
    cameraFocus = 'car'
    freeCamera = false
    controls.enabled = false
    if (vehicle) chase?.snap(vehicle.state)
    syncCameraButtons()
  }
  // A pure pick returns to whatever camera owned the view before pointerdown.
  const resumeOwnedCamera = () => {
    freeCamera = false
    controls.enabled = false
  }
  // Capture phase: OrbitControls ignores a pointerdown while it is disabled, so
  // the camera has to be handed over before its own listener on the same element
  // runs.
  let pointerStartedFree = false
  renderer.domElement.addEventListener(
    'pointerdown',
    () => {
      pointerStartedFree = freeCamera
      if (!pointerStartedFree) enterFreeCamera()
    },
    true,
  )

  // Clicking a part reports what it is. Some pieces in this scene are created by
  // this code rather than shipped in the model - cut-out windows, mirror pods,
  // lamp lenses, light strips - and "which one is that?" is not answerable from a
  // screenshot. A raycast answers it in one click: the label shows the mesh name
  // and the two nodes above it, which is enough to tell a model mesh from one this
  // code made (car-mirror-*, car-window-*, car-lamp-*, car-halo-*, car-mirror-strip-*).
  const raycaster = new THREE.Raycaster()
  const pickPointer = new THREE.Vector2()
  const pickLabel = document.querySelector<HTMLElement>('#race-pick')!
  type PickInfo = {
    name: string
    chain: string[]
    material: string
    vertices: number
    distance: number
    world: number[]
  }
  /** The line the pick label shows, for a click or for a row in the tree. */
  const describePart = (object: THREE.Object3D, distance?: number): PickInfo => {
    const mesh = object as THREE.Mesh
    const chain: string[] = []
    for (let node: THREE.Object3D | null = mesh; node; node = node.parent)
      chain.push(node.name || '(' + node.type + ')')
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : []
    return {
      name: mesh.name || '(' + mesh.type + ')',
      chain,
      material: materials.map((item) => item.name || '(unnamed)').join(','),
      vertices: mesh.isMesh ? (mesh.geometry.getAttribute('position')?.count ?? 0) : 0,
      distance: distance ?? 0,
      world: mesh
        .getWorldPosition(new THREE.Vector3())
        .toArray()
        .map((value) => Number(value.toFixed(2))),
    }
  }

  /**
   * The ray, with the object it hit attached. Kept separate from `pickAt` because
   * the hook of that name is read by the checks and must hand back plain data:
   * a THREE object in there is a circular structure and takes the report down.
   */
  const pickHitAt = (
    clientX: number,
    clientY: number,
  ): { info: PickInfo; object: THREE.Object3D } | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    pickPointer.x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1
    pickPointer.y = -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1
    raycaster.setFromCamera(pickPointer, camera)
    const hits = raycaster.intersectObjects(scene.children, true)
    // The sea and the sky dome cover everything, and a click on a part must not
    // come back as a click on the water. Markers this code adds - the selection
    // outline - are not parts either: a click on a highlighted door has to keep
    // answering "door", not "race-highlight".
    const hit =
      hits.find(
        (entry) =>
          (entry.object as THREE.Mesh).isMesh &&
          entry.object.userData?.raceHelper !== true &&
          !/^(water-surface|sky-dome)$/.test(entry.object.name),
      ) ?? hits[0]
    if (!hit) return null
    return { info: describePart(hit.object, Number(hit.distance.toFixed(2))), object: hit.object }
  }
  const pickAt = (clientX: number, clientY: number): PickInfo | null =>
    pickHitAt(clientX, clientY)?.info ?? null
  const showPick = (info: PickInfo | null) => {
    pickLabel.hidden = !info
    if (!info) return
    pickLabel.textContent =
      info.name +
      '  ←  ' +
      info.chain.slice(1, 3).join('  ←  ') +
      '    ·    ' +
      info.material +
      '    ·    ' +
      info.vertices +
      ' 顶点'
    console.info('[pick]', info)
  }
  /**
   * An outline around a part, measured from its vertices.
   *
   * `Box3.setFromObject` is not usable here: these models carry stray vertices
   * that blow a mesh's box up to twice the car's length (the BMW's body shell is
   * the standing example), and an outline drawn from that says nothing about the
   * part. The box is built in the parent's frame and parented to that parent, so
   * it travels with the car without being rebuilt every frame - and it is not a
   * child of the part itself, so it never shows up in the tree it came from.
   */
  const robustBoxOf = (object: THREE.Object3D, parent: THREE.Object3D) => {
    parent.updateMatrixWorld(true)
    const toParent = new THREE.Matrix4().copy(parent.matrixWorld).invert()
    const point = new THREE.Vector3()
    const samples: number[][] = [[], [], []]
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const position = mesh.geometry.getAttribute('position')
      if (!position) return
      mesh.updateWorldMatrix(true, false)
      const step = Math.max(1, Math.floor(position.count / 2000))
      for (let index = 0; index < position.count; index += step) {
        point
          .set(position.getX(index), position.getY(index), position.getZ(index))
          .applyMatrix4(mesh.matrixWorld)
          .applyMatrix4(toParent)
        samples[0].push(point.x)
        samples[1].push(point.y)
        samples[2].push(point.z)
      }
    })
    if (!samples[0].length) return null
    const low: number[] = []
    const high: number[] = []
    for (const axis of samples) {
      axis.sort((a, b) => a - b)
      low.push(axis[Math.floor(axis.length * 0.01)])
      high.push(axis[Math.min(axis.length - 1, Math.floor(axis.length * 0.99))])
    }
    return new THREE.Box3(
      new THREE.Vector3(low[0], low[1], low[2]),
      new THREE.Vector3(high[0], high[1], high[2]),
    )
  }

  const clearHighlight = () => {
    clearGlow()
    if (!highlightHelper) return
    highlightHelper.removeFromParent()
    highlightHelper.geometry.dispose()
    ;(highlightHelper.material as THREE.Material).dispose()
    highlightHelper = null
  }

  /**
   * A glowing shell around a part: its own geometry, pushed out along the normals so
   * the halo has something to spread from, and bright enough that the bloom pass
   * picks it up. The shells live in `glowScene`, which only the glow composer sees;
   * the part they belong to keeps its own materials untouched.
   *
   * The geometry is shared with the part, never copied and never disposed - the
   * shell is a second view of the same buffer.
   */
  const glowVertexShader = /* glsl */ `
  uniform float thickness;
  void main() {
    vec3 inflated = position + normal * thickness;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(inflated, 1.0);
  }
`
  const glowFragmentShader = /* glsl */ `
  uniform vec3 glowColor;
  uniform float glowLevel;
  void main() {
    // Over 1.0 on purpose: the bloom pass thresholds on brightness, so the shell
    // has to be brighter than anything the scene puts on screen.
    gl_FragColor = vec4(glowColor * glowLevel, 1.0);
  }
`
  const clearGlow = () => {
    for (const shell of glowShells) {
      shell.mesh.removeFromParent()
      shell.material.dispose()
    }
    glowShells.length = 0
    glowComposite.uniforms.glowAmount.value = 0
  }
  const glowMeshes = (object: THREE.Object3D) => {
    const meshes: THREE.Mesh[] = []
    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.isMesh && mesh.userData.raceHelper !== true) meshes.push(mesh)
    })
    return meshes
  }
  const buildGlow = (object: THREE.Object3D) => {
    object.updateWorldMatrix(true, true)
    for (const mesh of glowMeshes(object)) {
      // Convert the calibrated world thickness to the mesh's original GLB units.
      const worldScale = mesh.getWorldScale(new THREE.Vector3()).x || 1
      const thickness = fromLegacyUnits(0.014) / worldScale
      const material = new THREE.ShaderMaterial({
        name: 'race-glow-material',
        uniforms: {
          thickness: { value: thickness },
          glowColor: { value: new THREE.Color(0x63d2ff) },
          glowLevel: { value: 1 },
        },
        vertexShader: glowVertexShader,
        fragmentShader: glowFragmentShader,
        side: THREE.FrontSide,
        depthTest: false,
        depthWrite: false,
      })
      const shell = new THREE.Mesh(mesh.geometry, material)
      shell.name = 'race-glow'
      shell.userData.raceHelper = true
      shell.frustumCulled = false
      // In the glow scene, so the main pass never sees it; the world matrix is
      // copied from the part it stands in for, every frame, in render().
      shell.matrixAutoUpdate = false
      glowScene.add(shell)
      glowShells.push({ mesh: shell, material, thickness, source: mesh })
    }
  }
  const highlightPart = (object: THREE.Object3D | null) => {
    clearHighlight()
    if (!object || !object.parent) return
    // The box stays available for the two cases a shell cannot serve: a part with
    // hundreds of meshes, and anyone who asks for it with ?outline=1.
    const meshes = glowMeshes(object).length
    if (
      glowIntensity > 0 &&
      meshes &&
      meshes <= GLOW_MESH_LIMIT &&
      object.userData.raceHelper !== true &&
      params.get('outline') !== '1'
    ) {
      buildGlow(object)
      return
    }
    const box = robustBoxOf(object, object.parent)
    if (!box) return
    highlightHelper = new THREE.Box3Helper(box, new THREE.Color(0x7fd3ff))
    highlightHelper.name = 'race-highlight'
    highlightHelper.userData.raceHelper = true
    highlightHelper.renderOrder = 6
    const material = highlightHelper.material as THREE.LineBasicMaterial
    material.depthTest = false
    material.transparent = true
    material.opacity = 0.9
    object.parent.add(highlightHelper)
  }

  // One selection, two views: whichever side asked, the other follows.
  const selectPart = (object: THREE.Object3D | null) => {
    highlightPart(object)
    modelTree?.select(object)
    showPick(object ? describePart(object) : null)
  }

  let pickStart: { x: number; y: number; startedFree: boolean } | null = null
  renderer.domElement.addEventListener('pointerdown', (event) => {
    pickStart = { x: event.clientX, y: event.clientY, startedFree: pointerStartedFree }
  })
  renderer.domElement.addEventListener('pointerup', (event) => {
    if (!pickStart) return
    const start = pickStart
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    pickStart = null
    // A drag is the camera; a click is a question and must not steal the view.
    if (moved > 5) return
    const picked = pickHitAt(event.clientX, event.clientY)
    selectPart(picked ? picked.object : null)
    if (!start.startedFree) resumeOwnedCamera()
  })
  const updateTimeReadout = () => {
    readout.time.textContent = TIME_LABEL[timeOfDay]
  }
  const hud = () => {
    // 无人机读数先更新:车辆还没载入完时它同样要保持刷新
    syncDroneHud()
    if (!vehicle) return
    const kmh = (Math.abs(vehicle.state.speed) / UNITS_PER_METRE) * 3.6
    readout.speed.textContent = `${kmh.toFixed(0)} km/h`
    readout.steer.textContent = `${((vehicle.state.steer * 180) / Math.PI).toFixed(0)}°`
    readout.distance.textContent = `${(vehicle.state.distance / UNITS_PER_METRE).toFixed(0)} m`
  }

  /**
   * Who is driving this frame. The autopilot writes the same input struct a key
   * would, so the physics, the lamps and the HUD cannot tell the difference; a
   * real key press always wins and hands the wheel back to the player.
   */
  const applyDrivingInput = (keys = true) => {
    if (!vehicle) return
    // 接管无人机期间,键盘整体交给无人机(见 drone-control 的 CAR_KEY_AXES):
    // 否则按 W 会一边让飞机前飞、一边给汽车加油,那才是真的"绑定"。
    // 车本身**不被暂停** —— 自动驾驶与滑行照旧,交还的那一刻键盘立刻回来。
    if (dronePiloting()) {
      vehicle.setInput(
        autopilotOn && autopilot ? autopilot.command() : { throttle: 0, brake: 0, steer: 0 },
      )
      return
    }
    const pressed = keyboard
      ? keyboard.input.throttle > 0.05 || keyboard.input.brake > 0.05 || keyboard.input.steer !== 0
      : false
    if (autopilotOn && autopilot) {
      if (pressed) setAutopilot(false)
      else {
        vehicle.setInput(autopilot.command())
        return
      }
    }
    if (keys && keyboard) vehicle.setInput(keyboard.input)
  }

  const render = () => {
    // Close inspection needs a much smaller near plane than the driving camera's
    // ~23 cm. Keep the normal depth precision for distant views,
    // and update before every reflection and main render so their projections agree.
    const near = freeCamera
      ? THREE.MathUtils.clamp(
          camera.position.distanceTo(controls.target) * 0.02,
          metres(0.002),
          DRIVING_CAMERA_NEAR,
        )
      : DRIVING_CAMERA_NEAR
    if (Math.abs(camera.near - near) > 1e-6) {
      camera.near = near
      camera.updateProjectionMatrix()
    }
    renderer.shadowMap.needsUpdate = true
    medianLamps?.updateLighting(camera.position)
    // The mirror glass is fed by a cube camera, refreshed a couple of times a
    // second: it has to run outside the main pass, never inside it.
    mirrors?.update(performance.now())
    // The water needs the bridge and the cars mirrored onto it, and that pass has
    // to run with the same camera the main pass is about to use.
    environment.renderReflection(renderer, scene, camera)
    wetRoad.renderReflection(renderer, scene, camera)
    const glowing = glowShells.length > 0
    const rainVisible = rainActive()
    rainPass.enabled = rainVisible
    if (rainVisible) {
      rainPass.uniforms.time.value = performance.now() / 1000
      rainPass.uniforms.intensity.value = rainIntensity
    }
    if (!bloomActive() && !glowing && !rainVisible) {
      renderer.render(scene, camera)
      return
    }
    // Bloom is a night effect in this scene, so it is switched on and off with the
    // time of day rather than by taking the whole chain apart.
    bloomPass.enabled = bloomActive()
    // The selection glow breathes, so that it reads as "this one" rather than as a
    // part that happens to have caught the light. The pulse is worked out here, in
    // the render, and not in the animation loop: a frame drawn on demand - a
    // screenshot, a check reading pixels - has to carry the glow as well.
    if (glowing) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 340)
      glowBloomPass.strength = (0.45 + 0.25 * pulse) * glowIntensity
      glowComposite.uniforms.glowAmount.value = (0.55 + 0.22 * pulse) * glowIntensity
      // The shells are copies of the parts, not children of them: their world
      // matrices come across here, which is also what keeps them on the car while
      // it drives.
      for (const shell of glowShells) {
        shell.mesh.matrix.copy(shell.source.matrixWorld)
        shell.mesh.matrixWorldNeedsUpdate = true
        shell.material.uniforms.thickness.value = shell.thickness * (0.85 + 0.3 * pulse)
      }
      glowComposer.render()
      glowComposite.uniforms.glowMap.value = glowComposer.readBuffer.texture
    } else {
      glowComposite.uniforms.glowAmount.value = 0
    }
    // The exposure pass carries the exposure for the whole chain, so the renderer
    // must not apply it a second time in the output pass.
    const exposure = renderer.toneMappingExposure
    exposurePass.uniforms.exposure.value = exposure
    renderer.toneMappingExposure = 1
    composer.render()
    renderer.toneMappingExposure = exposure
  }

  // Park the car and look at the whole scene from above: `?overview=1`, and the
  // hook the wide shots are taken with. Same hand-over as `setCameraPose`, so the
  // controls do not fight it.
  const overview = () => {
    paused = true
    freeCamera = true
    controls.enabled = true
    const target = vehicle ? vehicle.state.position.clone() : new THREE.Vector3()
    controls.target.set(target.x, target.y + fromLegacyUnits(2), target.z)
    camera.position.set(
      target.x + fromLegacyUnits(26),
      target.y + fromLegacyUnits(22),
      target.z + fromLegacyUnits(26),
    )
    camera.lookAt(controls.target)
    camera.updateMatrixWorld()
    render()
  }

  const frame = (now: number) => {
    // 着色器预热期间只保活 rAF、不出帧(见 warmUpShaders 的说明):一次绘制就会触发
    // 同步的首次使用查询,把驱动正在做的并行编译打断成串行等待。
    if (warmUpHoldFrames) {
      previous = now
      if (running) rafId = requestAnimationFrame(frame)
      return
    }
    // A heavy frame (the water shader plus two mirror renders) can take a fifth of
    // a second. Clamping the frame delta to 0.1 s made the simulation run at a
    // fraction of real time on such a machine - the car crawled and appeared not to
    // steer, even though the physics was fine. The step itself stays 1/120 s, so a
    // larger catch-up budget costs a little CPU but does not change the simulation.
    // The simulation delta is clamped, the frame rate is not: a machine taking
    // 800 ms per frame should say so instead of reporting the clamp.
    const raw = (now - previous) / 1000
    const delta = Math.min(raw, 0.3)
    lastFrameDelta = delta
    previous = now
    // The first frame after a reload has no sane gap, so ignore anything absurd.
    if (raw > 0 && raw < 3) {
      fpsFrames++
      fpsWindow += raw
      if (fpsWindow >= 0.5) {
        fps = fpsFrames / fpsWindow
        readout.fps.textContent = `${fps.toFixed(0)} FPS · ${((fpsWindow / fpsFrames) * 1000).toFixed(1)} ms`
        fpsFrames = 0
        fpsWindow = 0
      }
    }
    const boardingWasRunning = boarding?.state().running ?? false
    boarding?.update(delta)
    if (boardingWasRunning && boarding?.state().seated && !boardingCameraHeld) {
      boardingCameraHeld = true
      enterChaseCamera()
    }
    // Display animations remain controllable when driving is paused (UI and MCP).
    carBody?.update(delta)
    sceneControl.tick()
    if (!paused && vehicle && rig && chase) {
      applyDrivingInput()
      accumulator = Math.min(accumulator + delta, 0.3)
      while (accumulator >= STEP) {
        vehicle.step(STEP)
        accumulator -= STEP
      }
      vehicle.syncRig(rig)
      sunShadow?.update(vehicle.state.position)
      lights?.update(
        {
          steer: vehicle.state.steerInput,
          brake: vehicle.input.brake > 0.05,
          reversing: vehicle.state.speed < fromLegacyUnits(-0.5), // -0.5 旧单位 ≈ -0.11 m/s 的倒车判定阈值
          hazards: hazardsOn,
        },
        delta,
      )
      const lampState = lights?.state()
      updateTimeReadout()
      readout.lights.textContent = lampState
        ? [
            lampState.leftIndicator ? '左转灯' : '',
            lampState.rightIndicator ? '右转灯' : '',
            lampState.brake ? '刹车灯' : '',
            lampState.reverse ? '倒车灯' : '',
            hazardsOn ? '双闪' : '',
          ]
            .filter(Boolean)
            .join(' · ') || '待机'
        : '--'
      // Procedural maps build their road as the car advances.
      map.update?.(vehicle.state.distance)
      if (rainActive()) wetRoad.refreshOverlays()
      hud()
    }
    // 云台俯仰:按住 T / F 连续走,松开即停。要写在 drone.update 之前,
    // 这样同一帧写位姿时云台就是新角度(相机跟拍/机载都读它)。
    if (dronePiloting() && gimbalHold) {
      drone.setGimbalPitch(drone.gimbalPitch() + gimbalHold * GIMBAL_RATE * delta)
    }
    // 无人机与车辆互不阻塞:接管飞行不影响车辆物理(P 暂停场景时两者才一起停)。
    if (vehicle) drone.update(paused ? 0 : delta, vehicle.state)
    // 无人机读数卡不挂在"车辆在跑"这一支里,每帧单独刷新,免得车辆静止时读数是死的。
    if (dronePiloting()) {
      syncDroneHud()
      syncDronePanel()
    }
    environment.update(now / 1000, camera)
    if (rainActive()) rainImpacts.update(delta, vehicle?.state.position ?? camera.position)
    if (cameraFocus === 'fpv') {
      // 云台不可用(模型被隐藏/未载完)时自动退回跟拍,别把镜头丢在原地
      if (!updateDroneFpvCamera()) enterDroneCamera()
    } else if (cameraFocus === 'drone') updateDroneCamera(delta)
    else if (freeCamera) controls.update()
    else if (!paused && vehicle && chase) chase.update(delta, vehicle.state)
    // The selection glow breathes, so that it reads as "this one" rather than as a
    // part that happens to have caught the light. Bloom does the blooming, so the
    // pulse is in its strength and in how much of it is added back.
    if (glowShells.length) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 340)
      glowBloomPass.strength = 0.8 + 0.6 * pulse
      glowComposite.uniforms.glowAmount.value = 0.75 + 0.35 * pulse
      for (const shell of glowShells)
        shell.material.uniforms.thickness.value = shell.thickness * (0.9 + 0.35 * pulse)
    }
    render()
    if (running) rafId = requestAnimationFrame(frame)
  }

  /** One mesh whose reflection the scene is meant to take away, plus both looks. */
  type MirrorShell = {
    mesh: THREE.Mesh
    original: THREE.Material | THREE.Material[]
    matte: THREE.Material
  }
  /**
   * Mirror shells that must not carry an environment reflection.
   *
   * The BMW packs both door mirrors and the cabin mirror into one white mesh
   * whose material is metalness 1 at roughness 0: a perfect mirror. There is no
   * separate glass in that model, so the reflection cannot be narrowed to the
   * glass - the honest version of taking the reflection off the mirror is to
   * take it off the shell. Each match keeps the material the model shipped with,
   * so the panel switch can put it back, and a clone with the environment, the
   * metal and the gloss removed is what is shown while it is off.
   */
  const collectMirrorShells = (root: THREE.Object3D, pattern: RegExp): MirrorShell[] => {
    const shells: MirrorShell[] = []
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const label = `${mesh.name} ${mesh.parent?.name ?? ''} ${materials.map((item) => item.name ?? '').join(' ')}`
      if (!pattern.test(label)) return
      const matte = (materials[0] as THREE.MeshStandardMaterial).clone()
      matte.envMapIntensity = 0
      if (typeof matte.metalness === 'number') matte.metalness = 0
      if (typeof matte.roughness === 'number') matte.roughness = 1
      matte.needsUpdate = true
      shells.push({ mesh, original: mesh.material, matte })
    })
    return shells
  }
  const applyMirrorReflection = () => {
    for (const shell of mirrorShells) {
      shell.mesh.material = mirrorReflection
        ? shell.original
        : Array.isArray(shell.original)
          ? shell.original.map(() => shell.matte)
          : shell.matte
    }
  }

  /**
   * Look at the driver's door from outside.
   *
   * The chase camera sits behind the car and the driver's side is its far side, so
   * from there the walk up to the door, the door itself and the seat all happen round
   * the back of the bodywork. A demo nobody can see is not a demo, so the sequence
   * opens a view of its own on the driver's door - once, at the start, leaving the
   * camera to the user from there on. Everything below is metres.
   */
  const boardingCamera = () => {
    if (!vehicle || !rig) return
    const at = vehicle.state.position.clone()
    const yaw = rig.root.getWorldQuaternion(new THREE.Quaternion())
    const left = new THREE.Vector3(1, 0, 0).applyQuaternion(yaw)
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(yaw)
    const eye = at.clone().addScaledVector(left, metres(6)).addScaledVector(forward, metres(-5.2))
    eye.y += metres(2.2)
    const target = at
      .clone()
      .addScaledVector(left, metres(0.5))
      .addScaledVector(forward, metres(-0.2))
    target.y += metres(1)
    // The same hand-over the overview and the camera hook use: park the simulation,
    // take the camera off the chase rig, and let OrbitControls have it from here.
    paused = true
    freeCamera = true
    controls.enabled = true
    controls.target.copy(target)
    camera.position.copy(eye)
    camera.lookAt(target)
    camera.updateMatrixWorld()
    render()
  }

  /**
   * 预热着色器期间是否挂起主循环(只保活 rAF、不出帧)。
   *
   * 载入阶段必须挂起:驱动拿到一批 program 后需要一个不被打断的窗口并行编译,而主循环
   * 里任何一次绘制都会触发「材质首次使用」查询,那个查询是同步等 program 链接完成的 ——
   * 它会把并行编译退化成串行等待,正好抵消预热的意义。
   * 运行期不要挂起:那时画面已经在跑,挂起等于让玩家盯着静止的屏幕。
   */
  let warmUpHoldFrames = false

  /**
   * 是否在撤遮罩前预编译着色器。`?warmup=0` 关掉它,复现改动前的行为(遮罩一撤、
   * 首帧为每个材质同步等一次编译),用于量化这条改动的作用。
   */
  const warmUpEnabled = params.get('warmup') !== '0'

  /**
   * 预热着色器:把整场景的材质 program 一次性交给驱动编译,再渲染一帧把
   * uniform/attribute 的首次查询做掉。
   *
   * three 是「某个材质第一次被绘制」才编译它的 program 的,而这次编译会同步阻塞主线程
   * (gl.getProgramInfoLog 要等驱动把 program 链接完才返回)。本场景一共 80 个 program,
   * 其中车模型自己就带 35 个材质;不预热它们就会在遮罩撤掉后的那一帧里一个接一个串行阻塞
   * —— 实测(无头 Chromium)单次最长 885 ms、累计 4.2 s,表现为「载入条刚消失、画面
   * 直接冻住好几秒」。
   *
   * 用 renderer.compileAsync:支持 KHR_parallel_shader_compile 时它让驱动在后台线程并行
   * 编译、异步轮询就绪状态,主线程全程不阻塞 —— 那种环境下这次预热还会顺带压短总时长。
   * 这么做的收益是把编译挪到遮罩底下(文案「编译着色器…」)。
   *
   * ⚠️ 反过来,在**不支持**该扩展的环境里额外「等一会儿让驱动并行编译」是无效的:实测
   * 预热前多等 600 / 2500 ms,预热耗时反而从 4.7 s 劣化到 36.5 / 22.0 s —— 驱动并不会
   * 提前把 program 编好,多等只是白等。所以这里不设任何「等待窗口」。
   *
   * ⚠️ 代价与收益要讲清楚:总时长不变(编译工作量没变),变的是**卡顿发生的位置** ——
   * 从「遮罩消失之后」挪到了「遮罩底下」。实测(无头)onFirstUse 的峰值从亮相后的
   * 7s/8s/9s(371/367/171 ms)变成遮罩中的 6-11s,亮相之后不再有任何编译阻塞。
   *
   * ⚠️ program 的缓存键包含灯光数量与阴影状态,所以必须在灯光、阴影全部就位之后再预热,
   * 否则预热出来的程序会被判定为过期而重编。
   *
   * @param holdFrames 预热期间是否挂起主循环(载入阶段 true,运行期 false)
   */
  const warmUpShaders = async (holdFrames: boolean): Promise<void> => {
    // 场景已卸载就别再碰渲染器了(上下文已丢失)
    if (!running) return
    const previousHold = warmUpHoldFrames
    warmUpHoldFrames = holdFrames
    let timer = 0
    try {
      // compileAsync 在缺少并行编译扩展时要靠轮询,理论上可能迟迟不 ready;加超时兜底,
      // 免得遮罩永远撤不掉。
      await Promise.race([
        renderer.compileAsync(scene, camera),
        new Promise<void>((resolve) => {
          timer = window.setTimeout(resolve, 20000)
        }),
      ])
    } catch (error) {
      // 预热失败不该拦住场景:照常撤遮罩,让首帧自己去编译
      console.warn('[race] 着色器预热失败', error)
    } finally {
      window.clearTimeout(timer)
      warmUpHoldFrames = previousHold
    }
  }

  /** 载入并装配场景主体:车辆模型、车灯、后视镜、车身动画、角色与自动驾驶,完成后隐藏载入遮罩 */
  const boot = async () => {
    try {
      rig = await loadCar({
        car,
        targetLength: car.lengthMetres * UNITS_PER_METRE,
        onProgress: (fraction) => {
          status.textContent = `载入车辆模型 ${(fraction * 100).toFixed(0)}%`
        },
      })
      scene.add(rig.root)
      environment.setReflectionOverlay(rig.root)
      lights = createCarLights(rig, car.lampPatterns)
      // The model's own mirror shell, with the reflection taken off it. The
      // panel switch puts the model's material back, which is how the two looks
      // were compared.
      mirrorShells = car.matteMirrors ? collectMirrorShells(rig.root, car.matteMirrors) : []
      applyMirrorReflection()
      // Mirror glass samples the reflection the water pass already rendered, so it
      // costs a few hundred pixels and needs no pass of its own. It is the one
      // thing on the car this code draws instead of the model, so it starts off:
      // the panel switch is what puts the layer on the glass. Built either way,
      // because putting it back has to be instant.
      mirrors = car.mirrorGlass
        ? createCarMirrors({
            rig,
            pattern: car.mirrorGlass,
            splitGlass: car.mirrorGlassSplit,
            renderer,
            scene,
          })
        : null
      mirrors?.setEnabled(mirrorReflection)
      // The switch only means something on a car that has a mirror at all: one
      // model (the BMW) carries its reflection on the shell, two carry it on the
      // glass, and the Volkswagen ships no mirrors.
      mirrorReflectionBox.disabled = mirrorShells.length === 0 && !mirrors
      // The car finally gets a shadow: until now nothing in this scene cast one.
      // `?shadows=0` turns it off, which is how its cost was measured.
      sunShadow =
        daylight && params.get('shadows') !== '0'
          ? createSunShadow({ renderer, light: daylight, casters: [rig.root] })
          : null
      if (sunShadow) sunShadow.setDirection(sunDirectionFor(environment.getParams().sunHeight))
      carBody = createCarBody({
        rig,
        windows: car.windows,
        mirrors: car.mirrors,
        sunroof: car.sunroof,
        doors: car.doors,
      })
      carBody.set({
        windows: params.get('windows') === '1',
        mirrors: params.get('mirrors') === '1',
        sunroof: params.get('sunroof') === '1',
      })
      carBody.setDoors(Object.fromEntries(doorsFromLink.map((id) => [id, true])))

      // The character is 15 MB, so it is fetched in the background while the scene
      // settles: the button has to be instant the first time it is pressed. It starts
      // only here, after the car has finished — the car is the model that gates being
      // able to drive, so it gets the connection to itself first. Its materials are
      // precompiled when it lands, so it does not hitch the frame it appears on.
      const boardingRig = rig as CarRig
      boardingCameraHeld = false
      boarding = createBoarding({
        scene,
        rig: boardingRig,
        url: '/models/a_man_in_suit.glb',
        seat: car.seat ?? { x: 0.4, y: 0.8, z: -0.1 },
        floor: 0.36,
        onDoor: (open) => {
          carBody?.setDoors({ fl: open })
          syncBodyPanel()
        },
      })
      boardingButton.disabled = false
      // ?board=1 plays the sequence as soon as the character is ready, which is how
      // the shots in reconstruction/race were taken.
      if (params.get('board') === '1')
        void boarding.load().then((ok) => {
          if (ok) {
            boarding?.start()
            boardingCamera()
          }
        })
      // 人物与无人机在车之后才开始下载(车模型是关键路径,先让它独占带宽),所以这里
      // 不用等它们;各自到位时再预热一次着色器即可(见 loadDrone 与下面的 boarding.load)。
      void boarding.load().then(() => void warmUpShaders(false))
      if (drone.state().enabled) loadDrone()
      // The tree belongs to the car that just loaded: a new model means new nodes.
      modelTree?.setRoot(rig.root)
      {
        let nodes = 0
        let meshes = 0
        rig.root.traverse((object) => {
          if ((object as THREE.Mesh).isMesh) meshes++
          else nodes++
        })
        treeCount.textContent = `${meshes} 个网格 / ${nodes} 个节点`
      }
      syncBodyPanel()
      // Running lights are on all the time, the way a modern car drives with its
      // daytime running lights lit; night only makes them brighter.
      // Lamps run at their night strength for dusk too: that is when a driver
      // switches them on, and it is what makes a sunset read as evening.
      syncHeadlights = () => {
        lights?.setNight(nightMode() || timeOfDay === 'dusk')
        syncHeadlightBox()
      }
      syncHeadlights()
      vehicle = createVehicle({
        track,
        wheelbase: rig.wheelbase,
        wheelRadius: rig.wheelRadius,
        config: assistEnabled ? VEHICLE : { ...VEHICLE, cornerAssist: 0 },
        spawnLateral: map.spawnLateral,
      })
      vehicle.syncRig(rig)
      // 无人机模型(14 MB)在车之后载入(见上面的 loadDrone);这里先让它按车辆状态
      // 摆好跟随机位,模型到位后再露面。
      drone.update(0, vehicle.state)
      // The autopilot only reads the vehicle and the track, so it is built once
      // here and switched on and off with `autopilotOn`.
      autopilot = createAutopilot({ track, vehicle, brakeDeceleration: VEHICLE.brakeDeceleration })
      map.update?.(vehicle.state.distance)
      chase = createChaseCamera(camera, CAMERA, VEHICLE.maxSpeed)
      chase.snap(vehicle.state)
      keyboard = createKeyboardInput()
      readout.map.textContent = map.generator
        ? `${map.name} · 已生成 ${(track.length / UNITS_PER_METRE).toFixed(0)} m · 种子 ${map.generator.seed}`
        : `${map.name} · ${(track.length / UNITS_PER_METRE).toFixed(0)} m${track.closed ? ' · 闭合' : ' · 单程'}`
      readout.wheels.textContent =
        (rig.proceduralWheels
          ? `${rig.wheels.length} 个程序化车轮（原模型车轮无法拆分）`
          : `${rig.wheels.length} 个独立车轮 · 轴距 ${(rig.wheelbase / UNITS_PER_METRE).toFixed(2)} m`) +
        ` · ${(rig.size.z / UNITS_PER_METRE).toFixed(2)} x ${(rig.size.x / UNITS_PER_METRE).toFixed(2)} x ${(rig.size.y / UNITS_PER_METRE).toFixed(2)} m`
      readout.assist.textContent = assistEnabled ? '开 · 过弯自动收油' : '关'
      // ?hide=<name|regex> hides matching meshes, ?show=<...> forces them back.
      // Built for identifying a part when a screenshot is not available: the names
      // this code creates are car-mirror-*, car-window-*, car-lamp-*, car-halo-*,
      // so ?hide=car-mirror-(left|right) answers "is that layer mine or the
      // model's?" in one reload.
      const hideParam = params.get('hide')
      const showParam = params.get('show')
      const toPattern = (value: string) => {
        try {
          return new RegExp(value, 'i')
        } catch {
          return new RegExp(
            value.replace(/[.*+?^${}()|[\]\\]/g, '\\    status.hidden = true;'),
            'i',
          )
        }
      }
      if (hideParam) {
        const pattern = toPattern(hideParam)
        scene.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (mesh.isMesh && pattern.test(mesh.name)) mesh.visible = false
        })
      }
      if (showParam) {
        const pattern = toPattern(showParam)
        scene.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (mesh.isMesh && pattern.test(mesh.name)) mesh.visible = true
        })
      }
      // 装配完了,但着色器一次都没编译过。先预热、再真渲染一帧,最后才撤遮罩 ——
      // 顺序反了就是「遮罩刚消失、画面立刻冻住好几秒」(见 warmUpShaders)。
      // `?warmup=0` 跳过预热,复现改动前的行为,用于对比测量。
      if (warmUpEnabled) {
        status.textContent = '编译着色器…'
        await warmUpShaders(true)
        // 预热等待期间用户可能已经切走路由(dispose 已把上下文销毁)
        if (!running) return
        render()
      }
      status.hidden = true
      hud()
      if (params.get('overview') === '1') overview()
    } catch (error) {
      status.hidden = false
      status.textContent = `车辆载入失败：${error instanceof Error ? error.message : String(error)}`
      console.error(error)
    }
  }

  /**
   * 场景级单次按键分发:无人机相关键(U/M/V/B/T/F)优先拦截,其余为车辆复位/暂停/
   * 车灯/视角/时段/自动驾驶/雨天的切换键。持续按住的驾驶键(W/S/A/D 等)由
   * createKeyboardInput 单独监听;接管无人机后这些键被 drone-control 借调。
   */
  const hotkeyHandler = (event: KeyboardEvent) => {
    // U 键:接管 / 交还无人机的键盘操控。接管不影响车辆,车辆快捷键照常可用。
    if (event.code === 'KeyU') {
      toggleDronePilot()
      return
    }
    // M 键:跟拍 ↔ 机载 来回切。**不要求先接管**——车照开,镜头可以一直在云台上。
    if (event.code === 'KeyM') {
      if (!drone.state().visible) return
      setCameraFocus(cameraFocus === 'fpv' ? 'drone' : 'fpv')
      return
    }
    // 无人机自己的按键(起降 V、返航 B、云台俯仰 T/F)只在接管时生效;飞行摇杆的键
    // (I/K/J/L + Z/X + Q/E)由 drone-control 自己监听,与这里的车辆键没有交集。
    if (dronePiloting()) {
      if (event.code === 'KeyV') {
        // 一键起降:空中就降落,已落地就重新起飞
        const flight = drone.flight()
        if (flight && flight.airborne) drone.startLanding()
        else drone.autoTakeOff()
        syncDroneHud()
        return
      }
      if (event.code === 'KeyB') {
        drone.startRth()
        syncDroneHud()
        return
      }
      if (event.code === 'KeyT' || event.code === 'KeyF') {
        // 先给一格即时反馈,再交给主循环按住连续走(见 gimbalHold)
        gimbalHold = event.code === 'KeyT' ? 1 : -1
        drone.setGimbalPitch(drone.gimbalPitch() + gimbalHold * 5)
        syncDroneHud()
        return
      }
    }
    if (!vehicle || !rig) return
    if (event.code === 'KeyR') {
      vehicle.reset()
      vehicle.syncRig(rig)
      enterChaseCamera()
    }
    if (event.code === 'KeyP') paused = !paused
    if (event.code === 'KeyH') {
      hazardsOn = !hazardsOn
      syncHazards()
    }
    if (event.code === 'KeyC') {
      if (freeCamera) enterChaseCamera()
      else enterFreeCamera()
    }
    if (event.code === 'KeyN') cycleTime()
    if (event.code === 'KeyG') setAutopilot(!autopilotOn)
    if (event.code === 'KeyY') setRain(!rainEnabled)
  }
  window.addEventListener('keydown', hotkeyHandler, { signal: globalSignal })
  // 云台俯仰是"按住连续走"的:松开就停,不然镜头会一直往上翻
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.code === 'KeyT' || event.code === 'KeyF') gimbalHold = 0
    },
    { signal: globalSignal },
  )
  window.addEventListener(
    'blur',
    () => {
      gimbalHold = 0
    },
    { signal: globalSignal },
  )

  // Deterministic hooks used by the headless driving check.
  // 上游是 `declare global { interface Window { __RACE__?: ... } }`;搬进函数体后
  // 全局增强不能嵌套,改成局部类型 + 显式断言写入。
  type RaceApi = {
    ready: () => boolean
    state: () => Record<string, unknown>
    info: () => Record<string, unknown>
    drone: () => RaceDroneState
    /** 接管飞行读数(未接管时为 null) */
    droneFlight: () => RaceDroneFlight | null
    /** 开关无人机接管操控,返回是否处于接管状态(供无头检查驱动) */
    dronePilot: (value: boolean) => boolean
    wheelRotations: () => { front: boolean; side: number; steer: number; spin: number }[]
    centrelineSamples: (count?: number) => [number, number][]
    frameAt: (distance: number) => {
      position: [number, number]
      heading: number
      yaw: number
      lateral: [number, number]
    }
    cameraPose: () => { position: number[]; lookYaw: number; fov: number; viewProjection: number[] }
    waterReflection: () => {
      enabled: boolean
      strength: number
      matrix: number[]
      planeY: number
      plane: [number, number]
      size: [number, number]
    }
    medianTrees: () => {
      status: string
      count: number
      batches: number
      triangles: number
      height: number
      spacing: number
      error: string
    } | null
    setReflection: (enabled: boolean) => void
    reflectionCoverage: () => number
    reflectionOverlayInfo: () => { attached: boolean; meshes: number }
    rigPose: () => { heading: number; roll: number }
    setInput: (patch: Partial<{ throttle: number; brake: number; steer: number }>) => void
    step: (dt: number) => void
    reset: () => void
    setPaused: (value: boolean) => void
    /** 场景是否被暂停(P 键)。接管无人机不应改变它 */
    paused: () => boolean
    /** 镜头当前看谁:车辆 / 无人机跟拍 / 机载视角 */
    cameraFocus: () => DroneCameraFocus
    /** 直接指定镜头(调试出口:`__RACE__.setCameraFocus('fpv')`) */
    setCameraFocus: (value: DroneCameraFocus) => DroneCameraFocus
    /** 云台俯仰:不给值就是读,给值就是设(返回夹紧后的实际角度) */
    droneGimbalPitch: (value?: number) => number
    setCarVisible: (value: boolean) => void
    setWheelsVisible: (value: boolean) => void
    partPositions: () => Record<string, number[]>
    carMaterials: () => {
      name: string
      transparent: boolean
      opacity: number
      depthWrite: boolean
      color: string
    }[]
    setPartVisible: (pattern: string, value: boolean) => number
    setChaseHeight: (height: number) => void
    depthReport: () => {
      name: string
      mesh: string
      depthTest: boolean
      depthWrite: boolean
      transparent: boolean
      renderOrder: number
      side: string
    }[]
    lightsState: () => Record<string, boolean>
    setHazards: (value: boolean) => void
    setHeadlights: (value: boolean) => void
    bloom: () => {
      enabled: boolean
      active: boolean
      strength: number
      radius: number
      threshold: number
      exposure: number
    }
    setBloom: (value: boolean) => void
    setBloomParams: (patch: { strength?: number; radius?: number; threshold?: number }) => {
      strength: number
      radius: number
      threshold: number
    }
    weather: () => {
      wetRoad: ReturnType<WetRoad['state']>
      impacts: ReturnType<RainImpacts['state']>
    }
    rain: () => {
      enabled: boolean
      active: boolean
      intensity: number
      density: number
      passEnabled: boolean
    }
    setRain: (enabled: boolean, intensity?: number) => void
    setRainDensity: (value: number) => void
    autopilot: () => {
      on: boolean
      plan?: {
        lookAhead: number
        targetLateral: number
        targetDistance: number
        headingError: number
        speedLimit: number
      }
    }
    setAutopilot: (value: boolean) => void
    fps: () => number
    mirrors: () =>
      { meshes: number; reflection: boolean; material: string; centre: number[] } | { meshes: 0 }
    shadow: () =>
      | {
          enabled: boolean
          casters: number
          extent: number
          mapSize: number
          hasMap: boolean
          sun: number[]
          target: number[]
          intensity: number
        }
      | { enabled: false }
    setShadows: (value: boolean) => void
    /** World transform of every object in the scene, for "what actually moved". */
    transformSnapshot: () => {
      name: string
      parent: string
      kind: string
      visible: boolean
      position: number[]
      quaternion: number[]
      vertices: number
    }[]
    /** Raycast pick: what is under this screen point, and who its parents are. */
    pickAt: (
      x: number,
      y: number,
    ) => {
      name: string
      chain: string[]
      material: string
      vertices: number
      distance: number
      world: number[]
    } | null
    /** Every mesh the ray meets, nearest first: "what is under this pixel". */
    traceRay: (
      x: number,
      y: number,
    ) => { name: string; parent: string; material: string; distance: number; point: number[] }[]
    /** Hide or show meshes by name without reloading, for attribution tests. */
    setVisible: (pattern: string, visible: boolean) => number
    picked: () => string
    /** The part the tree and the scene agree on, or null. */
    selection: () => { name: string; mesh: boolean; vertices: number; chain: string[] } | null
    /** Open or close the model tree without reaching for the button. */
    setTreeOpen: (open: boolean) => boolean
    treeRoot: () => { name: string; children: number; meshes: number; nodes: number } | null
    body: () => ReturnType<CarBody['state']>
    setBody: (patch: Partial<BodyTargets>) => void
    /** Doors open and close one at a time; the link carries ?doors=fl,rr. */
    setDoors: (patch: Partial<Record<DoorId, boolean>>) => void
    toggleDoor: (id: DoorId) => void
    /** What the reflections are working with: environment, intensity, exposure. */
    environment: () => { has: boolean; intensity: number; exposure: number; toneMapping: string }
    /** Whether the character is drawn at all, and what it is made of. */
    character: () => {
      visible: boolean
      meshes: number
      drawn: number
      bounds: number[][]
      worldScale: number[]
    } | null
    setCharacterVisible: (value: boolean) => boolean
    /** The boarding sequence: phase label, progress, and where the joints are. */
    boarding: () => ReturnType<Boarding['state']> | null
    /** Start the boarding sequence, as the panel button does. */
    board: () => boolean
    /** What the selection glow is doing: shells, additive amount, bloom strength. */
    glow: () => { shells: number; amount: number; bloom: number; sceneName: string }
    /** Hinge and edge samples of a door: "does it hang on its leading edge?". */
    doorPoints: (id: DoorId) => {
      hinge: number[]
      bounds: { min: number[]; max: number[] }
      leading: number[][]
      trailing: number[][]
    }
    nightBrightness: (value?: number) => number
    bodyProbe: () => BodyProbe
    setSunIntensity: (value: number) => void
    shadowTriage: () => { name: string; receive: boolean; cast: boolean; material: string }[]
    waterParams: () => {
      intensity: number
      wind: number
      ripple: number
      cloudDensity: number
      sunHeight: number
    }
    setWaterParams: (patch: { intensity?: number; wind?: number; ripple?: number }) => {
      intensity: number
      wind: number
      ripple: number
    }
    lampReport: () => {
      name: string
      material: string
      min: number[]
      max: number[]
      triangles: number
    }[]
    allParts: () => {
      name: string
      parent: string
      material: string
      centre: number[]
      size: number[]
    }[]
    setOverviewCamera: () => void
    setCameraPose: (position: [number, number, number], target: [number, number, number]) => void
    render: () => void
    pixels: () => { width: number; height: number; data: number[] }
    /** Diagnostic only: synchronizes the GPU to measure a complete render. */
    profileFrame: (hideKnots?: boolean) => {
      milliseconds: number
      calls: number
      triangles: number
    }
    screenshot: () => string
  }
  const raceApi = window as unknown as { __RACE__?: RaceApi }
  raceApi.__RACE__ = {
    ready: () => Boolean(vehicle && rig),
    drone: () => drone.state(),
    droneFlight: () => drone.flight(),
    dronePilot: (value: boolean) => {
      if (value !== drone.piloting()) toggleDronePilot()
      return drone.piloting()
    },
    state: () =>
      vehicle
        ? {
            position: vehicle.state.position.toArray(),
            heading: vehicle.state.heading,
            speed: vehicle.state.speed,
            steer: vehicle.state.steer,
            steerAngle: vehicle.state.steerAngle,
            wheelSpin: vehicle.state.wheelSpin,
            distance: vehicle.state.distance,
            lateral: vehicle.state.lateral,
          }
        : {},
    info: () =>
      rig
        ? {
            units: {
              length: 'metre',
              time: 'second',
              speed: 'metres/second',
              sceneUnitsPerMeter: UNITS_PER_METRE,
            },
            medianLamps: map.visual.getObjectByName('median-street-lamps')?.userData.lamps ?? null,
            wheelCount: rig.wheels.length,
            proceduralWheels: rig.proceduralWheels,
            wheelRatios: rig.wheelRatios,
            wheelDebug: rig.wheelDebug,
            bounds: rig.bounds,
            wheelbase: rig.wheelbase,
            wheelRadius: rig.wheelRadius,
            trackWidth: rig.trackWidth,
            size: rig.size.toArray(),
            car: { id: car.id, label: car.label },
            targetLength: car.lengthMetres * UNITS_PER_METRE,
            trackLength: track.length,
            surfaceY: track.surfaceY,
            lateralMin: track.lateralMin,
            lateralMax: track.lateralMax,
            map: {
              id: map.id,
              name: map.name,
              description: map.description,
              closed: map.closed,
              length: track.length,
              lateralMin: track.lateralMin,
              lateralMax: track.lateralMax,
              startDistance: track.startDistance,
            },
            generator: map.generator
              ? { seed: map.generator.seed, stats: map.generator.stats() }
              : null,
            wheels: rig.wheels.map((wheel) => ({
              front: wheel.front,
              side: wheel.side,
              centre: wheel.centre.toArray().map((value) => Number(value.toFixed(5))),
              radius: Number(wheel.radius.toFixed(5)),
              pieces: [
                ...wheel.spin.children,
                ...wheel.steer.children.filter((child) => child !== wheel.spin),
              ]
                .filter((child) => (child as THREE.Mesh).isMesh)
                .map((child) => {
                  const mesh = child as THREE.Mesh
                  mesh.geometry.computeBoundingBox()
                  return {
                    name: mesh.name,
                    size: mesh.geometry
                      .boundingBox!.getSize(new THREE.Vector3())
                      .toArray()
                      .map((value) => Number(value.toFixed(5))),
                  }
                }),
            })),
          }
        : {},
    wheelRotations: () =>
      rig
        ? rig.wheels.map((wheel) => ({
            front: wheel.front,
            side: wheel.side,
            steer: wheel.steer.rotation.y,
            spin: wheel.spin.rotation.x,
          }))
        : [],
    centrelineSamples: (count = 64) => {
      const total = Math.max(8, Math.min(Math.round(count), 512))
      const samples: [number, number][] = []
      for (let i = 0; i < total; i++) {
        const frame = track.frameAtDistance((track.length * i) / total)
        samples.push([Number(frame.position.x.toFixed(2)), Number(frame.position.z.toFixed(2))])
      }
      return samples
    },
    allParts: () => {
      const rows: any[] = []
      if (!rig) return rows
      const box = new THREE.Box3()
      const corner = new THREE.Vector3()
      rig.root.updateMatrixWorld(true)
      rig.root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh || mesh.name === 'car-lamp') return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        box.setFromObject(mesh)
        const local = new THREE.Box3()
        for (let index = 0; index < 8; index++) {
          corner.set(
            index & 1 ? box.max.x : box.min.x,
            index & 2 ? box.max.y : box.min.y,
            index & 4 ? box.max.z : box.min.z,
          )
          local.expandByPoint(rig!.root.worldToLocal(corner.clone()))
        }
        const scale = rig!.root.scale.x || 1
        const centre = local.getCenter(new THREE.Vector3()).multiplyScalar(scale)
        const size = local.getSize(new THREE.Vector3()).multiplyScalar(scale)
        rows.push({
          name: mesh.name,
          parent: mesh.parent?.name ?? '',
          material: materials.map((m) => m.name).join(','),
          centre: centre.toArray().map((v) => Number(v.toFixed(2))),
          size: size.toArray().map((v) => Number(v.toFixed(2))),
        })
      })
      return rows
    },
    lightsState: () => (lights ? (lights.state() as Record<string, boolean>) : {}),
    setHazards: (value) => {
      hazardsOn = value
    },
    setHeadlights: (value) => {
      lights?.setHeadlights(value)
    },
    // Bloom is the pass chain around the frame, so it gets its own probe: the
    // numbers here are what the lamp checks compare between the two paths.
    bloom: () => ({
      enabled: bloomEnabled,
      active: bloomActive(),
      strength: bloomPass.strength,
      radius: bloomPass.radius,
      threshold: bloomPass.threshold,
      exposure: renderer.toneMappingExposure,
    }),
    setBloom: (value: boolean) => {
      bloomEnabled = value
      syncBloomPanel()
    },
    setBloomParams: (patch: { strength?: number; radius?: number; threshold?: number }) => {
      if (patch.strength != null) bloomPass.strength = patch.strength
      if (patch.radius != null) bloomPass.radius = patch.radius
      if (patch.threshold != null) bloomPass.threshold = patch.threshold
      syncBloomPanel()
      return {
        strength: bloomPass.strength,
        radius: bloomPass.radius,
        threshold: bloomPass.threshold,
      }
    },
    weather: () => ({ wetRoad: wetRoad.state(), impacts: rainImpacts.state() }),
    rain: () => ({
      enabled: rainEnabled,
      active: rainActive(),
      intensity: rainIntensity,
      density: rainDensity,
      passEnabled: rainPass.enabled,
    }),
    setRain: (enabled: boolean, intensity?: number) => setRain(enabled, intensity),
    setRainDensity: (value: number) => {
      rainDensity = THREE.MathUtils.clamp(value, 0, 2)
      rainImpacts.setDensity(rainDensity)
      rewriteParam('rainDensity', Math.abs(rainDensity - 1) < 0.001 ? null : rainDensity.toFixed(2))
      syncRainPanel()
    },
    // Autopilot probe: what it is aiming at, and how fast the road ahead allows
    // the car to be going. The checks drive with it and read these numbers.
    autopilot: () =>
      autopilot && autopilotOn ? { on: true, ...autopilot.plan() } : { on: autopilotOn },
    setAutopilot: (value: boolean) => setAutopilot(value),
    fps: () => Number(fps.toFixed(1)),
    mirrors: () => (mirrors ? mirrors.state() : { meshes: 0 }),
    shadow: () => (sunShadow ? sunShadow.state() : { enabled: false }),
    setShadows: (value) => {
      sunShadow?.setEnabled(value)
      render()
    },
    transformSnapshot: () => {
      const rows: {
        name: string
        parent: string
        kind: string
        visible: boolean
        position: number[]
        quaternion: number[]
        vertices: number
      }[] = []
      scene.updateMatrixWorld(true)
      const point = new THREE.Vector3()
      const quaternion = new THREE.Quaternion()
      scene.traverse((object) => {
        if (rows.length > 4000) return
        object.getWorldPosition(point)
        object.getWorldQuaternion(quaternion)
        const mesh = object as THREE.Mesh
        rows.push({
          name: object.name || '(unnamed)',
          parent: object.parent?.name ?? '',
          kind: object.type,
          visible: object.visible,
          position: point.toArray().map((value) => Number(value.toFixed(3))),
          quaternion: quaternion.toArray().map((value) => Number(value.toFixed(4))),
          vertices: mesh.isMesh ? (mesh.geometry.getAttribute('position')?.count ?? 0) : 0,
        })
      })
      return rows
    },
    pickAt: (x, y) => {
      const info = pickAt(x, y)
      showPick(info)
      return info
    },
    picked: () => (pickLabel.hidden ? '' : (pickLabel.textContent ?? '')),
    selection: () => {
      const object = modelTree?.selected() ?? null
      if (!object) return null
      const info = describePart(object)
      return {
        name: info.name,
        mesh: (object as THREE.Mesh).isMesh === true,
        vertices: info.vertices,
        chain: info.chain,
      }
    },
    setTreeOpen: (open) => {
      setTreeOpen(open)
      return !isHidden(treePanel)
    },
    treeRoot: () => {
      if (!rig) return null
      let meshes = 0
      let nodes = 0
      rig.root.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) meshes++
        else nodes++
      })
      return { name: rig.root.name || '(root)', children: rig.root.children.length, meshes, nodes }
    },
    // Every mesh the ray meets, nearest first. A pick stops at the first hit;
    // when the eye says a surface is there and the label says otherwise, the
    // question is what the ray passes through on the way - and this answers it.
    traceRay: (x, y) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pickPointer.x = ((x - rect.left) / Math.max(rect.width, 1)) * 2 - 1
      pickPointer.y = -((y - rect.top) / Math.max(rect.height, 1)) * 2 + 1
      raycaster.setFromCamera(pickPointer, camera)
      return raycaster.intersectObjects(scene.children, true).map((hit) => ({
        name: hit.object.name || '(' + hit.object.type + ')',
        parent: hit.object.parent?.name ?? '',
        material: Array.isArray((hit.object as THREE.Mesh).material)
          ? ((hit.object as THREE.Mesh).material as THREE.Material[]).map((m) => m.name).join(',')
          : (((hit.object as THREE.Mesh).material as THREE.Material)?.name ?? ''),
        distance: Number(hit.distance.toFixed(2)),
        point: hit.point.toArray().map((value) => Number(value.toFixed(2))),
      }))
    },
    // ?hide= exists for one reload; this is the same test without one.
    setVisible: (pattern, visible) => {
      const match = new RegExp(pattern, 'i')
      let touched = 0
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh && match.test(mesh.name)) {
          mesh.visible = visible
          touched++
        }
      })
      return touched
    },
    body: () =>
      carBody?.state() ?? {
        windows: 0,
        mirrors: 0,
        sunroof: 0,
        targets: { windows: false, mirrors: false, sunroof: false },
        doors: { fl: 0, fr: 0, rl: 0, rr: 0 },
        doorTargets: { fl: false, fr: false, rl: false, rr: false },
        parts: { windows: 0, mirrors: 0, sunroof: 0, doors: 0 },
      },
    setBody: (patch) => {
      carBody?.set(patch)
      syncBodyPanel()
    },
    setDoors: (patch) => {
      carBody?.setDoors(patch)
      syncBodyPanel()
    },
    toggleDoor: (id) => {
      carBody?.toggleDoor(id)
      syncBodyPanel()
    },
    doorPoints: (id) =>
      carBody?.doorPoints(id) ?? {
        hinge: [],
        bounds: { min: [], max: [] },
        leading: [],
        trailing: [],
      },
    environment: () => ({
      has: Boolean(scene.environment),
      intensity: scene.environmentIntensity,
      exposure: renderer.toneMappingExposure,
      toneMapping: 'aces',
    }),
    boarding: () => boarding?.state() ?? null,
    character: () => {
      const group = scene.getObjectByName('boarding-character')
      if (!group) return null
      const box = new THREE.Box3()
      let meshes = 0
      let drawn = 0
      const scale = new THREE.Vector3()
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        meshes++
        let visible = mesh.visible
        for (let node = mesh.parent; node; node = node.parent) if (!node.visible) visible = false
        if (visible) {
          drawn++
          box.expandByObject(mesh)
        }
        if (meshes === 1) mesh.getWorldScale(scale)
      })
      return {
        visible: group.visible,
        meshes,
        drawn,
        bounds: box.isEmpty()
          ? []
          : [
              box.min.toArray().map((v) => Number(v.toFixed(2))),
              box.max.toArray().map((v) => Number(v.toFixed(2))),
            ],
        worldScale: scale.toArray().map((v) => Number(v.toFixed(3))),
      }
    },
    setCharacterVisible: (value) => {
      const group = scene.getObjectByName('boarding-character')
      if (!group) return false
      group.visible = Boolean(value)
      render()
      return group.visible
    },
    board: () => {
      const started = boarding?.start() ?? false
      if (started) boardingCamera()
      return started
    },
    glow: () => ({
      shells: glowShells.length,
      amount: Number(glowComposite.uniforms.glowAmount.value.toFixed(3)),
      bloom: Number(glowBloomPass.strength.toFixed(3)),
      sceneName: glowScene.name,
    }),
    nightBrightness: (value) => {
      if (value != null) {
        nightBrightness = Math.max(0.3, Math.min(2, value))
        applyTimeOfDay()
        syncNightPanel()
      }
      return nightBrightness
    },
    bodyProbe: () =>
      carBody?.probe() ?? {
        windows: [],
        mirrors: [],
        sunroof: [],
        doors: { fl: [], fr: [], rl: [], rr: [] },
      },
    setSunIntensity: (value) => {
      if (daylight) {
        daylight.intensity = value
        render()
      }
    },
    shadowTriage: () => {
      const rows: { name: string; receive: boolean; cast: boolean; material: string }[] = []
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        if (!/deck|roadway|surface|railing|parapet|road/i.test(mesh.name)) return
        rows.push({
          name: mesh.name,
          receive: mesh.receiveShadow,
          cast: mesh.castShadow,
          material: (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name ?? '',
        })
      })
      return rows.slice(0, 14)
    },
    waterParams: () => environment.getParams(),
    setWaterParams: (patch) => {
      environment.setParams(patch)
      syncWaterPanel()
      return environment.getParams()
    },
    lampReport: () => {
      const rows: any[] = []
      if (!rig) return rows
      const box = new THREE.Box3()
      rig.root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const label =
          mesh.name +
          ' | ' +
          (Array.isArray(mesh.material)
            ? mesh.material.map((m) => m.name).join(',')
            : mesh.material.name)
        if (!/light|glass|emis|ligh|bamper|lamp/i.test(label)) return
        box.setFromObject(mesh)
        rows.push({
          name: mesh.name,
          material: Array.isArray(mesh.material)
            ? mesh.material.map((m) => m.name).join(',')
            : mesh.material.name,
          min: box.min.toArray().map((v) => Number(v.toFixed(2))),
          max: box.max.toArray().map((v) => Number(v.toFixed(2))),
          triangles:
            (mesh.geometry.index
              ? mesh.geometry.index.count
              : mesh.geometry.attributes.position.count) / 3,
        })
      })
      return rows
    },
    setPartVisible: (pattern, value) => {
      if (!rig) return 0
      const matcher = new RegExp(pattern, 'i')
      let touched = 0
      rig.root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh || !matcher.test(mesh.name)) return
        mesh.visible = value
        touched++
      })
      return touched
    },
    setChaseHeight: (height) => {
      CAMERA.height = height
      chase?.snap(vehicle!.state)
    },
    // World frame at an arc length, so a driving check can aim at a point ahead
    // of the car on a track whose total length keeps growing.
    frameAt: (distance) => {
      const frame = track.frameAtDistance(distance)
      return {
        position: [Number(frame.position.x.toFixed(4)), Number(frame.position.z.toFixed(4))],
        heading: frame.heading,
        yaw: frame.yaw,
        lateral: [frame.lateral.x, frame.lateral.z],
      }
    },
    depthReport: () => {
      const seen = new Map<string, any>()
      if (rig)
        rig.root.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const key = (material.name || '(unnamed)') + '|' + mesh.name
            if (seen.has(key)) continue
            seen.set(key, {
              name: material.name || '(unnamed)',
              mesh: mesh.name,
              depthTest: material.depthTest,
              depthWrite: material.depthWrite,
              transparent: material.transparent,
              renderOrder: mesh.renderOrder,
              side:
                material.side === THREE.DoubleSide
                  ? 'double'
                  : material.side === THREE.FrontSide
                    ? 'front'
                    : 'back',
            })
          }
        })
      return [...seen.values()]
    },
    // How far the car is rotated relative to what the camera is looking at: if
    // this stays near zero the car looks like it never turns, however fast the
    // heading changes in world space.
    cameraPose: () => {
      const direction = camera.getWorldDirection(new THREE.Vector3())
      return {
        position: camera.position.toArray().map((value) => Number(value.toFixed(3))),
        lookYaw: Math.atan2(direction.x, direction.z),
        fov: camera.fov,
        // Column major, so a check can project a world point the same way the
        // renderer does.
        viewProjection: camera.projectionMatrix
          .clone()
          .multiply(camera.matrixWorldInverse)
          .elements.map((value) => Number(value.toFixed(8))),
      }
    },
    waterReflection: () => {
      const uniforms = environment.materials.water.uniforms
      const matrix = uniforms.reflectionMatrix.value as THREE.Matrix4
      const texture = uniforms.reflectionMap.value as THREE.Texture | null
      // `Texture.image` is untyped (it is whatever the loader produced), so read
      // the dimensions through a narrow shape instead of trusting the generic.
      const image = texture?.image as { width?: number; height?: number } | undefined
      const surface = environment.root.children.find((child) => child.name === 'water-surface')
      return {
        enabled: uniforms.reflectionStrength.value > 0.5,
        strength: uniforms.reflectionStrength.value,
        matrix: matrix.elements.map((value) => Number(value.toFixed(8))),
        planeY: surface?.position.y ?? 0,
        // The plane is finite; with `follow` on it travels with the camera, so
        // these are how a check proves the sea never runs out from under the car.
        plane: [surface?.position.x ?? 0, surface?.position.z ?? 0],
        size: [image?.width ?? 0, image?.height ?? 0],
      }
    },
    medianTrees: () => {
      const vegetation = medianTreeGroup?.userData.vegetation
      return vegetation
        ? {
            status: vegetation.status,
            count: vegetation.count,
            batches: vegetation.batches,
            triangles: Math.round(vegetation.triangles),
            height: vegetation.height,
            spacing: vegetation.spacing,
            error: vegetation.error,
          }
        : null
    },
    setReflection: (enabled) => environment.setReflectionEnabled(enabled),
    reflectionCoverage: () => environment.reflectionCoverage(renderer),
    reflectionOverlayInfo: () => environment.reflectionOverlayInfo(),
    rigPose: () =>
      rig ? { heading: rig.root.rotation.y, roll: rig.root.rotation.z } : { heading: 0, roll: 0 },
    setInput: (patch) => vehicle?.setInput(patch),
    step: (dt) => {
      if (!vehicle || !rig) return
      // Headless stepping stands in for a frame, so the autopilot drives here too
      // - but without the keyboard, so a check can still steer through setInput.
      applyDrivingInput(false)
      carBody?.update(dt)
      // Manual stepping stands in for a frame, so the character walks too - a
      // headless page throttles requestAnimationFrame to almost nothing, and the
      // boarding sequence would sit at 7% however long a check waited.
      boarding?.update(dt)
      vehicle.step(dt)
      vehicle.syncRig(rig)
      // Manual stepping stands in for a frame, so the lamps get their update too.
      lights?.update(
        {
          steer: vehicle.state.steerInput,
          brake: vehicle.input.brake > 0.05,
          reversing: vehicle.state.speed < fromLegacyUnits(-0.5), // -0.5 旧单位 ≈ -0.11 m/s 的倒车判定阈值
          hazards: hazardsOn,
        },
        dt,
      )
      // Manual stepping stands in for a frame, so a procedural map still gets to
      // stream its road around the car.
      map.update?.(vehicle.state.distance)
      // Manual stepping stands in for a frame, so the chase camera has to follow
      // too; otherwise headless captures show an empty road. Not when the camera has
      // been handed to someone else, though - the frame loop already makes that
      // distinction, and without it here a stepped run yanks the view back to the
      // chase rig mid-shot.
      if (!freeCamera) chase?.update(dt, vehicle.state)
    },
    reset: () => {
      if (!vehicle || !rig) return
      vehicle.reset()
      vehicle.syncRig(rig)
      enterChaseCamera()
    },
    setPaused: (value) => {
      paused = value
    },
    paused: () => paused,
    cameraFocus: () => cameraFocus,
    setCameraFocus: (value) => setCameraFocus(value),
    droneGimbalPitch: (value) =>
      value === undefined ? drone.gimbalPitch() : drone.setGimbalPitch(value),
    setCarVisible: (value) => {
      if (rig) rig.root.visible = value
    },
    setWheelsVisible: (value) => {
      if (rig) for (const wheel of rig.wheels) wheel.steer.visible = value
    },
    partPositions: () => {
      const out: Record<string, number[]> = {}
      if (!rig) return out
      const position = new THREE.Vector3()
      rig.root.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh) return
        const label = /Front_lights/i.test(mesh.name)
          ? 'frontLights'
          : /Back_lights/i.test(mesh.name)
            ? 'backLights'
            : /Koleso_Main/i.test(mesh.name)
              ? 'wheel'
              : ''
        if (label && !out[label])
          out[label] = mesh
            .getWorldPosition(position)
            .toArray()
            .map((value) => Number(value.toFixed(2)))
      })
      return out
    },
    carMaterials: () => {
      const seen = new Map<string, any>()
      if (rig)
        rig.root.traverse((object) => {
          const mesh = object as THREE.Mesh
          if (!mesh.isMesh) return
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const surface = material as THREE.MeshStandardMaterial
            const key = (material.name || '(unnamed)') + '|' + mesh.name
            if (seen.has(key)) continue
            seen.set(key, {
              name: material.name || '(unnamed)',
              mesh: mesh.name,
              transparent: material.transparent,
              opacity: material.opacity,
              depthWrite: material.depthWrite,
              side:
                material.side === THREE.DoubleSide
                  ? 'double'
                  : material.side === THREE.FrontSide
                    ? 'front'
                    : 'back',
              color: surface.color ? '#' + surface.color.getHexString() : '',
              metalness: typeof surface.metalness === 'number' ? surface.metalness : null,
              roughness: typeof surface.roughness === 'number' ? surface.roughness : null,
              envMapIntensity:
                typeof surface.envMapIntensity === 'number' ? surface.envMapIntensity : null,
              envMap: Boolean(surface.envMap),
            })
          }
        })
      return [...seen.values()]
    },
    setOverviewCamera: overview,
    // Park the car and look from anywhere: used to review the scene and the
    // water reflection from angles the chase camera cannot reach.
    setCameraPose: (position, target) => {
      paused = true
      freeCamera = true
      controls.enabled = true
      controls.target.set(target[0], target[1], target[2])
      camera.position.set(position[0], position[1], position[2])
      camera.lookAt(new THREE.Vector3(target[0], target[1], target[2]))
      camera.updateMatrixWorld()
      render()
    },
    render,
    pixels: () => {
      render()
      const gl = renderer.getContext()
      const width = renderer.domElement.width
      const height = renderer.domElement.height
      const buffer = new Uint8Array(width * height * 4)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, buffer)
      return { width, height, data: Array.from(buffer) }
    },
    profileFrame: (hideKnots = false) => {
      const knots = map.visual.getObjectByName('street-lamp-chinese-knots')
      const visible = knots?.visible ?? false
      const autoReset = renderer.info.autoReset
      const gl = renderer.getContext()
      gl.finish()
      if (knots && hideKnots) knots.visible = false
      renderer.info.autoReset = false
      renderer.info.reset()
      try {
        const started = performance.now()
        render()
        gl.finish()
        return {
          milliseconds: performance.now() - started,
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        }
      } finally {
        renderer.info.autoReset = autoReset
        if (knots) knots.visible = visible
      }
    },
    screenshot: () => {
      render()
      return renderer.domElement.toDataURL('image/png')
    },
  }

  resize()
  /** 暴露给浏览器端场景控制(MCP/控制台)的适配层,并在其后启动载入与渲染循环 */
  const sceneControl = createSceneControl({
    scene,
    map,
    camera,
    controls,
    renderer,
    car,
    rig: () => rig,
    body: () => carBody,
    vehicle: () => vehicle,
    boarding: () => boarding,
    paused: () => paused,
    pause: (value) => {
      paused = value
    },
    cameraMode: () => (boarding?.state().running ? 'boarding' : freeCamera ? 'free' : 'chase'),
    freeCamera: () => {
      freeCamera = true
      controls.enabled = true
    },
    time: () => timeOfDay,
    syncDoors: syncBodyPanel,
    render,
  })
  connectSceneBridge(sceneControl)
  void boot()
  rafId = requestAnimationFrame(frame)

  /**
   * 卸载:停掉渲染循环、注销全局监听、销毁 WebGL 上下文。
   * 元素级监听随容器清空自动失效;纹理与几何由上下文销毁统一回收。
   */
  return {
    dispose: () => {
      if (!running) return
      running = false
      cancelAnimationFrame(rafId)
      globalSignals.abort()
      // 提示浮层的延时器也要撤:它挂在 window 上,不撤会在页面卸载后回写 DOM
      droneToastDisposed = true
      window.clearTimeout(droneToastTimer)
      keyboard?.dispose()
      drone.dispose()
      controls.dispose()
      composer.dispose()
      glowComposer.dispose()
      pmrem.dispose()
      environmentTarget?.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      viewport.replaceChildren()
      delete raceApi.__RACE__
    },
  }
}
