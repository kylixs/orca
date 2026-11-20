#!/usr/bin/env node
// Round-7 dual-line golden journey (post-v2.2): A1/A2/A3 + B6/B7/B8/B9/B10.
// Discipline (§2-16): baseline probe first, terminal content via host terminal.read,
// measurement and function gates recorded separately. Evidence only, no fixes.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/journey-final')
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const ADMIN = { username: 'admin', password: 'Adm1n!' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const STAMP = Date.now()
const MARK_ONE = `J7-A-ONE-${STAMP}`
const MARK_TWO = `J7-A-TWO-${STAMP}`
const result = {
  base: BASE,
  stamp: STAMP,
  markers: { one: MARK_ONE, two: MARK_TWO },
  steps: {},
  gates: {},
  measurements: {},
  errors: [],
  ok: false
}

const tabState = (page) =>
  page.evaluate(() => ({
    url: location.href.replace(/#.*/, ''),
    hash: location.hash,
    appLayout: document.querySelector('.app-layout') !== null,
    signInForm: document.querySelector('#web-cloud-api-url') !== null,
    visibility: document.visibilityState,
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      title: el.getAttribute('data-tab-title'),
      dataActive: el.getAttribute('data-active'),
      visible: el.offsetParent !== null
    })),
    strips: document.querySelectorAll('.terminal-tab-strip').length,
    activePaneHeaders: document.querySelectorAll('.pane-title-bar[data-active-pane]').length,
    xterm: document.querySelectorAll('.xterm').length
  }))

const storeState = (page) =>
  page.evaluate(() => {
    const s = window.__store?.getState?.()
    if (!s) return { exposed: false }
    const wt = s.activeWorktreeId
    return {
      exposed: true,
      activeWorktreeId: wt,
      activeTabIdByWorktree: s.activeTabIdByWorktree?.[wt] ?? null,
      activeGroupIdByWorktree: s.activeGroupIdByWorktree?.[wt] ?? null,
      tabs: (s.tabsByWorktree?.[wt] ?? []).map((t) => ({ id: t.id })),
      groups: (s.groupsByWorktree?.[wt] ?? []).map((g) => ({ id: g.id, tabOrder: g.tabOrder }))
    }
  })

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

async function openWorkspace(context, consolePage, projectId, phase, keep = true) {
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
  await popup.waitForSelector('[data-testid="sortable-tab"]', { timeout: 120_000 }).catch(() => {})
  if (!keep) await popup.close()
  return popup
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
      if (!reply.ok) return { ok: false, error: reply.error }
      return { ok: true, result: reply.result }
    },
    { envId, method, params }
  )
}

async function getEnvId(popup) {
  const envs = await popup.evaluate(() => window.api.runtimeEnvironments.list())
  return envs[0]?.id ?? null
}

function briefList(r) {
  if (!r.ok) return r
  return {
    ok: true,
    tabs: (r.result.tabs ?? []).map((t) => ({
      id: t.id,
      parentTabId: t.parentTabId,
      title: t.title,
      isActive: t.isActive
    })),
    tabGroups: r.result.tabGroups ?? [],
    activeTabId: r.result.activeTabId,
    activeGroupId: r.result.activeGroupId
  }
}

async function waitForList(popup, envId, worktree, predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await hostCall(popup, envId, 'session.tabs.list', { worktree })
    if (last.ok && predicate(last.result)) return last
    if (Date.now() > deadline)
      throw new Error(
        `${label}: session.tabs.list never matched ${JSON.stringify(briefList(last)).slice(0, 1000)}`
      )
    await sleep(300)
  }
}

async function waitForMarker(popup, envId, handle, marker, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let tail = ''
  for (;;) {
    const read = await hostCall(popup, envId, 'terminal.read', { terminal: handle, limit: 300 })
    tail = (read.ok ? (read.result?.terminal?.tail ?? []) : []).join('\n')
    if (tail.includes(marker)) return { ok: true, tail: tail.slice(-400) }
    if (Date.now() > deadline) return { ok: false, label, tail: tail.slice(-400) }
    await sleep(300)
  }
}

function localIdOf(parentTabId) {
  return `web-terminal-${encodeURIComponent(parentTabId)}`
}

function activeIsParent(snapshot, parentTabId) {
  const active = String(snapshot?.activeTabId ?? '')
  return active === parentTabId || active.startsWith(`${parentTabId}::`)
}

function activeIsSurface(snapshot, surfaceId) {
  return snapshot?.activeTabId === surfaceId
}

