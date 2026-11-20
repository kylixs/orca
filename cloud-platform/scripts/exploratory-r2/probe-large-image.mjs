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
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.fill('#username', 'admin')
await page.fill('#password', 'Adm1n!')
await page.click('button:has-text("登录")')
await page.waitForSelector('text=demo-app')
const fr = () => page.frames().find((f) => f.url().includes('/cloud-admin.html'))
await page
  .locator('tr', { hasText: 'demo-app' })
  .getByRole('button', { name: '打开', exact: true })
  .click()
await page.locator('#workspaceOverlay iframe').waitFor()
await sleep(7000)
await fr().evaluate(() =>
  document.querySelector('[data-testid="cloud-workspace-file-tree-node-docs"]')?.click()
)
await sleep(500)
await fr().evaluate(() =>
  document.querySelector('[data-testid="cloud-workspace-file-tree-node-docs/r2-fixtures"]')?.click()
)
await sleep(500)
const t0 = Date.now()
await fr().evaluate(() =>
  document
    .querySelector(
      '[data-testid="cloud-workspace-file-tree-node-docs/r2-fixtures/r2-large-image.png"]'
    )
    ?.click()
)
await fr()
  .locator('[data-testid="cloud-workspace-preview-image"]:visible')
  .waitFor({ timeout: 30000 })
const info = await fr()
  .locator('[data-testid="cloud-workspace-preview-image"]:visible')
  .evaluate((el) => ({
    nw: el.naturalWidth,
    nh: el.naturalHeight,
    srcLen: el.getAttribute('src')?.length
  }))
await page.screenshot({ path: path.join(SHOTS, 'r2-27-large-image.png') })
console.log(JSON.stringify({ loadMs: Date.now() - t0, ...info }))
await browser.close()
