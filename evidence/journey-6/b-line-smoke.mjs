#!/usr/bin/env node
// v2.2 release smoke: workspace (a/b/c/d) + admin routing (e) + LDAP default login (f).
import { chromium, request } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/journey-6')
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const ADMIN = { username: 'admin', password: 'Adm1n!' }
const PROJECT_NAME = process.env.ORCA_QA_PROJECT ?? 'infra-tools'
const MARK = `RELEASE22-MARK-${Date.now()}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const result = {
  base: BASE,
  head: process.env.HEAD_SHA ?? null,
  user: DEV.username,
  project: PROJECT_NAME,
  marker: MARK,
  steps: {},
  consoleErrors: [],
  consoleErrorDetail: [],
  failedRequests: [],
  failure: null,
  gates: {},
  ok: false
}
const consoleErrors = []
const responseLog = []

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

async function dismissTips(page, windowMs = 12_000) {
  const deadline = Date.now() + windowMs
  let closed = 0
  let quietMs = 0
  while (Date.now() < deadline) {
    const dialog = page.locator('[role="dialog"]').first()
    if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
      const close = dialog.locator('[data-slot="dialog-close"]').first()
      if (await close.count()) await close.click({ timeout: 4000 }).catch(() => {})
      else await page.keyboard.press('Escape')
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
  return { closed, remaining: await page.locator('[role="dialog"]').count() }
}

async function login(page, creds) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  const resp = page.waitForResponse((r) => /\/v1\/auth\/login/.test(r.url()))
  await page.fill('#username', creds.username)
  await page.fill('#password', creds.password)
  await page.click('#loginBtn')
  const res = await resp
  await page.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
  return { status: res.status(), ok: res.ok() }
}

function watchPopup(popup, phase) {
  popup.setDefaultTimeout(120_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('console', (m) => {
    if (m.type() !== 'error') return
    const rec = { phase, type: 'console', text: m.text().slice(0, 500) }
    consoleErrors.push(rec)
    result.consoleErrors.push(rec)
  })
  popup.on('pageerror', (e) => {
    const rec = { phase, type: 'pageerror', text: String(e).slice(0, 500) }
    consoleErrors.push(rec)
    result.consoleErrors.push(rec)
  })
  popup.on('response', (r) => {
    if (responseLog.length < 3000)
      responseLog.push({ phase, status: r.status(), url: r.url().slice(0, 240) })
  })
  popup.on('requestfailed', (r) => {
    result.failedRequests.push({
      phase,
      url: r.url().slice(0, 300),
      error: r.failure()?.errorText ?? null
    })
  })
  popup.on('console', (m) => {
    if (m.type() !== 'error') return
    result.consoleErrorDetail.push({ phase, at: Date.now(), text: m.text().slice(0, 500) })
  })
}

async function openWorkspace(context, page, projectId, phase) {
  const button = page.locator(`[data-orca-web="${projectId}"]`).first()
  await button.waitFor({ state: 'visible', timeout: 60_000 })
  const popupPromise = context.waitForEvent('page', { timeout: 90_000 })
  popupPromise.catch(() => {})
  await button.click({ timeout: 30_000 })
  const popup = await popupPromise
  watchPopup(popup, phase)
  await popup.waitForSelector('.app-layout', { timeout: 120_000 })
  return popup
}

async function waitForTabs(popup, min, windowMs = 90_000) {
  const deadline = Date.now() + windowMs
  let last = null
  while (Date.now() < deadline) {
    last = await tabState(popup)
    if (last.tabs.length >= min) return last
    await sleep(200)
  }
  return last
}

async function newTerminalTab(popup) {
  const before = (await tabState(popup)).tabs.length
  let method = 'menu'
  await popup
    .getByRole('button', { name: 'New tab' })
    .first()
    .click({ timeout: 20_000 })
    .catch((e) => {
      method = 'menu-button-failed:' + String(e).slice(0, 100)
    })
  const item = popup.getByRole('menuitem', { name: /New Terminal/ }).first()
  let t0 = Date.now()
  try {
    await item.waitFor({ state: 'visible', timeout: 12_000 })
    t0 = Date.now()
    await item.click({ timeout: 10_000 })
  } catch (e) {
    method = 'shortcut'
    await popup.keyboard.press(process.platform === 'darwin' ? 'Meta+T' : 'Control+T')
    t0 = Date.now()
  }
  const deadline = Date.now() + 25_000
  let state = null
  let ms = null
  while (Date.now() < deadline) {
    state = await tabState(popup)
    if (state.tabs.length > before) {
      ms = Date.now() - t0
      break
    }
    await sleep(50)
  }
  return { method, ms, before, after: state?.tabs.length ?? null, tabs: state?.tabs ?? [] }
}

async function typeMarker(page, mark) {
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const term = page.locator('.xterm:visible').last()
    await term.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {})
    await term.click({ timeout: 10_000 }).catch(() => {})
    await page
      .locator('.xterm:visible .xterm-helper-textarea')
      .last()
      .focus()
      .catch(() => {})
    await page.keyboard.type(`echo ${mark}`)
    await page.keyboard.press('Enter')
    for (const deadline = Date.now() + 12_000; Date.now() < deadline;) {
      last = (await tabState(page)).termText
      if (last.includes(mark)) return { attempt, ok: true }
      await sleep(400)
    }
  }
  return { attempt: 3, ok: false, tail: last.slice(-300) }
}

const browser = await chromium.launch({ headless: true })
let failurePage = null
try {
  // ---------- f) LDAP default-state login: three accounts must be 200 ----------
  {
    const api = await request.newContext({ ignoreHTTPSErrors: true })
    const logins = {}
    for (const [name, creds] of Object.entries({
      admin: ADMIN,
      zhangsan: DEV,
      lisi: { username: 'lisi', password: 'Passw0rd!' }
    })) {
      const res = await api.post(BASE + '/v1/auth/login', {
        data: creds,
        headers: { 'content-type': 'application/json' }
      })
      let code = null
      try {
        const body = await res.json()
        code = body?.error?.code ?? null
      } catch {}
      logins[name] = { status: res.status(), ok: res.ok(), code }
    }
    await api.dispose()
    result.steps.ldapDefaultLogin = logins
  }

  // ---------- a) workspace opens with one terminal ----------
  const devContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  const consolePage = await devContext.newPage()
  failurePage = consolePage
  consolePage.setDefaultTimeout(60_000)
  consolePage.on('dialog', (d) => d.accept())
  result.steps.devLogin = await login(consolePage, DEV)
  const devProjects = await consolePage.evaluate(async () => {
    const token = localStorage.getItem('orca.access')
    const r = await fetch('/v1/projects', { headers: { authorization: `Bearer ${token}` } })
    return r.ok ? (await r.json()).projects : []
  })
  const devTarget = devProjects.find((p) => p.name === PROJECT_NAME)
  if (!devTarget) throw new Error(`project not visible to zhangsan: ${PROJECT_NAME}`)
  result.projectId = devTarget.id
  const workspace = await openWorkspace(devContext, consolePage, devTarget.id, 'a-open')
  const tipsA = await dismissTips(workspace)
  const initialAt = Date.now()
  let initial = null
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    initial = await tabState(workspace)
    if (initial.appLayout && initial.tabs.length >= 1 && initial.xterm >= 1) break
    await sleep(500)
  }
  const initialErrors = consoleErrors.filter((e) => e.phase === 'a-open')
  result.steps.openWorkspace = {
    tipsDismissed: tipsA,
    settleMs: Date.now() - initialAt,
    appLayout: initial?.appLayout,
    signInForm: initial?.signInForm,
    tabs: initial?.tabs,
    xterm: initial?.xterm,
    tabCount: initial?.tabs.length,
    consoleErrors: initialErrors.length
  }
  await workspace.screenshot({ path: path.join(OUT, 'a-workspace-initial.png') })

  // ---------- b) three tabs total, 40s soak, reload restores tabs + content ----------
  const baselineTabs = initial.tabs.length
  const creations = []
  let currentCount = baselineTabs
  const createAt = Date.now()
  while (currentCount < 3 && creations.length < 3) {
    const creation = await newTerminalTab(workspace)
    creations.push(creation)
    if (creation.after) currentCount = creation.after
    await sleep(300)
  }
  const three = await waitForTabs(workspace, 3, 30_000)
  await dismissTips(workspace, 6_000)
  const marker = await typeMarker(workspace, MARK)
  const beforeReloadText = (await tabState(workspace)).termText
  const soakStart = Date.now()
  await sleep(40_000)
  const soaked = await tabState(workspace)
  result.steps.threeTabs = {
    baselineTabs,
    targetTabs: 3,
    creations,
    createSpanMs: Date.now() - createAt,
    tabCount: three?.tabs.length,
    xterm: three?.xterm,
    tabs: three?.tabs,
    marker,
    markerVisible: beforeReloadText.includes(MARK),
    soakMs: Date.now() - soakStart,
    afterSoakTabs: soaked.tabs.length,
    afterSoakXterm: soaked.xterm,
    afterSoakMarker: soaked.termText.includes(MARK)
  }
  await workspace.screenshot({ path: path.join(OUT, 'b-three-tabs-soak.png') })

  const reloadAt = Date.now()
  await workspace.reload({ waitUntil: 'domcontentloaded' })
  await workspace.waitForSelector('.app-layout', { timeout: 120_000 })
  await dismissTips(workspace, 10_000)
  let restored = null
  let tabsRestoredMs = null
  let markerRestoredMs = null
  for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
    restored = await tabState(workspace)
    if (tabsRestoredMs === null && restored.tabs.length >= 3) tabsRestoredMs = Date.now() - reloadAt
    if (restored.tabs.length >= 3 && restored.termText.includes(MARK)) {
      markerRestoredMs = Date.now() - reloadAt
      break
    }
    await sleep(500)
  }
  result.steps.reloadRestore = {
    restoreMs: Date.now() - reloadAt,
    tabsRestoredMs,
    markerRestoredMs,
    tabCount: restored?.tabs.length,
    xterm: restored?.xterm,
    tabs: restored?.tabs,
    markerRestored: Boolean(restored?.termText.includes(MARK)),
    termTail: (restored?.termText ?? '').slice(-500),
    consoleErrors: consoleErrors.filter((e) => e.phase === 'a-open').length
  }
  await workspace.screenshot({ path: path.join(OUT, 'b-after-reload.png') })

  // ---------- c) close page, reopen from platform: tabs restore ----------
  await workspace.close()
  const reopened1 = await openWorkspace(devContext, consolePage, devTarget.id, 'c-reopen')
  await dismissTips(reopened1, 10_000)
  const c = await waitForTabs(reopened1, 3, 90_000)
  result.steps.closeReopen = {
    tabCount: c?.tabs.length,
    xterm: c?.xterm,
    tabs: c?.tabs,
    markerRestored: Boolean(c?.termText.includes(MARK)),
    consoleErrors: consoleErrors.filter((e) => e.phase === 'c-reopen').length
  }
  await reopened1.screenshot({ path: path.join(OUT, 'c-close-reopen.png') })

  // ---------- d) close again, reopen same project: restores every time ----------
  await reopened1.close()
  const reopened2 = await openWorkspace(devContext, consolePage, devTarget.id, 'd-reopen')
  await dismissTips(reopened2, 10_000)
  const d = await waitForTabs(reopened2, 3, 90_000)
  result.steps.secondOpen = {
    tabCount: d?.tabs.length,
    xterm: d?.xterm,
    tabs: d?.tabs,
    markerRestored: Boolean(d?.termText.includes(MARK)),
    consoleErrors: consoleErrors.filter((e) => e.phase === 'd-reopen').length
  }
  await reopened2.screenshot({ path: path.join(OUT, 'd-second-reopen.png') })
  await reopened2.close()
  // B7: third return-and-reopen must restore as well.
  const reopened3 = await openWorkspace(devContext, consolePage, devTarget.id, 'e3-reopen')
  await dismissTips(reopened3, 10_000)
  const e3 = await waitForTabs(reopened3, 3, 90_000)
  result.steps.thirdOpen = {
    tabCount: e3?.tabs.length,
    xterm: e3?.xterm,
    tabs: e3?.tabs,
    markerRestored: Boolean(e3?.termText.includes(MARK)),
    consoleErrors: consoleErrors.filter((e) => e.phase === 'e3-reopen').length
  }
  await reopened3.screenshot({ path: path.join(OUT, 'e3-third-reopen.png') })
  await reopened3.close()
  await devContext.close()

  // ---------- e) admin console route spot checks ----------
  const adminContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  const adminPage = await adminContext.newPage()
  failurePage = adminPage
  adminPage.setDefaultTimeout(60_000)
  adminPage.on('dialog', (d) => d.accept())
  result.steps.adminLogin = await login(adminPage, ADMIN)
  const projects = await adminPage.evaluate(async () => {
    const token = localStorage.getItem('orca.access')
    const r = await fetch('/v1/projects', { headers: { authorization: `Bearer ${token}` } })
    return r.ok ? (await r.json()).projects : []
  })
  const target =
    projects.find((p) => p.name === PROJECT_NAME) ?? projects.find((p) => p.name === 'demo-app')
  result.steps.adminProjects = {
    count: projects.length,
    target: target ? { id: target.id, name: target.name } : null
  }

  const detailHash = `#/projects/${encodeURIComponent(target.id)}?tab=perms`
  await adminPage.goto(BASE + '/' + detailHash, { waitUntil: 'domcontentloaded' })
  await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
  const dialog1 = adminPage.locator('[role="dialog"]').first()
  await dialog1.waitFor({ state: 'visible', timeout: 60_000 })
  const beforeReloadHash = await adminPage.evaluate(() => location.hash)
  await adminPage.screenshot({ path: path.join(OUT, 'e-deeplink-before-reload.png') })
  await adminPage.reload({ waitUntil: 'domcontentloaded' })
  await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
  let dialog2Visible = false
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    dialog2Visible = await adminPage
      .locator('[role="dialog"]')
      .first()
      .isVisible()
      .catch(() => false)
    if (dialog2Visible) break
    await sleep(300)
  }
  const afterReloadHash = await adminPage.evaluate(() => location.hash)
  await adminPage.screenshot({ path: path.join(OUT, 'e-deeplink-after-reload.png') })
  result.steps.projectDeepLink = {
    hashBeforeReload: beforeReloadHash,
    hashAfterReload: afterReloadHash,
    dialogBeforeReload: true,
    dialogAfterReload: dialog2Visible,
    hashPreserved: beforeReloadHash === detailHash && afterReloadHash === detailHash
  }

  await adminPage.goto(BASE + '/#/members', { waitUntil: 'domcontentloaded' })
  await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
  let notFoundVisible = false
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    notFoundVisible = await adminPage
      .getByText('页面不存在')
      .first()
      .isVisible()
      .catch(() => false)
    if (notFoundVisible) break
    await sleep(300)
  }
  const membersHash = await adminPage.evaluate(() => location.hash)
  await adminPage.screenshot({ path: path.join(OUT, 'e-members-404.png') })
  result.steps.membersRoute = {
    hash: membersHash,
    hashPreserved: membersHash === '#/members',
    notFoundVisible
  }

  await adminPage.click('#logoutBtn')
  await adminPage.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  const logout = await adminPage.evaluate(() => ({
    hash: location.hash,
    access: localStorage.getItem('orca.access'),
    refresh: localStorage.getItem('orca.refresh')
  }))
  await adminPage.screenshot({ path: path.join(OUT, 'e-logout.png') })
  result.steps.logout = logout
  await adminContext.close()

  // ---------- gates ----------
  const l = result.steps.ldapDefaultLogin
  result.gates = {
    f_ldap_default_login_200: ['admin', 'zhangsan', 'lisi'].every((n) => l[n]?.status === 200),
    a_app_layout_one_tab:
      result.steps.openWorkspace.appLayout === true &&
      result.steps.openWorkspace.tabCount === 1 &&
      result.steps.openWorkspace.xterm === 1,
    a_zero_console_errors: consoleErrors.filter((e) => e.phase === 'a-open').length === 0,
    b_three_tabs:
      result.steps.threeTabs.tabCount === 3 &&
      result.steps.threeTabs.creations.length === 3 - result.steps.threeTabs.baselineTabs,
    b_soak_stable:
      result.steps.threeTabs.afterSoakTabs === 3 &&
      result.steps.threeTabs.afterSoakXterm === 3 &&
      result.steps.threeTabs.markerVisible === true,
    b_reload_restores:
      result.steps.reloadRestore.tabCount === 3 &&
      result.steps.reloadRestore.markerRestored === true,
    c_close_reopen_restores: result.steps.closeReopen.tabCount === 3,
    d_second_open_restores: result.steps.secondOpen.tabCount === 3,
    e_third_open_restores: result.steps.thirdOpen.tabCount === 3,
    e_project_deep_link:
      result.steps.projectDeepLink.hashPreserved === true && dialog2Visible === true,
    e_members_404: result.steps.membersRoute.hashPreserved === true && notFoundVisible === true,
    e_logout_clears_hash:
      logout.hash === '#/login' && logout.access === null && logout.refresh === null
  }
  result.ok = Object.values(result.gates).every(Boolean)
} catch (error) {
  result.ok = false
  result.failure = String(error).slice(0, 1500)
  if (failurePage)
    await failurePage.screenshot({ path: path.join(OUT, 'smoke-failure.png') }).catch(() => {})
} finally {
  result.responseTail = responseLog.slice(-300)
  fs.writeFileSync(path.join(OUT, 'smoke.json'), JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(
  JSON.stringify({ ok: result.ok, gates: result.gates, failure: result.failure }, null, 2)
)
process.exit(result.ok ? 0 : 1)
