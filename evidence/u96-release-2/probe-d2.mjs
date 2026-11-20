#!/usr/bin/env node
// Final d check: get to 2 tabs (UI menu, then store createTab fallback), echo, reload, verify restore.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'zhangsan'
const PASS = process.env.ORCA_QA_PASS ?? 'Passw0rd!'
const OUT = path.resolve('evidence/u96-release-2')
const MARK = `RELEASE2-MARK-${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { mark: MARK, user: USER, steps: {}, errors: [] }
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
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      title: el.getAttribute('data-tab-title')
    })),
    xterm: document.querySelectorAll('.xterm').length,
    visibleXterm: document.querySelectorAll('.xterm').length
      ? [...document.querySelectorAll('.xterm')].filter(
          (el) => el.getBoundingClientRect().height > 0
        ).length
      : 0,
    text: [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .join('\n')
      .slice(-600),
    overlay: (document.body.innerText || '').includes('Opening the project workspace'),
    appLayout: document.querySelector('.app-layout') !== null,
    signIn: document.querySelector('#web-cloud-api-url') !== null
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
async function closeTo(p, target) {
  for (let guard = 0; guard < 12; guard += 1) {
    const s = await st(p)
    if (s.tabs.length <= target) return s
    const tab = s.tabs[s.tabs.length - 1]
    const el = p.locator(`[data-tab-id="${tab.id}"]`).first()
    await el.click({ button: 'middle' }).catch(() => {})
    await sleep(700)
    if ((await st(p)).tabs.length === s.tabs.length) {
      const x = el.locator('[aria-label^="Close tab"]').first()
      if (await x.count()) await x.click({ timeout: 5000 }).catch(() => {})
      await sleep(700)
      const dlg = p.locator('[role="dialog"]').first()
      if (await dlg.count()) {
        const btn = dlg.getByRole('button', { name: /Close|Discard|Don't save/ }).last()
        await btn.click({ timeout: 4000 }).catch(() => p.keyboard.press('Enter'))
      }
      await sleep(700)
    }
  }
  return st(p)
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
    if (m.type() === 'error' && !/favicons|ERR_CONNECTION|Failed to load resource/.test(m.text()))
      errs.push({ phase: out.phase, text: m.text().slice(0, 350) })
  })
  popup.on('pageerror', (e) => errs.push({ phase: out.phase, pageerror: String(e).slice(0, 350) }))
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  out.tipsInitial = await dismiss(popup)
  await sleep(1500)
  out.steps.baseline = await closeTo(popup, 1)
  if (out.steps.baseline.tabs.length !== 1)
    throw new Error('could not reduce to 1 tab: ' + JSON.stringify(out.steps.baseline.tabs))

  // Attempt 1: the real UI menu via role.
  out.phase = 'menu'
  await popup.getByRole('button', { name: 'New tab' }).first().click({ timeout: 15_000 })
  const item = popup.getByRole('menuitem', { name: /^New Terminal/ }).first()
  await item.waitFor({ state: 'visible', timeout: 15_000 })
  out.steps.menuItem = (await item.textContent())?.slice(0, 80)
  await item.click({ timeout: 10_000 })
  let s
  const snapshots = []
  for (let i = 0; i < 170; i += 1) {
    await sleep(700)
    s = await st(popup)
    if (i % 14 === 0) snapshots.push({ i, tabs: s.tabs.length, xterm: s.xterm, overlay: s.overlay })
    if (s.tabs.length >= 2) break
  }
  out.steps.menuSnapshots = snapshots
  out.steps.afterMenuClick = s
  out.steps.menuCreated = (s?.tabs.length ?? 0) >= 2
  if (!out.steps.menuCreated) {
    await popup.screenshot({ path: path.join(OUT, 'd2-menu-stuck.png') }).catch(() => {})
    throw new Error('second tab not created; overlay=' + s?.overlay + ' tabs=' + s?.tabs.length)
  }

  // Echo marker in the active (last) visible terminal.
  out.phase = 'echo'
  const term = popup.locator('.xterm:visible').last()
  await term.waitFor({ state: 'visible', timeout: 30_000 })
  await term.click()
  await popup.keyboard.type(`echo ${MARK}`)
  await popup.keyboard.press('Enter')
  let t = ''
  for (let i = 0; i < 60; i += 1) {
    await sleep(700)
    t = (await st(popup)).text
    if (t.includes(MARK)) break
  }
  out.steps.markerBefore = { visible: t.includes(MARK), tail: t.slice(-300) }
  out.steps.tabsBeforeReload = (await st(popup)).tabs
  await popup.screenshot({ path: path.join(OUT, 'd2-before-reload.png') })

  out.phase = 'reload'
  const at = Date.now()
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  out.steps.reloadAppLayoutMs = Date.now() - at
  out.tipsReload = await dismiss(popup)
  let r
  let restoreMs = null
  for (let i = 0; i < 90; i += 1) {
    await sleep(700)
    r = await st(popup)
    if (r.tabs.length >= 2 && r.text.includes(MARK)) {
      restoreMs = Date.now() - at
      break
    }
  }
  out.steps.afterReload = {
    tabs: r?.tabs,
    tabCount: r?.tabs.length,
    xterm: r?.xterm,
    signIn: r?.signIn,
    overlay: r?.overlay,
    markRestored: Boolean(r?.text.includes(MARK)),
    restoreMs,
    tail: (r?.text ?? '').slice(-400)
  }
  await popup.screenshot({ path: path.join(OUT, 'd2-after-reload.png') })
  out.ok = (r?.tabs.length ?? 0) >= 2 && Boolean(r?.text.includes(MARK)) && !r?.signIn
} catch (error) {
  out.failure = String(error).slice(0, 1200)
  await (popup ?? page).screenshot({ path: path.join(OUT, 'd2-failure.png') }).catch(() => {})
} finally {
  out.errors = errs
  fs.writeFileSync(path.join(OUT, 'probe-d2.json'), JSON.stringify(out, null, 2))
  await browser.close()
}
console.log(JSON.stringify(out, null, 2))
