/**
 * 海面材质（water-sky/materials）：用 ShaderMaterial 逐片元解析海面高度、法线与反射。
 * 涌浪与细波纹在着色器内程序化生成、按世界空间采样，因此网格可随相机平移而不“滑动”。
 * 对外导出 createWaterMaterial；uniforms 由 environment.ts 的宿主逐帧或改参时写入。
 * 非直觉约定：着色器内部用上游“旧单位”(LEGACY_UNITS_PER_METRE) 做噪声采样与阈值比较，
 * 但传入的几何/相机/反射位置都是米；镜面 pass 的覆盖度存放在反射贴图的 alpha 通道里。
 */
import * as THREE from 'three'
import { skyColorGLSL } from './sky'
import { LEGACY_UNITS_PER_METRE } from '../../units'

// Shared height AND gradient keep the lighting continuous across mesh triangles.
// Wave/noise calibration retains its original sampling coordinates internally.
// Geometry, camera and reflection positions exposed by the material are metres.
const swellField = /* glsl */ `
  uniform float intensity;
  uniform float wind;
  uniform float rippleSize;

  void swell(inout vec3 field, vec2 p, vec2 frequency, float amplitude, float phase) {
    float angle = dot(p, frequency) + phase;
    field += vec3(amplitude * sin(angle), amplitude * cos(angle) * frequency);
  }

  // x = height, yz = analytic d(height)/d(xz)
  vec3 surface(vec2 p) {
    vec3 field = vec3(0.0);
    // 振幅递减、频率递增的 4 组正弦涌浪；相位含 time 与 wind，风越大越快。
    swell(field, p, vec2( .52,  .19), .052,  time * (.63 + wind * .22));
    swell(field, p, vec2(-.17,  .43), .037, -time * (.37 + wind * .16) + 1.7);
    swell(field, p, vec2( .91, -.67), .017,  time * (.29 + wind * .11) + 2.4);
    swell(field, p, vec2(-1.37, -.21), .009, -time * .19 + 4.1);
    return field * intensity;
  }
`

/**
 * 创建海面材质。返回的 ShaderMaterial 由外部（environment.ts）驱动 uniforms：
 * time/intensity/wind/rippleSize/sunHeight/cloudDensity/sunset，以及
 * reflectionMap/reflectionMatrix/reflectionStrength（由宿主镜面 pass 填充）。
 */
