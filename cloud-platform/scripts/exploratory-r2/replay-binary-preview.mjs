#!/usr/bin/env node
/** Replay U59② P1: a known binary extension must open in the preview placeholder, not Monaco. */
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
const OUT = path.resolve('cloud-platform/evidence/r-fixes-verify')
const SHOTS = path.join(OUT, 'screenshots')
fs.mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 }
})
const page = await context.newPage()
page.setDefaultTimeout(25000)
const events = { consoleErrors: [], httpFailures: [], dialogs: [] }
page.on('console', (m) => {
  if (m.type() === 'error') events.consoleErrors.push(m.text().slice(0, 200))
})
page.on('pageerror', (e) => events.consoleErrors.push(`pageerror: ${e.message}`))
page.on('response', (r) => {
  if (r.status() >= 400) events.httpFailures.push(`${r.status()} ${r.url().slice(0, 160)}`)
})
page.on('dialog', (d) => {
  events.dialogs.push(d.message())
  void d.accept()
})
const result = { check: 'U59② P1 binary file opens in preview placeholder', base: BASE }
try {
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
  await page.locator('#workspaceOverlay iframe').waitFor()
  // Wait for the embedded workspace to reach ready, then resolve its frame.
  for (let i = 0; i < 60; i += 1) {
    const ready = await page.evaluate(
      () => document.querySelector('#workspaceOverlay [data-workspace-status]')?.hidden === true
    )
    if (ready) break
    await sleep(500)
  }
  let frame
  for (let i = 0; i < 40; i += 1) {
    frame = page.frames().find((f) => f.url().includes('/cloud-admin.html'))
    if (frame) break
    await sleep(250)
  }
  if (!frame)
    throw new Error(
      `embed frame not found: ${page
        .frames()
        .map((f) => f.url())
        .join(' | ')}`
    )
  await frame
    .locator('[data-testid="cloud-simple-workspace-right-tab-files"]')
    .click()
    .catch(() => {})
  await frame.evaluate(() =>
    document.querySelector('[data-testid="cloud-workspace-file-tree-node-docs"]')?.click()
  )
  await sleep(500)
  await frame.evaluate(() =>
    document
      .querySelector('[data-testid="cloud-workspace-file-tree-node-docs/r2-fixtures"]')
      ?.click()
  )
  await sleep(600)
  await frame.evaluate(() =>
    document
      .querySelector(
        '[data-testid="cloud-workspace-file-tree-node-docs/r2-fixtures/r2-binary.bin"]'
      )
      ?.click()
  )
  await sleep(3000)
  result.dom = await frame.evaluate(() => {
    const binary = document.querySelector('[data-testid="cloud-workspace-preview-binary"]')
    const monaco = document.querySelector('.monaco-editor')
    const tabPath = document.querySelector('[data-testid="cloud-workspace-preview-path"]')
    const previewTab = document.querySelector('[data-testid="cloud-workspace-preview-tab"]')
    const save = document.querySelector('[data-testid="cloud-workspace-file-tab-save"]')
    return {
      previewBinaryCount: binary ? 1 : 0,
      previewBinaryText: binary?.innerText?.slice(0, 240) ?? null,
      previewTabCount: previewTab ? 1 : 0,
      previewPath: tabPath?.textContent ?? null,
      monacoCount: monaco ? 1 : 0,
      saveButtonCount: save ? 1 : 0,
      tabLabels: [...document.querySelectorAll('[role="tab"]')]
        .map((t) => (t.innerText ?? '').replace(/\s+/g, ' ').trim())
        .slice(0, 10)
    }
  })
  result.pass =
    result.dom.previewBinaryCount === 1 &&
    result.dom.monacoCount === 0 &&
    result.dom.saveButtonCount === 0
  await page.screenshot({ path: path.join(SHOTS, 'p1-binary-preview.png') })
} catch (error) {
  result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  result.pass = false
} finally {
  result.events = events
  result.generatedAt = new Date().toISOString()
  fs.writeFileSync(path.join(OUT, 'p1-binary-preview.json'), JSON.stringify(result, null, 2))
  await browser.close()
  console.log(
    `${result.pass ? 'PASS' : 'FAIL'} binary-preview ${JSON.stringify(result.dom ?? { error: result.error })}`
  )
}
