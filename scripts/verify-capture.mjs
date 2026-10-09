/**
 * 拍照 / 录像专项回归:
 *  - 拍照:云台取景出 PNG(尺寸=画布尺寸)、UI 出缩略图与计数、事件日志、自动下载且 PNG 魔数正确;
 *  - 轨道视角下拍的照片必须与屏幕上的观察者画面不同(证明拍的是云台取景而非屏幕截图);
 *  - 机载视角下拍的照片与屏幕画面一致(同一取景);
 *  - 录像:开始→REC 徽标与计时;停止→自动下载 webm(EBML 魔数)并写事件日志;
 *    仿真侧主动停录(重置)也要收尾。
 *
 * 用法:node scripts/verify-capture.mjs [url](默认 http://127.0.0.1:15186/dji)
 * 前置:先构建并用 vite preview 起产物服务;context 必须 acceptDownloads 才能收到下载。
 * 坑:比对照片与屏幕画面前,要先临时隐藏盖在画布上的 UI 覆盖层,否则比的是 UI。
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

delete process.env.HTTP_PROXY
delete process.env.HTTPS_PROXY
delete process.env.http_proxy
delete process.env.https_proxy

const URL = process.argv[2] ?? 'http://127.0.0.1:15186/dji'
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    console.log(`PASS │ ${name}${detail ? ' │ ' + detail : ''}`)
  } else {
    fail += 1
    console.log(`FAIL │ ${name}${detail ? ' │ ' + detail : ''}`)
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, acceptDownloads: true })
const page = await context.newPage()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
const downloads = []
page.on('download', async (download) => {
  try {
    const path = await download.path()
    const buffer = path ? fs.readFileSync(path) : Buffer.alloc(0)
    downloads.push({ name: download.suggestedFilename(), size: buffer.length, head: buffer.subarray(0, 4) })
  } catch (error) {
    downloads.push({ name: download.suggestedFilename(), size: 0, head: Buffer.alloc(0), error: String(error) })
  }
})

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction('window.__djiDebug?.fly?.rig', undefined, { timeout: 120000 })
// 先展开机臂(armFold→0),否则云台取景会被折叠的桨叶挡住
await page.evaluate(() => window.__djiDebug.fly.setArmFoldTarget(0))
await page.waitForFunction('window.__djiDebug.fly.rig.armFold < 0.02', undefined, { timeout: 30000 })
await page.waitForTimeout(1200)

const canvasSize = await page.evaluate(() => {
  const canvas = window.__djiDebug.game.renderer.domElement
  return { width: canvas.width, height: canvas.height }
})

// ——— 拍照(观察者视角,应拍到云台取景) ———
await page.waitForTimeout(600)
const before = await page.evaluate(() => window.__djiDebug.fly.sim.photoCount)
await page.click('[data-testid="photo-button"]')
await page.waitForSelector('[data-testid="photo-thumb"]', { timeout: 15000 })
await page.waitForTimeout(1200)

const photoState = await page.evaluate(() => ({
  count: window.__djiDebug.fly.sim.photoCount,
  note: document.querySelector('[data-testid="photo-note"]')?.textContent?.trim() ?? '',
  thumb: document.querySelector('[data-testid="photo-thumb"]')?.getAttribute('src') ?? '',
  events: window.__djiDebug.fly.sim.events.slice(0, 6).map((e) => e.text),
}))
check('拍照计数 +1', photoState.count === before + 1, `${before} → ${photoState.count}`)
check('照片为 PNG data URL', photoState.thumb.startsWith('data:image/png;base64,'), `${photoState.thumb.slice(0, 24)}…`)
check(
  '照片尺寸 = 画布尺寸',
  photoState.note.includes(`${canvasSize.width}×${canvasSize.height}`),
  `${photoState.note}`,
)
check(
  '事件日志记录拍照',
  photoState.events.some((text) => text.includes(`拍照(第 ${photoState.count} 张)`)),
  photoState.events[0] ?? '',
)

const photoDownload = downloads.find((item) => item.name.endsWith('.png'))
check('照片自动下载', Boolean(photoDownload), photoDownload ? photoDownload.name : `下载 ${downloads.length} 个`)
// PNG 魔数 89 50 4E 47:校验前两字节 0x89 0x50,并要求体积 >20KB 排除空图
check(
  '下载文件是合法 PNG',
  Boolean(photoDownload && photoDownload.size > 20_000 && photoDownload.head[0] === 0x89 && photoDownload.head[1] === 0x50),
  photoDownload ? `${photoDownload.size}B head=${photoDownload.head.toString('hex')}` : '无',
)

// 云台取景 vs 屏幕画面:观察者视角下两者应显著不同
// 参考截图前先隐藏盖在画布上的 UI(面板/暗角/快门闪光),只比纯画面
const overlaySelector = '.panel, .vignette, .stick-deck, .shutter-flash, .loading, [aria-label="Current frames per second"]'
const captureCleanScreen = async () => {
  await page.evaluate((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      el.dataset.captureHidden = '1'
      el.style.display = 'none'
    })
  }, overlaySelector)
  await page.waitForTimeout(400)
  const shot = await page.locator('canvas').screenshot()
  await page.evaluate((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      if (el.dataset.captureHidden) {
        delete el.dataset.captureHidden
        el.style.display = ''
      }
    })
  }, overlaySelector)
  await page.waitForTimeout(200)
  return shot
}

const compareWithCanvas = async (dataUrl) => {
  const canvasShot = await captureCleanScreen()
  return page.evaluate(
    async ([photo, screen]) => {
      const load = async (src) => {
        const bitmap = await createImageBitmap(await (await fetch(src)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        return ctx.getImageData(0, 0, canvas.width, canvas.height)
      }
      const a = await load(photo)
      const b = await load(screen)
      if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: true, a: [a.width, a.height], b: [b.width, b.height] }
      let sum = 0
      for (let i = 0; i < a.data.length; i += 4) {
        sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])
      }
      return { sizeMismatch: false, meanDiff: Number((sum / (a.data.length / 4) / 3).toFixed(2)) }
    },
    [dataUrl, `data:image/png;base64,${canvasShot.toString('base64')}`],
  )
}
const orbitCompare = await compareWithCanvas(photoState.thumb)
// 经验阈值 8:同取景平均像素差远小于 8,不同取景明显大于 8(下方机载用例反过来用 <8 判同一取景)
check(
  '观察者视角下照片 ≠ 屏幕画面(拍到的是云台取景)',
  !orbitCompare.sizeMismatch && orbitCompare.meanDiff > 8,
  orbitCompare.sizeMismatch ? `尺寸不一致 ${JSON.stringify(orbitCompare)}` : `平均像素差 ${orbitCompare.meanDiff}`,
)

// ——— 机载视角拍照:与屏幕画面应为同一取景 ———
await page.evaluate(() => window.__djiDebug.fly.setCameraMode('fpv'))
await page.waitForTimeout(1500)
await page.click('[data-testid="photo-button"]')
await page.waitForTimeout(1500)
const fpvPhoto = await page.evaluate(() => document.querySelector('[data-testid="photo-thumb"]')?.getAttribute('src') ?? '')
const fpvCompare = await compareWithCanvas(fpvPhoto)
check(
  '机载视角下照片 ≈ 屏幕画面(同一取景)',
  !fpvCompare.sizeMismatch && fpvCompare.meanDiff < 8,
  fpvCompare.sizeMismatch ? `尺寸不一致 ${JSON.stringify(fpvCompare)}` : `平均像素差 ${fpvCompare.meanDiff}`,
)

// ——— 录像 ———
await page.click('[data-testid="record-toggle"]')
await page.waitForTimeout(1800)
const recState = await page.evaluate(() => ({
  simRecording: window.__djiDebug.fly.sim.recording,
  engineRecording: window.__djiDebug.fly.isRecording,
  seconds: window.__djiDebug.fly.sim.recordSeconds,
  badge: document.querySelector('.badge.rec')?.textContent?.trim() ?? '',
  label: document.querySelector('[data-testid="record-toggle"]')?.textContent?.trim() ?? '',
}))
check('开始录像:仿真与引擎都进入录制', recState.simRecording && recState.engineRecording, JSON.stringify(recState))
check('HUD 出现 REC 徽标并计时', recState.badge.startsWith('REC') && recState.seconds > 0.5, `${recState.badge} · ${recState.seconds.toFixed(1)}s`)
check('按钮切为停止录像', recState.label.includes('停止录像'), recState.label)

await page.click('[data-testid="record-toggle"]')
await page.waitForTimeout(1800)
const afterRec = await page.evaluate(() => ({
  simRecording: window.__djiDebug.fly.sim.recording,
  engineRecording: window.__djiDebug.fly.isRecording,
  note: document.querySelector('[data-testid="record-note"]')?.textContent?.trim() ?? '',
  events: window.__djiDebug.fly.sim.events.slice(0, 4).map((e) => e.text),
}))
check('停止录像:状态复位', !afterRec.simRecording && !afterRec.engineRecording, JSON.stringify(afterRec))
check('事件日志记录录像结束', afterRec.events.some((text) => text.includes('录像结束')), afterRec.events[0] ?? '')
const videoDownload = downloads.find((item) => item.name.endsWith('.webm'))
check('录像自动下载', Boolean(videoDownload), videoDownload ? videoDownload.name : `下载 ${downloads.length} 个`)
// WebM 是 EBML 容器,魔数 1A 45 DF A3:校验前两字节 0x1a 0x45 并排除过小文件
check(
  '下载文件是合法 WebM(EBML 魔数)',
  Boolean(videoDownload && videoDownload.size > 2_000 && videoDownload.head[0] === 0x1a && videoDownload.head[1] === 0x45),
  videoDownload ? `${videoDownload.size}B head=${videoDownload.head.toString('hex')}` : '无',
)

// ——— 仿真侧主动停录(重置)也要收尾 ———
await page.click('[data-testid="record-toggle"]')
await page.waitForTimeout(900)
await page.evaluate(() => window.__djiDebug.fly.sim.reset())
await page.waitForTimeout(1600)
const afterReset = await page.evaluate(() => ({
  engineRecording: window.__djiDebug.fly.isRecording,
  simRecording: window.__djiDebug.fly.sim.recording,
}))
check('重置时自动收尾录像', !afterReset.engineRecording && !afterReset.simRecording, JSON.stringify(afterReset))

console.log(`\n════════ 结果:${pass}/${pass + fail} 通过 ════════`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
