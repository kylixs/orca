#!/usr/bin/env node
import { chromium } from 'playwright'
import path from 'node:path'
const BASE = 'https://127.0.0.1:18787'
const SHOTS = path.resolve('cloud-platform/evidence/exploratory-r2/screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
page.on('dialog', (d) => d.accept())
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
async function state() {
  return page.evaluate(() => {
    const o = document.querySelector('#workspaceOverlay')
    return {
      overlay: !!o,
      ready: o?.querySelector('[data-workspace-status]')?.hidden === true,
      failure: o?.querySelector('[data-workspace-ready-failure]')?.innerText?.slice(0, 100) ?? '',
      statusText: o?.querySelector('[data-workspace-status]')?.innerText ?? '',
      retry: !!o?.querySelector('[data-workspace-retry]'),
      iframe: !!o?.querySelector('iframe')
    }
  })
}
async function waitEnd(ms = 25000) {
  for (let i = 0; i < ms / 500; i += 1) {
    const s = await state()
    if (s.ready || s.failure) return s
    await sleep(500)
  }
  return await state()
}

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
if (await page.locator('#username').count()) {
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('button:has-text("登录")')
}
await page.waitForSelector('text=demo-app')
await page
  .locator('tr', { hasText: 'demo-app' })
  .getByRole('button', { name: '打开', exact: true })
  .click()
console.log('first', await waitEnd(30000))
await page.locator('#workspaceOverlay [data-workspace-close]').click()
await sleep(1200)
await page
  .locator('tr', { hasText: 'infra-tools' })
  .getByRole('button', { name: '打开', exact: true })
  .click()
const second = await waitEnd(25000)
console.log('second', second)
await page.screenshot({ path: path.join(SHOTS, 'probe-second-failure.png') })
if (second.retry) {
  await page.locator('#workspaceOverlay [data-workspace-retry]').click()
  const retried = await waitEnd(30000)
  console.log('retry1', retried)
  await page.screenshot({ path: path.join(SHOTS, 'probe-second-retry1.png') })
  const f = fr()
  if (f) console.log('retry body', await f.evaluate(() => document.body.innerText.slice(0, 300)))
}
await browser.close()
