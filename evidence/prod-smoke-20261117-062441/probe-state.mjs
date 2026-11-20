import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
const OUT = path.resolve(import.meta.dirname)
const ENTRY = 'https://100.67.197.59:18444/h/dev-local-02/web-index.html?api=https%3A%2F%2F127.0.0.1%3A18787&project=proj_c1cc0f50'
const context = await chromium.launchPersistentContext('/tmp/prod-smoke/profile-20261117-062441', { headless: true, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 }, locale: 'zh-CN', permissions: ['clipboard-read','clipboard-write'], args: ['--no-sandbox'] })
const page = context.pages()[0] ?? await context.newPage()
const logs = []
page.on('console', m => logs.length < 100 && logs.push(`${m.type()}: ${m.text().slice(0,300)}`))
page.on('pageerror', e => logs.push(`pageerror: ${e.message}`))
await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(20000)
const state = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0,1500), hasApp: !!document.querySelector('.app-layout'), hasForm: !!document.querySelector('#web-cloud-api-url'), localStorage: Object.fromEntries(Object.entries(localStorage).map(([k,v]) => [k, String(v).slice(0,200)])) }))
await page.screenshot({ path: path.join(OUT, 'screenshots', 'probe-state.png') })
console.log(JSON.stringify({ state, logs }, null, 2))
await context.close()
