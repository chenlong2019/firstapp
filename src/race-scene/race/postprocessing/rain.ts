import * as THREE from 'three'

/**
 * Screen-space rain streaks for the third-person camera.
 *
 * The visual is adapted from the light-scattering idea in Reinder Nijhoff's
 * "Tokyo by night in the rain", but the raymarched city is deliberately not
 * reproduced: this pass reads the already-rendered scene, uses bright pixels as
 * light sources, and keeps the expensive geometry work in the normal scene.
 */
export const RainShader = {
  name: 'RainShader',
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    resolution: { value: new THREE.Vector2(1, 1) },
    intensity: { value: 0.65 },
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
    uniform float time;
    uniform vec2 resolution;
    uniform float intensity;

    varying vec2 vUv;

    float hash21(vec2 value) {
      vec3 mapped = fract(vec3(value.xyx) * 0.2331);
      mapped += dot(mapped, mapped.yzx + 27.19);
      return fract((mapped.x + mapped.y) * mapped.z);
    }

    vec2 hash22(vec2 value) {
      vec3 mapped = fract(vec3(value.xyx) * vec3(0.1031, 0.1030, 0.0973));
      mapped += dot(mapped, mapped.yzx + 33.33);
      return fract((mapped.xx + mapped.yz) * mapped.zy);
    }

    // One smooth capsule in a vertical rain column. The row seed changes at a
    // cell edge, where the capsule is invisible, so drops do not pop on screen.
    float rainLayer(vec2 pixel, float seconds, float seed, float cellWidth,
                    float cellHeight, float speed) {
      vec2 coord = vec2(pixel.x / cellWidth, pixel.y / cellHeight + seconds * speed / cellHeight);
      float column = floor(coord.x);
      float row = floor(coord.y);
      vec2 columnSeed = hash22(vec2(column, seed * 71.3));
      vec2 cellSeed = hash22(vec2(column * 43.7 + row * 17.1, seed));

      float x = (fract(coord.x) - 0.5) * cellWidth;
      float y = (fract(coord.y) - 0.5) * cellHeight;
      x += (columnSeed.x - 0.5) * cellWidth * 0.70;
      x += (cellSeed.x - 0.5) * cellWidth * 0.28;

      float dropLength = mix(cellHeight * 0.18, cellHeight * 0.36, cellSeed.y);
      float distanceY = max(abs(y) - dropLength, 0.0);
      float radius = mix(0.9, 1.45, columnSeed.y);
      float capsule = length(vec2(x, distanceY));
      float shape = smoothstep(radius, radius * 0.12, capsule);
      return shape * mix(0.24, 1.0, cellSeed.x);
    }

    // Rec.709 亮度权重，用来把邻近像素亮度当作"灯光强度"。
    float colorLuminance(vec3 color) {
      return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    // The scene has no light list here, so bright pixels stand in for lamps.
    // A small cross/ring sample is enough: rain picks up the lamp's colour and
    // fades again a few pixels away.
    vec3 lightGlow(vec2 uv, vec2 texel) {
      vec3 total = texture2D(tDiffuse, uv).rgb;
      total += texture2D(tDiffuse, uv + vec2(2.5, 0.0) * texel).rgb;
      total += texture2D(tDiffuse, uv + vec2(-2.5, 0.0) * texel).rgb;
      total += texture2D(tDiffuse, uv + vec2(0.0, 4.0) * texel).rgb;
      total += texture2D(tDiffuse, uv + vec2(0.0, -4.0) * texel).rgb;
      total += texture2D(tDiffuse, uv + vec2(8.0, 5.0) * texel).rgb;
      total += texture2D(tDiffuse, uv + vec2(-8.0, 5.0) * texel).rgb;
      total += texture2D(tDiffuse, uv + vec2(8.0, -5.0) * texel).rgb;
      total += texture2D(tDiffuse, uv + vec2(-8.0, -5.0) * texel).rgb;
      return total / 9.0;
    }

    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      vec2 pixel = vUv * resolution;
      // 对像素坐标做水平剪切，让整片雨丝斜向下落，模拟有风的雨。
      vec2 slantedPixel = pixel + pixel.y * vec2(-0.075, 0.0);

      float drops = 0.0;
      // 叠三层雨丝：格子越大、下落速度（像素/秒）越慢，观感上雨层越远越细。
      drops += 0.58 * rainLayer(slantedPixel, time, 1.0, 13.0, 190.0, 1500.0);
      drops += 0.74 * rainLayer(slantedPixel, time, 2.0, 20.0, 265.0, 1080.0);
      drops += 0.52 * rainLayer(slantedPixel, time, 3.0, 30.0, 350.0, 760.0);
      drops = clamp(drops, 0.0, 1.0);

      vec3 nearby = lightGlow(vUv, 1.0 / resolution);
      float brightness = colorLuminance(nearby);
      float scatter = pow(smoothstep(0.10, 0.78, brightness), 1.25);
      vec3 lightTint = nearby / max(brightness, 0.001);
      lightTint = clamp(lightTint, 0.0, 2.0);

      // A neutral rain layer keeps streaks visible against a dark road. Near a
      // light it takes the light's colour, which is what makes the reference
      // image read as rainy Tokyo rather than as television noise.
      vec3 neutralColor = vec3(0.075, 0.095, 0.130);
      vec3 dropColor = mix(neutralColor, lightTint * 1.9, scatter);
      base += drops * intensity * 1.25 * dropColor * (0.38 + scatter * 1.35);

      // Wet-weather grade: cloudier and slightly cool, without turning the day
      // scene grey or flattening the night lights.
      vec3 overcast = base * mix(vec3(1.0), vec3(0.78, 0.82, 0.90), intensity * 0.48);
      base = mix(base, overcast, 0.82);
      base += drops * intensity * 0.012 * vec3(0.70, 0.82, 1.00);

      gl_FragColor = vec4(base, 1.0);
    }
  `,
}
