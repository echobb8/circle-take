/**
 * README screenshot rig. Serves the built renderer (mock mode = NIGHT MARKET
 * demo project with real generated footage) and captures the six tour shots
 * at 1600×1000 @2x into docs/images/.
 *
 * Usage: npm run build && node scripts/screenshots.mjs
 */
import { chromium } from '@playwright/test'
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { existsSync, mkdirSync } from 'fs'
import { extname, join, resolve, normalize } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const DIST = join(ROOT, 'out', 'renderer')
const OUT = join(ROOT, 'docs', 'images')

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('out/renderer missing — run `npm run build` first')
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let p = normalize(url.pathname)
  if (p === '/' || p === '\\') p = '/index.html'
  const file = join(DIST, p)
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const port = server.address().port

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
})
await page.goto(`http://127.0.0.1:${port}/index.html?mock=1`)
await page.waitForSelector('.rail-btn', { timeout: 15000 })
await page.waitForTimeout(600) // fonts + images settle

const room = async (name) => {
  await page.evaluate((n) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === n)
    if (!b) throw new Error(`no rail button ${n}`)
    b.click()
  }, name)
  await page.waitForTimeout(500)
}
const shoot = (file) => page.screenshot({ path: join(OUT, file) })

// 1. The Bin
await room('Bin')
await shoot('shot-bin.png')

// 2. Village — open the 4-take shot, enable compare + wipe if available
await page.evaluate(() => {
  const card = [...document.querySelectorAll('[class*="shot-card"], .bin-card')].find((c) =>
    c.textContent.includes('Stroll'),
  )
  if (card) card.click()
})
await page.waitForTimeout(700)
// pick a B-take for compare when the control exists
const compareBtn = page.locator('button', { hasText: /set as b|compare/i }).first()
if (await compareBtn.count()) {
  await compareBtn.click()
  await page.waitForTimeout(500)
}
await shoot('shot-village.png')

// 3. Report overlay (open full report when the button exists)
const reportBtn = page.locator('button', { hasText: /full report|open report/i }).first()
if (await reportBtn.count()) {
  await reportBtn.click()
  await page.waitForTimeout(600)
  await shoot('shot-report.png')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
} else {
  console.warn('report button not found — skipping shot-report')
}

// 4. Kits
await room('Kits')
await shoot('shot-kits.png')

// 5. Print
await room('Print')
await shoot('shot-print.png')

// 6. Welcome (empty boot)
await page.goto(`http://127.0.0.1:${port}/index.html?mock=1&empty=1`)
await page.waitForTimeout(800)
await shoot('shot-welcome.png')

await browser.close()
server.close()
console.log('Screenshots written to docs/images/')
