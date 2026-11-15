#!/usr/bin/env node
import { chromium } from 'playwright'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const SHOTS = path.resolve('cloud-platform/evidence/exploratory-r2/screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } })
const page = await context.newPage()
const events = []
page.on('console', (m) => events.push({ t: Date.now(), kind: 'console', type: m.type(), text: m.text().slice(0, 300) }))
page.on('pageerror', (e) => events.push({ t: Date.now(), kind: 'pageerror', text: e.message }))
page.on('requestfailed', (r) => events.push({ t: Date.now(), kind: 'requestfailed', url: r.url(), error: r.failure()?.errorText }))
page.on('response', (r) => { if (r.status() >= 400 || r.url().includes('handoff') || r.url().includes('cloud-admin')) events.push({ t: Date.now(), kind: 'response', status: r.status(), url: r.url().slice(0, 180) }) })

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
if (await page.locator('#username').count()) {
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('button:has-text("登录")')
}
await page.waitForSelector('text=infra-tools')
await page.locator('tr', { hasText: 'infra-tools' }).getByRole('button', { name: '打开', exact: true }).click()
const start = Date.now()
for (const at of [2000, 5000, 9000, 14000, 19000]) {
  await sleep(at - (Date.now() - start))
  const info = await page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    const iframe = o?.querySelector('iframe')
    return {
      overlay: !!o,
      iframe: !!iframe,
      src: iframe?.src ?? '',
      bar: o?.querySelector('.workspace-bar')?.innerText ?? '',
      body: o?.querySelector('.workspace-body')?.innerText?.slice(0, 300) ?? ''
    }
  })
  const frameUrls = page.frames().map((f) => f.url())
  console.log(at, JSON.stringify(info), JSON.stringify(frameUrls))
  await page.screenshot({ path: path.join(SHOTS, `probe-host2-${at}.png`) })
}
// try to read the iframe document even cross-origin via Playwright frame handle
const f = page.frames().find((x) => x.url().includes('cloud-admin'))
if (f) {
  console.log('cloud-admin frame body:', (await f.evaluate(() => document.body.innerText)).slice(0, 800))
  console.log('cloud-admin frame html:', (await f.content()).slice(0, 400))
}
console.log('events', JSON.stringify(events.slice(-40), null, 2))
await browser.close()
