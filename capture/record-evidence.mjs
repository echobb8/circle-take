/**
 * One-shot capture: the evidence-click beat for the launch video.
 * Village → flagged take → gate panel → click an evidence chip → the player
 * seeks to the failing frame (timecode + scrub jump). ~7s recording.
 */
import { chromium } from '@playwright/test'
import { execFileSync } from 'child_process'
import { createServer } from 'http'
import { readFile, rm } from 'fs/promises'
import { extname, join, resolve, normalize } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const DIST = join(ROOT, 'out', 'renderer')
const OUT = join(ROOT, 'capture', 'recordings')
const W = 1600
const H = 1000
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

const server = createServer(async (req, res) => {
  let p = normalize(new URL(req.url, 'http://x').pathname)
  if (p === '/' || p === '\\') p = '/index.html'
  const file = join(DIST, p)
  if (!file.startsWith(DIST)) return void res.writeHead(403).end()
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(await readFile(file))
  } catch { res.writeHead(404).end() }
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const port = server.address().port

const browser = await chromium.launch()
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
  colorScheme: 'dark',
})
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:${port}/index.html?mock=1`)
await page.waitForSelector('.rail-btn', { timeout: 15000 })
await page.waitForTimeout(900)

// open the Stroll shot, pick a take that has evidence chips
await page.evaluate(() => {
  const card = [...document.querySelectorAll('[class*="shot-card"], .bin-card')].find((c) =>
    c.textContent.includes('Stroll'))
  if (card) card.click()
})
await page.waitForTimeout(900)

// walk takes (ArrowDown) until an evidence chip is visible in the gate panel
for (let i = 0; i < 4; i++) {
  if (await page.locator('.evidence-chip').count()) break
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(650)
}
const chips = page.locator('.evidence-chip')
const n = await chips.count()
if (!n) {
  console.error('no evidence chips found — aborting')
  process.exit(1)
}
await page.waitForTimeout(900)
// hover then click the first evidence chip → player seeks to the failing frame
const chip = chips.first()
await chip.hover()
await page.waitForTimeout(700)
await chip.click()
await page.waitForTimeout(1400)
// click a second one if present, for a double beat
if (n > 1) {
  await chips.nth(1).hover()
  await page.waitForTimeout(500)
  await chips.nth(1).click()
  await page.waitForTimeout(1400)
}
await page.waitForTimeout(600)

const video = page.video()
await ctx.close()
const webm = await video.path()
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', webm, '-c:v', 'libx264', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-r', '30', join(OUT, 'evidence-click.mp4')])
await rm(webm, { force: true })
await browser.close()
server.close()
console.log('✓ evidence-click.mp4')
