// 本文件负责降雨的"撞击表现"：路面上的雨滴涟漪、空中下落的雨滴拉丝，以及桥下海面的涟漪。
// 全部用 InstancedMesh + 自定义着色器实现，每帧只更新实例属性，不重建几何体。
// 位置：race-scene/race/weather 之一，与湿滑路面、全屏雨丝后处理共同组成雨天视觉。
// 对外导出：createRainImpacts 工厂，以及 RainImpacts / RainImpactsOptions 两个类型。
// 非直觉约定：世界尺寸单位为米；实例按环形缓冲复用，靠 aBirth 时间戳控制生灭。
import * as THREE from 'three'
import type { TrackSurface } from '../track/trackSurface'

/** 雨滴撞击效果句柄：控制开关/强度/亮度/密度，并按帧推进时间与生成雨滴。 */
export type RainImpacts = {
  object: THREE.Object3D
  setEnabled: (active: boolean, intensity: number) => void
  setBrightness: (value: number) => void
  setDensity: (value: number) => void
  update: (deltaSeconds: number, focus: THREE.Vector3) => void
  state: () => {
    active: boolean
    intensity: number
    density: number
    ripples: number
    drops: number
    live: number
    waterLive: number
  }
}

/** 构建雨滴撞击效果的输入：可行驶表面，以及可选的实例容量与密度。 */
export type RainImpactsOptions = {
  track: TrackSurface
  capacity?: number
  density?: number
}

const CAPACITY = 1800
const WATER_CAPACITY = 1000
// All world-space dimensions below are metres (1 Three.js unit = 1 m).
const WATER_RANGE = 34.40367
const WATER_Y = 0
const WATER_SCALE = 3.4
const BACK_RANGE = 14.908257
const AHEAD_RANGE = 41.284404
const LATERAL_RANGE = 24.082569
const RIPPLE_LIFE = 0.68
const MAX_FALL = 0.16

function createRippleMesh(capacity: number) {
  const geometry = new THREE.PlaneGeometry(1, 1)
  geometry.rotateX(-Math.PI / 2)
  // aBirth 初值取负一万表示"尚未生成"；着色器据此把该实例丢出屏幕外。
  const birth = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(-1e4), 1)
  const seed = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity).map(() => Math.random()),
    1,
  )
  geometry.setAttribute('aBirth', birth)
  geometry.setAttribute('aSeed', seed)

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uBrightness: { value: 1 },
      uColor: { value: new THREE.Color(0xb2babd) },
    },
    vertexShader: /* glsl */ `
      attribute float aBirth;
      attribute float aSeed;
      uniform float uTime;
      uniform float uIntensity;

      varying vec2 vUv;
      varying float vAge;
      varying float vSeed;

      void main() {
        float life = mix(1.05, ${RIPPLE_LIFE.toFixed(2)}, fract(aSeed * 7.31));
        float age = clamp((uTime - aBirth) / life, 0.0, 1.0);
        vUv = uv;
        vAge = age;
        vSeed = fract(aSeed * 11.17);

        if (uIntensity < 0.01 || age <= 0.0 || age >= 1.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }

        // 涟漪直径在 0.25～0.60 米之间随机。
        float diameter = mix(0.252294, 0.596330, fract(aSeed * 3.71));
        float growth = 0.10 + 0.90 * pow(age, 0.58);
        vec4 world = instanceMatrix * vec4(position * diameter * growth, 1.0);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      uniform float uBrightness;
      uniform vec3 uColor;

      varying vec2 vUv;
      varying float vAge;
      varying float vSeed;

      void main() {
        vec2 centred = vUv - 0.5;
        float radius = length(centred) * 2.0;
        if (radius > 1.0) discard;

        float growth = pow(vAge, 0.58);
        float leadingRadius = mix(0.16, 0.90, growth);
        float width = mix(0.035, 0.080, growth);
        float leading = exp(-pow((radius - leadingRadius) / width, 2.0));
        float trailing = 0.22 * exp(-pow((radius - leadingRadius * 0.52) / (width * 1.25), 2.0));
        float centre = 0.72 * exp(-pow(radius / (0.07 + 0.13 * growth), 2.0)) * pow(1.0 - vAge, 1.8);

        float wave = leading * 1.08 + trailing + centre;
        float fade = pow(1.0 - vAge, 0.92);
        float edge = smoothstep(1.0, 0.84, radius);
        float alpha = wave * fade * edge * uIntensity * mix(0.62, 0.94, vSeed) * 0.88;
        vec3 tint = uColor * mix(1.0, uBrightness, 0.45);
        gl_FragColor = vec4(tint, clamp(alpha, 0.0, 1.0));
      }
    `,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.renderOrder = 4
  return { mesh, geometry, birth, seed, material }
}

