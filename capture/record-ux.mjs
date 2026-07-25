/**
 * Launch-video UX capture rig (house pattern). Drives the built renderer in
 * mock mode (NIGHT MARKET demo, real generated footage) and records one video
 * per beat into capture/recordings/, plus beats.json with per-beat timings for
 * the narration pass. Playwright video (webm) → ffmpeg mp4 (crf 18).
 *
 * Usage: npm run build && node capture/record-ux.mjs
 */
import { chromium } from '@playwright/test'
import { execFileSync } from 'child_process'
import { createServer } from 'http'
import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises'
import { extname, join, resolve, normalize } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const DIST = join(ROOT, 'out', 'renderer')
const OUT = join(ROOT, 'capture', 'recordings')
const W = 1600
const H = 1000

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
}

const server = createServer(async (req, res) => {
  let p = normalize(new URL(req.url, 'http://x').pathname)
  if (p === '/' || p === '\\') p = '/index.html'
  const file = join(DIST, p)
  if (!file.startsWith(DIST)) return void res.writeHead(403).end()
  try {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const port = server.address().port
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const beats = []

/** Record one beat: fresh context+page, run fn, save as <name>.mp4. */
async function record(name, fn) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    colorScheme: 'dark',
  })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${port}/index.html?mock=1`)
  await page.waitForSelector('.rail-btn', { timeout: 15000 })
  await page.waitForTimeout(900) // fonts/images settle before action
  const t0 = Date.now()
  await fn(page)
  const durSec = (Date.now() - t0) / 1000
  const video = page.video()
  await ctx.close()
  const webm = await video.path()
  const mp4 = join(OUT, `${name}.mp4`)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', webm, '-c:v', 'libx264', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', '30', mp4])
  await rm(webm, { force: true })
  beats.push({ name, file: `${name}.mp4`, actionSec: Math.round(durSec * 10) / 10 })
  console.log(`✓ ${name} (${durSec.toFixed(1)}s of action)`)
}

const clickRail = (page, label) =>
  page.evaluate((n) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n)
    if (b) b.click()
  }, label)

const openShot = async (page, text) => {
  await page.evaluate((t) => {
    const card = [...document.querySelectorAll('[class*="shot-card"], .bin-card')].find((c) =>
      c.textContent.includes(t),
    )
    if (card) card.click()
  }, text)
  await page.waitForTimeout(800)
}

// Beat 1 — The Bin: slow hover pass over the production grid.
await record('bin-tour', async (page) => {
  await page.waitForTimeout(1200)
  for (const [x, y] of [[290, 500], [640, 500], [990, 500], [1340, 500], [640, 810]]) {
    await page.mouse.move(x, y, { steps: 24 })
    await page.waitForTimeout(650)
  }
  await page.waitForTimeout(800)
})

// Beat 2 — Circle a take: the draw-on moment (toggle off, then on, twice slow).
await record('circle-moment', async (page) => {
  await openShot(page, 'Stroll')
  await page.waitForTimeout(900)
  await page.keyboard.press('c') // un-circle (mock starts circled)
  await page.waitForTimeout(1100)
  await page.keyboard.press('c') // circle — draw-on animation
  await page.waitForTimeout(1600)
  await page.keyboard.press('c')
  await page.waitForTimeout(1000)
  await page.keyboard.press('c')
  await page.waitForTimeout(1800)
})

// Beat 3 — Wipe compare: set B, enable wipe, drag the handle across.
await record('wipe-compare', async (page) => {
  await openShot(page, 'Stroll')
  const setB = page.locator('button', { hasText: /set as b/i }).first()
  if (await setB.count()) await setB.click()
  await page.waitForTimeout(700)
  const wipe = page.locator('button', { hasText: /wipe/i }).first()
  if (await wipe.count()) await wipe.click()
  await page.waitForTimeout(700)
  // drag the wipe handle: find its element, else sweep across the stage center
  const stage = await page.evaluate(() => {
    const el = document.querySelector('[class*="wipe-handle"], [class*="wipeHandle"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  const y = stage?.y ?? 520
  const x0 = stage?.x ?? 1000
  await page.mouse.move(x0, y, { steps: 10 })
  await page.mouse.down()
  await page.mouse.move(620, y, { steps: 50 })
  await page.waitForTimeout(300)
  await page.mouse.move(1240, y, { steps: 50 })
  await page.waitForTimeout(300)
  await page.mouse.move(900, y, { steps: 30 })
  await page.mouse.up()
  await page.waitForTimeout(900)
})

// Beat 4 — Recipe diff: compare open, reveal the prompt diff panel.
await record('recipe-diff', async (page) => {
  await openShot(page, 'Stroll')
  const setB = page.locator('button', { hasText: /set as b/i }).first()
  if (await setB.count()) await setB.click()
  await page.waitForTimeout(800)
  const diff = page.locator('button, summary', { hasText: /recipe diff|diff/i }).first()
  if (await diff.count()) {
    await diff.click()
    await page.waitForTimeout(500)
    const r = await diff.boundingBox()
    if (r) await page.mouse.move(r.x, Math.min(H - 60, r.y + 160), { steps: 20 })
  }
  await page.waitForTimeout(2200)
})

// Beat 5 — Kits lineup: scroll The Crew's lineup wall.
await record('kits-lineup', async (page) => {
  await clickRail(page, 'Kits')
  await page.waitForTimeout(1200)
  await page.mouse.move(800, 500, { steps: 10 })
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(900)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(1200)
})

// Beat 6 — Print It: selects, summary cards, reshoot list scroll.
await record('print-room', async (page) => {
  await clickRail(page, 'Print')
  await page.waitForTimeout(1400)
  await page.mouse.move(1200, 500, { steps: 10 })
  await page.mouse.wheel(0, 500)
  await page.waitForTimeout(1000)
  await page.mouse.wheel(0, 500)
  await page.waitForTimeout(1200)
})

await browser.close()
server.close()
await writeFile(join(OUT, 'beats.json'), JSON.stringify(beats, null, 2))
console.log(`\n${beats.length} beats → capture/recordings/ (+ beats.json)`)
