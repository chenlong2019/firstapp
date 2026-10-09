// 本文件负责雨天"湿滑路面"效果：把可驾驶路面对应的材质改成会积水的沥青，并在路面上方
// 叠加一层真实的平面反射贴图，合成出参考图里那种被雨水打湿的街道反光。
// 位置：race-scene/race/weather 的雨天表现之一，由上层在开启降雨时驱动。
// 对外导出：createWetRoad 工厂，以及 WetRoad / WetRoadOptions 两个类型。
// 非直觉约定：反射用的虚拟相机、裁剪平面与纹理矩阵都按"平面镜"推导，需与地面法线 (0,1,0) 一致；
// 反射贴图按绘制缓冲比例动态缩放并夹在上下限之间，用来约束每帧多出的一次离屏渲染开销。
import * as THREE from 'three'

type WetUniforms = {
  uWet: { value: number }
  uStrength: { value: number }
  uRoughness: { value: number }
  uDarkening: { value: number }
}

type WetMaterialRecord = {
  uniforms: WetUniforms
}

const GLSL_NOISE = /* glsl */ `
  float wetRoadHash(vec2 value) {
    vec2 mapped = fract(value * vec2(123.34, 456.21));
    mapped += dot(mapped, mapped + 45.32);
    return fract(mapped.x * mapped.y);
  }

  float wetRoadNoise(vec2 value) {
    vec2 whole = floor(value);
    vec2 part = fract(value);
    part = part * part * (3.0 - 2.0 * part);
    float a = wetRoadHash(whole);
    float b = wetRoadHash(whole + vec2(1.0, 0.0));
    float c = wetRoadHash(whole + vec2(0.0, 1.0));
    float d = wetRoadHash(whole + vec2(1.0, 1.0));
    return mix(mix(a, b, part.x), mix(c, d, part.x), part.y);
  }

  float wetRoadFbm(vec2 value) {
    float total = 0.0;
    total += 0.5000 * wetRoadNoise(value);
    value = value * 2.03 + 17.1;
    total += 0.2500 * wetRoadNoise(value);
    value = value * 2.01 + 31.7;
    total += 0.1250 * wetRoadNoise(value);
    return total / 0.875;
  }

  float wetRoadPuddle(vec2 world) {
    // World coordinates are metres; frequencies retain the existing puddle size.
    vec2 p = world * 0.7848;
    float broad = wetRoadFbm(p * 0.36);
    float medium = wetRoadFbm(p * 1.08 + vec2(9.7, 3.1));
    float channels = smoothstep(0.60, 0.92, wetRoadNoise(p * vec2(0.032, 0.17) + vec2(2.0, 8.0)));
    float puddle = smoothstep(0.44, 0.76, broad * 0.62 + medium * 0.38);
    return clamp(puddle + channels * 0.32, 0.0, 1.0);
  }
`

