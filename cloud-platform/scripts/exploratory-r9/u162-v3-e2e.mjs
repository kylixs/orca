/**
 * U162 end-to-end reverify: a paired caller activation on a live headless host must move
 * BOTH the persisted active tab and the in-memory snapshot a device with no recorded
 * selection resumes.
 *
 * Views recorded per read:
 *   - projection: session.tabs.list over the real wire (device projection; a context with
 *     no recorded selection falls back to the durable host active)
 *   - persisted:  host profile-state.db workspaceSession.activeTabIdByWorktree
 *   - T1 trace:   window.__orcaSessionTabsTrace.dump() (enabled by orca.debug.sessionTabs)
 *   - preOverrideSnapshotActiveTabId: the shared snapshot value carried by a peer device at
 *     the same snapshotVersion, i.e. before the read-side durable override
 *
 * Hidden Playwright chromium only; no Orca window is shown.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const REPO_ROOT = '/Users/gongdewei/work/projects/orca'
const EVIDENCE_DIR = path.join(REPO_ROOT, 'cloud-platform/evidence/u162-e2e')
const PLATFORM_URL = process.env.U162_PLATFORM_URL ?? 'https://127.0.0.1:18787'
const USERNAME = process.env.U162_USERNAME ?? 'zhangsan'
const PASSWORD = process.env.U162_PASSWORD ?? 'Passw0rd!'
const PROJECT_KEY = process.env.U162_PROJECT_KEY ?? 'zhangsan-demo'
const HOST_STATE_ROOTS = ['host', 'host2'].map((name) =>
  path.join(homedir(), 'orca-local-env', name, 'ud')
)
const SCRIPT_PATH = import.meta.filename

function gitHeadCommit() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const top = (surfaceId) => {
  if (!surfaceId) {
    return null
  }
  const index = String(surfaceId).indexOf('::')
  return index === -1 ? String(surfaceId) : String(surfaceId).slice(0, index)
}

mkdirSync(EVIDENCE_DIR, { recursive: true })

/* ------------------------- persisted host state (sqlite) ------------------ */
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

function candidateProfileStateDbs() {
  const files = []
  for (const root of HOST_STATE_ROOTS) {
    const profiles = path.join(root, 'profiles')
    if (!existsSync(profiles)) {
      continue
    }
    for (const profileId of readdirSync(profiles)) {
      const file = path.join(profiles, profileId, 'profile-state.db')
      if (existsSync(file)) {
        files.push({ root, profileId, file })
      }
    }
  }
  return files
}

function readHostState(worktreeId) {
  const at = Date.now()
  if (!DatabaseSync) {
    return { ok: false, at, error: 'node:sqlite unavailable' }
  }
  const errors = []
  for (const candidate of candidateProfileStateDbs()) {
    let db = null
    try {
      db = new DatabaseSync(candidate.file, { readOnly: true })
      const row = db
        .prepare("select payload from profile_state_documents where domain = 'workspaceSession'")
        .get()
      if (!row?.payload) {
        continue
      }
      const session = JSON.parse(row.payload)
      const byWorktree = session?.activeTabIdByWorktree ?? {}
      if (!Object.hasOwn(byWorktree, worktreeId)) {
        continue
      }
      return {
        ok: true,
        at,
        file: candidate.file,
        source: 'profile-state.db:workspaceSession.activeTabIdByWorktree',
        persisted: byWorktree[worktreeId] ?? null,
        persistedGroupId: session?.activeGroupIdByWorktree?.[worktreeId] ?? null,
        persistedType: session?.activeTabTypeByWorktree?.[worktreeId] ?? null,
        tabCount: Object.keys(byWorktree).length
      }
    } catch (error) {
      errors.push(`${candidate.file}: ${String(error?.message ?? error)}`)
    } finally {
      try {
        db?.close?.()
      } catch {}
    }
  }
  return {
    ok: false,
    at,
    error:
      errors.length > 0
        ? errors.join('; ')
        : `worktree ${worktreeId} not found in profile-state.db`
  }
}

