import { chromium } from 'playwright'
const url = 'https://100.67.197.59:18444/h/dev-local-02/web-index.html'
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => { if (logs.length < 200) logs.push(`${m.type()}: ${m.text().slice(0,300)}`) })
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
console.log('status', resp?.status(), 'url', page.url())
await page.waitForTimeout(8000)
console.log('title', await page.title())
console.log('body', (await page.evaluate(() => document.body.innerText)).slice(0, 2000))
console.log('inputs', await page.evaluate(() => [...document.querySelectorAll('input,button,form')].slice(0,40).map(e => `${e.tagName} id=${e.id} type=${e.type} aria=${e.getAttribute('aria-label')} text=${(e.innerText||'').slice(0,40)}`)))
await page.screenshot({ path: '/tmp/prod-smoke/recon.png' })
console.log('logs', JSON.stringify(logs.slice(0,40), null, 1))
await browser.close()
