#!/usr/bin/env node
// Targeted content-restore check: the canvas renderer hides .xterm-rows from JS,
// so prove scrollback by WebSocket snapshot frames plus per-tab screenshots.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = 'https://127.0.0.1:18787'
const OUT = 'evidence/release-2.2'
const MARK = `RELEASE22-CONTENT-${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const args = process.env.ORCA_QA_DISABLE_WEBGL === '1' ? ['--disable-webgl', '--disable-gpu'] : []
const result = { mark: MARK, args, steps: {}, consoleErrors: [], failedRequests: [], ws: {} }

const tabs = (page) =>
  page.evaluate(() => ({
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      title: el.getAttribute('data-tab-title'),
      selected: el.getAttribute('aria-selected')
    })),
    activeTabIds: [
      ...document.querySelectorAll('[data-testid="sortable-tab"][aria-selected="true"]')
    ].map((el) => el.getAttribute('data-tab-id')),
    rows: document.querySelectorAll('.xterm-rows').length,
    rowsText: [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .join('\n'),
    xterm: document.querySelectorAll('.xterm').length
  }))

const browser = await chromium.launch({ headless: true, args })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const admin = await context.newPage()
admin.on('dialog', (d) => d.accept())
let popup = null
try {
  await admin.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await admin.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  await admin.fill('#username', 'zhangsan')
  await admin.fill('#password', 'Passw0rd!')
  await admin.click('#loginBtn')
  await admin.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
  const ids = await admin.evaluate(async () => {
    const t = localStorage.getItem('orca.access')
    const r = await fetch('/v1/projects', { headers: { authorization: `Bearer ${t}` } })
    return Object.fromEntries(((await r.json()).projects ?? []).map((p) => [p.name, p.id]))
  })
  const projectId = ids['infra-tools']
  const button = admin.locator(`[data-orca-web="${projectId}"]`).first()
  await button.waitFor({ state: 'visible', timeout: 30_000 })

  const frameHits = []
  const encodedMark = Buffer.from(MARK).toString('base64')
  const capture = true
  const openPopup = async (phase) => {
    const p = context.waitForEvent('page', { timeout: 90_000 })
    p.catch(() => {})
    await button.click()
    const page = await p
    page.setDefaultTimeout(120_000)
    page.on('dialog', (d) => d.accept())
    page.on('console', (m) => {
      if (m.type() === 'error') result.consoleErrors.push({ phase, text: m.text().slice(0, 300) })
    })
    page.on('pageerror', (e) => result.consoleErrors.push({ phase, text: String(e).slice(0, 300) }))
    page.on('requestfailed', (r) =>
      result.failedRequests.push({
        phase,
        url: r.url().slice(0, 240),
        error: r.failure()?.errorText ?? null
      })
    )
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        if (!capture) return
        const payload =
          typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
        if (payload.includes(MARK) || payload.includes(encodedMark)) {
          frameHits.push({ phase, bytes: payload.length, base64: payload.includes(encodedMark) })
        }
      })
    })
    await page.waitForSelector('.app-layout', { timeout: 120_000 })
    return page
  }

  const activateThird = async (page) => {
    const tabEls = page.locator('[data-testid="sortable-tab"]')
    const count = await tabEls.count()
    if (count >= 3)
      await tabEls
        .nth(2)
        .click()
        .catch(() => {})
    await sleep(800)
    return tabs(page)
  }

  // First open: inspect DOM rows availability with the current renderer.
  popup = await openPopup('open1')
  await sleep(2000)
  const openState = await tabs(popup)
  result.steps.open1 = {
    tabCount: openState.tabs.length,
    xterm: openState.xterm,
    domRows: openState.rows
  }

  // Type the marker into the third tab.
  await activateThird(popup)
  await popup
    .locator('.xterm:visible')
    .last()
    .click({ timeout: 10_000 })
    .catch(() => {})
  await popup
    .locator('.xterm:visible .xterm-helper-textarea')
    .last()
    .focus()
    .catch(() => {})
  await popup.keyboard.type(`echo ${MARK}`)
  await popup.keyboard.press('Enter')
  const typedAt = Date.now()
  while (Date.now() - typedAt < 20_000 && frameHits.length === 0) await sleep(300)
  result.steps.typed = {
    frameHits: frameHits.length,
    typedTail: (await tabs(popup)).rowsText.slice(-300)
  }
  await popup.screenshot({ path: `${OUT}/content-before-reload.png` })

  // Reload: fresh JS must re-fetch the scrollback; compare frame hits by index.
  const hitsBeforeReload = frameHits.length
  const reloadAt = Date.now()
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 120_000 })
  let restored = null
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    restored = await tabs(popup)
    if (restored.tabs.length >= 3 && frameHits.length > hitsBeforeReload) break
    await sleep(500)
  }
  result.steps.reload = {
    tabsRestoredMs: restored?.tabs.length >= 3 ? Date.now() - reloadAt : null,
    tabCount: restored?.tabs.length,
    xterm: restored?.xterm,
    domRows: restored?.rows,
    markFrameHits: frameHits.length - hitsBeforeReload,
    markRestoredOverWire: frameHits.length > hitsBeforeReload,
    rowsTail: (restored?.rowsText ?? '').slice(-300)
  }
  await activateThird(popup)
  await popup.screenshot({ path: `${OUT}/content-after-reload.png` })

  // Close and reopen: frames prove the new page fetched the scrollback.
  await popup.close()
  const hitsBeforeReopen = frameHits.length
  popup = await openPopup('reopen')
  let reopened = null
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    reopened = await tabs(popup)
    if (reopened.tabs.length >= 3 && frameHits.length > hitsBeforeReopen) break
    await sleep(500)
  }
  result.steps.reopen = {
    tabCount: reopened?.tabs.length,
    xterm: reopened?.xterm,
    domRows: reopened?.rows,
    markFrameHits: frameHits.length - hitsBeforeReopen,
    markRestoredOverWire: frameHits.length > hitsBeforeReopen,
    rowsTail: (reopened?.rowsText ?? '').slice(-300)
  }
  await activateThird(popup)
  await popup.screenshot({ path: `${OUT}/content-after-reopen.png` })
} catch (e) {
  result.failure = String(e).slice(0, 1000)
  if (popup) await popup.screenshot({ path: `${OUT}/content-failure.png` }).catch(() => {})
} finally {
  fs.writeFileSync(`${OUT}/content-check.json`, JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(JSON.stringify({ steps: result.steps, failure: result.failure }, null, 2))
