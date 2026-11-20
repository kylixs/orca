#!/usr/bin/env node
// Round-6 dual-line journey on the deployed v2.2 stack (:18787 + local hosts).
// A line uses the equivalent web-client path (allowed) and asserts terminal
// markers through host terminal.read — never DOM text.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/journey-6')
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const ADMIN = { username: 'admin', password: 'Adm1n!' }
const HOST_ID = process.env.ORCA_QA_HOST_ID ?? 'host_281843a9' // dev-local-02
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const STAMP = Date.now()
const MARK_ONE = `J6-A-ONE-${STAMP}`
const MARK_TWO = `J6-A-TWO-${STAMP}`
const result = {
  base: BASE,
  stamp: STAMP,
  markers: { one: MARK_ONE, two: MARK_TWO },
  steps: {},
  gates: {},
  errors: [],
  ok: false
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
      ariaSelected: el.getAttribute('aria-selected'),
      dataActive: el.getAttribute('data-active')
    })),
    strips: document.querySelectorAll('.terminal-tab-strip').length,
    xterm: document.querySelectorAll('.xterm').length
  }))

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

async function api(token, pathname, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function openWorkspace(context, consolePage, projectId, phase) {
  const button = consolePage.locator(`[data-orca-web="${projectId}"]`).first()
  await button.waitFor({ state: 'visible', timeout: 60_000 })
  const popupPromise = context.waitForEvent('page', { timeout: 90_000 })
  popupPromise.catch(() => {})
  await button.click({ timeout: 30_000 })
  const popup = await popupPromise
  popup.setDefaultTimeout(120_000)
  popup.on('dialog', (d) => d.accept())
  popup.on('pageerror', (e) =>
    result.errors.push({ phase, kind: 'pageerror', text: String(e).slice(0, 400) })
  )
  popup.on('console', (m) => {
    if (m.type() === 'error')
      result.errors.push({ phase, kind: 'console', text: m.text().slice(0, 400) })
  })
  await popup.waitForSelector('.app-layout', { timeout: 180_000 })
  return popup
}

async function hostEnv(popup) {
  return popup.evaluate(async () => {
    const envs = await window.api.runtimeEnvironments.list()
    let worktreeId = null
    let candidates = []
    try {
      const all = await window.api.worktrees.listAll()
      candidates = all.map((w) => ({ id: w.id, path: w.path }))
      // The cloud ticket scope is the per-user checkout, not the project root.
      worktreeId =
        (all.find((w) => String(w.path).includes('.orca-worktrees/')) ?? all[0])?.id ?? null
    } catch {}
    if (!worktreeId) {
      const ids = [...document.querySelectorAll('[data-worktree-id]')]
        .map((el) => el.getAttribute('data-worktree-id'))
        .filter(Boolean)
      // The cloud ticket scope is the per-user checkout, not the project root.
      worktreeId =
        ids.find((v) => v.includes('.orca-worktrees/zhangsan/')) ??
        ids.find((v) => v.includes('.orca-worktrees/')) ??
        ids[0] ??
        null
    }
    return {
      envId: envs[0]?.id ?? null,
      worktreeId,
      candidates,
      apiAvailable: Boolean(window.api?.runtimeEnvironments)
    }
  })
}

async function hostCall(popup, envId, method, params) {
  return popup.evaluate(
    async ({ envId, method, params }) => {
      const reply = await window.api.runtimeEnvironments.call({
        selector: envId,
        method,
        params,
        timeoutMs: 60_000
      })
      if (!reply.ok) throw new Error(`${method}: ${reply.error.code} ${reply.error.message}`)
      return reply.result
    },
    { envId, method, params }
  )
}

async function waitForList(popup, envId, worktree, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await hostCall(popup, envId, 'session.tabs.list', { worktree })
    if (predicate(last)) return last
    if (Date.now() > deadline)
      throw new Error(
        `${label}: session.tabs.list never matched ${JSON.stringify(last).slice(0, 600)}`
      )
    await sleep(250)
  }
}

async function waitForMarker(popup, envId, handle, marker, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let tail = ''
  for (;;) {
    const read = await hostCall(popup, envId, 'terminal.read', { terminal: handle, limit: 300 })
    tail = (read?.terminal?.tail ?? []).join('\n')
    if (tail.includes(marker)) return { ok: true, tail: tail.slice(-600) }
    if (Date.now() > deadline) return { ok: false, tail: tail.slice(-600), label }
    await sleep(300)
  }
}

function localIdOf(parentTabId) {
  return `web-terminal-${encodeURIComponent(parentTabId)}`
}