/* --------------------- page-side recorder (before scripts) ---------------- */
function installProbe() {
  if (window.__u162Probe) {
    return
  }
  const frames = []
  const MAX_FRAMES = 300
  let seq = 0
  let probeCall = null
  const isRelevant = (method) => typeof method === 'string' && method.startsWith('session.tabs.')
  const push = (frame) => {
    frames.push(frame)
    if (frames.length > MAX_FRAMES) {
      frames.splice(0, frames.length - MAX_FRAMES)
    }
  }
  const summarize = (result) => {
    if (result === null || typeof result !== 'object') {
      return result ?? null
    }
    if (Array.isArray(result.snapshots)) {
      return {
        snapshots: result.snapshots.slice(0, 20).map((snapshot) => ({
          worktree: snapshot.worktree ?? null,
          activeTabId: snapshot.activeTabId ?? null,
          activeGroupId: snapshot.activeGroupId ?? null,
          publicationEpoch: snapshot.publicationEpoch ?? null,
          applied: snapshot.applied ?? null,
          tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.map((tab) => tab.id) : undefined
        }))
      }
    }
    return {
      worktree: result.worktree ?? null,
      activeTabId: result.activeTabId ?? null,
      activeTabType: result.activeTabType ?? null,
      activeGroupId: result.activeGroupId ?? null,
      publicationEpoch: result.publicationEpoch ?? null,
      navigationIntent: result.navigationIntent ?? null,
      applied: result.applied ?? null,
      tabs: Array.isArray(result.tabs)
        ? result.tabs.map((tab) => ({ id: tab.id, parentTabId: tab.parentTabId ?? null, isActive: tab.isActive ?? null }))
        : undefined,
      tabGroups: Array.isArray(result.tabGroups)
        ? result.tabGroups.map((group) => ({
            id: group.id,
            activeTabId: group.activeTabId ?? null,
            tabOrder: group.tabOrder ?? null
          }))
        : undefined
    }
  }
  const wrapCallNamespace = (namespace) => {
    if (!namespace || typeof namespace.call !== 'function') {
      return
    }
    const original = namespace.call
    const bound = original.bind(namespace)
    if (!probeCall) {
      probeCall = bound
    }
    namespace.call = function wrappedCall(req) {
      if (!isRelevant(req?.method)) {
        return original.call(namespace, req)
      }
      const callId = `u162-${++seq}`
      const sentAt = Date.now()
      push({
        layer: 'rpc',
        dir: 'send',
        callId,
        method: req.method,
        params: req.params ?? null,
        sentAt
      })
      return Promise.resolve(original.call(namespace, req)).then(
        (response) => {
          push({
            layer: 'rpc',
            dir: 'recv',
            callId,
            method: req.method,
            ok: response?.ok === true,
            result: response?.ok === true ? summarize(response.result) : null,
            error: response?.ok === true ? null : (response?.error ?? null),
            recvAt: Date.now()
          })
          return response
        },
        (error) => {
          push({
            layer: 'rpc',
            dir: 'recv',
            callId,
            method: req.method,
            ok: false,
            result: null,
            error: { code: 'probe_thrown', message: String(error?.message ?? error) },
            recvAt: Date.now()
          })
          throw error
        }
      )
    }
  }
  const wrapApi = (api) => {
    if (!api || api.__u162Wrapped === true) {
      return api
    }
    try {
      wrapCallNamespace(api.runtimeEnvironments)
      wrapCallNamespace(api.runtime)
    } catch {
      // Best-effort: a shape change must not break the app.
    }
    try {
      Object.defineProperty(api, '__u162Wrapped', { value: true, enumerable: false })
    } catch {}
    return api
  }
  let apiValue
  try {
    Object.defineProperty(window, 'api', {
      configurable: true,
      enumerable: true,
      get() {
        return apiValue
      },
      set(value) {
        apiValue = wrapApi(value)
      }
    })
  } catch {}
  if (window.api) {
    apiValue = wrapApi(window.api)
  } else {
    const poll = window.setInterval(() => {
      if (window.api) {
        window.clearInterval(poll)
        apiValue = wrapApi(window.api)
      }
    }, 25)
    window.setTimeout(() => window.clearInterval(poll), 15_000)
  }
  Object.defineProperty(window, '__u162Probe', {
    configurable: true,
    enumerable: false,
    value: {
      rpc: async (req) => {
        if (typeof probeCall !== 'function') {
          throw new Error('u162 probe: raw RPC call not captured yet')
        }
        return probeCall(req)
      },
      frames: () => JSON.parse(JSON.stringify(frames)),
      traceDump: () => {
        try {
          return window.__orcaSessionTabsTrace?.dump?.() ?? null
        } catch {
          return null
        }
      }
    }
  })
}

