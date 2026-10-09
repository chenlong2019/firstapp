/**
 * 中国结吊穗的 GPU 飘动（scenery）：向顶点着色器注入受限形变，让灯结丝线与吊穗产生
 * 微风与阻尼振荡。静止姿态是离线结算好的，运行时只做小幅度几何形变。
 * 对外导出 createKnotMotion，返回 time/strength 两个 uniform、一个 depth 材质与 apply。
 * 约定：不解析模拟、不增加 draw call、不上传实例数据；旋转量始终小于约 1.5 度。
 * 注意：着色器中引用的属性名（_tasselroot 等）与 customProgramCacheKey 版本串须与 GLB 预处理保持一致。
 */
import * as THREE from 'three'
import { LEGACY_UNITS_PER_METRE } from '../units'

/** Rest pose is gravity-settled offline. Only bounded breeze/pendulum motion runs
 * on the GPU: no per-thread simulation, extra draw calls or instance uploads. */
export function createKnotMotion() {
  const time = { value: 0 }
  const strength = { value: 1 }
  const code = /* glsl */ `
    uniform float knotTime;
    uniform float knotMotionStrength;
    attribute vec3 _tasselroot;
    attribute vec2 _tasseldata;
    attribute vec3 _pendantroot;
    float knotPhase() {
      // Instance translations are metres; the normalized GLB deformation stays local.
      return dot(instanceMatrix[3].xz * ${LEGACY_UNITS_PER_METRE}, vec2(.017, .031));
    }
    mat3 knotRotation(float x, float z) {
      float cx=cos(x), sx=sin(x), cz=cos(z), sz=sin(z);
      return mat3(cz,sz,0., -sz,cz,0., 0.,0.,1.)
        * mat3(1.,0.,0., 0.,cx,sx, 0.,-sx,cx);
    }
    mat3 knotBodyRotation() {
      float phase=knotPhase();
      // Less than 1.5 degrees. Slow breeze plus a small damped free oscillation.
      float settle=.004*exp(-knotTime*.65)*sin(knotTime*2.2);
      float x=(.006*sin(knotTime*.72+phase)+settle)*knotMotionStrength;
      float z=.005*sin(knotTime*.91+phase*1.37)*knotMotionStrength;
      return knotRotation(x,z);
    }
    vec2 knotBreeze() {
      float phase=knotPhase()+_tasseldata.y;
      return vec2(.008*sin(knotTime*.85+phase),.004*sin(knotTime*.71+phase+.4))*knotMotionStrength;
    }
    vec2 pendantSlope() {
      float phase=knotPhase()+_tasseldata.y;
      // Gold cords, bead and fringe form one hanging assembly. The mounting
      // point at the red bar is fixed; all lower junctions move together.
      float enabled=step(.01,length(_pendantroot));
      return vec2(.028*sin(knotTime*.9+phase),.02*sin(knotTime*.77+phase+.3))*enabled*knotMotionStrength;
    }
    vec2 pendantBend(vec3 p) {
      float span=max(_pendantroot.y-_tasselroot.y,.001);
      float drop=max(_pendantroot.y-p.y,0.);
      // Curved connector with zero slope at its mount. Below the bead continue
      // along its tangent, so cuff and fringe cannot separate while swaying.
      float travel=drop<span ? drop*drop/(2.*span) : drop-span*.5;
      return pendantSlope()*travel;
    }
    vec3 knotDeform(vec3 p) {
      // Each bundle has its own measured bead root. Quadratic bending fixes both
      // the root position and its tangent; the tail bends instead of rotating as
      // one rigid piece. No upper knot/bead vertex carries a nonzero weight.
      float q=_tasseldata.x;
      vec2 bend=knotBreeze()*q*q;
      p.xz+=bend;
      p.xz+=pendantBend(p);
      return knotBodyRotation()*p;
    }
    vec3 knotDeformNormal(vec3 n) {
      float q=_tasseldata.x;
      float length=max((_tasselroot.y-position.y)/max(q,.001),.001);
      vec2 derivative=-2.0*q*knotBreeze()/length;
      float span=max(_pendantroot.y-_tasselroot.y,.001);
      derivative-=pendantSlope()*clamp((_pendantroot.y-position.y)/span,0.,1.);
      n.y-=dot(derivative,n.xz);
      return knotBodyRotation()*normalize(n);
    }
  `
  const apply = (material: THREE.Material, normals: boolean) => {
    const previous = material.onBeforeCompile
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      shader.uniforms.knotTime = time
      shader.uniforms.knotMotionStrength = strength
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + code)
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\ntransformed = knotDeform(transformed);',
        )
      if (normals)
        shader.vertexShader = shader.vertexShader.replace(
          '#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\nobjectNormal = knotDeformNormal(objectNormal);',
        )
    }
    // 版本串必须随着色器改动一起更新，否则会命中旧的着色器程序缓存。
    material.customProgramCacheKey = () => `knot-pendant-motion-v4-metres-${normals}`
  }
  const depth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    side: THREE.DoubleSide,
  })
  apply(depth, false)
  return { time, strength, depth, apply }
}
