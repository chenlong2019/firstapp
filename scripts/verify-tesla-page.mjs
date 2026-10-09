/**
 * /tesla 页面的运行验证脚本(一次性,留档:与 scripts/verify-race-page.mjs 同一惯例,重跑需 dev server 已在 15176 端口)。
 *
 * 做四件事:
 * 1. 打开页面,等模型真正载入完成(用顶栏状态文案作为信号,而不是等固定时长);
 * 2. 截图默认状态(3/4 机位);
 * 3. 通过真实交互点按"全部打开""全部点亮",再把转向 / 车速滑块推到值上;
 * 4. 等灯光渐变与车轮滚动跑一会儿,截第二张图,并报告控制台错误。
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:15176'
const OUT = 'D:/learnProject/firstapp/.verify-shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

await page.goto(`${BASE}/tesla`, { waitUntil: 'domcontentloaded' })

// 等载入完成:就绪后顶栏 meta 会变成 "5 机位 · 4 门 · 4 灯组"
await page.waitForFunction(
  () => document.querySelector('.top-meta')?.textContent?.includes('机位') ?? false,
  { timeout: 120000 },
)
// 再多给一帧渲染时间,避免截到还没上色的画面
await page.waitForTimeout(1200)
await page.screenshot({ path: `${OUT}/tesla_01_default.png` })
console.log('shot 1: 默认 3/4 视角')

// 模型信息回读(尺寸 / 轮胎半径 / 帧率都在面板里)
const info = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.info-grid div')].map((div) => [
    div.querySelector('dt')?.textContent?.trim(),
    div.querySelector('dd')?.textContent?.trim(),
  ])
  return Object.fromEntries(rows)
})
console.log('模型信息:', JSON.stringify(info))

// 真实交互:四门全开 + 全部点亮 + 前后门按钮点一遍
const openAll = page.getByRole('button', { name: '全部打开' })
console.log('「全部打开」按钮数量:', await openAll.count())
await openAll.click()
await page.getByRole('button', { name: '全部点亮' }).click()
await page.waitForTimeout(300)
console.log('点击后门滑块读数:',
  await page.locator('.slider-row strong').first().textContent())

const sliders = page.locator('input[type=range]')
const sliderCount = await sliders.count()
console.log('滑块数量:', sliderCount)

// 顺序:4 个门 → 后视镜 → 转向 → 车速 → 亮度
await sliders.nth(4).fill('1') // 后视镜全折
await sliders.nth(5).fill('22') // 前轮左转 22°
await sliders.nth(6).fill('16') // 车速 16 m/s
await sliders.nth(7).fill('1.6') // 灯光亮度 1.6×

// 等灯光渐变 + 车轮滚动,再截第二张
await page.waitForTimeout(2000)
await page.screenshot({ path: `${OUT}/tesla_02_open_lights.png` })
console.log('shot 2: 开门 + 灯亮 + 转向 + 行驶')

// 换到"侧"机位补一张:这个角度最容易看出门是真的开了、车轮真的转了
await page.getByRole('button', { name: '侧', exact: true }).click()
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/tesla_03_side.png` })
console.log('shot 3: 侧视角')

// 面板读数回读,确认状态确实写进去了
const readback = await page.evaluate(() => {
  const values = [...document.querySelectorAll('.slider-row strong')].map((el) => el.textContent.trim())
  const lamps = [...document.querySelectorAll('.toggle-row')].map((row) => ({
    label: row.querySelector('span')?.textContent?.replace(/\s+/g, ' ').trim(),
    on: row.querySelector('.segmented button.active')?.textContent?.trim(),
  }))
  return { values, lamps }
})
console.log('面板滑块读数:', JSON.stringify(readback.values))
console.log('灯光开关状态:', JSON.stringify(readback.lamps))

console.log('控制台错误:', errors.length ? JSON.stringify(errors, null, 2) : '无')
await browser.close()
