#!/usr/bin/env node
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
const BASE = 'https://127.0.0.1:18787'
const SHOTS = path.resolve('cloud-platform/evidence/exploratory-r2/screenshots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
const events = []
page.on('console', (m) => {
  if (m.type() === 'error') events.push({ kind: 'console', text: m.text().slice(0, 200) })
})
page.on('dialog', (d) => d.accept())
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.fill('#username', 'admin')
await page.fill('#password', 'Adm1n!')
await page.click('button:has-text("登录")')
await page.waitForSelector('text=demo-app')
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
async function openDemo() {
  await page
    .locator('tr', { hasText: 'demo-app' })
    .getByRole('button', { name: '打开', exact: true })
    .click()
  await page.locator('#workspaceOverlay iframe').waitFor()
}
await openDemo()
await sleep(7000)
console.log(
  'first ready',
  await page.evaluate(
    () => document.querySelector('#workspaceOverlay [data-workspace-route]')?.textContent
  )
)
await page.locator('#workspaceOverlay [data-workspace-close]').click()
await sleep(1200)
await openDemo()
await sleep(9000)
const state = await page.evaluate(() => {
  const o = document.querySelector('#workspaceOverlay')
  return {
    bar: o?.querySelector('.workspace-bar')?.innerText ?? '',
    iframe: !!o?.querySelector('iframe'),
    status: o?.querySelector('[data-workspace-status]')?.innerText ?? '',
    failure: o?.querySelector('[data-workspace-ready-failure]')?.innerText?.slice(0, 120) ?? ''
  }
})
const f = fr()
const frameBody = f ? await f.evaluate(() => document.body.innerText.slice(0, 300)) : null
const storage = f ? await f.evaluate(() => Object.keys(localStorage)) : null
await page.screenshot({ path: path.join(SHOTS, 'r2-28-reentry-not-signed-in.png') })
console.log(
  JSON.stringify(
    { state, frameBody, frameUrl: f?.url() ?? null, storage, events: events.slice(-6) },
    null,
    2
  )
)
await browser.close()