function createFallingDropMesh(capacity: number) {
  const geometry = new THREE.PlaneGeometry(1, 1)
  // aBirth 初值取负一万表示"尚未生成"；着色器据此把该实例丢出屏幕外。
  const birth = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(-1e4), 1)
  const seed = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity).map(() => Math.random()),
    1,
  )
  geometry.setAttribute('aBirth', birth)
  geometry.setAttribute('aSeed', seed)

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uBrightness: { value: 1 },
      uColor: { value: new THREE.Color(0xc9d0d3) },
    },
    vertexShader: /* glsl */ `
      attribute float aBirth;
      attribute float aSeed;
      uniform float uTime;
      uniform float uIntensity;

      varying vec2 vUv;
      varying float vProgress;

      void main() {
        float fallTime = mix(0.05, ${MAX_FALL.toFixed(2)}, fract(aSeed * 5.19));
        float beforeImpact = aBirth - uTime;
        float progress = clamp(1.0 - beforeImpact / fallTime, 0.0, 1.0);
        vUv = uv;
        vProgress = progress;

        if (uIntensity < 0.01 || progress <= 0.0 || progress >= 1.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }

        vec3 centre = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        vec3 view = normalize(cameraPosition - centre);
        vec3 side = cross(vec3(0.0, 1.0, 0.0), view);
        vec3 right = length(side) < 0.001 ? vec3(1.0, 0.0, 0.0) : normalize(side);

        // 雨滴下落高度约 0.80～1.49 米。
        float fallHeight = mix(0.802752, 1.490826, fract(aSeed * 9.31)) * (1.0 - progress);
        float dropWidth = mix(0.077982, 0.133028, fract(aSeed * 2.93));
        float dropHeight = mix(0.321101, 0.504587, fract(aSeed * 4.41));
        vec3 world = centre
          + right * position.x * dropWidth
          + vec3(0.0, position.y * dropHeight + fallHeight, 0.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uIntensity;
      uniform float uBrightness;
      uniform vec3 uColor;

      varying vec2 vUv;
      varying float vProgress;

      void main() {
        float x = abs(vUv.x - 0.5);
        float body = smoothstep(0.10, 0.015, x);
        float core = smoothstep(0.040, 0.0, x);
        float vertical = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.62, vUv.y);
        float fade = smoothstep(0.0, 0.16, vProgress) * smoothstep(1.0, 0.90, vProgress);
        float alpha = (body * 0.42 + core * 0.68) * vertical * fade * uIntensity;
        gl_FragColor = vec4(uColor * uBrightness * 0.25, clamp(alpha, 0.0, 1.0));
      }
    `,
  })

  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.renderOrder = 5
  return { mesh, geometry, birth, seed, material }
}

