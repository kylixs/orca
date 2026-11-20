#!/usr/bin/env node
import { chromium } from 'playwright'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
const BASE = 'https://127.0.0.1:18787'
const WT = '/Users/gongdewei/orca-local-env/host/projects/demo-app/.orca-worktrees/admin/main-2'
const SRC = path.join(WT, 'docs/r2-fixtures/r2-binary.bin')
const COPY = path.join(WT, 'docs/r2-fixtures/r2-binary-copy.bin')
const SHOTS = path.resolve('cloud-platform/evidence/exploratory-r2/screenshots')
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
fs.copyFileSync(SRC, COPY)
const before = sha(COPY)
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
await sleep(400)
await fr().evaluate(() =>
  document.querySelector('[data-testid="cloud-workspace-file-tree-node-docs/r2-fixtures"]')?.click()
)
await sleep(500)
await fr().evaluate(() =>
  document
    .querySelector(
      '[data-testid="cloud-workspace-file-tree-node-docs/r2-fixtures/r2-binary-copy.bin"]'
    )
    ?.click()
)
await fr().locator('.monaco-editor:visible').first().waitFor({ timeout: 20000 })
await sleep(800)
const save = fr().locator('[data-testid="cloud-workspace-file-tab-save"]:visible')
const saveState = {
  count: await save.count(),
  disabled: (await save.count()) ? await save.isDisabled() : null
}
const readonly = await fr()
  .locator('[data-testid="cloud-workspace-file-tab-readonly"]:visible')
  .count()
const info = await fr().evaluate(() => ({
  text: document.querySelector('[data-testid="cloud-workspace-file-tab-path"]')?.textContent,
  body: document.querySelector('[role="tabpanel"]:not([hidden])')?.innerText?.slice(0, 120)
}))
await page.screenshot({ path: path.join(SHOTS, 'r2-29-binary-editable.png') })
// type one character and save, then compare bytes
await fr().locator('.monaco-editor:visible .view-lines').first().click()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End')
await page.keyboard.type('X', { delay: 20 })
await sleep(800)
await save.click()
await sleep(2500)
const after = sha(COPY)
const afterSize = fs.statSync(COPY).size
console.log(
  JSON.stringify({ saveState, readonly, info, before, after, changed: before !== after, afterSize })
)
await browser.close()
// leave the corrupted copy as evidence; do not touch the original
