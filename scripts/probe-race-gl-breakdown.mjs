/**
 * /race 载入期 WebGL 调用剖析 —— 把"原生 GL 时间"拆开:着色器编译/链接 vs 纹理上传 vs 绘制。
 *
 * 背景:CDP CPU 采样里大头是 `(program)`(原生帧统称),它既可能是着色器编译、也可能是
 * 纹理上传、也可能是软件光栅化(无头 GPU 下 drawElements 是 CPU 干的)。不拆开就无法
 * 判断"卡顿"到底是不是 shader 编译引起的。本脚本在页面脚本之前 hook WebGL2 上下文方法,
 * 逐项累计耗时与调用次数。
 *
 * 用法:node scripts/probe-race-gl-breakdown.mjs [baseUrl] [等待毫秒]
 */
import { chromium } from 'playwright'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const BASE = (process.argv[2] ?? 'http://127.0.0.1:15176').replace(/\/+$/, '')
const WAIT = Number(process.argv[3] ?? 22000)

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })

await page.addInitScript(() => {
  const w = window
  w.__GLPROBE__ = { calls: {}, programs: 0, extension: null, firstRenderAt: null }
  const P = w.__GLPROBE__
  const t0 = performance.now()

  const patch = (proto) => {
    if (!proto) return
    /** 包一层:统一计数,timeIt=true 时额外计入累计/最大耗时(只调用一次原函数)。 */
    const track = (name, timeIt) => {
      const original = proto[name]
      if (typeof original !== 'function') return
      proto[name] = function (...args) {
        const slot = (P.calls[name] = P.calls[name] || { n: 0, ms: 0, max: 0 })
        slot.n++
        if (name === 'createProgram') P.programs++
        if (name === 'drawElements' && P.firstRenderAt === null) {
          P.firstRenderAt = +(performance.now() - t0).toFixed(0)
        }
        if (!timeIt) return original.apply(this, args)
        const s = performance.now()
        try {
          return original.apply(this, args)
        } finally {
          const elapsed = performance.now() - s
          slot.ms += elapsed
          slot.max = Math.max(slot.max, elapsed)
        }
      }
    }
    // 可能阻塞驱动的调用(计时)
    for (const m of [
      'compileShader',
      'linkProgram',
      'getProgramInfoLog',
      'getShaderInfoLog',
      'getProgramParameter',
      'getActiveUniform',
      'getActiveAttrib',
      'getUniformLocation',
      'texImage2D',
      'texSubImage2D',
    ]) {
      track(m, true)
    }
    // 纯计数
    for (const m of ['createProgram']) {
      track(m, false)
    }
    // 绘制调用也计时:无头环境是软件光栅化(drawElements 本身就是 CPU 干的),
    // 不把它单列出来,就没法和"着色器编译"区分开,容易把"软渲染慢"误判成"编译慢"。
    for (const m of ['drawElements', 'drawArrays', 'drawElementsInstanced']) {
      track(m, true)
    }
  }

  patch(w.WebGL2RenderingContext?.prototype)
  patch(w.WebGLRenderingContext?.prototype)

  // 并行着色器编译扩展是否可用(决定 compileAsync 能否真正并行)
  const probeExt = () => {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return 'no-webgl'
    return gl.getExtension('KHR_parallel_shader_compile') ? 'available' : 'unavailable'
  }
  P.extension = probeExt()
})

const t0 = Date.now()
await page.goto(`${BASE}/race`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(WAIT)
const probe = await page.evaluate(() => window.__GLPROBE__)
console.log(`采样窗口: ${Date.now() - t0} ms`)
console.log(`KHR_parallel_shader_compile: ${probe.extension}`)
console.log(`首次真实绘制(drawElements): ${probe.firstRenderAt} ms`)
console.log(`创建的 WebGL program 总数: ${probe.programs}\n`)

const rows = Object.entries(probe.calls).sort((a, b) => b[1].ms - a[1].ms)
console.log('──── 按累计耗时排序 ────')
console.log('   次数        累计ms     单次最大ms   调用')
for (const [name, s] of rows) {
  console.log(
    `  ${String(s.n).padStart(8)}  ${String(Math.round(s.ms)).padStart(9)}  ${String(Math.round(s.max)).padStart(10)}   ${name}`,
  )
}

const compileMs = (probe.calls.compileShader?.ms ?? 0) + (probe.calls.linkProgram?.ms ?? 0)
const queryMs =
  (probe.calls.getProgramInfoLog?.ms ?? 0) +
  (probe.calls.getShaderInfoLog?.ms ?? 0) +
  (probe.calls.getProgramParameter?.ms ?? 0) +
  (probe.calls.getActiveUniform?.ms ?? 0) +
  (probe.calls.getActiveAttrib?.ms ?? 0) +
  (probe.calls.getUniformLocation?.ms ?? 0)
const texMs = (probe.calls.texImage2D?.ms ?? 0) + (probe.calls.texSubImage2D?.ms ?? 0)
const drawMs =
  (probe.calls.drawElements?.ms ?? 0) +
  (probe.calls.drawArrays?.ms ?? 0) +
  (probe.calls.drawElementsInstanced?.ms ?? 0)
const draws = probe.calls.drawElements?.n ?? 0

console.log('\n──── 归类汇总 ────')
console.log(`  着色器编译+链接(compileShader+linkProgram)  ${Math.round(compileMs)} ms`)
console.log(`  程序/着色器查询(getXxxInfoLog/getProgramParameter/getActive*)  ${Math.round(queryMs)} ms`)
console.log(`  纹理上传(texImage2D/texSubImage2D)          ${Math.round(texMs)} ms`)
console.log(`  绘制提交(drawElements/drawArrays)           ${Math.round(drawMs)} ms   (${draws} 次)`)
console.log('')
console.log(`  ⚠️ 判断依据:无头 Chromium 走软件光栅化,「绘制提交」里含着真实的逐像素光栅化`)
console.log(`     开销。若它远大于前三项,说明这里的墙钟时间主要由"软渲染慢"决定,`)
console.log(`     与真机 GPU 无关 —— 这种情况下应看着色器查询那一项,而不是总时长。`)

await browser.close()