export function createRainImpacts(options: RainImpactsOptions): RainImpacts {
  const { track } = options
  const capacity = options.capacity ?? CAPACITY
  const ripple = createRippleMesh(capacity)
  const drop = createFallingDropMesh(capacity)
  const waterRipple = createRippleMesh(WATER_CAPACITY)
  const waterDrop = createFallingDropMesh(WATER_CAPACITY)
  const group = new THREE.Group()
  group.name = 'rain-impacts'
  group.add(ripple.mesh, drop.mesh)
  group.add(waterRipple.mesh, waterDrop.mesh)

  let active = false
  let intensity = 0
  let density = THREE.MathUtils.clamp(options.density ?? 1, 0, 2)
  let time = 0
  let index = 0
  let debt = 0
  let waterIndex = 0
  let waterDebt = 0
  const matrix = new THREE.Matrix4()
  const orientation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0)
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()

  const spawnDrop = (focus: THREE.Vector3) => {
    const projected = track.project(focus.x, focus.z)
    const forward = Math.pow(Math.random(), 1.45)
    const distance = projected.distance + (forward * (BACK_RANGE + AHEAD_RANGE) - BACK_RANGE)
    const lateral = THREE.MathUtils.clamp(
      projected.lateral + (Math.random() + Math.random() - 1) * LATERAL_RANGE,
      track.lateralMin + 0.458716,
      track.lateralMax - 0.458716,
    )
    const point = track.pointAt(distance, lateral)
    const seed = Math.random()
    const impactTime = time + 0.04 + Math.random() * (MAX_FALL - 0.04)

    position.set(point.x, point.y + 0.103211, point.z)
    scale.setScalar(1)
    matrix.compose(position, orientation, scale)
    ripple.mesh.setMatrixAt(index, matrix)
    ripple.seed.setX(index, seed)
    ripple.birth.setX(index, impactTime)

    position.set(point.x, point.y + 0.080275, point.z)
    matrix.compose(position, orientation, scale)
    drop.mesh.setMatrixAt(index, matrix)
    drop.seed.setX(index, seed)
    drop.birth.setX(index, impactTime)

    ripple.mesh.instanceMatrix.needsUpdate = true
    ripple.seed.needsUpdate = true
    ripple.birth.needsUpdate = true
    drop.mesh.instanceMatrix.needsUpdate = true
    drop.seed.needsUpdate = true
    drop.birth.needsUpdate = true
    index = (index + 1) % capacity
  }

  const spawnWaterDrop = (focus: THREE.Vector3) => {
    // The sea is not constrained to the road centreline. Keep a circular field
    // around the vehicle/camera so rings are visible beside and under the bridge.
    const angle = Math.random() * Math.PI * 2
    // 用 sqrt 采样半径，保证雨滴在圆面上均匀分布，而不是向圆心堆积。
    const radius = Math.sqrt(Math.random()) * WATER_RANGE
    const x = focus.x + Math.cos(angle) * radius
    const z = focus.z + Math.sin(angle) * radius
    const seed = Math.random()
    const impactTime = time + 0.04 + Math.random() * (MAX_FALL - 0.04)

    position.set(x, WATER_Y + 0.183486, z)
    scale.setScalar(WATER_SCALE)
    matrix.compose(position, orientation, scale)
    waterRipple.mesh.setMatrixAt(waterIndex, matrix)
    waterRipple.seed.setX(waterIndex, seed)
    waterRipple.birth.setX(waterIndex, impactTime)

    position.set(x, WATER_Y + 0.126147, z)
    matrix.compose(position, orientation, scale)
    waterDrop.mesh.setMatrixAt(waterIndex, matrix)
    waterDrop.seed.setX(waterIndex, seed)
    waterDrop.birth.setX(waterIndex, impactTime)

    waterRipple.mesh.instanceMatrix.needsUpdate = true
    waterRipple.seed.needsUpdate = true
    waterRipple.birth.needsUpdate = true
    waterDrop.mesh.instanceMatrix.needsUpdate = true
    waterDrop.seed.needsUpdate = true
    waterDrop.birth.needsUpdate = true
    waterIndex = (waterIndex + 1) % WATER_CAPACITY
  }

  const countLive = () => {
    const births = ripple.birth.array as Float32Array
    let count = 0
    for (let item = 0; item < births.length; item++) {
      const age = time - births[item]
      if (age > -MAX_FALL && age < RIPPLE_LIFE) count++
    }
    return count
  }

  const countWaterLive = () => {
    const births = waterRipple.birth.array as Float32Array
    let count = 0
    for (let item = 0; item < births.length; item++) {
      const age = time - births[item]
      if (age > -MAX_FALL && age < RIPPLE_LIFE) count++
    }
    return count
  }

  return {
    object: group,
    setEnabled(nextActive: boolean, nextIntensity: number) {
      active = nextActive
      intensity = THREE.MathUtils.clamp(nextIntensity, 0, 1)
      group.visible = active && intensity > 0.01
      ripple.material.uniforms.uIntensity.value = intensity
      drop.material.uniforms.uIntensity.value = intensity
      waterRipple.material.uniforms.uIntensity.value = Math.min(intensity * 1.6, 0.95)
      waterDrop.material.uniforms.uIntensity.value = intensity
      if (!group.visible) {
        ;(ripple.birth.array as Float32Array).fill(-1e4)
        ;(drop.birth.array as Float32Array).fill(-1e4)
        ;(waterRipple.birth.array as Float32Array).fill(-1e4)
        ;(waterDrop.birth.array as Float32Array).fill(-1e4)
        ripple.birth.needsUpdate = true
        drop.birth.needsUpdate = true
        waterRipple.birth.needsUpdate = true
        waterDrop.birth.needsUpdate = true
      }
    },
    setBrightness(value: number) {
      const brightness = THREE.MathUtils.clamp(value, 0.5, 1.8)
      ripple.material.uniforms.uBrightness.value = brightness
      drop.material.uniforms.uBrightness.value = Math.min(brightness * 0.18, 0.9)
      waterRipple.material.uniforms.uBrightness.value = brightness
      waterDrop.material.uniforms.uBrightness.value = Math.min(brightness * 0.18, 0.9)
    },
    setDensity(value: number) {
      density = THREE.MathUtils.clamp(value, 0, 2)
    },
    update(deltaSeconds: number, focus: THREE.Vector3) {
      // 单帧步长上限 0.3 秒，防止切后台回来后一次性补生成大量雨滴。
      const delta = Math.max(0, Math.min(deltaSeconds, 0.3))
      time += delta
      ripple.material.uniforms.uTime.value = time
      drop.material.uniforms.uTime.value = time
      waterRipple.material.uniforms.uTime.value = time
      waterDrop.material.uniforms.uTime.value = time
      if (!active || intensity < 0.015) return

      // 累积"应生成"的路面雨滴数（每秒约 480 个基准），不足一个的余量留到下一帧，避免低帧率漏生成。
      debt += 480 * density * Math.pow(intensity, 1.18) * delta
      const count = Math.min(Math.floor(debt), capacity)
      for (let item = 0; item < count; item++) spawnDrop(focus)
      debt -= count

      // 海面涟漪单独限速：每秒约 650 个基准。
      waterDebt += 650 * density * Math.pow(intensity, 1.18) * delta
      const waterCount = Math.min(Math.floor(waterDebt), WATER_CAPACITY)
      for (let item = 0; item < waterCount; item++) spawnWaterDrop(focus)
      waterDebt -= waterCount
    },
    state: () => ({
      active,
      intensity,
      density,
      ripples: capacity,
      drops: capacity,
      live: countLive(),
      waterLive: countWaterLive(),
    }),
  }
}
