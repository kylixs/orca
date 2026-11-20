#!/usr/bin/env node
// Canonical visual evidence: click each seeded U113 tab, screenshot its terminal,
// and cross-check the marker through the host terminal.read for that handle.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/u113-retest')
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const summary = JSON.parse(fs.readFileSync(path.join(OUT, 'summary.json'), 'utf8'))
const seeded = summary.setup.seeded
const markerByTabId = {
  [seeded.terminalTabIds[0]]: { marker: summary.markers.one, handle: seeded.handles.one },
  [seeded.terminalTabIds[1]]: { marker: summary.markers.two, handle: seeded.handles.two }
}
const out = { markers: summary.markers, tabs: [], ok: false, errors: [] }

const browser = await chromium.launch({ headless: true })
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
  const cp = await ctx.newPage()
  cp.on('dialog', (d) => d.accept())
  await cp.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  if (await cp.locator('#loginForm').count()) {
    await cp.fill('#username', DEV.username)
    await cp.fill('#password', DEV.password)
    await cp.click('#loginBtn')
  }
  await cp.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
  const projects = await cp.evaluate(async () => {
    const t = localStorage.getItem('orca.access')
    const r = await fetch('/v1/projects', { headers: { authorization: `Bearer ${t}` } })
    return r.ok ? (await r.json()).projects : []
  })
  const project = projects.find((p) => p.key === 'zhangsan-demo')
  const popupPromise = ctx.waitForEvent('page', { timeout: 60_000 })
  await cp.locator(`[data-orca-web="${project.id}"]`).first().click()
  const page = await popupPromise
  page.on('dialog', (d) => d.accept())
  await page.waitForSelector('.app-layout', { timeout: 120_000 })
  await page.waitForSelector('[data-testid="sortable-tab"]', { timeout: 120_000 })
  await sleep(3000)
  for (let i = 0; i < 12; i += 1) {
    const dialog = page.locator('[role="dialog"]').first()
    if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
      const close = dialog.locator('[data-slot="dialog-close"]').first()
      if (await close.count()) await close.click({ timeout: 3000 }).catch(() => {})
      else await page.keyboard.press('Escape')
      await sleep(600)
    } else break
  }
  const envId = await page.evaluate(async () => (await window.api.runtimeEnvironments.list())[0]?.id)
  const hostRead = (handle) =>
    page.evaluate(
      async ({ envId, handle }) => {
        const reply = await window.api.runtimeEnvironments.call({
          selector: envId,
          method: 'terminal.read',
          params: { terminal: handle, limit: 300 },
          timeoutMs: 60_000
        })
        return reply.ok ? { ok: true, tail: (reply.result?.terminal?.tail ?? []).join('\n') } : { ok: false }
      },
      { envId, handle }
    )
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((e) => ({
      id: e.getAttribute('data-tab-id'),
      title: e.getAttribute('data-tab-title'),
      active: e.getAttribute('data-active')
    }))
  )
  for (const tab of ids) {
    const parentId = String(tab.id ?? '').replace(/^web-terminal-/, '')
    const seed = markerByTabId[decodeURIComponent(parentId)] ?? markerByTabId[parentId]
    if (!seed) continue
    const loc = page.locator(`[data-testid="sortable-tab"][data-tab-id="${tab.id}"]`).first()
    await loc.click({ timeout: 10_000 })
    await sleep(1800)
    const read = await hostRead(seed.handle)
    const file = `visual-${seed.marker.includes('ONE') ? 'mark-one' : 'mark-two'}.png`
    await page.screenshot({ path: path.join(OUT, file) })
    out.tabs.push({
      tabId: tab.id,
      title: tab.title,
      marker: seed.marker,
      screenshot: file,
      hostReadOk: read.ok && read.tail.includes(seed.marker)
    })
  }
  out.ok =
    out.tabs.length === 2 &&
    out.tabs.every((t) => t.hostReadOk) &&
    out.tabs.some((t) => t.marker === summary.markers.one) &&
    out.tabs.some((t) => t.marker === summary.markers.two)
} catch (e) {
  out.errors.push(String(e).slice(0, 800))
} finally {
  await browser.close().catch(() => {})
  fs.writeFileSync(path.join(OUT, 'visual-tabs.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
}