const REFLECTION_SHADER = {
  name: 'WetRoadReflectionShader',
  uniforms: {
    uReflection: { value: null },
    uTextureMatrix: { value: new THREE.Matrix4() },
    uTime: { value: 0 },
    uWet: { value: 0 },
    uStrength: { value: 1.45 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 uTextureMatrix;
    varying vec3 vWorldPosition;
    varying vec4 vReflectCoord;

    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPosition = world.xyz;
      vReflectCoord = uTextureMatrix * world;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uReflection;
    uniform float uTime;
    uniform float uWet;
    uniform float uStrength;
    varying vec3 vWorldPosition;
    varying vec4 vReflectCoord;

    ${GLSL_NOISE}

    vec3 wetReflection(vec4 coord, vec2 world, float puddle) {
      if (coord.w <= 0.0) return vec3(0.0);
      vec2 uv = coord.xy / coord.w;
      if (uv.x < -0.05 || uv.x > 1.05 || uv.y < -0.05 || uv.y > 1.05) return vec3(0.0);

      float smear = (0.0035 + puddle * 0.0125) * uStrength;
      float phase = uTime * 0.55 + world.x * 0.01744 + world.y * 0.04796;
      vec2 drift = vec2(
        (wetRoadNoise(world * 0.6976 + phase) - 0.5) * 0.0022,
        (wetRoadNoise(world * 0.5668 - phase) - 0.5) * 0.0045
      );
      vec3 total = vec3(0.0);
      float weights = 0.0;
      for (int index = -3; index <= 3; index++) {
        float weight = 1.0 - abs(float(index)) / 4.0;
        vec2 offset = vec2(drift.x, drift.y + float(index) * smear);
        total += texture2D(uReflection, clamp(uv + offset, vec2(0.001), vec2(0.999))).rgb * weight;
        weights += weight;
      }
      return total / weights;
    }

    void main() {
      if (uWet < 0.01) discard;
      vec2 world = vWorldPosition.xz;
      float puddle = wetRoadPuddle(world);
      float mask = clamp(uWet * puddle, 0.0, 1.0);
      if (mask < 0.012) discard;

      vec3 toEye = normalize(cameraPosition - vWorldPosition);
      float facing = clamp(dot(toEye, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);
      float fresnel = mix(0.025, 0.94, pow(1.0 - facing, 2.6));
      vec3 reflection = wetReflection(vReflectCoord, world, puddle);
      vec3 glints = pow(max(reflection, vec3(0.0)), vec3(1.28));
      vec3 colour = (reflection * 0.72 + glints * 0.86) * fresnel * mask * uStrength;
      float alpha = clamp(length(colour), 0.0, 1.0);
      gl_FragColor = vec4(colour, alpha);
    }
  `,
}

function attachWetShader(
  material: THREE.MeshStandardMaterial,
  strength: number,
  roughness: number,
  darkening: number,
) {
  if (material.userData.wetRoad) return
  const uniforms: WetUniforms = {
    uWet: { value: 0 },
    uStrength: { value: strength },
    uRoughness: { value: roughness },
    uDarkening: { value: darkening },
  }
  material.userData.wetRoad = { uniforms } satisfies WetMaterialRecord

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWetWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWetWorld = (modelMatrix * vec4(transformed, 1.0)).xz;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWet;uniform float uStrength;uniform float uRoughness;uniform float uDarkening;varying vec2 vWetWorld;',
      )
      .replace('#include <common>', '#include <common>\n' + GLSL_NOISE)
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
          #include <roughnessmap_fragment>
          float wetPuddle = wetRoadPuddle(vWetWorld);
          float wetMask = clamp(uWet * uStrength * wetPuddle, 0.0, 1.0);
          roughnessFactor = mix(roughnessFactor, uRoughness, wetMask * 0.94);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(uDarkening), wetMask * 0.78);
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
          #include <normal_fragment_maps>
          if (wetMask > 0.005) {
            vec2 wetP = vWetWorld * 6.322;
            float wetBase = wetRoadNoise(wetP + uWet * 0.04);
            vec2 wetGradient = vec2(
              wetRoadNoise(wetP + vec2(0.10, 0.0)) - wetBase,
              wetRoadNoise(wetP + vec2(0.0, 0.10)) - wetBase
            );
            vec3 wetWorldNormal = normalize(vec3(wetGradient.x, 1.0, wetGradient.y));
            normal = normalize(normal + mat3(viewMatrix) * wetWorldNormal * wetMask * 0.30);
          }
        `,
      )
  }
  material.customProgramCacheKey = () => 'wet-road-v2'
  material.needsUpdate = true
}

/** 湿滑路面运行时句柄：切换雨量、刷新材质、渲染平面反射，并查询材质/叠加层/反射状态。 */
export type WetRoad = {
  setRain: (active: boolean, intensity: number) => void
  refreshOverlays: () => void
  renderReflection: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) => boolean
  setExclusions: (objects: readonly THREE.Object3D[]) => void
  state: () => {
    active: boolean
    intensity: number
    materials: number
    overlays: number
    reflection: { width: number; height: number; rendered: boolean }
  }
}

/** 构建湿滑路面的输入：场景根节点、场景本身、路面世界高度，以及可选的自定义匹配正则。 */
export type WetRoadOptions = {
  root: THREE.Object3D
  scene: THREE.Scene
  /** World height in metres of the drivable plane; all current maps are flat. */
  surfaceY: number
  pattern?: RegExp
}

// 这两组正则按网格名称筛选：一个挑"会积水的地面"，一个挑"需要套湿滑着色器的材质"，
// 名称取自各桥梁/道路生成器的命名约定。
const SURFACE_PATTERN = /^(bridge-roadway|road-surface)$/i
const MATERIAL_PATTERN =
  /^(bridge-roadway|road-surface|road-deck|edge-line|centre-line)$|^bridge-marking/i
const PLANE_NORMAL = new THREE.Vector3(0, 1, 0)

/**
 * Wet asphalt as a real planar reflector plus a material-level dampness pass.
 * The mirror texture supplies the actual scene; puddle noise and a vertical
 * smear turn that reflection into the reference image's wet-street streaks.
 */
