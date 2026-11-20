#!/usr/bin/env node
// Probe B10: admin-surface embed -> copy button -> audit file_copy event.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18788'
const OUT = 'evidence/u129-retest'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { base: BASE, steps: {} }
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write']
})
const page = await ctx.newPage()
page.setDefaultTimeout(60000)
page.on('dialog', (d) => d.accept())
page.on('console', (m) => {
  if (m.type() === 'error') (out.errors ??= []).push(m.text().slice(0, 300))
})
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ timeout: 30000 })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ timeout: 30000 })
  await page.goto(BASE + '/#/workspace/proj_fd19e4ff', { waitUntil: 'domcontentloaded' })
  await page.locator('.workspace-frame').waitFor({ state: 'visible', timeout: 60_000 })
  await sleep(15000)
  out.steps.frames = page.frames().map((f) => f.url().slice(0, 200))
  const frame = page.frames().find((f) => f.url().includes('cloud-admin.html')) ?? page.mainFrame()
  out.steps.iframeUrl = frame.url().slice(0, 200)
  // Dismiss any host-key/confirm dialogs inside frame.
  const dialog = frame.locator('[role="dialog"]').first()
  if (await dialog.isVisible().catch(() => false)) {
    const close = dialog.locator('[data-slot="dialog-close"], button').first()
    await close.click().catch(() => {})
    await sleep(1000)
  }
  out.steps.simpleWorkspace = await frame
    .locator('[data-testid="cloud-simple-workspace"]')
    .first()
    .isVisible()
    .catch(() => false)
  out.steps.treeVisible = await frame
    .locator('[data-testid="cloud-workspace-file-tree-node-README.md"]')
    .first()
    .isVisible()
    .catch(() => false)
  out.steps.fileTreeMarkers = await frame.evaluate(() =>
    [
      ...document.querySelectorAll(
        '[data-testid^="cloud-workspace-file-tree-node-"], [data-testid^="cloud-simple-workspace-file-tree-"], [data-testid="cloud-simple-workspace-right-panel"]'
      )
    ]
      .map((el) => el.getAttribute('data-testid'))
      .slice(0, 30)
  )
  let node = frame.locator('[data-testid="cloud-workspace-file-tree-node-README.md"]').first()
  if (!(await node.isVisible().catch(() => false))) {
    node = frame
      .locator('[data-testid^="cloud-workspace-file-tree-node-"]')
      .filter({ hasNotText: '' })
      .first()
  }
  if (await node.isVisible().catch(() => false)) {
    await node.click()
    const copyButton = frame
      .locator(
        '[data-testid="cloud-workspace-file-copy"], [data-testid="cloud-workspace-preview-copy"]'
      )
      .first()
    await copyButton.waitFor({ state: 'visible', timeout: 45_000 })
    out.steps.copyButton = await copyButton.getAttribute('data-testid')
    await copyButton.click()
    await sleep(2500)
    out.steps.copyStatusText = (await copyButton.textContent().catch(() => null))?.trim() ?? null
    out.steps.clipboardLength = await page
      .evaluate(
        () =>
          navigator.clipboard
            ?.readText?.()
            .then((t) => t.length)
            .catch(() => null) ?? null
      )
      .catch(() => null)
    out.steps.frameClipboardLength = await frame
      .evaluate(
        () =>
          navigator.clipboard
            ?.readText?.()
            .then((t) => t.length)
            .catch(() => null) ?? null
      )
      .catch(() => null)
  } else {
    out.steps.nodeMissing = true
  }
  // Audit query as admin
  const login = await fetch(BASE + '/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!' })
  })
  const token = (await login.json()).accessToken
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  let events = []
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    const q = await fetch(
      BASE + `/v1/audit/events?eventType=file_copy&since=${encodeURIComponent(since)}&limit=50`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    const body = await q.json().catch(() => ({}))
    events = body.events ?? []
    if (events.length) break
    await sleep(2000)
  }
  out.steps.events = events
    .slice(0, 5)
    .map((e) => ({
      eventType: e.eventType,
      actor: e.actor,
      result: e.result,
      fileName: e.metadata?.fileName,
      copyKind: e.metadata?.copyKind,
      capturePoint: e.metadata?.capturePoint,
      projectId: e.metadata?.projectId,
      hostId: e.metadata?.hostId
    }))
  await page.screenshot({ path: `${OUT}/probe-b10.png` })
} catch (e) {
  out.error = String(e).slice(0, 1500)
} finally {
  fs.writeFileSync(`${OUT}/probe-b10.json`, JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
