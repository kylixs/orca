#!/usr/bin/env node
// U96 release-2 smoke: platform/login/hosts, handoff, refresh silent resume, tab+scrollback restore.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const USER = process.env.ORCA_QA_USER ?? 'admin'
const PASS = process.env.ORCA_QA_PASS ?? 'Adm1n!'
const OUT = path.resolve('evidence/u96-release-2')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MARK = `RELEASE2-MARK-${Date.now()}`
const result = {
  base: BASE,
  head: process.env.HEAD_SHA ?? null,
  marker: MARK,
  steps: {},
  errors: []
}
const consoleErrors = []
const authOrHandoff = (url) =>
  /\/v1\/auth\/login|\/web-handoff|\/v1\/web\/handoff|[?&#]handoff=/.test(url)
async function dismissTips(p, windowMs = 12_000) {
  // Feature tips mount only after async settings/onboarding/CLI reads, so poll
  // the whole window and close each one; exit early after 2s of quiet.
  const deadline = Date.now() + windowMs
  let closed = 0
  let quietMs = 0
  while (Date.now() < deadline) {
    const dialog = p.locator('[role="dialog"]').first()
    if ((await dialog.count()) > 0) {
      const close = dialog.locator('[data-slot="dialog-close"]').first()
      if (await close.count()) await close.click({ timeout: 4000 }).catch(() => {})
      else await p.keyboard.press('Escape')
      closed += 1
      quietMs = 0
      await sleep(800)
    } else {
      if (closed > 0) {
        quietMs += 500
        if (quietMs >= 2000) break
      }
      await sleep(500)
    }
  }
  return { closed, remaining: await p.locator('[role="dialog"]').count() }
}
const tabState = (page) =>
  page.evaluate(() => ({
    url: location.href.replace(/#.*/, ''),
    hash: location.hash,
    appLayout: document.querySelector('.app-layout') !== null,
    signInForm: document.querySelector('#web-cloud-api-url') !== null,
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      title: el.getAttribute('data-tab-title'),
      active: el.getAttribute('aria-selected')
    })),
    xterm: document.querySelectorAll('.xterm').length,
    termText: [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .join('\n')
  }))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 }
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
page.on('dialog', (d) => d.accept())
let popup = null
let phase = 'platform'
const requests = []
const responses = []