async function waitForAgreement(popup, envId, worktree, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    const dom = await tabState(popup)
    const store = await storeState(popup)
    const host = await hostCall(popup, envId, 'session.tabs.list', { worktree })
    const domActive = dom.tabs.filter((t) => t.dataActive === 'true').map((t) => t.id)
    const hostParent = String(host.ok ? host.result.activeTabId : '').split('::')[0]
    last = {
      dom: domActive[0] ?? null,
      store: store.activeTabIdByWorktree,
      hostLocal: hostParent ? localIdOf(hostParent) : null,
      domActiveCount: domActive.length,
      strips: dom.strips,
      domTabCount: dom.tabs.length,
      storeGroupCount: store.groups?.length ?? null,
      hostGroupCount: (host.ok ? (host.result.tabGroups ?? []) : []).length
    }
    if (last.dom && last.dom === last.store && last.store === last.hostLocal) {
      return { ok: true, ms: timeoutMs - (deadline - Date.now()), ...last }
    }
    if (Date.now() > deadline) return { ok: false, timeoutMs, ...last }
    await sleep(500)
  }
}

async function waitDom(popup, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  for (;;) {
    state = await tabState(popup)
    if (predicate(state)) return state
    if (Date.now() > deadline)
      throw new Error(`${label}: DOM never matched ${JSON.stringify(state).slice(0, 900)}`)
    await sleep(300)
  }
}

async function waitStore(popup, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  for (;;) {
    state = await storeState(popup)
    if (predicate(state)) return state
    if (Date.now() > deadline)
      throw new Error(`${label}: store never matched ${JSON.stringify(state).slice(0, 900)}`)
    await sleep(300)
  }
}

