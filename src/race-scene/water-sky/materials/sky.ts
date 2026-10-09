/**
 * 天空材质与共享天空 GLSL（water-sky/materials）。
 * 天空颜色按观察方向解析求解：高度渐变、云层 FBM、太阳光斑与地平线雾，日间/日落由 sunset 混合。
 * 对外导出 SKY_SUN_DIRECTION、sunDirectionFor、skyDirectionGLSL、skyColorGLSL 与 createSkyMaterial；
 * 两段 GLSL 被水面材质复用，因此天空与水面共享同一太阳方向与云层。约定：GLSL 返回线性色，
 * 由渲染器的 tonemapping/colorspace 处理。
 */
import * as THREE from 'three'

/** Shared direction used by the sky, sun light and water reflection. */
export const SKY_SUN_DIRECTION = new THREE.Vector3(0.3, 0.58, -0.76).normalize()

/**
 * Where the sun sits for a given height. The shader clamps the low end, so this
 * does too: the shadow camera has to agree with the sky it is lighting, and a
 * shadow cast by a sun the sky does not have is worse than no shadow.
 */
export function sunDirectionFor(sunHeight: number): THREE.Vector3 {
  return new THREE.Vector3(0.3, Math.max(0.12, sunHeight), -0.76).normalize()
}

// Shared include for the water shader. Both materials therefore agree on the
// angular sky, cloud banks and the sun's location. Values returned here are
// linear and are tone-mapped by the renderer along with the sky material.
export const skyDirectionGLSL = /* glsl */ `
  vec3 sunDirection() { return normalize(vec3(.30, max(.12, sunHeight), -.76)); }
`
/** 天空颜色 GLSL 片段（含 sunDirection/skyColor/skyHorizonHaze）：被水面材质直接 include 复用。 */
export const skyColorGLSL = /* glsl */ `
  uniform float time;
  uniform float cloudDensity;
  uniform float sunHeight;
  uniform float sunset;
  ${skyDirectionGLSL}
  float skyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  float skyNoise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    float a=skyHash(i), b=skyHash(i+vec2(1,0)), c=skyHash(i+vec2(0,1)), d=skyHash(i+vec2(1,1));
    return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
  }
  float skyFbm(vec2 p) {
    float n=0.0, amplitude=.50;
    mat2 rotation=mat2(.8,-.6,.6,.8);
    for(int octave=0;octave<7;octave++) {
      n+=skyNoise(p)*amplitude;
      p=rotation*p*2.07+vec2(12.7,8.9);
      amplitude*=.49;
    }
    return n/ .973;
  }
  vec3 skyLinear(vec3 srgb) { return pow(max(srgb,vec3(0.0)),vec3(2.2)); }
  /** The colour the horizon fades into: neutral by day, warm at sunset. */
  vec3 skyHorizonHaze() {
    return mix(skyLinear(vec3(.65,.71,.74)), skyLinear(vec3(1.0,.44,.19)), sunset);
  }
  vec3 skyColor(vec3 d) {
    d=normalize(d);
    float height=max(d.y,0.0);
    // Sunset: the gradient warms from the horizon up, and the warm band reaches
    // higher because the sun is low and the glow spreads.
    vec3 horizonColor=mix(skyLinear(vec3(.66,.72,.78)),skyLinear(vec3(1.0,.40,.14)),sunset);
    vec3 zenithColor=mix(skyLinear(vec3(.19,.40,.62)),skyLinear(vec3(.13,.11,.30)),sunset);
    vec3 col=mix(horizonColor,zenithColor,smoothstep(.015,mix(.70,.34,sunset),height));
    vec3 sd=sunDirection();
    float alignment=max(dot(d,sd),0.0);
    float angularX=atan(d.x,-d.z);
    float angularY=asin(clamp(d.y,-1.0,1.0));
    // Project onto a cloud deck. Angular sampling makes distant clouds compress
    // naturally into a layered horizon; no flat background plane is used.
    // +.16 防止贴近地平线时高度除零；按角度采样让远处云自然压成层状地平线。
    vec2 p=d.xz/(height+.16)*1.3+vec2(time*.0016,-time*.001);
    float broad=skyFbm(p*1.55+vec2(1.7,8.3));
    float detail=skyFbm(p*10.5+vec2(13.1,3.7));
    float blueOpening=exp(-pow((angularX+.12)/.51,2.0)-pow((angularY-.47)/.30,2.0));
    float density=broad*.82+detail*.18-blueOpening*.21+.045;
    density+=smoothstep(.58,1.12,angularY)*.12;
    float mask=smoothstep(.47,.58,density+(cloudDensity-.58)*.31);
    mask*=smoothstep(.01,.085,height);
    float shaded=skyFbm(p*1.55+vec2(1.86,8.42));
    float relief=clamp(.35+(broad-shaded)*4.0+detail*.30
                      +smoothstep(.49,.66,density)*.30,0.0,1.0);
    // Clouds at sunset: dark undersides, and the parts facing the sun glow
    // orange. The rim term gets both stronger and wider, which is what makes a
    // cloud bank read as lit from below instead of just recoloured.
    vec3 cloudShade=mix(skyLinear(vec3(.51,.57,.65)),skyLinear(vec3(.19,.10,.15)),sunset);
    vec3 cloudLit=mix(skyLinear(vec3(.94,.95,.97)),skyLinear(vec3(1.0,.44,.13)),sunset);
    vec3 cloud=mix(cloudShade,cloudLit,relief);
    cloud+=mix(vec3(.18),vec3(.85,.30,.07),sunset)*pow(alignment,mix(12.0,4.0,sunset));
    col=mix(col,cloud,mask);
    float haze=exp(-height*28.0);
    vec3 hazeTint=mix(skyLinear(vec3(.68,.74,.78)),skyLinear(vec3(1.0,.45,.20)),sunset);
    col=mix(col,hazeTint,haze*.6);
    // Diffused white sunlight through the broken bank, with a compact inner glow.
    col+=mix(vec3(.42,.43,.42),vec3(1.0,.40,.11),sunset)*pow(alignment,22.0)*(1.0-mask*.36);
    col+=vec3(.60)*pow(alignment,320.0)*(1.0-mask*.24);
    col+=vec3(2.0)*pow(alignment,6000.0)*(1.0-mask*.70);
    return col;
  }

`

const skyVertex = /* glsl */ `
  varying vec3 vSkyDir;
  void main() {
    vSkyDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const skyFragment = /* glsl */ `
  varying vec3 vSkyDir;
  ${skyColorGLSL}
  void main() {
    gl_FragColor = vec4(skyColor(normalize(vSkyDir)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** 创建天空穹顶材质：BackSide 且不写深度；uniforms 为 sunHeight/cloudDensity/sunset/time。 */
export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      sunHeight: { value: 0.58 },
      cloudDensity: { value: 0.76 },
      sunset: { value: 0 },
      time: { value: 0 },
    },
    vertexShader: skyVertex,
    fragmentShader: skyFragment,
  })
}
