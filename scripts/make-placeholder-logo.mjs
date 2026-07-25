/** Renders a brand-matched placeholder logo until the real logo art lands. */
import { chromium } from '@playwright/test'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div id="mark" style="width:900px;height:420px;display:flex;align-items:center;justify-content:center;gap:36px;font-family:-apple-system,Helvetica,sans-serif">
  <svg width="260" height="260" viewBox="0 0 260 260">
    <defs>
      <linearGradient id="g" x1="0%" y1="20%" x2="100%" y2="80%">
        <stop offset="0%" stop-color="#3b82f6"/><stop offset="55%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#d946ef"/>
      </linearGradient>
      <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <ellipse cx="130" cy="130" rx="98" ry="88" fill="none" stroke="url(#g)" stroke-width="11" stroke-linecap="round"
      transform="rotate(-7 130 130)" filter="url(#glow)" stroke-dasharray="560 40"/>
    <ellipse cx="132" cy="127" rx="88" ry="79" fill="none" stroke="url(#g)" stroke-width="4" opacity="0.55"
      transform="rotate(-11 130 130)" stroke-dasharray="420 90"/>
    <path d="M 112 100 L 168 130 L 112 160 Z" fill="url(#g)" opacity="0.92"/>
  </svg>
  <div>
    <div style="font-size:76px;font-weight:700;letter-spacing:-1px;color:#e8ebf4">Circle <span style="background:linear-gradient(90deg,#3b82f6,#8b5cf6,#d946ef);-webkit-background-clip:text;color:transparent">Take</span></div>
    <div style="font-size:22px;letter-spacing:5px;color:#96a0b5;margin-top:10px">AI DAILIES · QUALITY GATES · SELECT · SEND</div>
  </div>
</div></body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 420 }, deviceScaleFactor: 2 })
await page.setContent(html)
await page.waitForTimeout(300)
await page.locator('#mark').screenshot({ path: join(ROOT, 'docs', 'images', 'logo.png'), omitBackground: true })
await browser.close()
console.log('placeholder logo written')
