import { chromium } from '@playwright/test'
const html = `<!doctype html><body style="margin:0"><div id="i" style="width:1024px;height:1024px;background:#0b0e14;display:flex;align-items:center;justify-content:center;border-radius:180px">
<svg width="820" height="820" viewBox="0 0 260 260">
<defs><linearGradient id="g" x1="0%" y1="20%" x2="100%" y2="80%"><stop offset="0%" stop-color="#3b82f6"/><stop offset="55%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#d946ef"/></linearGradient>
<filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
<ellipse cx="130" cy="130" rx="98" ry="88" fill="none" stroke="url(#g)" stroke-width="12" stroke-linecap="round" transform="rotate(-7 130 130)" filter="url(#glow)" stroke-dasharray="560 40"/>
<path d="M 108 96 L 172 130 L 108 164 Z" fill="url(#g)"/>
</svg></div></body>`
const b = await chromium.launch(); const p = await b.newPage({viewport:{width:1024,height:1024}})
await p.setContent(html); await p.waitForTimeout(200)
await p.locator('#i').screenshot({ path: 'build/icon.png' })
await b.close(); console.log('icon.png done')