const browser = await chromium.launch({ headless: true })
let failurePage = null
try {
  // ---------- baseline probe: every project's current tab count ----------
  const devContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write']
  })
  const consolePage = await devContext.newPage()
  failurePage = consolePage
  consolePage.setDefaultTimeout(60_000)
  consolePage.on('dialog', (d) => d.accept())
  result.steps.devLogin = await login(consolePage, DEV)
  const token = await consolePage.evaluate(() => localStorage.getItem('orca.access'))
  const projects = (await api(token, '/v1/projects')).body?.projects ?? []
  result.steps.projects = projects.map((p) => ({
    id: p.id,
    key: p.key,
    hostId: p.hostId,
    online: p.online
  }))
  const baseline = {}
  let demoPage = null
  const order = ['demo-app', 'infra-tools', 'zhangsan-lab', 'zhangsan-demo']
  // Probe each project once, keep only zhangsan-demo open for the drill.
  for (const key of order) {
    const project = projects.find((p) => p.key === key)
    if (!project) continue
    try {
      const popup = await openWorkspace(devContext, consolePage, project.id, `baseline-${key}`)
      await sleep(3500)
      const [dom, store, envs] = await Promise.all([
        tabState(popup).catch(() => null),
        storeState(popup).catch(() => null),
        popup.evaluate(() => window.api.runtimeEnvironments.list()).catch(() => [])
      ])
      const envId = envs[0]?.id
      const worktree = store?.activeWorktreeId ? `id:${store.activeWorktreeId}` : null
      let listAll = null
      if (envId) listAll = await hostCall(popup, envId, 'session.tabs.listAll', {})
      baseline[key] = {
        projectId: project.id,
        hostId: project.hostId,
        domTabCount: dom?.tabs.length ?? null,
        domStrips: dom?.strips ?? null,
        storeTabCount: store?.tabs?.length ?? null,
        worktree,
        listAll: listAll?.ok
          ? (listAll.result.snapshots ?? []).map((s) => ({
              worktree: s.worktree,
              tabCount: (s.tabs ?? []).length,
              groupCount: (s.tabGroups ?? []).length
            }))
          : (listAll?.error ?? null)
      }
      if (key === 'zhangsan-demo') {
        demoPage = popup
      } else {
        await popup.close()
      }
    } catch (e) {
      baseline[key] = { error: String(e).slice(0, 400) }
    }
  }
  result.steps.baseline = baseline
  if (!demoPage) throw new Error('zhangsan-demo workspace unavailable')
  const page = demoPage
  failurePage = page

  const a1 = await waitDom(page, (s) => s.appLayout && s.tabs.length >= 1 && s.xterm >= 1, 'A1')
  const envs = await page.evaluate(() => window.api.runtimeEnvironments.list())
  const envId = envs[0]?.id
  const store0 = await storeState(page)
  const env = { envId, name: envs[0]?.name, worktree: store0.activeWorktreeId }
  if (!envId || !env.worktree) throw new Error(`host env missing: ${JSON.stringify(env)}`)
  const worktree = `id:${env.worktree}`
  result.steps.a1 = { ...a1, env }
  await page.screenshot({ path: path.join(OUT, 'a1-workspace.png') })

  // ---------- A2 setup: retire baseline to 1 tab, add 2, split into 2 groups ----------
  const list0 = await hostCall(page, envId, 'session.tabs.list', { worktree })
  const tabs0 = list0.result?.tabs ?? []
  const keepParent = list0.result?.activeTabId?.split('::')[0] ?? tabs0[0]?.parentTabId
  const retired = []
  for (const t of tabs0) {
    const parent = t.parentTabId ?? t.id
    if (parent === keepParent) continue
    const r = await hostCall(page, envId, 'session.tabs.close', {
      worktree,
      tabId: parent,
      reason: 'user'
    })
    retired.push({ parent, ok: r.ok })
  }
  const list1 = await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabs ?? []).length === 1,
    'retire-to-one',
    30_000
  )
  result.steps.a2Retire = {
    baselineTabs: tabs0.length,
    keepParent,
    retired,
    remaining: briefList(list1)
  }

  const ids1 = new Set((list1.result?.tabs ?? []).map((t) => t.id))
  const created = []
  for (const index of [1, 2]) {
    const r = await hostCall(page, envId, 'terminal.create', {
      worktree,
      title: `J7 terminal ${index}`,
      tabId: `j7-tab-${STAMP}-${index}`,
      leafId: `j7-leaf-${STAMP}-${index}`
    })
    if (!r.ok) throw new Error(`terminal.create ${index}: ${JSON.stringify(r.error)}`)
    created.push({
      handle: r.result.terminal.handle,
      parentTabId: r.result.terminal.tabId,
      marker: index === 1 ? MARK_ONE : MARK_TWO
    })
  }
  const list2 = await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabs ?? []).length === 3,
    'three-tabs',
    30_000
  )
  const fresh = (list2.result?.tabs ?? []).filter((t) => !ids1.has(t.id))
  for (const entry of created) {
    const surface = fresh.find(
      (t) =>
        t.parentTabId === entry.parentTabId || String(t.id).startsWith(`${entry.parentTabId}::`)
    )
    if (!surface) throw new Error(`no surface for ${entry.parentTabId}`)
    entry.surfaceId = surface.id
  }
  const sourceGroup = (list2.result?.tabGroups ?? []).find((g) =>
    g.tabOrder?.includes(created[0].parentTabId)
  )
  if (!sourceGroup)
    throw new Error(`no source group: ${JSON.stringify(briefList(list2)).slice(0, 800)}`)
  const split = await hostCall(page, envId, 'session.tabs.move', {
    kind: 'split',
    worktree,
    tabId: created[0].surfaceId,
    targetGroupId: sourceGroup.id,
    splitDirection: 'right'
  })
  if (!split.ok) throw new Error(`split: ${JSON.stringify(split.error)}`)
  const list3 = await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabGroups ?? []).length >= 2,
    'split-group',
    30_000
  )
  const newGroup = (list3.result?.tabGroups ?? []).find(
    (g) => !(list2.result?.tabGroups ?? []).some((x) => x.id === g.id)
  )
  if (!newGroup) throw new Error('split produced no new group')
  const move = await hostCall(page, envId, 'session.tabs.move', {
    kind: 'move-to-group',
    worktree,
    tabId: created[1].surfaceId,
    targetGroupId: newGroup.id
  })
  if (!move.ok) throw new Error(`move-to-group: ${JSON.stringify(move.error)}`)
  for (const entry of created) {
    await hostCall(page, envId, 'terminal.send', {
      terminal: entry.handle,
      text: `printf '${entry.marker}\\n'\r`
    })
  }
  const readOne = await waitForMarker(page, envId, created[0].handle, MARK_ONE, 'A2-one')
  const readTwo = await waitForMarker(page, envId, created[1].handle, MARK_TWO, 'A2-two')
  const activate = await hostCall(page, envId, 'session.tabs.activate', {
    worktree,
    tabId: created[0].surfaceId
  })
  if (!activate.ok) throw new Error(`activate: ${JSON.stringify(activate.error)}`)
  const grouped = await waitForList(
    page,
    envId,
    worktree,
    (s) =>
      (s.tabGroups ?? []).length >= 2 &&
      (s.tabs ?? []).length === 3 &&
      activeIsParent(s, created[0].parentTabId),
    'grouped-active',
    30_000
  )
  const expectedTabCount = 3
  const activeLocalId = localIdOf(created[0].parentTabId)
  const domBefore = await tabState(page)
  const storeBefore = await storeState(page)
  result.steps.a2 = {
    expectedTabCount,
    activeLocalId,
    activeParentTabId: created[0].parentTabId,
    host: {
      tabCount: (grouped.result.tabs ?? []).length,
      groupCount: (grouped.result.tabGroups ?? []).length,
      activeTabId: grouped.result.activeTabId,
      groups: grouped.result.tabGroups
    },
    domBeforeReload: {
      tabCount: domBefore.tabs.length,
      strips: domBefore.strips,
      active: domBefore.tabs.filter((t) => t.dataActive === 'true').map((t) => t.id),
      activePaneHeaders: domBefore.activePaneHeaders
    },
    storeBeforeReload: {
      activeTabId: storeBefore.activeTabIdByWorktree,
      groups: storeBefore.groups?.length ?? null
    },
    terminalRead: { one: readOne.ok, two: readTwo.ok }
  }
  await page.screenshot({ path: path.join(OUT, 'a2-before-reload.png') })

  // ---------- A2/B6: reload restores 2 groups / 3 tabs / active; DOM = store = host ----------
  const reloadAt = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-layout', { timeout: 180_000 })
  const domRestored = await waitDom(
    page,
    (s) =>
      s.tabs.length === expectedTabCount &&
      s.strips >= 2 &&
      s.signInForm === false &&
      s.tabs.filter((t) => t.dataActive === 'true').length === 1 &&
      s.tabs.some((t) => t.dataActive === 'true' && t.visible),
    'reload-restore-dom'
  )
  const storeRestored = await waitStore(
    page,
    (s) =>
      (s.tabs?.length ?? 0) === expectedTabCount &&
      (s.groups?.length ?? 0) >= 2 &&
      Boolean(s.activeTabIdByWorktree),
    'reload-restore-store'
  )
  const hostRestored = await waitForList(
    page,
    envId,
    worktree,
    (s) =>
      (s.tabGroups ?? []).length >= 2 &&
      (s.tabs ?? []).length === expectedTabCount &&
      Boolean(s.activeTabId),
    'reload-restore-host'
  )
  const domActive = domRestored.tabs.filter((t) => t.dataActive === 'true').map((t) => t.id)
  const hostActiveParent = String(hostRestored.result.activeTabId ?? '').split('::')[0]
  const restoredReadOne = await waitForMarker(
    page,
    envId,
    created[0].handle,
    MARK_ONE,
    'reload-one'
  )
  const restoredReadTwo = await waitForMarker(
    page,
    envId,
    created[1].handle,
    MARK_TWO,
    'reload-two'
  )
  const agreementSettled = await waitForAgreement(page, envId, worktree, 'reload-agreement', 20_000)
  result.steps.reloadRestore = {
    ms: Date.now() - reloadAt,
    dom: {
      tabCount: domRestored.tabs.length,
      strips: domRestored.strips,
      active: domActive,
      activePaneHeaders: domRestored.activePaneHeaders,
      visibility: domRestored.visibility,
      signInForm: domRestored.signInForm
    },
    store: {
      activeTabId: storeRestored.activeTabIdByWorktree,
      tabCount: storeRestored.tabs.length,
      groupCount: storeRestored.groups.length
    },
    host: {
      tabCount: (hostRestored.result.tabs ?? []).length,
      groupCount: (hostRestored.result.tabGroups ?? []).length,
      activeTabId: hostRestored.result.activeTabId,
      activeParent: hostActiveParent
    },
    agreement: {
      dom: domActive[0] ?? null,
      store: storeRestored.activeTabIdByWorktree,
      hostLocal: hostActiveParent ? localIdOf(hostActiveParent) : null
    },
    agreementSettled,
    terminalRead: { one: restoredReadOne.ok, two: restoredReadTwo.ok }
  }
  await page.screenshot({ path: path.join(OUT, 'a2-b6-after-reload.png') })

  // B6: a second F5 must keep 3 tabs + content.
  const f5At = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-layout', { timeout: 180_000 })
  const domF5 = await waitDom(
    page,
    (s) =>
      s.tabs.length === 3 &&
      s.strips >= 2 &&
      s.tabs.filter((t) => t.dataActive === 'true').length === 1,
    'f5-dom'
  )
  const readF5One = await waitForMarker(page, envId, created[0].handle, MARK_ONE, 'f5-one')
  const readF5Two = await waitForMarker(page, envId, created[1].handle, MARK_TWO, 'f5-two')
  result.steps.b6F5 = {
    ms: Date.now() - f5At,
    dom: {
      tabCount: domF5.tabs.length,
      strips: domF5.strips,
      active: domF5.tabs.filter((t) => t.dataActive === 'true').map((t) => t.id)
    },
    terminalRead: { one: readF5One.ok, two: readF5Two.ok }
  }
  await page.screenshot({ path: path.join(OUT, 'b6-f5-second.png') })

  // ---------- B7: return and reopen x3 ----------
  const reopens = []
  await page.close()
  let current = null
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const reopened = await openWorkspace(
      devContext,
      consolePage,
      projects.find((p) => p.key === 'zhangsan-demo').id,
      `reopen-${cycle}`
    )
    const cycleEnvId = (await getEnvId(reopened)) ?? envId
    const dom = await waitDom(
      reopened,
      (s) =>
        s.tabs.length === 3 &&
        s.strips >= 2 &&
        s.signInForm === false &&
        s.tabs.filter((t) => t.dataActive === 'true').length === 1,
      `reopen-${cycle}-dom`
    )
    let host = await waitForList(
      reopened,
      cycleEnvId,
      worktree,
      (s) =>
        (s.tabGroups ?? []).length >= 2 && (s.tabs ?? []).length === 3 && Boolean(s.activeTabId),
      `reopen-${cycle}-host`
    )
    await waitForAgreement(reopened, cycleEnvId, worktree, `reopen-${cycle}-agree`, 20_000)
    host = await waitForList(
      reopened,
      cycleEnvId,
      worktree,
      (s) =>
        (s.tabGroups ?? []).length >= 2 && (s.tabs ?? []).length === 3 && Boolean(s.activeTabId),
      `reopen-${cycle}-host-final`
    )
    const store = await storeState(reopened)
    const one = await waitForMarker(
      reopened,
      cycleEnvId,
      created[0].handle,
      MARK_ONE,
      `reopen-${cycle}-one`
    )
    const two = await waitForMarker(
      reopened,
      cycleEnvId,
      created[1].handle,
      MARK_TWO,
      `reopen-${cycle}-two`
    )
    const cycleHostParent = String(host.result.activeTabId ?? '').split('::')[0]
    reopens.push({
      cycle,
      dom: {
        tabCount: dom.tabs.length,
        strips: dom.strips,
        active: dom.tabs.filter((t) => t.dataActive === 'true').map((t) => t.id)
      },
      store: { activeTabId: store.activeTabIdByWorktree, groupCount: store.groups?.length ?? null },
      host: {
        tabCount: (host.result.tabs ?? []).length,
        groupCount: (host.result.tabGroups ?? []).length,
        activeTabId: host.result.activeTabId
      },
      agreement: {
        dom: dom.tabs.filter((t) => t.dataActive === 'true')[0]?.id ?? null,
        store: store.activeTabIdByWorktree,
        hostLocal: cycleHostParent ? localIdOf(cycleHostParent) : null
      },
      terminalRead: { one: one.ok, two: two.ok }
    })
    await reopened.screenshot({ path: path.join(OUT, `b7-reopen-${cycle}.png`) })
    current = reopened
    if (cycle < 3) await reopened.close()
  }
  result.steps.b7Reopens = reopens
  const workPage = current
  failurePage = workPage
  const workEnvId = (await getEnvId(workPage)) ?? envId

  // ---------- A3: close semantics spot check (host close -> group collapses, remaining markers survive) ----------
  const listA3Before = await hostCall(workPage, workEnvId, 'session.tabs.list', { worktree })
  const closeTarget = created[1] // second tab in the 2-tab group
  const a3Close = await hostCall(workPage, workEnvId, 'session.tabs.close', {
    worktree,
    tabId: closeTarget.parentTabId,
    reason: 'user'
  })
  const listA3After = await waitForList(
    workPage,
    workEnvId,
    worktree,
    (s) => (s.tabs ?? []).length === 2,
    'a3-close',
    30_000
  )
  const closedStillListed = (listA3After.result.tabs ?? []).some(
    (t) => t.parentTabId === closeTarget.parentTabId
  )
  const remainingGroupCount = (listA3After.result.tabGroups ?? []).length
  await workPage.reload({ waitUntil: 'domcontentloaded' })
  await workPage.waitForSelector('.app-layout', { timeout: 180_000 })
  const domA3 = await waitDom(workPage, (s) => s.tabs.length === 2, 'a3-dom')
  const readA3 = await waitForMarker(
    workPage,
    workEnvId,
    created[0].handle,
    MARK_ONE,
    'a3-remaining'
  )
  const hostA3 = await waitForList(
    workPage,
    workEnvId,
    worktree,
    (s) => (s.tabs ?? []).length === 2,
    'a3-host-final'
  )
  result.steps.a3Close = {
    before: {
      tabCount: (listA3Before.result.tabs ?? []).length,
      groupCount: (listA3Before.result.tabGroups ?? []).length
    },
    closedParent: closeTarget.parentTabId,
    closeOk: a3Close.ok,
    after: {
      tabCount: (listA3After.result.tabs ?? []).length,
      groupCount: remainingGroupCount,
      closedStillListed
    },
    dom: { tabCount: domA3.tabs.length, strips: domA3.strips },
    terminalReadRemaining: readA3.ok,
    hostFinal: {
      tabCount: (hostA3.result.tabs ?? []).length,
      groupCount: (hostA3.result.tabGroups ?? []).length
    }
  }
  await workPage.screenshot({ path: path.join(OUT, 'a3-close-semantics.png') })

  // ---------- B10: copy capture in the admin-surface embed -> audit search ----------
  let b10 = { skipped: 'embed workspace unavailable' }
  try {
    await consolePage.goto(
      BASE +
        `/#/workspace/${encodeURIComponent(projects.find((p) => p.key === 'zhangsan-demo')?.id ?? '')}`,
      { waitUntil: 'domcontentloaded' }
    )
    await consolePage.locator('.workspace-frame').waitFor({ state: 'visible', timeout: 60_000 })
    await sleep(4000)
    const frame = consolePage.frames().find((f) => f.url().includes('cloud-admin.html'))
    if (!frame) throw new Error('cloud-admin iframe frame not found')
    const node = frame.locator('[data-testid="cloud-workspace-file-tree-node-README.md"]').first()
    await node.waitFor({ state: 'visible', timeout: 45_000 })
    await node.click()
    const copyButton = frame
      .locator(
        '[data-testid="cloud-workspace-file-copy"], [data-testid="cloud-workspace-preview-copy"]'
      )
      .first()
    await copyButton.waitFor({ state: 'visible', timeout: 45_000 })
    const copyButtonId = await copyButton.getAttribute('data-testid')
    await copyButton.click()
    await sleep(2500)
    const copyStatusText = (await copyButton.textContent().catch(() => null))?.trim() ?? null
    // Audit chain ingestion is asynchronous; poll the admin API before the UI search.
    const adminLogin = await api(null, '/v1/auth/login', { method: 'POST', body: ADMIN })
    const adminToken = adminLogin.body?.accessToken
    const since = new Date(Date.now() - 24 * 3600_000).toISOString()
    let events = []
    for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
      const q = await api(
        adminToken,
        `/v1/audit/events?eventType=file_copy&fileName=${encodeURIComponent('README.md')}&since=${encodeURIComponent(since)}&limit=50`
      )
      events = q.body?.events ?? []
      if (events.length > 0) break
      await sleep(2000)
    }
    b10 = {
      embedUrl: frame.url().slice(0, 180),
      copyButtonId,
      copyStatusText,
      eventCount: events.length,
      events: events
        .slice(0, 5)
        .map((e) => ({
          seq: e.seq,
          eventType: e.eventType,
          actor: e.actor,
          result: e.result,
          fileName: e.metadata?.fileName,
          copyKind: e.metadata?.copyKind,
          capturePoint: e.metadata?.capturePoint,
          projectId: e.metadata?.projectId ?? e.projectId,
          hostId: e.metadata?.hostId ?? e.hostId
        }))
    }
    result.steps.b10 = b10
    await consolePage.screenshot({ path: path.join(OUT, 'b10-copy-embed.png') })
  } catch (e) {
    result.steps.b10 = { error: String(e).slice(0, 600) }
  }
  await workPage.close()

  // ---------- B8/B9: admin routing + permission cards ----------
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
  const adminProjects = (await api(adminToken, '/v1/projects')).body?.projects ?? []
  const adminHosts = (await api(adminToken, '/v1/hosts')).body?.hosts ?? []
  const target = adminProjects.find((p) => p.key === 'zhangsan-demo') ?? adminProjects[0]
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
  result.steps.routing = {
    projectId: target?.id ?? null,
    detailHash,
    beforeHash,
    afterHash,
    hashPreserved: beforeHash === detailHash && afterHash === detailHash,
    dialogVisible,
    dialogAfterReload: dialogAfter,
    members: { hash: membersHash, notFound }
  }

  // B9: host permission surface shows the three hierarchy cards on both hosts.
  const permCards = {}
  for (const host of adminHosts.filter((h) => ['dev-local-02', 'dev-local-03'].includes(h.name))) {
    try {
      await adminPage.goto(BASE + '/#/hosts', { waitUntil: 'domcontentloaded' })
      await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
      await adminPage.locator(`button[data-host="${host.id}"]`).first().click({ timeout: 30_000 })
      await adminPage.locator('.drawer').first().waitFor({ state: 'visible', timeout: 30_000 })
      await adminPage.locator('.drawer [data-auth-tab="perms"]').first().click({ timeout: 30_000 })
      await sleep(1200)
      permCards[host.name] = await adminPage.evaluate(() => {
        const cards = [...document.querySelectorAll('.drawer [data-perm-cards] > [data-card]')]
        return cards.map((card) => ({
          key: card.getAttribute('data-card'),
          label: card.querySelector('.perm-card-head strong')?.textContent ?? null,
          subjects: card.querySelectorAll('.perm-chip').length
        }))
      })
      await adminPage.keyboard.press('Escape')
      await sleep(400)
    } catch (e) {
      permCards[host.name] = { error: String(e).slice(0, 400) }
    }
  }
  result.steps.b9PermCards = permCards
  await adminPage.goto(BASE + '/#/hosts', { waitUntil: 'domcontentloaded' }).catch(() => {})
  if (
    await adminPage
      .locator('button[data-host]')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await adminPage
      .locator('button[data-host]')
      .first()
      .click()
      .catch(() => {})
    await adminPage
      .locator('.drawer')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .catch(() => {})
    await adminPage
      .locator('.drawer [data-auth-tab="perms"]')
      .first()
      .click()
      .catch(() => {})
    await sleep(800)
    await adminPage.screenshot({ path: path.join(OUT, 'b9-permission-cards.png') })
  }

  // B10 UI search (audit page) on the file_copy event.
  let auditUi = { skipped: 'no copied event' }
  if ((result.steps.b10?.eventCount ?? 0) > 0) {
    try {
      await adminPage.goto(BASE + '/#/audit?event=file_copy&fileName=README.md&range=24', {
        waitUntil: 'domcontentloaded'
      })
      await adminPage.locator('#view-app').waitFor({ state: 'visible', timeout: 60_000 })
      await adminPage
        .locator('#auditKeyword, #auditApply')
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 })
        .catch(() => {})
      let rows = []
      for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
        rows = await adminPage.evaluate(() =>
          [...document.querySelectorAll('table tbody tr')]
            .map((tr) => tr.textContent?.replace(/\s+/g, ' ').trim() ?? '')
            .filter((t) => t && !t.includes('没有符合筛选'))
        )
        if (rows.some((t) => t.includes('README.md'))) break
        await sleep(1000)
      }
      auditUi = {
        rows: rows.slice(0, 5),
        matched: rows.filter((t) => t.includes('README.md') && /复制|file_copy/.test(t)).length,
        filter: await adminPage.evaluate(() => ({
          event: document.querySelector('#auditType')?.value ?? null,
          fileName: document.querySelector('#auditFileName')?.value ?? null
        }))
      }
      await adminPage.screenshot({ path: path.join(OUT, 'b10-audit-search.png') })
    } catch (e) {
      auditUi = { error: String(e).slice(0, 500) }
    }
  }
  result.steps.b10AuditUi = auditUi

  // ---------- logout (admin) ----------
  await adminPage.goto(BASE + '/#/hosts', { waitUntil: 'domcontentloaded' }).catch(() => {})
  const logoutBtn = adminPage.locator('#logoutBtn')
  if (await logoutBtn.isVisible().catch(() => false)) {
    await logoutBtn.click()
    await adminPage.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  }
  const logout = await adminPage.evaluate(() => ({
    hash: location.hash,
    access: localStorage.getItem('orca.access'),
    refresh: localStorage.getItem('orca.refresh')
  }))
  result.steps.logout = logout
  await adminPage.screenshot({ path: path.join(OUT, 'b8-logout.png') })
  await adminContext.close()

  // ---------- gates (function) ----------
  const st = result.steps
  const baselineCounts = Object.fromEntries(
    Object.entries(st.baseline).map(([k, v]) => [k, v?.storeTabCount ?? v?.domTabCount ?? null])
  )
  result.measurements.baselineCounts = baselineCounts
  const agreed = (a) => Boolean(a?.dom && a.dom === a.store && a.store === a.hostLocal)
  result.gates = {
    baseline_probed_before_drill:
      Object.keys(baselineCounts).filter((k) => typeof baselineCounts[k] === 'number').length >= 3,
    a1_workspace_terminal: Boolean(
      st.a1?.appLayout && st.a1?.tabs?.length >= 1 && st.a1?.xterm >= 1
    ),
    a2_three_tabs_two_groups_before_reload:
      st.a2?.host?.tabCount === 3 &&
      st.a2?.host?.groupCount >= 2 &&
      st.a2?.terminalRead?.one === true &&
      st.a2?.terminalRead?.two === true,
    a2_reload_dom_store_host_agree:
      st.reloadRestore?.dom?.tabCount === 3 &&
      st.reloadRestore?.dom?.strips >= 2 &&
      st.reloadRestore?.dom?.active?.length === 1 &&
      st.reloadRestore?.agreementSettled?.ok === true &&
      st.reloadRestore?.dom?.visibility === 'visible' &&
      st.reloadRestore?.dom?.activePaneHeaders >= 1 &&
      st.reloadRestore?.store?.tabCount === 3 &&
      st.reloadRestore?.store?.groupCount >= 2 &&
      st.reloadRestore?.host?.groupCount >= 2,
    a2_reload_content_markers:
      st.reloadRestore?.terminalRead?.one === true && st.reloadRestore?.terminalRead?.two === true,
    b6_f5_restores_three_tabs_content:
      st.b6F5?.dom?.tabCount === 3 &&
      st.b6F5?.dom?.strips >= 2 &&
      st.b6F5?.terminalRead?.one === true &&
      st.b6F5?.terminalRead?.two === true,
    b7_reopen_three_times:
      st.b7Reopens?.length === 3 &&
      st.b7Reopens.every(
        (r) =>
          r.dom.tabCount === 3 &&
          r.dom.strips >= 2 &&
          r.host.groupCount >= 2 &&
          r.terminalRead.one &&
          r.terminalRead.two
      ),
    a3_close_semantics:
      st.a3Close?.closeOk === true &&
      st.a3Close?.after?.tabCount === 2 &&
      st.a3Close?.after?.closedStillListed === false &&
      st.a3Close?.hostFinal?.tabCount === 2 &&
      st.a3Close?.terminalReadRemaining === true,
    b8_deeplink_hash_preserved:
      st.routing?.hashPreserved === true && st.routing?.dialogAfterReload === true,
    b8_members_404:
      st.routing?.members?.hash === '#/members' && st.routing?.members?.notFound === true,
    b9_permission_three_cards: ['dev-local-02', 'dev-local-03'].every((name) => {
      const cards = st.b9PermCards?.[name]
      return (
        Array.isArray(cards) &&
        ['view', 'control', 'manage'].every((key) => cards.some((c) => c.key === key && c.label)) &&
        cards.length === 3
      )
    }),
    b10_copy_captured_and_auditable:
      (st.b10?.eventCount ?? 0) >= 1 &&
      st.b10.events.some((e) => e.eventType === 'file_copy' && e.fileName === 'README.md') &&
      (st.b10AuditUi?.matched ?? 0) >= 1,
    b8_logout_clears_hash:
      st.logout?.hash === '#/login' && st.logout?.access === null && st.logout?.refresh === null
  }
  result.ok = Object.values(result.gates).every(Boolean)
} catch (error) {
  result.ok = false
  result.failure = String(error).slice(0, 2000)
  if (failurePage)
    await failurePage.screenshot({ path: path.join(OUT, 'journey8-failure.png') }).catch(() => {})
} finally {
  fs.writeFileSync(path.join(OUT, 'journey8.json'), JSON.stringify(result, null, 2))
  await browser.close()
}
console.log(
  JSON.stringify({ ok: result.ok, gates: result.gates, failure: result.failure ?? null }, null, 2)
)
process.exit(result.ok ? 0 : 1)
