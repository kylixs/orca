#!/usr/bin/env node
// d-path via the app shortcut: Mod+T -> marker -> reload -> tabs+scrollback restore.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const OUT = path.resolve('evidence/u96-release-2')
const MARK = `RELEASE2-MARK-${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { mark: MARK, steps: {}, errors: [] }
const errs = []
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
page.on('dialog', (d) => d.accept())
let popup
const st = (p) =>
  p.evaluate(() => ({
    url: location.href.replace(/#.*/, ''),
    overlay: (document.body.innerText || '').includes('Opening the project workspace'),
    appLayout: document.querySelector('.app-layout') !== null,
    signIn: document.querySelector('#web-cloud-api-url') !== null,
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) =>
      el.getAttribute('data-tab-title')
    ),
    xterm: document.querySelectorAll('.xterm').length,
    text: [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .join('\n')
      .slice(-800)
  }))
async function dismiss(p, windowMs = 12_000) {
  const deadline = Date.now() + windowMs
  let closed = 0,
    quiet = 0
  while (Date.now() < deadline) {
    const d = p.locator('[role="dialog"]').first()
    if ((await d.count()) > 0) {
      const c = d.locator('[data-slot="dialog-close"]').first()
      if (await c.count()) await c.click({ timeout: 4000 }).catch(() => {})
      else await p.keyboard.press('Escape')
      closed += 1
      quiet = 0
      await sleep(800)
    } else {
      if (closed > 0) {
        quiet += 500
        if (quiet >= 1500) break
      }
      await sleep(500)
    }
  }
  return closed
}
async function newTab(p, tag) {
  out.phase = tag
  const before = (await st(p)).tabs.length
  await p.keyboard.press('Meta+T')
  let s
  for (let i = 0; i < 60; i += 1) {
    await sleep(700)
    s = await st(p)
    if (s.tabs.length > before) break
  }
  out.steps[tag] = { before, after: s.tabs, xterm: s.xterm, overlay: s.overlay, url: s.url }
  return s
}
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  await page.locator('#view-app').waitFor({ state: 'visible' })
  const pp = context.waitForEvent('page', { timeout: 60_000 })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  popup = await pp
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('console', (m) => {
    if (m.type() === 'error' && !/favicons|ERR_CONNECTION|Failed to load resource/.test(m.text())) {
      errs.push({ phase: out.phase, text: m.text().slice(0, 400) })
    }
  })
  popup.on('pageerror', (e) => errs.push({ phase: out.phase, pageerror: String(e).slice(0, 400) }))
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  out.tipsInitial = await dismiss(popup)
  await sleep(2000)
  out.steps.fresh = await st(popup)

  const afterOpen = await newTab(popup, 'newTabFresh')
  out.steps.newTabFreshOk = afterOpen.tabs.length > afterOpen.before
  if (afterOpen.tabs.length >= 2) {
    await popup.locator('.xterm').last().click()
    await popup.keyboard.type(`echo ${MARK}`)
    await popup.keyboard.press('Enter')
    let t = ''
    for (let i = 0; i < 60; i += 1) {
      await sleep(700)
      t = (await st(popup)).text
      if (t.includes(MARK)) break
    }
    out.steps.markerBefore = { visible: t.includes(MARK), tail: t.slice(-300) }
    await popup.screenshot({ path: path.join(OUT, 'shortcut-d-before-reload.png') })
  }

  out.phase = 'reload'
  const at = Date.now()
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  out.steps.reload = { appLayoutMs: Date.now() - at }
  out.tipsReload = await dismiss(popup)
  let s
  let restoredAt = null
  for (let i = 0; i < 80; i += 1) {
    await sleep(700)
    s = await st(popup)
    if (s.tabs.length >= 2 && s.text.includes(MARK)) {
      restoredAt = Date.now() - at
      break
    }
  }
  out.steps.afterReload = {
    tabs: s?.tabs,
    tabCount: s?.tabs.length,
    xterm: s?.xterm,
    signIn: s?.signIn,
    overlay: s?.overlay,
    markRestored: Boolean(s?.text.includes(MARK)),
    restoreMs: restoredAt,
    tail: (s?.text ?? '').slice(-400)
  }
  await popup.screenshot({ path: path.join(OUT, 'shortcut-d-after-reload.png') })
  out.errors = errs
  out.ok = out.steps.newTabFreshOk && Boolean(s?.text.includes(MARK)) && s?.tabs.length >= 2
} catch (error) {
  out.failure = String(error).slice(0, 1200)
  await (popup ?? page).screenshot({ path: path.join(OUT, 'shortcut-failure.png') }).catch(() => {})
} finally {
  out.errors = errs
  fs.writeFileSync(path.join(OUT, 'probe-shortcut.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