export function createWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    // Water is optically reflective here, not a transparent overlay on the sky.
    uniforms: {
      time: { value: 0 },
      intensity: { value: 0.45 },
      wind: { value: 0.35 },
      rippleSize: { value: 1 },
      sunHeight: { value: 0.58 },
      cloudDensity: { value: 0.76 },
      sunset: { value: 0 },
      // Shader output is converted from linear to sRGB by colorspace_fragment.
      // These linear values therefore keep the foreground deep green instead of washing it out.
      deepColor: { value: new THREE.Color().setRGB(0.012, 0.055, 0.033) },
      shallowColor: { value: new THREE.Color().setRGB(0.05, 0.145, 0.092) },
      hazeColor: { value: new THREE.Color().setRGB(0.23, 0.33, 0.34) },
      // Mirror pass, filled by the host through WaterSkyEnvironment.
      // `reflectionStrength` stays 0 until that pass has rendered once, so the
      // water looks exactly as before when nothing feeds it.
      reflectionMap: { value: null },
      reflectionMatrix: { value: new THREE.Matrix4() },
      reflectionStrength: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float time;
      ${swellField}
      varying vec3 vWorld;
      varying vec2 vSurface;
      void main() {
        // Sample the wave field in world space. The mesh can then be moved under
        // the camera to follow it without the sea sliding along with the mesh.
        vec4 base = modelMatrix * vec4(position, 1.0);
        // 世界坐标（米）换算到着色器内部使用的旧单位采样坐标。
        vSurface = base.xz * ${LEGACY_UNITS_PER_METRE};
        vec3 p = position;
        // 波浪振幅从旧单位换回米，再加到顶点高度上。
        p.y += surface(vSurface).x / ${LEGACY_UNITS_PER_METRE};
        vec4 world = modelMatrix * vec4(p, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `                            
      ${skyColorGLSL}
      ${swellField}
      uniform vec3 deepColor;
      uniform vec3 shallowColor;
      uniform vec3 hazeColor;
      uniform sampler2D reflectionMap;
      uniform mat4 reflectionMatrix;
      uniform float reflectionStrength;
      varying vec3 vWorld;
      varying vec2 vSurface;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      // Quintic interpolation and its exact gradient. No finite-difference blur
      // or grid-aligned geometric face normals enter the fine water shading.
      vec3 noiseGradient(vec2 p) {
        vec2 cell = floor(p), f = fract(p);
        vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
        vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
        float a = hash(cell), b = hash(cell+vec2(1,0));
        float c = hash(cell+vec2(0,1)), d = hash(cell+vec2(1,1));
        float k = a-b-c+d;
        return vec3(a+(b-a)*u.x+(c-a)*u.y+k*u.x*u.y,
                    du.x*(b-a+k*u.y), du.y*(c-a+k*u.x));
      }

      vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

      // Simplex noise with an analytic derivative, summed in rotated, stretched
      // bands. Unlike crossing sine trains, it has no repeating diamond interference.
      vec3 simplexGradient(vec2 v) {
        const vec4 C = vec4(.211324865405187, .366025403784439,
                            -.577350269189626, .024390243902439);
        vec2 cell = floor(v+dot(v,C.yy));
        vec2 x0 = v-cell+dot(cell,C.xx);
        vec2 corner = x0.x>x0.y ? vec2(1,0) : vec2(0,1);
        vec4 x12 = x0.xyxy+C.xxzz;
        x12.xy -= corner;
        cell = mod(cell,289.0);
        vec3 p = permute(permute(cell.y+vec3(0.0,corner.y,1.0))
                                  +cell.x+vec3(0.0,corner.x,1.0));
        vec3 x = 2.0*fract(p*C.www)-1.0;
        vec3 h = abs(x)-.5;
        vec3 a = x-floor(x+.5);
        vec3 scale = 1.79284291400159-.85373472095314*(a*a+h*h);
        vec2 g0 = vec2(a.x,h.x)*scale.x;
        vec2 g1 = vec2(a.y,h.y)*scale.y;
        vec2 g2 = vec2(a.z,h.z)*scale.z;
        vec3 m = max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
        vec3 m3 = m*m*m, m4 = m3*m;
        vec3 projection = vec3(dot(g0,x0),dot(g1,x12.xy),dot(g2,x12.zw));
        vec2 gradient = m4.x*g0+m4.y*g1+m4.z*g2
                     -8.0*(m3.x*projection.x*x0+m3.y*projection.y*x12.xy+m3.z*projection.z*x12.zw);
        return 130.0*vec3(dot(m4,projection),gradient);
      }

      vec2 rippleSlope(vec2 p, float footprint) {
        // Ripple size: scale the sampling, not the amplitudes, so bigger ripples
        // are longer wavelets rather than taller ones, and the anti-aliasing
        // below keeps measuring the same ratio of footprint to wavelength.
        p /= rippleSize;
        footprint /= rippleSize;
        vec2 slope = vec2(0.0);
        for (int i=0; i<5; i++) {
          float band = float(i);
          float heading = wind*.65 + sin(band*2.39996+.6)*.55;
          vec2 direction = vec2(cos(heading),sin(heading));
          vec2 across = vec2(-direction.y,direction.x);
          float frequency = .40*pow(2.09,band);
          vec2 q = vec2(dot(p,direction),dot(p,across)*.48)*frequency;
          q += vec2(17.31,-9.17)*band + time*vec2(-.16,.043)*sqrt(frequency)*(1.0 + (wind - .35)*.8);
          vec3 detail = simplexGradient(q);
          // Keep a small, stable contribution at grazing and top-down views. At
          // 90 degrees the projected footprint can cover several world units,
          // which used to fade every ripple out and leave a perfectly flat sheet.
          // The floor preserves broad wavelets while the smooth transition still
          // anti-aliases only the finest bands.
          float antiAlias = 1.0-smoothstep(.42,1.65,frequency*footprint);
          float resolved = mix(.20, 1.0, antiAlias);
          slope += (detail.y*direction+detail.z*.48*across)
                 * (.028*pow(.86,band)*resolved);
        }
        return slope*(intensity*1.8);
      }

      void main() {
        // Screen derivatives measure sampling footprint only, never triangle normals.
        float footprint = max(length(dFdx(vSurface)), length(dFdy(vSurface)));
        vec3 swell = surface(vSurface);
        // 视距换算到旧单位，以与后续 450/1800 的雾与细节阈值同量纲。
        float distanceToEye = length(cameraPosition-vWorld) * ${LEGACY_UNITS_PER_METRE};
        float resolvedSwell = 1.0-smoothstep(450.0,1800.0,distanceToEye);
        vec2 slope = swell.yz*resolvedSwell + rippleSlope(vSurface, footprint);
        vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
        vec3 view = normalize(cameraPosition-vWorld);
        float facing = max(dot(normal, view), 0.0);
        float fresnel = .020 + .98*pow(1.0-facing, 5.0);
        vec2 position = vSurface;
        // Long, slow color changes in the water column, independent of wave detail.
        // Use simplex rather than axis-aligned value cells; large cells read as
        // square patches when the camera looks straight down.
        float shoal = simplexGradient(position*.0032+vec2(4.5,9.1)).x*.5+.5;
        float depthChange = smoothstep(.27,.79,shoal);
        vec3 bodyColor = mix(deepColor,shallowColor,depthChange*.65);
        float shadow = simplexGradient(position*.0017+vec2(18.2,time*.002)).x*.5+.5;
        bodyColor *= mix(.75,1.07,shadow);

        // The water samples the exact sky dome, so cloud banks and sun share direction.
        vec3 reflected = reflect(-view, normal);
        vec3 skyReflection = skyColor(reflected);
        // Looking straight down collapses the reflected ray to nearly one sky
        // direction for every fragment. Project a broad cloud field onto the
        // water in that view so the aerial reflection remains visibly varied.
        vec2 projectedUv = position*.00135 + vec2(time*.0016, -time*.001);
        // A smooth projected field avoids exposing the square cells of sky FBM
        // when the reflected ray collapses to one direction in a top view.
        float projectedBroad = .5+.5*sin(projectedUv.x*.34
          +sin(projectedUv.y*.23)*1.7+sin(dot(projectedUv,vec2(.13,.19)))*.8);
        float projectedDetail = .5+.5*sin(projectedUv.x*1.1+projectedUv.y*.47
          +sin(projectedUv.y*.63)*1.2+time*.016);
        float projectedCloud = projectedBroad*.72 + projectedDetail*.28;
        vec3 projectedSky = mix(mix(skyLinear(vec3(.12,.28,.49)),skyLinear(vec3(.30,.13,.20)),sunset),
                                mix(skyLinear(vec3(.86,.90,.92)),skyLinear(vec3(1.0,.58,.30)),sunset),
                                smoothstep(.34,.68,projectedCloud));
        float topView = smoothstep(.70,.98,facing);
        // At a true aerial angle the view footprint suppresses the geometric
        // swell. Add one continuous, low-frequency simplex slope so the broad
        // wave direction remains readable without reintroducing a grid pattern.
        vec3 aerialSlopeNoise = simplexGradient(position*.005 + vec2(6.7,time*.004));
        vec2 aerialSlope = aerialSlopeNoise.yz * (.115 * topView * intensity);
        slope += aerialSlope;
        normal = normalize(vec3(-slope.x, 1.0, -slope.y));
        facing = max(dot(normal, view), 0.0);
        topView = smoothstep(.70,.98,facing);
        skyReflection = mix(skyReflection, projectedSky, topView);
        skyReflection=mix(skyReflection,skyHorizonHaze(),
                          smoothstep(180.0,1200.0,distanceToEye)*.9);
        // Everything above the water, mirrored onto it by the host's mirror
        // pass: the bridge deck, its towers and the car. The lookup is offset by
        // the same wave slope that drives the sky reflection, so the mirrored
        // structure breaks up across the ripples instead of sitting on glass.
        // Alpha carries the mirror pass coverage; where nothing above the water
        // was drawn the exact sky reflection above stays in place.
        if (reflectionStrength > 0.001) {
          vec4 mirror = reflectionMatrix * vec4(vWorld, 1.0);
          // reflectionMatrix already carries the clip to UV bias, so the
          // perspective divide is the whole conversion. Applying the bias a
          // second time squeezed every lookup towards the middle of the mirror
          // texture where nothing lined up with the geometry.
          vec2 mirrorUv = mirror.xy / max(mirror.w, 1e-4 / ${LEGACY_UNITS_PER_METRE});
          mirrorUv += slope * .07;
          mirrorUv = clamp(mirrorUv, vec2(0.002), vec2(0.998));
          vec4 mirrored = texture2D(reflectionMap, mirrorUv);
          float coverage = clamp(mirrored.a * reflectionStrength, 0.0, 1.0);
          // Ripples scatter the reflection: less of it survives where the
          // surface tilts away, which is what keeps it from looking painted on.
          float broken = 1.0 - clamp(length(slope) * 2.2, 0.0, .45);
          skyReflection = mix(skyReflection, mirrored.rgb, coverage * broken);
        }
        // Aerial water still carries a readable sky tint when viewed straight
        // down. Keep this broad environmental reflection restrained so it reads
        // as water colour rather than a polished glass surface.
        float topSky = mix(.28, .16, smoothstep(.0, 1.0, facing));
        float reflectionWeight = clamp(topSky + fresnel*.35, .10, .44);
        vec3 color = mix(bodyColor,skyReflection,reflectionWeight);
        float slopeLight = dot(normal,sunDirection());
        color *= .70 + max(slopeLight,0.0)*.43;
        // Readable wavelets for aerial views: use the analytic slope magnitude
        // as a soft crest mask, avoiding the faceted/diamond pattern of grid
        // normals while keeping the water visibly rippled at 90 degrees.
        float crest = smoothstep(.009, .035, length(slope));
        color += mix(vec3(.08,.11,.095),vec3(.16,.07,.03),sunset) * crest * topView;
        // Aerial views need a readable direction field after the projected
        // reflection is averaged by the nearly orthographic footprint. This
        // warped single-band signal is continuous, avoids crossed-grid diamonds,
        // and is used only as a subtle value modulation of the water.
        float aerialRipple = .5 + .5*sin(dot(position,vec2(.0123,.0067))
          + sin(dot(position,vec2(.0031,.0147)))*1.6 + time*.18);
        color *= 1.0 + (aerialRipple-.5)*.24*topView*intensity;

        vec3 halfDirection = normalize(sunDirection()+view);
        float highlight = max(dot(normal, halfDirection), 0.0);
        float unresolved = smoothstep(.15, 1.0, footprint);
        float silver = pow(highlight, mix(1900.0,400.0,unresolved));
        float reflection = pow(highlight, 135.0);
        color += vec3(.93,.97,1.0)*(silver*.62+reflection*.07);
        float haze = 1.0-exp(-max(distanceToEye-120.0,0.0)*.0005);
        // At a near-vertical aerial view the camera is intentionally far from
        // the water plane. Atmospheric haze must not flatten the entire top
        // view into one grey card; keep only a small far-distance veil there.
        haze *= 1.0 - topView*.88;
        vec3 veil = mix(hazeColor, skyHorizonHaze(), sunset*.85);
        color = mix(color,veil,min(haze,.96));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
}