try {
  // ---- a) platform + login + hosts ----
  const root = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  result.steps.platformRoot = { status: root.status(), url: page.url() }
  await page.locator('#loginForm').waitFor({ state: 'visible' })
  const loginResp = page.waitForResponse((r) => /\/v1\/auth\/login/.test(r.url()))
  await page.fill('#username', USER)
  await page.fill('#password', PASS)
  await page.click('#loginBtn')
  const lr = await loginResp
  result.steps.login = { status: lr.status(), ok: lr.ok() }
  await page.locator('#view-app').waitFor({ state: 'visible' })

  const api = (p) =>
    page.evaluate(async (url) => {
      const token = localStorage.getItem('orca.access')
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      let json = null
      try {
        json = await r.json()
      } catch {}
      return { status: r.status, json }
    }, p)
  const hosts = await api('/v1/hosts')
  const hostList = (hosts.json?.hosts ?? []).map((h) => ({
    name: h.name,
    online: h.online,
    relayOnline: h.relayOnline,
    addrs: h.directAddrs
  }))
  result.steps.hosts = { status: hosts.status, list: hostList }
  const required = ['dev-local-02', 'dev-local-03']
  result.steps.hostsOk = required.every((n) => hostList.find((h) => h.name === n)?.online === true)

  // ---- b) handoff -> headless web workspace ----
  phase = 'handoff'
  const popupPromise = context.waitForEvent('page', { timeout: 60_000 })
  await page.locator('tr', { hasText: 'demo' }).first().locator('[data-orca-web]').click()
  popup = await popupPromise
  popup.setDefaultTimeout(90_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('console', (m) => {
    if (m.type() === 'error') {
      const rec = { phase, text: m.text().slice(0, 500) }
      consoleErrors.push(rec)
      result.errors.push(rec)
    }
  })
  popup.on('pageerror', (e) => {
    const rec = { phase, pageerror: String(e).slice(0, 500) }
    consoleErrors.push(rec)
    result.errors.push(rec)
  })
  popup.on('request', (r) => {
    const rec = { phase, method: r.method(), url: r.url().slice(0, 300) }
    if (requests.length < 2000) requests.push(rec)
    if (authOrHandoff(r.url()))
      result.steps[`authOrHandoff_${phase}`] = (result.steps[`authOrHandoff_${phase}`] ?? 0) + 1
  })
  popup.on('response', (r) => {
    if (responses.length < 2000)
      responses.push({ phase, status: r.status(), url: r.url().slice(0, 300) })
  })

  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  const tipsDismissed = await dismissTips(popup)
  const loadedAt = Date.now()
  let first = null
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    first = await tabState(popup)
    if (first.tabs.length >= 1 && first.xterm >= 1) break
    await sleep(500)
  }
  result.steps.initial = {
    appLayout: first?.appLayout,
    signInForm: first?.signInForm,
    tabs: first?.tabs,
    xterm: first?.xterm,
    tipsDismissed,
    settleMs: Date.now() - loadedAt
  }
  await popup.screenshot({ path: path.join(OUT, 'b-workspace-initial.png') })
  const initialConsoleErrors = consoleErrors.filter((e) => e.phase === 'handoff')

  // ---- c) refresh path: silent session resume ----
  phase = 'reload1'
  const before1 = requests.length
  const reloadAt = Date.now()
  await popup.reload({ waitUntil: 'domcontentloaded' })
  const dclMs = Date.now() - reloadAt
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  const appLayoutMs = Date.now() - reloadAt
  const reload1Tips = await dismissTips(popup)
  let c = null
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    c = await tabState(popup)
    if (c.appLayout && !c.signInForm && c.tabs.length >= 1 && c.xterm >= 1) break
    await sleep(500)
  }
  const reloadRequests = requests.slice(before1)
  const reloadAuth = reloadRequests.filter((r) => authOrHandoff(r.url))
  result.steps.reload1 = {
    dclMs,
    appLayoutMs,
    settledMs: Date.now() - reloadAt,
    tipsDismissed: reload1Tips,
    appLayout: c?.appLayout,
    signInForm: c?.signInForm,
    hash: c?.hash,
    tabs: c?.tabs,
    xterm: c?.xterm,
    reLoginOrHandoffRequests: reloadAuth,
    noAuthOrHandoffRequest: reloadAuth.length === 0
  }
  await popup.screenshot({ path: path.join(OUT, 'c-after-reload1.png') })
  const reload1ConsoleErrors = consoleErrors.filter((e) => e.phase === 'reload1')

  // ---- d) second terminal tab + marker survives reload ----
  phase = 'tabopen'
  const tabsBefore = c.tabs.length
  // Primary path: the tab bar's "+" menu (deterministic in headless web).
  let openMethod = 'menu'
  await popup
    .getByRole('button', { name: 'New tab' })
    .first()
    .click({ timeout: 15_000 })
    .catch((e) => {
      openMethod = 'menu-click-failed:' + String(e).slice(0, 120)
    })
  await sleep(600)
  result.steps.tabMenuItems = await popup.locator('[role="menuitem"]').allTextContents()
  const exactItem = popup.getByRole('menuitem', { name: /^New Terminal$/ })
  if (await exactItem.count())
    await exactItem
      .first()
      .click({ timeout: 10_000 })
      .catch(() => {})
  else
    await popup
      .getByRole('menuitem', { name: /New Terminal/ })
      .first()
      .click({ timeout: 10_000 })
      .catch(() => {})
  let d1 = null
  for (const deadline = Date.now() + 20_000; Date.now() < deadline;) {
    d1 = await tabState(popup)
    if (d1.tabs.length > tabsBefore) break
    await sleep(500)
  }
  if (!d1 || d1.tabs.length <= tabsBefore) {
    // Fall back to the shortcut if the menu path was swallowed.
    await popup.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+T')
    openMethod = 'shortcut'
    for (const deadline = Date.now() + 25_000; Date.now() < deadline;) {
      d1 = await tabState(popup)
      if (d1.tabs.length > tabsBefore) break
      await sleep(500)
    }
  }
  result.steps.tabOpen = {
    openMethod: d1 && d1.tabs.length > tabsBefore ? openMethod : 'failed',
    tabsBefore,
    tabs: d1?.tabs,
    dialogs: await popup.locator('[role="dialog"]').count(),
    url: (d1?.url ?? '').slice(0, 200)
  }
  const term = popup.locator('.xterm').last()
  await term.waitFor({ state: 'attached', timeout: 60_000 })
  await dismissTips(popup)
  await term.click()
  await popup.keyboard.type(`echo ${MARK}`)
  await popup.keyboard.press('Enter')
  let beforeReloadText = ''
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    beforeReloadText = (await tabState(popup)).termText
    if (beforeReloadText.includes(MARK)) break
    await sleep(700)
  }
  const d2 = await tabState(popup)
  result.steps.markerBeforeReload = {
    tabs: d2.tabs,
    xterm: d2.xterm,
    markerVisible: beforeReloadText.includes(MARK)
  }
  await popup.screenshot({ path: path.join(OUT, 'd-marker-before-reload.png') })

  // Reload #2 and wait for tab + scrollback restoration.
  phase = 'reload2'
  const before2 = requests.length
  const reload2At = Date.now()
  await popup.reload({ waitUntil: 'domcontentloaded' })
  await popup.waitForSelector('.app-layout', { timeout: 90_000 })
  const reload2Tips = await dismissTips(popup)
  let d3 = null
  let restoreMarkerMs = null
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    d3 = await tabState(popup)
    if (d3.tabs.length >= 2 && d3.termText.includes(MARK)) {
      restoreMarkerMs = Date.now() - reload2At
      break
    }
    await sleep(700)
  }
  const reload2Auth = requests.slice(before2).filter((r) => authOrHandoff(r.url))
  result.steps.reload2 = {
    appLayout: d3?.appLayout,
    signInForm: d3?.signInForm,
    hash: d3?.hash,
    tabs: d3?.tabs,
    tabCount: d3?.tabs.length,
    xterm: d3?.xterm,
    markRestored: Boolean(d3?.termText.includes(MARK)),
    restoreMs: restoreMarkerMs,
    tipsDismissed: reload2Tips,
    noAuthOrHandoffRequest: reload2Auth.length === 0,
    reLoginOrHandoffRequests: reload2Auth,
    termTail: (d3?.termText ?? '').slice(-600)
  }
  await popup.screenshot({ path: path.join(OUT, 'd-after-reload2.png') })

  // Console error summary per phase.
  result.steps.consoleErrors = {
    total: consoleErrors.length,
    byPhase: consoleErrors.reduce((acc, e) => {
      acc[e.phase] = (acc[e.phase] ?? 0) + 1
      return acc
    }, {}),
    sample: consoleErrors.slice(0, 10)
  }
  result.steps.initialConsoleErrors = initialConsoleErrors.length
  result.steps.reload1ConsoleErrors = reload1ConsoleErrors.length

  // Gates.
  const gates = {
    a_platform200: result.steps.platformRoot.status === 200,
    a_login200: result.steps.login.status === 200,
    a_bothHostsOnline: result.steps.hostsOk === true,
    b_appLayout: first?.appLayout === true,
    b_oneTerminalTab: first?.tabs.length === 1 && first.tabs[0]?.title === 'Terminal',
    b_zeroConsoleErrors: initialConsoleErrors.length === 0,
    c_appLayout: c?.appLayout === true,
    c_noLoginForm: c?.signInForm === false,
    c_noAuthOrHandoff: reloadAuth.length === 0,
    d_twoTabs: d3?.tabs.length === 2,
    d_markerRestored: Boolean(d3?.termText.includes(MARK))
  }
  result.gates = gates
  result.ok = Object.values(gates).every(Boolean)
} catch (error) {
  result.ok = false
  result.failure = String(error).slice(0, 1200)
  await (popup ?? page).screenshot({ path: path.join(OUT, 'smoke-failure.png') }).catch(() => {})
} finally {
  result.requests = requests.slice(-400)
  result.responses = responses.slice(-400)
  fs.writeFileSync(path.join(OUT, 'smoke.json'), JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(
  JSON.stringify(
    { ok: result.ok, gates: result.gates, steps: result.steps, failure: result.failure },
    null,
    2
  )
)
process.exit(result.ok ? 0 : 1)
