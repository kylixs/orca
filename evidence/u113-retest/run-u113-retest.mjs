#!/usr/bin/env node
// U113/G18 A-retest matrix: 2 groups x 3 tabs x dual markers, 3 rounds each of
// F5 reload / close-page reopen / second open. Host/DOM/store active = observation only.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const OUT = path.resolve('evidence/u113-retest')
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const STAMP = Date.now()
const MARK_ONE = `U113-RT-ONE-${STAMP}`
const MARK_TWO = `U113-RT-TWO-${STAMP}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const result = {
  base: BASE,
  stamp: STAMP,
  markers: { one: MARK_ONE, two: MARK_TWO },
  setup: {},
  rounds: [],
  observations: {},
  errors: [],
  gates: {},
  ok: false
}

const tabState = (page) =>
  page.evaluate(() => ({
    appLayout: document.querySelector('.app-layout') !== null,
    signInForm: document.querySelector('#web-cloud-api-url') !== null,
    tabs: [...document.querySelectorAll('[data-testid="sortable-tab"]')].map((el) => ({
      id: el.getAttribute('data-tab-id'),
      title: el.getAttribute('data-tab-title'),
      dataActive: el.getAttribute('data-active'),
      visible: el.offsetParent !== null
    })),
    strips: document.querySelectorAll('.terminal-tab-strip').length,
    xterm: document.querySelectorAll('.xterm').length,
    termText: [...document.querySelectorAll('.xterm-rows')]
      .map((el) => el.textContent ?? '')
      .join('\n')
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

async function login(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.locator('#loginForm').waitFor({ state: 'visible', timeout: 30_000 })
  const resp = page.waitForResponse((r) => /\/v1\/auth\/login/.test(r.url()))
  await page.fill('#username', DEV.username)
  await page.fill('#password', DEV.password)
  await page.click('#loginBtn')
  const res = await resp
  await page.locator('#view-app').waitFor({ state: 'visible', timeout: 30_000 })
  return { status: res.status(), ok: res.ok() }
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

async function hostCall(popup, envId, method, params) {
  return popup.evaluate(
    async ({ envId, method, params }) => {
      const reply = await window.api.runtimeEnvironments.call({
        selector: envId,
        method,
        params,
        timeoutMs: 60_000
      })
      return reply.ok ? { ok: true, result: reply.result } : { ok: false, error: reply.error }
    },
    { envId, method, params }
  )
}

async function getEnvId(popup) {
  const envs = await popup.evaluate(() => window.api.runtimeEnvironments.list())
  return envs[0]?.id ?? null
}

async function waitForList(popup, envId, worktree, predicate, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    last = await hostCall(popup, envId, 'session.tabs.list', { worktree })
    if (last.ok && predicate(last.result)) return last
    if (Date.now() > deadline)
      throw new Error(`${label}: tabs.list timeout ${JSON.stringify(last).slice(0, 500)}`)
    await sleep(300)
  }
}

async function waitForMarker(popup, envId, handle, marker, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let tail = ''
  for (;;) {
    const read = await hostCall(popup, envId, 'terminal.read', { terminal: handle, limit: 300 })
    tail = (read.ok ? (read.result?.terminal?.tail ?? []) : []).join('\n')
    if (tail.includes(marker)) return { ok: true }
    if (Date.now() > deadline) return { ok: false, label, tail: tail.slice(-300) }
    await sleep(300)
  }
}

function localIdOf(parentTabId) {
  return `web-terminal-${encodeURIComponent(parentTabId)}`
}

async function waitDom(popup, predicate, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  for (;;) {
    state = await tabState(popup)
    if (predicate(state)) return state
    if (Date.now() > deadline)
      throw new Error(`${label}: DOM timeout ${JSON.stringify(state).slice(0, 600)}`)
    await sleep(300)
  }
}

async function waitStore(popup, predicate, label, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  let state = null
  for (;;) {
    state = await storeState(popup)
    if (predicate(state)) return state
    if (Date.now() > deadline)
      throw new Error(`${label}: store timeout ${JSON.stringify(state).slice(0, 600)}`)
    await sleep(300)
  }
}


async function dismissTips(page, windowMs = 12_000) {
  const deadline = Date.now() + windowMs
  let closed = 0
  let lastAction = 0
  while (Date.now() < deadline) {
    const dialog = page.locator('[role="dialog"]').first()
    if ((await dialog.count()) > 0 && (await dialog.isVisible().catch(() => false))) {
      const close = dialog.locator('[data-slot="dialog-close"]').first()
      if (await close.count()) await close.click({ timeout: 3000 }).catch(() => {})
      else await page.keyboard.press('Escape')
      closed += 1
      lastAction = Date.now()
      await sleep(600)
    } else {
      if (closed > 0 && Date.now() - lastAction > 1500) break
      await sleep(400)
    }
  }
  return closed
}

// Assert one settled state: 3 tabs / 2 groups / both markers. Observations recorded, not gated.
async function assertRound(page, envId, worktree, handles, phase, scenario, round) {
  const dom = await waitDom(
    page,
    (s) =>
      s.appLayout &&
      s.signInForm === false &&
      s.tabs.length === 3 &&
      s.strips >= 2 &&
      s.tabs.filter((t) => t.dataActive === 'true').length === 1,
    `${phase}-dom`
  )
  const store = await waitStore(
    page,
    (s) => (s.tabs?.length ?? 0) === 3 && (s.groups?.length ?? 0) >= 2,
    `${phase}-store`
  )
  const host = await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabs ?? []).length === 3 && (s.tabGroups ?? []).length >= 2 && Boolean(s.activeTabId),
    `${phase}-host`
  )
  const one = await waitForMarker(page, envId, handles.one, MARK_ONE, `${phase}-one`)
  const two = await waitForMarker(page, envId, handles.two, MARK_TWO, `${phase}-two`)

  const domActive = dom.tabs.filter((t) => t.dataActive === 'true')[0]?.id ?? null
  const hostParent = String(host.result.activeTabId ?? '').split('::')[0]
  const domHasBothMarkers = dom.termText.includes(MARK_ONE) && dom.termText.includes(MARK_TWO)

  const checks = {
    app_layout: dom.appLayout === true,
    signed_in: dom.signInForm === false,
    tabs_3: dom.tabs.length === 3,
    groups_2: (host.result.tabGroups ?? []).length >= 2 && (store.groups?.length ?? 0) >= 2,
    single_active: dom.tabs.filter((t) => t.dataActive === 'true').length === 1,
    marker_one_readable: one.ok === true,
    marker_two_readable: two.ok === true
  }
  const pass = Object.values(checks).every(Boolean)
  const entry = {
    scenario,
    round,
    phase,
    checks,
    pass,
    observation: {
      host: {
        tabs: (host.result.tabs ?? []).length,
        groups: (host.result.tabGroups ?? []).length,
        activeTabId: host.result.activeTabId ?? null,
        activeParent: hostParent
      },
      dom: {
        tabs: dom.tabs.length,
        strips: dom.strips,
        xterm: dom.xterm,
        active: domActive,
        activeEqualsStore: domActive === store.activeTabIdByWorktree,
        activeEqualsHost: domActive === (hostParent ? localIdOf(hostParent) : null),
        bothMarkersVisible: domHasBothMarkers
      },
      store: {
        tabs: store.tabs?.length ?? null,
        groups: store.groups?.length ?? null,
        activeTabId: store.activeTabIdByWorktree,
        activeGroupId: store.activeGroupIdByWorktree
      }
    }
  }
  const tipsClosed = await dismissTips(page, 12_000)
  entry.observation.tipsClosed = tipsClosed
  await page.screenshot({ path: path.join(OUT, `round-${round}-${scenario}.png`) })
  return entry
}

const browser = await chromium.launch({ headless: true })
let failurePage = null
try {
  fs.mkdirSync(OUT, { recursive: true })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  const consolePage = await context.newPage()
  failurePage = consolePage
  consolePage.setDefaultTimeout(60_000)
  consolePage.on('dialog', (d) => d.accept())
  result.setup.login = await login(consolePage)
  const token = await consolePage.evaluate(() => localStorage.getItem('orca.access'))
  const projectsResp = await consolePage.evaluate(async () => {
    const t = localStorage.getItem('orca.access')
    const r = await fetch('/v1/projects', { headers: { authorization: `Bearer ${t}` } })
    return r.ok ? (await r.json()).projects : []
  })
  const project = projectsResp.find((p) => p.key === 'zhangsan-demo')
  if (!project) throw new Error('zhangsan-demo not visible')
  result.setup.project = { id: project.id, key: project.key, hostId: project.hostId, token: Boolean(token) }

  let page = await openWorkspace(context, consolePage, project.id, 'setup-open')
  failurePage = page
  await waitDom(page, (s) => s.appLayout && s.tabs.length >= 1, 'setup-a1')
  const envId = await getEnvId(page)
  const store0 = await storeState(page)
  if (!envId || !store0.activeWorktreeId) throw new Error('host env or worktree missing')
  const worktree = `id:${store0.activeWorktreeId}`
  result.setup.env = { envId, activeWorktreeId: store0.activeWorktreeId, worktree }

  // ---------- deterministic setup: retire to 1 tab, add 2, split into 2 groups ----------
  const list0 = await hostCall(page, envId, 'session.tabs.list', { worktree })
  const tabs0 = list0.result?.tabs ?? []
  const keepParent = list0.result?.activeTabId?.split('::')[0] ?? tabs0[0]?.parentTabId
  let liveParentIds = new Set(tabs0.map((t) => t.parentTabId ?? t.id))
  const retired = []
  for (const t of tabs0) {
    const parent = t.parentTabId ?? t.id
    if (parent === keepParent) continue
    if (!liveParentIds.has(parent)) continue
    const r = await hostCall(page, envId, 'session.tabs.close', {
      worktree,
      tabId: parent,
      reason: 'user'
    })
    retired.push({ parent, ok: r.ok })
    liveParentIds.delete(parent)
  }
  const list1 = await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabs ?? []).length === 1,
    'retire-to-one'
  )
  const ids1 = new Set((list1.result?.tabs ?? []).map((t) => t.id))
  const created = []
  for (const index of [1, 2]) {
    const r = await hostCall(page, envId, 'terminal.create', {
      worktree,
      title: `U113 terminal ${index}`,
      tabId: `u113-tab-${STAMP}-${index}`,
      leafId: `u113-leaf-${STAMP}-${index}`
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
    'three-tabs'
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
  if (!sourceGroup) throw new Error('no source group')
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
    'split-group'
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
  const activate = await hostCall(page, envId, 'session.tabs.activate', {
    worktree,
    tabId: created[0].surfaceId
  })
  if (!activate.ok) throw new Error(`activate: ${JSON.stringify(activate.error)}`)
  for (const entry of created) {
    await hostCall(page, envId, 'terminal.send', {
      terminal: entry.handle,
      text: `printf '${entry.marker}\\n'\r`
    })
  }
  const seedOne = await waitForMarker(page, envId, created[0].handle, MARK_ONE, 'seed-one')
  const seedTwo = await waitForMarker(page, envId, created[1].handle, MARK_TWO, 'seed-two')
  if (!seedOne.ok || !seedTwo.ok) throw new Error('seed markers unreadable')
  await waitForList(
    page,
    envId,
    worktree,
    (s) => (s.tabs ?? []).length === 3 && (s.tabGroups ?? []).length >= 2,
    'seed-settled'
  )
  const handles = { one: created[0].handle, two: created[1].handle }
  result.setup.retire = { baselineTabs: tabs0.length, keepParent, retired }
  result.setup.seeded = {
    tabCount: 3,
    groupCount: 2,
    markers: { one: MARK_ONE, two: MARK_TWO },
    handles,
    terminalTabIds: created.map((c) => c.parentTabId),
    groups: (list3.result?.tabGroups ?? []).map((g) => ({ id: g.id, tabOrder: g.tabOrder }))
  }
  await page.screenshot({ path: path.join(OUT, 'setup-3tabs-2groups.png') })

  // ---------- matrix: per round F5 -> close/reopen -> second open ----------
  for (let round = 1; round <= 3; round += 1) {
    // (2) F5 refresh on the current page
    let f5Entry
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.app-layout', { timeout: 180_000 })
      f5Entry = await assertRound(page, envId, worktree, handles, `r${round}-f5`, 'f5', round)
    } catch (e) {
      f5Entry = { scenario: 'f5', round, pass: false, error: String(e).slice(0, 800) }
      result.errors.push({ phase: `r${round}-f5`, kind: 'assert', text: String(e).slice(0, 800) })
    }
    result.rounds.push(f5Entry)

    // (1) close page -> reopen (first open of the round)
    let closeEntry
    try {
      await page.close()
      page = await openWorkspace(context, consolePage, project.id, `r${round}-close-reopen`)
      failurePage = page
      const cycleEnvId = (await getEnvId(page)) ?? envId
      closeEntry = await assertRound(
        page,
        cycleEnvId,
        worktree,
        handles,
        `r${round}-close-reopen`,
        'close-reopen',
        round
      )
    } catch (e) {
      closeEntry = {
        scenario: 'close-reopen',
        round,
        pass: false,
        error: String(e).slice(0, 800)
      }
      result.errors.push({
        phase: `r${round}-close-reopen`,
        kind: 'assert',
        text: String(e).slice(0, 800)
      })
    }
    result.rounds.push(closeEntry)

    // (3) close again -> open again (second open)
    let secondEntry
    try {
      await page.close()
      page = await openWorkspace(context, consolePage, project.id, `r${round}-second-open`)
      failurePage = page
      const cycleEnvId = (await getEnvId(page)) ?? envId
      secondEntry = await assertRound(
        page,
        cycleEnvId,
        worktree,
        handles,
        `r${round}-second-open`,
        'second-open',
        round
      )
    } catch (e) {
      secondEntry = {
        scenario: 'second-open',
        round,
        pass: false,
        error: String(e).slice(0, 800)
      }
      result.errors.push({
        phase: `r${round}-second-open`,
        kind: 'assert',
        text: String(e).slice(0, 800)
      })
    }
    result.rounds.push(secondEntry)
  }

  // ---------- gates ----------
  const byScenario = (name) => result.rounds.filter((r) => r.scenario === name)
  for (const name of ['f5', 'close-reopen', 'second-open']) {
    const runs = byScenario(name)
    result.gates[`${name}_3_rounds_pass`] = runs.length === 3 && runs.every((r) => r.pass)
  }
  result.gates.all_9_rounds_pass =
    result.rounds.length === 9 && result.rounds.every((r) => r.pass)
  result.ok = result.gates.all_9_rounds_pass
} catch (e) {
  result.errors.push({ kind: 'fatal', text: String(e).slice(0, 1200) })
  result.ok = false
  if (failurePage) await failurePage.screenshot({ path: path.join(OUT, 'fatal.png') }).catch(() => {})
} finally {
  await browser.close().catch(() => {})
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: result.ok, gates: result.gates, rounds: result.rounds.map((r) => ({ scenario: r.scenario, round: r.round, pass: r.pass, error: r.error?.slice(0, 150) })), errors: result.errors.slice(0, 10) }, null, 2))
}