export function createWetRoad(options: WetRoadOptions): WetRoad {
  const { root, scene, surfaceY } = options
  const materialPattern = options.pattern ?? MATERIAL_PATTERN
  const surfacePattern = options.pattern ?? SURFACE_PATTERN
  const materials = new Set<THREE.MeshStandardMaterial>()
  const roadMeshes = new Set<THREE.Mesh>()
  const overlays = new Set<THREE.Mesh>()
  const overlayBySource = new Map<THREE.Mesh, THREE.Mesh>()
  const exclusions = new Set<THREE.Object3D>()

  let active = false
  let intensity = 0
  let rendered = false
  const planePoint = new THREE.Vector3(0, surfaceY, 0)
  // 此处尺寸仅为占位；renderReflection 会按实际绘制缓冲大小动态调整该反射贴图。
  const reflectionTarget = new THREE.WebGLRenderTarget(768, 432, {
    type: THREE.HalfFloatType,
    samples: 0,
  })
  const reflectionMaterial = new THREE.ShaderMaterial({
    ...REFLECTION_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  reflectionMaterial.uniforms.uReflection.value = reflectionTarget.texture

  const virtualCamera = new THREE.PerspectiveCamera()
  const cameraWorld = new THREE.Vector3()
  const cameraRotation = new THREE.Matrix4()
  const cameraLook = new THREE.Vector3()
  const mirrorTarget = new THREE.Vector3()
  const mirrorUp = new THREE.Vector3()
  const reflectorPlane = new THREE.Plane()
  const clipPlane = new THREE.Vector4()
  const projectionQ = new THREE.Vector4()
  const textureMatrix = new THREE.Matrix4()
  const drawingSize = new THREE.Vector2()

  const attachOverlay = (mesh: THREE.Mesh) => {
    if (overlayBySource.has(mesh) || !mesh.parent) {
      roadMeshes.add(mesh)
      return
    }
    roadMeshes.add(mesh)
    const overlay = new THREE.Mesh(mesh.geometry, reflectionMaterial)
    overlay.name = `${mesh.name}-wet-reflection`
    overlay.userData.raceHelper = true
    // 沿世界竖直方向抬高约 0.0505 米，让反射叠加层压在原路面之上，避免共面产生 z-fighting。
    overlay.position.y += 0.050459
    overlay.renderOrder = 3
    overlay.receiveShadow = false
    overlay.castShadow = false
    overlay.visible = active && intensity > 0.01
    mesh.add(overlay)
    overlays.add(overlay)
    overlayBySource.set(mesh, overlay)
  }

  const scan = () => {
    roadMeshes.clear()
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      if (materialPattern.test(mesh.name)) {
        const owned = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of owned) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue
          const marking = /marking|line/i.test(mesh.name)
          const deck = /deck/i.test(mesh.name)
          attachWetShader(
            material,
            marking ? 0.58 : deck ? 0.72 : 1,
            marking ? 0.2 : deck ? 0.17 : 0.12,
            marking ? 0.72 : deck ? 0.62 : 0.54,
          )
          materials.add(material)
        }
      }
      if (surfacePattern.test(mesh.name)) attachOverlay(mesh)
    })

    for (const overlay of overlays) {
      const source = overlay.parent as THREE.Mesh | null
      if (!source || !roadMeshes.has(source)) {
        overlay.removeFromParent()
        overlays.delete(overlay)
        if (source) overlayBySource.delete(source)
      }
    }
    for (const mesh of [...roadMeshes]) if (!mesh.parent) roadMeshes.delete(mesh)
  }

  const setUniform = (value: number) => {
    for (const material of materials) {
      const record = material.userData.wetRoad as WetMaterialRecord | undefined
      if (record) record.uniforms.uWet.value = value
    }
    reflectionMaterial.uniforms.uWet.value = value * 1.08
    for (const overlay of overlays) overlay.visible = value > 0.01
  }

  const renderReflection = (
    renderer: THREE.WebGLRenderer,
    renderScene: THREE.Scene,
    camera: THREE.Camera,
  ) => {
    rendered = false
    if (!active || intensity < 0.015 || overlays.size === 0) return false
    camera.updateMatrixWorld()
    camera.getWorldPosition(cameraWorld)
    // 相机高度低于"路面 + 0.229 米"时几乎看不到反射，早退以省掉一次整场景离屏渲染。
    if (cameraWorld.y <= surfaceY + 0.229358) return false

    cameraRotation.extractRotation(camera.matrixWorld)
    cameraLook.set(0, 0, -1).applyMatrix4(cameraRotation).add(cameraWorld)
    virtualCamera.position.set(cameraWorld.x, surfaceY * 2 - cameraWorld.y, cameraWorld.z)
    mirrorTarget.set(cameraLook.x, surfaceY * 2 - cameraLook.y, cameraLook.z)
    mirrorUp.set(0, 1, 0).applyMatrix4(cameraRotation).reflect(PLANE_NORMAL)
    virtualCamera.up.copy(mirrorUp)
    virtualCamera.lookAt(mirrorTarget)
    const host = camera as THREE.PerspectiveCamera
    if (host.isPerspectiveCamera) {
      virtualCamera.fov = host.fov
      virtualCamera.aspect = host.aspect
      virtualCamera.near = host.near
      virtualCamera.far = host.far
      virtualCamera.updateProjectionMatrix()
    } else {
      virtualCamera.projectionMatrix.copy(camera.projectionMatrix)
    }
    virtualCamera.updateMatrixWorld()

    // 把反射平面改写成虚拟相机的斜近裁剪面：位于镜面之下的几何不会进入反射图，防止穿帮。
    reflectorPlane.setFromNormalAndCoplanarPoint(PLANE_NORMAL, planePoint)
    reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse)
    clipPlane.set(
      reflectorPlane.normal.x,
      reflectorPlane.normal.y,
      reflectorPlane.normal.z,
      reflectorPlane.constant,
    )
    const projection = virtualCamera.projectionMatrix
    projectionQ.x = (Math.sign(clipPlane.x) + projection.elements[8]) / projection.elements[0]
    projectionQ.y = (Math.sign(clipPlane.y) + projection.elements[9]) / projection.elements[5]
    projectionQ.z = -1
    projectionQ.w = (1 + projection.elements[10]) / projection.elements[14]
    clipPlane.multiplyScalar(2 / clipPlane.dot(projectionQ))
    projection.elements[2] = clipPlane.x
    projection.elements[6] = clipPlane.y
    projection.elements[10] = clipPlane.z + 1 - 0.003
    projection.elements[14] = clipPlane.w

    // 标准投影纹理矩阵：世界坐标 → 虚拟相机裁剪空间 → [0,1] 的反射贴图 UV。
    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    textureMatrix.multiply(virtualCamera.projectionMatrix)
    textureMatrix.multiply(virtualCamera.matrixWorldInverse)
    reflectionMaterial.uniforms.uTextureMatrix.value.copy(textureMatrix)

    renderer.getDrawingBufferSize(drawingSize)
    // 反射按绘制缓冲的 38% 分辨率渲染，并夹在 320×180 / 896×504 之间，控制每帧的离屏开销。
    const width = Math.max(320, Math.min(896, Math.round(drawingSize.x * 0.38)))
    const height = Math.max(180, Math.min(504, Math.round(drawingSize.y * 0.38)))
    if (reflectionTarget.width !== width || reflectionTarget.height !== height)
      reflectionTarget.setSize(width, height)

    const hidden: THREE.Object3D[] = []
    const previousVisible = new Map<THREE.Object3D, boolean>()
    for (const overlay of overlays) hidden.push(overlay)
    for (const mesh of roadMeshes) hidden.push(mesh)
    for (const object of exclusions) hidden.push(object)
    for (const object of hidden) {
      previousVisible.set(object, object.visible)
      object.visible = false
    }

    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    const previousShadowUpdate = renderer.shadowMap.autoUpdate
    renderer.setRenderTarget(reflectionTarget)
    renderer.setClearColor(0x000000, 0)
    renderer.autoClear = true
    renderer.shadowMap.autoUpdate = false
    renderer.render(renderScene, virtualCamera)
    renderer.shadowMap.autoUpdate = previousShadowUpdate
    renderer.autoClear = previousAutoClear
    renderer.setRenderTarget(previousTarget)
    for (const object of hidden) object.visible = previousVisible.get(object) ?? true
    rendered = true
    return true
  }

  scan()

  return {
    setRain(nextActive, nextIntensity) {
      active = nextActive
      intensity = THREE.MathUtils.clamp(nextIntensity, 0, 1)
      scan()
      // 用 0.72 次幂把雨量映射到湿度：小雨也能较快显出湿痕。
      const target = active ? Math.pow(intensity, 0.72) : 0
      setUniform(target)
    },
    refreshOverlays: scan,
    renderReflection,
    setExclusions(objects) {
      exclusions.clear()
      for (const object of objects) if (object) exclusions.add(object)
    },
    state: () => ({
      active,
      intensity,
      materials: materials.size,
      overlays: overlays.size,
      reflection: { width: reflectionTarget.width, height: reflectionTarget.height, rendered },
    }),
  }
}