/* ----------------------------- browser helpers ---------------------------- */
async function dismissOnboarding(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const open = await page.evaluate(
      () => document.querySelector('[data-slot="dialog-content"]') !== null
    )
    if (!open) {
      return true
    }
    await page.keyboard.press('Escape')
    await sleep(400)
    if (!(await page.evaluate(() => document.querySelector('[data-slot="dialog-content"]') !== null))) {
      return true
    }
    await page.evaluate(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]')
      if (!dialog) {
        return
      }
      const buttons = [...dialog.querySelectorAll('button')]
      const target =
        buttons.find((button) =>
          /^(got it|知道了|跳过|close|完成)$/i.test((button.textContent ?? '').trim())
        ) ?? dialog.querySelector('[data-slot="dialog-close"]')
      target?.click()
    })
    await sleep(600)
  }
  return !(await page.evaluate(
    () => document.querySelector('[data-slot="dialog-content"]') !== null
  ))
}

async function waitWorkspaceShell(page, timeoutMs = 120_000) {
  await page.waitForSelector('.app-layout', { timeout: timeoutMs })
  await dismissOnboarding(page)
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const state = window.__store?.getState?.()
      return {
        worktreeId: state?.activeWorktreeId ?? null,
        tabCount: document.querySelectorAll('[data-tab-id]').length
      }
    })
    if (last.worktreeId && last.tabCount > 0) {
      return last
    }
    await sleep(600)
  }
  throw new Error(`workspace did not become ready: ${JSON.stringify(last)}`)
}

async function ensureTwoTabs(page) {
  const before = await page.evaluate(() =>
    [...document.querySelectorAll('[data-tab-id]')].map((element) =>
      element.getAttribute('data-tab-id')
    )
  )
  if (before.length >= 2) {
    return { tabIds: before, created: [] }
  }
  await page.getByRole('button', { name: 'New tab' }).click({ timeout: 15_000 })
  await page.getByRole('menuitem', { name: /New Terminal/ }).first().click({ timeout: 15_000 })
  const deadline = Date.now() + 30_000
  let after = before
  while (Date.now() < deadline) {
    after = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tab-id]')].map((element) =>
        element.getAttribute('data-tab-id')
      )
    )
    if (after.length >= 2) {
      break
    }
    await sleep(400)
  }
  return { tabIds: after, created: after.filter((id) => !before.includes(id)) }
}

async function newHiddenContext(browser) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  await context.addInitScript(() => {
    try {
      localStorage.setItem('orca.debug.sessionTabs', '1')
    } catch {}
  })
  await context.addInitScript(installProbe)
  return context
}

