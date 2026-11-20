import { chromium } from 'playwright'
import path from 'node:path'
const OUT = path.resolve(import.meta.dirname)
const ENTRY = 'https://100.67.197.59:18444/h/dev-local-02/web-index.html?api=https%3A%2F%2F127.0.0.1%3A18787&project=proj_c1cc0f50'
const context = await chromium.launchPersistentContext('/tmp/prod-smoke/profile-20261117-062441', { headless: true, ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 }, locale: 'zh-CN', permissions: ['clipboard-read','clipboard-write'], args: ['--no-sandbox'] })
const page = context.pages()[0] ?? await context.newPage()
const logs = []
page.on('console', m => logs.length < 120 && logs.push(`${m.type()}: ${m.text().slice(0,400)}`))
page.on('pageerror', e => logs.push(`pageerror: ${e.message}`))
page.on('requestfailed', r => logs.push(`reqfail: ${r.url().slice(0,160)} ${r.failure()?.errorText}`))
await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(2000)
if (await page.locator('#web-cloud-api-url').isVisible().catch(() => false)) {
  await page.locator('#web-cloud-api-url').fill('https://127.0.0.1:18787')
  await page.locator('#web-cloud-username').fill('zhangsan')
  await page.locator('#web-cloud-password').fill('Passw0rd!')
  await page.locator('button[type="submit"]').click()
}
await page.waitForTimeout(25000)
const state = await page.evaluate(() => ({ body: document.body.innerText.slice(0,1200), hasApp: !!document.querySelector('.app-layout'), formDisabled: document.querySelector('button[type="submit"]')?.disabled, html: document.querySelector('form')?.innerText.slice(0,400) }))
await page.screenshot({ path: path.join(OUT, 'screenshots', 'probe-signin.png') })
console.log(JSON.stringify({ state, logs }, null, 2))
await context.close()
