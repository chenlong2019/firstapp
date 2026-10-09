/**
 * 生成 README 配图:把 `.verify-shots/` 里选定的截图转成压缩 JPEG 存进 `docs/screenshots/`。
 *
 * 职责:仓库里不适合塞 1MB+ 的 PNG,统一转质量 82 的 JPEG(体积约为原图 1/5)。
 * 位置:项目根目录运行;产物目录 `docs/screenshots/` 随仓库提交,README 以相对路径引用。
 * 用法:node scripts/make-readme-images.mjs
 *
 * 非直觉约定:
 * - 转码用浏览器 canvas 完成(data URL 注入避免 file:// 污染画布),不引入 sharp 等原生依赖。
 * - 源图在 `.verify-shots/`(gitignore),本脚本把选中的图"固化"进仓库,删除截图目录不影响 README。
 */
import { chromium } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(PROJECT, '.verify-shots')
const OUT = join(PROJECT, 'docs', 'screenshots')
const QUALITY = 0.82

/** README 选图:源文件名 → 输出文件名。 */
const PICKS = [
  ['race-03-follow.png', 'race-follow.jpg'], // 主视觉:跨海大桥竞速
  ['race-06-fpv.png', 'race-fpv.jpg'], // 机载 FPV 视角
  ['skeleton-helper-on.png', 'glb-skeleton.jpg'], // GLB 查看器 + 骨骼动画
  ['model-formats-fbx.png', 'glb-formats.jpg'], // 多格式导入
  ['final-hover.png', 'dji-sandbox.jpg'], // DJI 沙盒 HUD 全景
  ['tesla_02_open_lights.png', 'tesla-interactive.jpg'], // Tesla 车型交互
  ['libdemo-04-glb.png', 'lib-demo.jpg'], // three-engine 库示例
]

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('about:blank')

let totalIn = 0
let totalOut = 0

for (const [srcName, outName] of PICKS) {
  const srcPath = join(SRC, srcName)
  const buf = readFileSync(srcPath)
  totalIn += buf.length
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`

  // data URL 图片不算跨源,canvas 不会被污染,toDataURL 可正常导出
  const jpeg = await page.evaluate(
    async ({ dataUrl, quality }) => {
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      return canvas.toDataURL('image/jpeg', quality)
    },
    { dataUrl, quality: QUALITY },
  )

  const outBuf = Buffer.from(jpeg.split(',')[1], 'base64')
  writeFileSync(join(OUT, outName), outBuf)
  totalOut += outBuf.length
  console.log(
    `${outName.padEnd(24)} ${srcName.padEnd(30)} ${(buf.length / 1024).toFixed(0)}KB → ${(outBuf.length / 1024).toFixed(0)}KB`,
  )
}

await browser.close()
console.log(`\n共 ${PICKS.length} 张  ${(totalIn / 1024 / 1024).toFixed(1)}MB → ${(totalOut / 1024 / 1024).toFixed(1)}MB`)
console.log(`输出目录: ${OUT}`)