/** The host may report a surface id (`parent::leaf`) or the parent id itself. */
function activeIsCreated0(snapshot, created) {
  const active = String(snapshot?.activeTabId ?? '')
  return (
    active === created.surfaceId ||
    active === created.parentTabId ||
    active.startsWith(`${created.parentTabId}::`)
  )
}

function sameActive(active, parentTabId) {
  return active === parentTabId || String(active ?? '').startsWith(`${parentTabId}::`)
}

async function waitDom(popup, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  for (;;) {
    state = await tabState(popup)
    if (predicate(state)) return state
    if (Date.now() > deadline)
      throw new Error(`${label}: DOM never matched ${JSON.stringify(state).slice(0, 600)}`)
    await sleep(300)
  }
}

const browser = await chromium.launch({ headless: true })
let failurePage = null
try {
  // ---------- clean baseline: self-service project ----------
  const devContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  const consolePage = await devContext.newPage()
  failurePage = consolePage
  consolePage.setDefaultTimeout(60_000)
  consolePage.on('dialog', (d) => d.accept())
  result.steps.devLogin = await login(consolePage, DEV)
  const token = await consolePage.evaluate(() => localStorage.getItem('orca.access'))
  // Baseline probe found no 1-tab project; use the documented seed and retire
  // its extra inherited tab through the host before the 3-tab drill.
  const key = 'zhangsan-demo'
  const projects0 = (await api(token, '/v1/projects')).body?.projects ?? []
  const seed = projects0.find((p) => p.key === key)
  result.steps.cleanProject = {
    key,
    status: 200,
    projectId: seed?.id ?? null,
    inheritedTabs: 'to-close'
  }
  const projectId = seed?.id ?? null
  if (!projectId) throw new Error('no journey project available')

  // ---------- A1: login -> project -> workspace (.app-layout + terminal) ----------
  const page = await openWorkspace(devContext, consolePage, projectId, 'A1')
  failurePage = page
  const a1 = await waitDom(page, (s) => s.appLayout && s.tabs.length >= 1 && s.xterm >= 1, 'A1')
  result.steps.a1 = { ...a1, host: await hostEnv(page) }
  await page.screenshot({ path: path.join(OUT, 'a1-workspace.png') })

  const { envId, worktreeId } = result.steps.a1.host
  if (!envId || !worktreeId)
    throw new Error(`host env missing: ${JSON.stringify(result.steps.a1.host)}`)
  const worktree = `id:${worktreeId}`

  // A5 (retire half): close the inherited extra tab(s) down to one baseline row.
  const inherited = await hostCall(page, envId, 'session.tabs.list', { worktree })
  const keepId = inherited.activeTabId ?? inherited.tabs?.[0]?.id
  const retired = []
  for (const t of inherited.tabs ?? []) {
    if (t.id === keepId) continue
    await hostCall(page, envId, 'session.tabs.close', {
      worktree,
      tabId: t.parentTabId ?? t.id,
      reason: 'user'
    })
    retired.push(t.id)
  }
  const afterRetire = await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabs ?? []).length === 1,
    'retire-inherited'
  )
  result.steps.a5CloseRetire = {
    inherited: (inherited.tabs ?? []).length,
    retired,
    remaining: (afterRetire.tabs ?? []).length,
    retiredStillListed: (afterRetire.tabs ?? []).some((t) => retired.includes(t.id))
  }

  // ---------- A2: 3 tabs, split/move into 2 groups ----------
  const before = await hostCall(page, envId, 'session.tabs.list', { worktree })
  const beforeIds = new Set((before.tabs ?? []).map((t) => t.id))
  const createdTabs = []
  for (const index of [1, 2]) {
    const r = await hostCall(page, envId, 'terminal.create', {
      worktree,
      title: `J6 terminal ${index}`,
      tabId: `j6-tab-${STAMP}-${index}`,
      leafId: `j6-leaf-${STAMP}-${index}`
    })
    createdTabs.push({ handle: r.terminal.handle, parentTabId: r.terminal.tabId, surfaceId: '' })
  }
  const afterCreate = await hostCall(page, envId, 'session.tabs.list', { worktree })
  const fresh = (afterCreate.tabs ?? []).filter((t) => !beforeIds.has(t.id))
  for (const entry of createdTabs) {
    const surface = fresh.find((t) => String(t.id).startsWith(`${entry.parentTabId}::`))
    if (!surface) throw new Error(`no surface for ${entry.parentTabId}`)
    entry.surfaceId = surface.id
  }
  const groupIdsBefore = new Set((afterCreate.tabGroups ?? []).map((g) => g.id))
  const firstGroupId = afterCreate.tabGroups?.[0]?.id
  if (!firstGroupId) throw new Error('no tab group to split from')
  await hostCall(page, envId, 'session.tabs.move', {
    kind: 'split',
    worktree,
    tabId: createdTabs[0].surfaceId,
    targetGroupId: firstGroupId,
    splitDirection: 'right'
  })
  const afterSplit = await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabGroups ?? []).some((g) => !groupIdsBefore.has(g.id)),
    'split'
  )
  const secondGroupId = (afterSplit.tabGroups ?? []).find((g) => !groupIdsBefore.has(g.id))?.id
  if (!secondGroupId) throw new Error('split produced no second group')
  await hostCall(page, envId, 'session.tabs.move', {
    kind: 'move-to-group',
    worktree,
    tabId: createdTabs[1].surfaceId,
    targetGroupId: secondGroupId
  })
  await hostCall(page, envId, 'terminal.send', {
    terminal: createdTabs[0].handle,
    text: `printf '${MARK_ONE}\\n'\r`
  })
  await hostCall(page, envId, 'terminal.send', {
    terminal: createdTabs[1].handle,
    text: `printf '${MARK_TWO}\\n'\r`
  })
  // The split/move may re-key the surface; re-read the current entry before activate.
  const preActivate = await hostCall(page, envId, 'session.tabs.list', { worktree })
  const entry0 = (preActivate.tabs ?? []).find(
    (t) =>
      t.parentTabId === createdTabs[0].parentTabId ||
      String(t.id).startsWith(`${createdTabs[0].parentTabId}::`)
  )
  createdTabs[0].surfaceId = entry0?.id ?? createdTabs[0].surfaceId
  await hostCall(page, envId, 'session.tabs.activate', {
    worktree,
    tabId: createdTabs[0].surfaceId
  }).catch(() =>
    hostCall(page, envId, 'session.tabs.activate', { worktree, tabId: createdTabs[0].parentTabId })
  )
  let grouped = null
  const groupedDeadline = Date.now() + 30_000
  for (;;) {
    grouped = await hostCall(page, envId, 'session.tabs.list', { worktree })
    if ((grouped.tabGroups ?? []).length >= 2 && activeIsCreated0(grouped, createdTabs[0])) break
    if (Date.now() > groupedDeadline) {
      throw new Error(
        `grouped-activate: ${JSON.stringify({ createdTabs, groups: (grouped.tabGroups ?? []).map((g) => ({ id: g.id, activeTabId: g.activeTabId, tabOrder: g.tabOrder })), activeTabId: grouped.activeTabId, activeGroupId: grouped.activeGroupId, tabs: (grouped.tabs ?? []).map((t) => ({ id: t.id, parentTabId: t.parentTabId })) }).slice(0, 1800)}`
      )
    }
    await sleep(300)
  }
  // Wait for the strip to show all host tabs before the reload under test.
  const expectedTabCount = (grouped.tabs ?? []).length
  const activeLocalId = localIdOf(createdTabs[0].parentTabId)
  const domBefore = await waitDom(
    page,
    (s) => s.tabs.length === expectedTabCount && s.strips >= 2,
    'A2-dom'
  )
  const readOne = await waitForMarker(page, envId, createdTabs[0].handle, MARK_ONE, 'A2-one')
  const readTwo = await waitForMarker(page, envId, createdTabs[1].handle, MARK_TWO, 'A2-two')
  result.steps.a2 = {
    expectedTabCount,
    activeLocalId,
    hostActiveTabId: grouped.activeTabId,
    activeParentTabId: createdTabs[0].parentTabId,
    groupCount: (grouped.tabGroups ?? []).length,
    groups: (grouped.tabGroups ?? []).map((g) => ({ id: g.id, tabOrder: g.tabOrder })),
    domBefore: {
      tabCount: domBefore.tabs.length,
      strips: domBefore.strips,
      active:
        domBefore.tabs.find((t) => t.dataActive === 'true' || t.ariaSelected === 'true')?.id ?? null
    },
    terminalRead: { one: readOne, two: readTwo }
  }
  await page.screenshot({ path: path.join(OUT, 'a2-two-groups-three-tabs.png') })

  // ---------- A2/B6: reload in place restores 2 groups / 3 tabs / active ----------
  const reloadAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-layout', { timeout: 180_000 })
  const domRestored = await waitDom(
    page,
    (s) =>
      s.tabs.length === expectedTabCount &&
      s.strips >= 2 &&
      s.signInForm === false &&
      s.tabs.some(
        (t) => t.id === activeLocalId && (t.dataActive === 'true' || t.ariaSelected === 'true')
      ),
    'reload-restore'
  )
  const hostRestored = await waitForList(
    page,
    envId,
    worktree,
    (s) =>
      (s.tabGroups ?? []).length >= 2 &&
      activeIsCreated0(s, createdTabs[0]) &&
      (s.tabs ?? []).length === expectedTabCount,
    'reload-restore-host'
  )
  const restoredReadOne = await waitForMarker(
    page,
    envId,
    createdTabs[0].handle,
    MARK_ONE,
    'reload-one'
  )
  const restoredReadTwo = await waitForMarker(
    page,
    envId,
    createdTabs[1].handle,
    MARK_TWO,
    'reload-two'
  )
  result.steps.reloadRestore = {
    ms: Date.now() - reloadAt,
    dom: {
      tabCount: domRestored.tabs.length,
      strips: domRestored.strips,
      active:
        domRestored.tabs.find((t) => t.dataActive === 'true' || t.ariaSelected === 'true')?.id ??
        null,
      signInForm: domRestored.signInForm
    },
    host: {
      tabCount: (hostRestored.tabs ?? []).length,
      groupCount: (hostRestored.tabGroups ?? []).length,
      activeTabId: hostRestored.activeTabId
    },
    terminalRead: { one: restoredReadOne, two: restoredReadTwo }
  }
  await page.screenshot({ path: path.join(OUT, 'b6-reload-restored.png') })

  // ---------- A2/B7: close page, return and reopen x3 ----------
  const reopens = []
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await page.close()
    const reopened = await openWorkspace(devContext, consolePage, projectId, `reopen-${cycle}`)
    const dom = await waitDom(
      reopened,
      (s) =>
        s.tabs.length === expectedTabCount &&
        s.strips >= 2 &&
        s.signInForm === false &&
        s.tabs.some(
          (t) => t.id === activeLocalId && (t.dataActive === 'true' || t.ariaSelected === 'true')
        ),
      `reopen-${cycle}`
    )
    const host = await waitForList(
      reopened,
      envId,
      worktree,
      (s) =>
        (s.tabGroups ?? []).length >= 2 &&
        activeIsCreated0(s, createdTabs[0]) &&
        (s.tabs ?? []).length === expectedTabCount,
      `reopen-${cycle}-host`
    )
    const one = await waitForMarker(
      reopened,
      envId,
      createdTabs[0].handle,
      MARK_ONE,
      `reopen-${cycle}-one`
    )
    const two = await waitForMarker(
      reopened,
      envId,
      createdTabs[1].handle,
      MARK_TWO,
      `reopen-${cycle}-two`
    )
    reopens.push({
      cycle,
      dom: {
        tabCount: dom.tabs.length,
        strips: dom.strips,
        active:
          dom.tabs.find((t) => t.dataActive === 'true' || t.ariaSelected === 'true')?.id ?? null
      },
      host: {
        tabCount: (host.tabs ?? []).length,
        groupCount: (host.tabGroups ?? []).length,
        activeTabId: host.activeTabId
      },
      terminalRead: { one: one.ok, two: two.ok }
    })
    await reopened.screenshot({ path: path.join(OUT, `b7-reopen-${cycle}.png`) })
    if (cycle < 3) {
      // keep the last popup open for the next iteration; close at loop start
      globalThis.__lastReopen = reopened
    } else {
      await reopened.screenshot({ path: path.join(OUT, 'b7-reopen-3-final.png') })
      await reopened.close()
    }
    if (cycle < 3) {
      // page variable for next iteration is the popup we just opened
      await globalThis.__lastReopen.close().catch(() => {})
    }
  }
  result.steps.reopens = reopens
  await devContext.close()

  // ---------- B8: admin routing deep link / 404 / logout ----------
  const adminContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  const adminPage = await adminContext.newPage()
  failurePage = adminPage
  adminPage.setDefaultTimeout(60_000)
  adminPage.on('dialog', (d) => d.accept())
  result.steps.adminLogin = await login(adminPage, ADMIN)
  const adminToken = await adminPage.evaluate(() => localStorage.getItem('orca.access'))
  const projects = (await api(adminToken, '/v1/projects')).body?.projects ?? []
  const target = projects.find((p) => p.key === key) ?? projects[0]
  const detailHash = `#/projects/${encodeURIComponent(target.id)}?tab=perms`
  await adminPage.goto(BASE + '/' + detailHash, { waitUntil: 'domcontentloaded' })
  await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
  const dialogVisible = await adminPage
    .locator('[role="dialog"]')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => true)
    .catch(() => false)
  const beforeHash = await adminPage.evaluate(() => location.hash)
  await adminPage.reload({ waitUntil: 'domcontentloaded' })
  await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
  const dialogAfter = await adminPage
    .locator('[role="dialog"]')
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => true)
    .catch(() => false)
  const afterHash = await adminPage.evaluate(() => location.hash)
  const permsTab = await adminPage.evaluate(() => {
    const el = document.querySelector(
      '[role="dialog"] [data-auth-tab="perms"], [role="dialog"] [data-tab="perms"], [role="dialog"] [aria-controls*="perms"]'
    )
    return el
      ? {
          text: el.textContent?.trim().slice(0, 40) ?? null,
          selected: el.getAttribute('aria-selected') ?? el.getAttribute('data-active')
        }
      : null
  })
  await adminPage.screenshot({ path: path.join(OUT, 'b8-deeplink-perms.png') })
  await adminPage.goto(BASE + '/#/members', { waitUntil: 'domcontentloaded' })
  await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
  let notFound = false
  for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
    notFound = await adminPage
      .getByText('页面不存在')
      .first()
      .isVisible()
      .catch(() => false)
    if (notFound) break
    await sleep(300)
  }
  const membersHash = await adminPage.evaluate(() => location.hash)
  await adminPage.screenshot({ path: path.join(OUT, 'b8-members-404.png') })
  await adminPage.click('#logoutBtn')
  await adminPage.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  const logout = await adminPage.evaluate(() => ({
    hash: location.hash,
    access: localStorage.getItem('orca.access'),
    refresh: localStorage.getItem('orca.refresh')
  }))
  await adminPage.screenshot({ path: path.join(OUT, 'b8-logout.png') })
  result.steps.routing = {
    projectId: target?.id ?? null,
    detailHash,
    beforeHash,
    afterHash,
    hashPreserved: beforeHash === detailHash && afterHash === detailHash,
    dialogVisible,
    dialogAfterReload: dialogAfter,
    permsTab,
    members: { hash: membersHash, notFound },
    logout
  }
  await adminContext.close()

  // ---------- gates ----------
  const st = result.steps
  result.gates = {
    clean_baseline_created: Boolean(st.cleanProject.projectId),
    a1_app_layout_terminal: st.a1.appLayout === true && st.a1.tabs.length >= 1 && st.a1.xterm >= 1,
    a2_two_groups_three_tabs:
      st.a2.expectedTabCount === 3 &&
      st.a2.groupCount >= 2 &&
      st.a2.terminalRead.one.ok === true &&
      st.a2.terminalRead.two.ok === true,
    a2_reload_restores:
      st.reloadRestore.dom.tabCount === 3 &&
      st.reloadRestore.dom.strips >= 2 &&
      st.reloadRestore.dom.active === st.a2.activeLocalId &&
      st.reloadRestore.dom.signInForm === false &&
      st.reloadRestore.host.groupCount >= 2 &&
      sameActive(st.reloadRestore.host.activeTabId, st.a2.activeParentTabId) &&
      st.reloadRestore.terminalRead.one.ok === true &&
      st.reloadRestore.terminalRead.two.ok === true,
    b7_reopen_three_times_restore:
      st.reopens.length === 3 &&
      st.reopens.every(
        (r) =>
          r.dom.tabCount === 3 &&
          r.dom.strips >= 2 &&
          r.dom.active === st.a2.activeLocalId &&
          r.host.groupCount >= 2 &&
          r.terminalRead.one &&
          r.terminalRead.two
      ),
    b8_deeplink_hash_preserved:
      st.routing.hashPreserved === true && st.routing.dialogAfterReload === true,
    b8_members_404: st.routing.members.hash === '#/members' && st.routing.members.notFound === true,
    b8_logout_clears_hash:
      st.routing.logout.hash === '#/login' &&
      st.routing.logout.access === null &&
      st.routing.logout.refresh === null
  }
  result.ok = Object.values(result.gates).every(Boolean)
} catch (error) {
  result.ok = false
  result.failure = String(error).slice(0, 2000)
  if (failurePage)
    await failurePage.screenshot({ path: path.join(OUT, 'smoke-failure.png') }).catch(() => {})
} finally {
  fs.writeFileSync(path.join(OUT, 'round6-web-journey.json'), JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(
  JSON.stringify({ ok: result.ok, gates: result.gates, failure: result.failure ?? null }, null, 2)
)
process.exit(result.ok ? 0 : 1)