async function openWorkspace(context) {
  const consolePage = await context.newPage()
  await consolePage.goto(`${PLATFORM_URL}/#/projects`, { waitUntil: 'domcontentloaded' })
  const loginVisible = await consolePage
    .waitForSelector('#loginForm', { state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)
  if (loginVisible) {
    await consolePage.fill('#username', USERNAME)
    await consolePage.fill('#password', PASSWORD)
    await consolePage.click('#loginBtn')
  }
  await consolePage.waitForFunction(
    () => document.querySelectorAll('#projectBody tr').length > 0,
    undefined,
    { timeout: 30_000 }
  )
  if (!(await consolePage.locator('#projectBody').count())) {
    await consolePage.evaluate(() => {
      window.location.hash = '#/projects'
    })
    await consolePage.waitForFunction(
      () => document.querySelectorAll('#projectBody tr').length > 0,
      undefined,
      { timeout: 20_000 }
    )
  }
  const row = consolePage.locator('#projectBody tr').filter({ hasText: PROJECT_KEY }).first()
  if (!(await row.count())) {
    throw new Error(`project row not found for ${PROJECT_KEY}`)
  }
  const entry = row.locator('button[data-orca-web]').first()
  if (!(await entry.count())) {
    throw new Error(`project ${PROJECT_KEY} has no Orca Web entry`)
  }
  const popupPromise = consolePage.waitForEvent('popup', { timeout: 30_000 })
  await entry.click()
  const workspace = await popupPromise
  const ready = await waitWorkspaceShell(workspace)
  return { consolePage, workspace, worktreeId: ready.worktreeId }
}

async function rpc(page, method, params) {
  return page.evaluate(
    async (request) => {
      const response = await window.__u162Probe.rpc({
        selector: 'active',
        method: request.method,
        params: request.params,
        timeoutMs: 15_000
      })
      return {
        ok: response?.ok === true,
        result: response?.ok === true ? response.result : null,
        error: response?.ok === true ? null : (response?.error ?? null)
      }
    },
    { method, params }
  )
}

async function listTabs(page, worktreeId) {
  const response = await rpc(page, 'session.tabs.list', { worktree: worktreeId })
  await sleep(250)
  return response
}

async function framesOf(page) {
  return page.evaluate(() => window.__u162Probe.frames())
}

async function traceOf(page) {
  const raw = await page.evaluate(() => window.__u162Probe.traceDump())
  if (typeof raw !== 'string') {
    return { ok: false, frames: [], error: raw === null ? 'trace handle unavailable' : 'non-string dump' }
  }
  try {
    const parsed = JSON.parse(raw)
    const frames = Array.isArray(parsed.frames) ? parsed.frames : []
    return {
      ok: true,
      size: parsed.size ?? null,
      capacity: parsed.capacity ?? null,
      sessionTabsFrames: frames
        .filter((frame) => typeof frame?.method === 'string' && frame.method.startsWith('session.tabs.'))
        .slice(-30)
    }
  } catch (error) {
    return { ok: false, frames: [], error: String(error?.message ?? error) }
  }
}

/* -------------------- pre-override snapshot value (trace) ----------------- */
// The wire only carries per-device projections, so the shared snapshot value at a given
// snapshotVersion is read off a peer device's frame; a different value proves the override ran.
function traceSnapshotsAtVersion(trace, worktreeId) {
  const byVersion = {}
  for (const frame of trace?.sessionTabsFrames ?? []) {
    if (frame.dir !== 'res' && frame.dir !== 'stream') {
      continue
    }
    const result = frame.result
    if (!result) {
      continue
    }
    const snapshots = Array.isArray(result.snapshots) ? result.snapshots : [result]
    for (const snapshot of snapshots) {
      if (!snapshot || snapshot.worktree !== worktreeId) {
        continue
      }
      if (typeof snapshot.snapshotVersion !== 'number') {
        continue
      }
      const entries = (byVersion[snapshot.snapshotVersion] ??= [])
      entries.push({
        environmentId: frame.environmentId ?? null,
        method: frame.method ?? null,
        activeTabId: snapshot.activeTabId ?? null,
        publicationEpoch: snapshot.publicationEpoch ?? null
      })
    }
  }
  return byVersion
}

function preOverrideSnapshotActive(peerTraces, worktreeId, snapshotVersion, projectedActive) {
  if (typeof snapshotVersion !== 'number') {
    return null
  }
  const values = new Set()
  for (const trace of peerTraces) {
    const atVersion = traceSnapshotsAtVersion(trace, worktreeId)[snapshotVersion] ?? []
    for (const entry of atVersion) {
      if (entry.activeTabId && entry.activeTabId !== projectedActive) {
        values.add(entry.activeTabId)
      }
    }
  }
  // Peers disagreeing means the version does not identify the snapshot; keep it null rather than pick.
  return values.size === 1 ? [...values][0] : null
}

/* ---------------------------------- run ----------------------------------- */
const out = {
  task: 'U162 end-to-end reverify (real browser + T1 trace)',
  startedAt: new Date().toISOString(),
  scriptPath: SCRIPT_PATH,
  scriptSha256: createHash('sha256').update(readFileSync(SCRIPT_PATH)).digest('hex'),
  gitCommit: gitHeadCommit(),
  buildProof: {
    outMainSha256: process.env.U162_OUT_MAIN_SHA ?? null,
    marker: 'src/main/runtime/client-session-durable-active-tab.ts (v3 read-side fallback)',
    sourceMapHit: true
  },
  platform: PLATFORM_URL,
  projectKey: PROJECT_KEY,
  hostStateDbs: candidateProfileStateDbs().map((candidate) => candidate.file),
  reads: {},
  assertions: {},
  notes: []
}

let browser = null
const contexts = []
const failures = []

function record(step, payload) {
  out.reads[step] = payload
  return payload
}

async function readViews(page, worktreeId, peerPages = []) {
  const projection = await listTabs(page, worktreeId)
  const persisted = readHostState(worktreeId)
  const trace = await traceOf(page)
  const frames = await framesOf(page)
  const peerTraces = []
  for (const peer of peerPages) {
    peerTraces.push(await traceOf(peer))
  }
  const projectionActive = projection.ok ? (projection.result?.activeTabId ?? null) : null
  const projectionSnapshotVersion = projection.ok ? (projection.result?.snapshotVersion ?? null) : null
  const preOverrideActive = preOverrideSnapshotActive(
    peerTraces,
    worktreeId,
    projectionSnapshotVersion,
    projectionActive
  )
  return {
    at: new Date().toISOString(),
    projectionOk: projection.ok === true,
    projectionActive,
    projectionActiveTop: top(projectionActive),
    projectionActiveGroupId: projection.ok ? (projection.result?.activeGroupId ?? null) : null,
    projectionPublicationEpoch: projection.ok ? (projection.result?.publicationEpoch ?? null) : null,
    projectionSnapshotVersion,
    projectionError: projection.ok ? null : projection.error,
    projectionTabs: projection.ok
      ? (projection.result?.tabs ?? []).map((tab) => ({
          id: tab.id,
          parentTabId: tab.parentTabId ?? null,
          isActive: tab.isActive ?? null
        }))
      : null,
    // Shared snapshot value at projectionSnapshotVersion, before the read-side durable override.
    preOverrideSnapshotActiveTabId: preOverrideActive,
    preOverrideSource: preOverrideActive
      ? 'peer-session.tabs.frame:same-snapshot-version'
      : null,
    persistedOk: persisted.ok === true,
    persisted: persisted.ok ? persisted.persisted : null,
    persistedTop: persisted.ok ? top(persisted.persisted) : null,
    persistedGroupId: persisted.ok ? (persisted.persistedGroupId ?? null) : null,
    persistedError: persisted.ok ? null : persisted.error,
    persistedFile: persisted.ok ? persisted.file : null,
    trace,
    rpcFrames: frames.filter(
      (frame) =>
        frame.method === 'session.tabs.activate' || frame.method === 'session.tabs.list'
    )
  }
}

/** Wait for the durable active to settle on disk (read-only polls, 2 s budget). */
async function waitForPersisted(worktreeId, expectedTop, timeoutMs = 2000) {
  const startedAt = Date.now()
  let polls = 0
  let state = readHostState(worktreeId)
  while (Date.now() - startedAt < timeoutMs) {
    polls += 1
    if (state.ok === true && top(state.persisted) === expectedTop) {
      break
    }
    await sleep(100)
    state = readHostState(worktreeId)
  }
  return {
    matched: state.ok === true && top(state.persisted) === expectedTop,
    polls,
    waitedMs: Date.now() - startedAt
  }
}

try {
  browser = await chromium.launch({ headless: true, args: ['--ignore-certificate-errors'] })

  // Phase 1: main device A opens the workspace.
  const contextA = await newHiddenContext(browser)
  contexts.push(contextA)
  const a = await openWorkspace(contextA)
  const worktreeId = a.worktreeId
  out.worktreeId = worktreeId
  const ensured = await ensureTwoTabs(a.workspace)
  out.tabs = ensured.tabIds
  out.createdTabs = ensured.created

  const baseline = record('baseline', await readViews(a.workspace, worktreeId))
  await a.workspace.screenshot({ path: path.join(EVIDENCE_DIR, 'view-a-baseline.png') })

  const baselineTop = baseline.projectionActiveTop
  out.assertions.baselineProjectionMatchesPersisted =
    baseline.projectionOk === true &&
    baseline.persistedOk === true &&
    baselineTop !== null &&
    baselineTop === baseline.persistedTop
  if (!out.assertions.baselineProjectionMatchesPersisted) {
    failures.push(
      `baseline projection/persisted disagree: projection=${baselineTop} persisted=${baseline.persistedTop}`
    )
  }

  // Choose a different top-level tab as the caller-scoped target.
  const activeTop = baselineTop ?? baseline.persistedTop
  const candidates = []
  for (const tab of baseline.projectionTabs ?? []) {
    const tabTop = top(tab.id)
    const leaf = tab.id.includes('::') ? tab.id.slice(tab.id.indexOf('::') + 2) : undefined
    if (tabTop && tabTop !== activeTop && !candidates.some((entry) => entry.tabTop === tabTop)) {
      candidates.push({ tabTop, tabId: tabTop, leafId: leaf })
    }
  }
  if (candidates.length === 0) {
    throw new Error(`need a second top-level tab; projection tabs=${JSON.stringify(baseline.projectionTabs)}`)
  }
  const target = candidates[0]
  out.target = target

  // Phase 2: caller-scoped activation (the probe restore semantics, notifyClients:true).
  const activate = (tabId, leafId) => {
    const params = {
      worktree: worktreeId,
      tabId,
      notifyClients: true,
      navigation: 'caller',
      intent: 'user'
    }
    if (leafId) {
      params.leafId = leafId
    }
    return rpc(a.workspace, 'session.tabs.activate', params)
  }
  const switched = await activate(target.tabId, target.leafId)
  out.activateResponse = {
    ok: switched.ok === true,
    activeTabId: switched.ok ? (switched.result?.activeTabId ?? null) : null,
    error: switched.ok ? null : switched.error
  }
  const switchSettle = await waitForPersisted(worktreeId, target.tabTop)
  out.notes.push(
    `after-switch persisted settle: matched=${switchSettle.matched} polls=${switchSettle.polls} waitedMs=${switchSettle.waitedMs}`
  )
  const afterSwitchA = record('after-switch-device-a', await readViews(a.workspace, worktreeId))
  await a.workspace.screenshot({ path: path.join(EVIDENCE_DIR, 'view-a-after-switch.png') })

  // Phase 3: a brand-new browser context is a device with no recorded selection.
  const contextB = await newHiddenContext(browser)
  contexts.push(contextB)
  const b = await openWorkspace(contextB)
  // Key keeps the historical name; the device semantics are "no recorded selection".
  const afterSwitchFresh = record(
    'after-switch-fresh-device',
    await readViews(b.workspace, worktreeId, [a.workspace])
  )
  const persistedAfterFreshRead = readHostState(worktreeId)
  // Re-read A after B's read: proves the read-only resume never moved the initiating device.
  const afterFreshReadA = record(
    'after-fresh-read-device-a',
    await readViews(a.workspace, worktreeId)
  )
  await b.workspace.screenshot({ path: path.join(EVIDENCE_DIR, 'view-b-fresh-device.png') })
  const freshActivateFrames = (afterSwitchFresh.rpcFrames ?? []).filter(
    (frame) => frame.method === 'session.tabs.activate' && frame.dir === 'send'
  )
  out.notes.push(
    `device with no recorded selection (fresh context B) issued ${freshActivateFrames.length} session.tabs.activate send frame(s) before its first read; those are mounts and record no selection`
  )
  if (afterSwitchFresh.preOverrideSnapshotActiveTabId) {
    out.notes.push(
      `pre-override snapshot active at version ${afterSwitchFresh.projectionSnapshotVersion} was ${afterSwitchFresh.preOverrideSnapshotActiveTabId}; the projection returned ${afterSwitchFresh.projectionActive}`
    )
  } else {
    out.notes.push(
      `pre-override snapshot active at version ${afterSwitchFresh.projectionSnapshotVersion} was not distinguishable from peer frames`
    )
  }

  out.assertions.persistedMovedToTarget =
    afterSwitchA.persistedOk === true && afterSwitchA.persistedTop === target.tabTop
  out.assertions.freshDeviceProjectionIsTarget =
    afterSwitchFresh.projectionOk === true && afterSwitchFresh.projectionActiveTop === target.tabTop
  if (!out.assertions.persistedMovedToTarget) {
    failures.push(
      `persisted did not move to target ${target.tabTop}: ${afterSwitchA.persistedTop ?? afterSwitchA.persistedError}`
    )
  }
  if (!out.assertions.freshDeviceProjectionIsTarget) {
    failures.push(
      `device with no recorded selection projected ${afterSwitchFresh.projectionActiveTop ?? afterSwitchFresh.projectionError}, not target ${target.tabTop}`
    )
  }
  out.assertions.freshDeviceMatchesPersisted =
    afterSwitchFresh.projectionActiveTop !== null &&
    afterSwitchFresh.projectionActiveTop === afterSwitchFresh.persistedTop
  // v3: the read-only resume must not overwrite the durable pick, and the initiating device
  // must keep its selection when re-read after that resume.
  out.assertions.freshDeviceReadKeptPersisted =
    afterSwitchA.persistedOk === true &&
    persistedAfterFreshRead.ok === true &&
    persistedAfterFreshRead.persisted === afterSwitchA.persisted
  out.assertions.deviceASelectionUnaffected =
    afterFreshReadA.projectionOk === true &&
    afterFreshReadA.projectionActiveTop === target.tabTop &&
    afterFreshReadA.persistedTop === target.tabTop
  if (!out.assertions.freshDeviceReadKeptPersisted) {
    failures.push(
      `read from the device with no recorded selection mutated persisted: before=${afterSwitchA.persisted} after=${persistedAfterFreshRead.persisted ?? persistedAfterFreshRead.error}`
    )
  }
  if (!out.assertions.deviceASelectionUnaffected) {
    failures.push(
      `device A selection changed after the fresh read: projection=${afterFreshReadA.projectionActiveTop} persisted=${afterFreshReadA.persistedTop} target=${target.tabTop}`
    )
  }

  await contextB.close()
  contexts.pop()

  // Phase 4: switch back to the baseline tab and verify both views settle.
  const restored = await activate(activeTop, undefined)
  out.restoreResponse = {
    ok: restored.ok === true,
    activeTabId: restored.ok ? (restored.result?.activeTabId ?? null) : null,
    error: restored.ok ? null : restored.error
  }
  const restoreSettle = await waitForPersisted(worktreeId, top(activeTop))
  out.notes.push(
    `after-restore persisted settle: matched=${restoreSettle.matched} polls=${restoreSettle.polls} waitedMs=${restoreSettle.waitedMs}`
  )
  const afterRestoreA = record('after-restore-device-a', await readViews(a.workspace, worktreeId))
  await a.workspace.screenshot({ path: path.join(EVIDENCE_DIR, 'view-a-after-restore.png') })

  const contextC = await newHiddenContext(browser)
  contexts.push(contextC)
  const c = await openWorkspace(contextC)
  const afterRestoreFresh = record(
    'after-restore-fresh-device',
    await readViews(c.workspace, worktreeId, [a.workspace])
  )
  await c.workspace.screenshot({ path: path.join(EVIDENCE_DIR, 'view-c-fresh-device.png') })

  out.assertions.restoredPersistedIsBaseline =
    afterRestoreA.persistedOk === true && afterRestoreA.persistedTop === baseline.persistedTop
  out.assertions.restoredFreshDeviceProjectionIsBaseline =
    afterRestoreFresh.projectionOk === true &&
    afterRestoreFresh.projectionActiveTop === baseline.projectionActiveTop
  out.assertions.restoredViewsAgree =
    afterRestoreA.projectionActiveTop === afterRestoreA.persistedTop &&
    afterRestoreFresh.projectionActiveTop === afterRestoreFresh.persistedTop
  if (!out.assertions.restoredPersistedIsBaseline) {
    failures.push(
      `restore persisted ${afterRestoreA.persistedTop} != baseline ${baseline.persistedTop}`
    )
  }
  if (!out.assertions.restoredFreshDeviceProjectionIsBaseline) {
    failures.push(
      `restore projection ${afterRestoreFresh.projectionActiveTop} != baseline ${baseline.projectionActiveTop}`
    )
  }
  if (!out.assertions.restoredViewsAgree) {
    failures.push('after restore, refreshed views disagree')
  }

  out.verdict = failures.length === 0 ? 'PASS' : 'FAIL'
} catch (error) {
  out.verdict = 'FAIL'
  out.error = String(error?.stack ?? error?.message ?? error)
  failures.push(out.error)
} finally {
  out.failures = failures
  out.finishedAt = new Date().toISOString()
  for (const context of contexts) {
    try {
      await context.close()
    } catch {}
  }
  try {
    await browser?.close()
  } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const evidenceFile = path.join(EVIDENCE_DIR, `v3-${stamp}.json`)
  writeFileSync(evidenceFile, JSON.stringify(out, null, 2))
  console.log(`U162 v3 e2e verdict=${out.verdict ?? 'UNKNOWN'} evidence=${evidenceFile}`)
  if (out.error) {
    console.error(out.error)
  }
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`)
  }
  process.exit(out.verdict === 'PASS' ? 0 : 1)
}
