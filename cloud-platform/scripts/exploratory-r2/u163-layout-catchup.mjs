/**
 * U163 V8a-1 real-stack harness — scenario A: first-open baseline + focus catch-up 1→2.
 *
 * Build/run from an isolated snapshot worktree (never the main tree's out/):
 *   U163_BUILD_ROOT=/tmp/orca-u163a-<ts> node cloud-platform/scripts/exploratory-r2/u163-layout-catchup.mjs
 *
 * Launch rules (AGENTS.md): ORCA_BACKGROUND_LAUNCH=1, ORCA_E2E_HEADLESS=1, isolated HOME/userData,
 * never show()/focus()/OS activation. The focus edge is the real window `focus` DOM event (the same
 * one the V5 hook listens to); headless hidden windows cannot receive OS focus, so `hasFocus` is
 * fixtured only when Chromium reports false (recorded in evidence).
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { _electron as electron } from '@stablyai/playwright-test'
import { createElectronHomeIsolation } from '../../../tests/e2e/helpers/electron-home-isolation.ts'
import { getOrcaElectronLaunchArgs } from '../../../tests/e2e/helpers/electron-launch-args.ts'

const REPO = '/Users/gongdewei/work/projects/orca'
const BUILD_ROOT = process.env.U163_BUILD_ROOT
if (!BUILD_ROOT) {
  throw new Error('U163_BUILD_ROOT is required (snapshot worktree)')
}
const STAMP = process.env.U163_STAMP || String(Date.now())
const RUN_DIR = path.join('/tmp', `u163a-${STAMP}`)
const PROFILE = path.join(RUN_DIR, 'profile')
const REPO_PATH = path.join(RUN_DIR, 'repo')
const EVIDENCE = path.join(REPO, 'cloud-platform/evidence', `u163-v8a1-${STAMP}`)
mkdirSync(EVIDENCE, { recursive: true })
mkdirSync(RUN_DIR, { recursive: true })

let APP = null
const out = {
  case: 'U163 V8a-1 scenario A',
  stamp: STAMP,
  buildRoot: BUILD_ROOT,
  steps: [],
  samples: {},
  assertions: {},
  console: []
}
const record = (step, detail) => {
  out.steps.push({ step, at: new Date().toISOString(), detail })
  try {
    writeEvidence()
  } catch {}
}
function writeEvidence() {
  writeFileSync(path.join(EVIDENCE, 'u163-v8a1.json'), JSON.stringify(out, null, 2))
}

function cleanEnv(keys) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) {
    if (keys.includes(key)) {
      delete env[key]
    }
  }
  return env
}

const dbPath = () => path.join(PROFILE, 'profiles/local-default/profile-state.db')

function readSessionRow() {
  const raw = execSync(
    `sqlite3 -json "${dbPath()}" "select payload, domain_version, revision, updated_at, content_hash from profile_state_documents where domain='workspaceSession'"`
  ).toString()
  return JSON.parse(raw)[0]
}

function restoreSessionRow(row) {
  const esc = (v) => String(v).replace(/'/g, "''")
  execSync(`sqlite3 "${dbPath()}"`, {
    input: `update profile_state_documents set payload='${esc(row.payload)}', domain_version=${row.domain_version}, revision=${row.revision}, updated_at=${row.updated_at}, content_hash='${esc(row.content_hash)}' where domain='workspaceSession';`
  })
}

async function closeApp(app) {
  if (!app) {
    return
  }
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 6000))])
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {})
  await new Promise((r) => setTimeout(r, 300))
}

async function launch(label) {
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv([
      'ORCA_CLOUD_API_URL',
      'ORCA_DEFAULT_PLATFORM_URL',
      'REMOTE_DEBUGGING_PORT'
    ]),
    launchEnv: { NODE_ENV: 'development' },
    extraEnv: {},
    userDataDir: PROFILE
  })
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(BUILD_ROOT, 'out', 'main', 'index.js'), false),
    env: {
      ...isolation.env,
      ORCA_E2E_HEADLESS: '1',
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1',
      ...(process.env.ORCA_CLOUD_API_URL
        ? { ORCA_CLOUD_API_URL: process.env.ORCA_CLOUD_API_URL }
        : {})
    },
    timeout: 120_000
  })
  APP = app
  const page = await app.firstWindow({ timeout: 120_000 })
  page.on('console', (m) => {
    if (out.console.length < 400) {
      out.console.push(`${label}:${m.type()}: ${m.text().slice(0, 300)}`)
    }
  })
  page.on('pageerror', (e) => out.console.push(`${label}:pageerror: ${String(e).slice(0, 300)}`))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForSelector('.app-layout', { timeout: 120_000 })
  await page.waitForTimeout(1200)
  return { app, page, label }
}

async function dismissOnboarding(page) {
  const present = await page.evaluate(() =>
    Boolean(document.querySelector('[data-onboarding-overlay]'))
  )
  if (!present) {
    return
  }
  await page.evaluate(() => document.querySelector('[data-onboarding-overlay]')?.remove?.())
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(300)
}

async function hostCall(page, method, params) {
  return page.evaluate(
    async ({ method, params }) => {
      const reply = await window.api.runtime.call({ method, params })
      return reply?.ok
        ? { ok: true, result: reply.result }
        : { ok: false, error: reply?.error ?? reply }
    },
    { method, params }
  )
}

async function hostList(page, worktree) {
  const r = await hostCall(page, 'session.tabs.list', { worktree })
  if (!r.ok) {
    return r
  }
  const l = r.result ?? {}
  return {
    ok: true,
    groups: (l.tabGroups ?? []).map((g) => ({
      id: g.id,
      activeTabId: g.activeTabId,
      tabOrder: g.tabOrder
    })),
    layout: l.tabGroupLayout,
    tabs: (l.tabs ?? []).map((t) => ({ parentTabId: t.parentTabId, title: t.title, type: t.type }))
  }
}

async function sample(page, label, worktree) {
  const host = await hostList(page, worktree)
  const local = await page.evaluate((wt) => {
    const s = window.__store?.getState?.()
    if (!s) {
      return { exposed: false }
    }
    return {
      exposed: true,
      focused: document.hasFocus(),
      visibility: document.visibilityState,
      activeWorktreeId: s.activeWorktreeId,
      activeGroupId: s.activeGroupIdByWorktree?.[wt] ?? null,
      activeTabId: s.activeTabIdByWorktree?.[wt] ?? null,
      groups: (s.groupsByWorktree?.[wt] ?? []).map((g) => ({
        id: g.id,
        activeTabId: g.activeTabId,
        tabOrder: g.tabOrder
      })),
      tabs: (s.tabsByWorktree?.[wt] ?? []).map((t) => ({ id: t.id }))
    }
  }, worktree)
  const dom = await page.evaluate(() => {
    const strips = [...document.querySelectorAll('.terminal-tab-strip')]
    return {
      strips: strips.length,
      groups: strips.map((el) => ({
        groupId:
          el.getAttribute('data-group-id') ??
          el.closest('[data-group-id]')?.getAttribute('data-group-id') ??
          null,
        worktreeId: el.getAttribute('data-worktree-id') ?? null
      })),
      bodies: document.querySelectorAll('[data-group-body], .tab-group-body').length
    }
  }, worktree)
  const v = {
    label,
    at: new Date().toISOString(),
    hostGroups: host.ok ? host.groups.length : null,
    host,
    storeGroups: local.groups?.length ?? null,
    local,
    domStrips: dom.strips,
    dom
  }
  out.samples[label] = v
  record(`sample:${label}`, {
    hostGroups: v.hostGroups,
    storeGroups: v.storeGroups,
    domStrips: v.domStrips,
    focused: local.focused,
    visibility: local.visibility
  })
  return v
}

async function seedRepoAndOpen(page) {
  out.repoPath = REPO_PATH
  const ids = await page.evaluate(async (repoPath) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store unavailable')
    }
    const added = await store.getState().addRepoPath(repoPath)
    if (!added) {
      throw new Error('addRepoPath failed')
    }
    await store.getState().updateRepo(added.id, { externalWorktreeVisibility: 'show' })
    return { repoId: added.id }
  }, REPO_PATH)
  for (let i = 0; i < 40; i += 1) {
    const n = await page.evaluate(async (repoId) => {
      await window.__store.getState().fetchWorktrees(repoId)
      return window.__store.getState().worktreesByRepo[repoId]?.length ?? 0
    }, ids.repoId)
    if (n > 0) {
      break
    }
    await page.waitForTimeout(500)
  }
  const picked = await page.evaluate((repoId) => {
    const state = window.__store.getState()
    const wt = (state.worktreesByRepo[repoId] ?? [])[0]
    if (!wt) {
      throw new Error('no worktree')
    }
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('recent')
    state.setShowActiveOnly(false)
    state.setShowSleepingWorkspaces(true)
    state.setHideDefaultBranchWorkspace(false)
    state.setFilterRepoIds([])
    state.setActiveRepo(repoId)
    state.setActiveWorktree(wt.id)
    return { worktreeId: wt.id, worktreePath: wt.path }
  }, ids.repoId)
  record('seed.repo-open', picked)
  await page.waitForTimeout(2500)
  return picked
}

async function createTwoTerminals(page) {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${mod}+t`)
  await page.waitForTimeout(2500)
  await page.keyboard.press(`${mod}+t`)
  await page.waitForTimeout(3000)
  return page.evaluate(() => {
    const s = window.__store.getState()
    const wt = s.activeWorktreeId
    return {
      tabs: (s.tabsByWorktree?.[wt] ?? []).map((t) => t.id),
      groups: (s.groupsByWorktree?.[wt] ?? []).map((g) => g.id)
    }
  })
}

async function main() {
  execSync(
    `mkdir -p "${REPO_PATH}" && cd "${REPO_PATH}" && git init -q && git config user.email u163@test && git config user.name u163 && echo hi > README.md && git add . && git commit -qm seed`,
    { stdio: 'ignore' }
  )
  record('env', { profile: PROFILE, repo: REPO_PATH, evidence: EVIDENCE, snapshot: BUILD_ROOT })

  // Phase A — create the worktree with one group (local baseline).
  let { app, page } = await launch('A')
  await dismissOnboarding(page)
  const seeded = await seedRepoAndOpen(page)
  const wt = seeded.worktreeId
  out.worktree = wt
  const created = await createTwoTerminals(page)
  record('phaseA.tabs', created)
  await sample(page, 'phaseA.seed', wt)
  await closeApp(app)
  record('phaseA.closed', true)
  // Local-first-open fixture: keep the phase-A (1-group) persisted layout to restore after B.
  const phaseALocalRow = readSessionRow()
  out.localRowBytes = phaseALocalRow.payload.length

  // Phase B — host layout becomes 2 groups (host RPC, same user path).
  ;({ app, page } = await launch('B'))
  await dismissOnboarding(page)
  await page.waitForTimeout(2500)
  const before = await hostList(page, wt)
  record('phaseB.host-before', { groups: before.ok ? before.groups.length : before })
  let split = null
  if (before.ok && before.groups.length === 1) {
    const g = before.groups[0]
    const tabId = g.tabOrder?.at(-1) ?? g.activeTabId
    split = await hostCall(page, 'session.tabs.move', {
      kind: 'split',
      worktree: wt,
      tabId,
      targetGroupId: g.id,
      splitDirection: 'right'
    })
  }
  record('phaseB.split', split ?? 'skipped: already-multi-group')
  await page.waitForTimeout(1500)
  const afterSplit = await hostList(page, wt)
  record('phaseB.host-after', { groups: afterSplit.ok ? afterSplit.groups.length : afterSplit })
  out.samples['phaseB.localBeforeClose'] = await page.evaluate((w) => {
    const s = window.__store.getState()
    return { groups: (s.groupsByWorktree?.[w] ?? []).length }
  }, wt)
  await closeApp(app)
  record('phaseB.closed', true)
  // Why: a desktop window that never saw the host split still holds its 1-group layout; restore it
  // so the cold open exercises catch-up rather than first-open host-layout authority (U172).
  restoreSessionRow(phaseALocalRow)
  const restoredPayload = JSON.parse(readSessionRow().payload)
  record(
    'phaseB.local-restored-1-group',
    Object.fromEntries(
      Object.entries(restoredPayload.tabGroups ?? {}).map(([k, v]) => [k, v.length])
    )
  )

  // Phase C — cold open pointing at the worktree, then a real focus edge.
  ;({ app, page } = await launch('C'))
  await dismissOnboarding(page)
  const activeNow = await page.evaluate(() => window.__store.getState().activeWorktreeId)
  if (activeNow !== wt) {
    await page.evaluate((w) => window.__store.getState().setActiveWorktree(w), wt)
    record('phaseC.active-worktree-set', wt)
    await page.waitForTimeout(1500)
  }
  for (let i = 0; i < 40; i += 1) {
    const ready = await page.evaluate(() => window.__store.getState().workspaceSessionReady)
    if (ready) {
      break
    }
    await page.waitForTimeout(500)
  }
  record('phaseC.ready', await page.evaluate(() => window.__store.getState().workspaceSessionReady))
  const baseline = await sample(page, 'C.cold-baseline', wt)

  // Why live divergence: at cold start the persisted host layout and the window layout share one
  // profile source, so reproduce the mobile-client path — a host-RPC split now must move the host
  // without the desktop store adopting it.
  const preSplit = await hostList(page, wt)
  const preSplitGroup = preSplit.ok ? preSplit.groups[0] : null
  const hostSplit = preSplitGroup
    ? await hostCall(page, 'session.tabs.move', {
        kind: 'split',
        worktree: wt,
        tabId: preSplitGroup.tabOrder?.at(-1) ?? preSplitGroup.activeTabId,
        targetGroupId: preSplitGroup.id,
        splitDirection: 'right'
      })
    : { ok: false, error: 'no host group' }
  record('C.host-split', hostSplit)
  await page.waitForTimeout(1200)
  const diverged = await sample(page, 'C.host-split', wt)

  // One real focus edge, with the outbound census installed before the dispatch.
  const calls = await page.evaluate(async () => {
    const methods = []
    const patched = window.api.runtime
    if (typeof patched?.call === 'function' && !patched.__u163wrapped) {
      const original = patched.call.bind(patched)
      patched.call = async (args) => {
        methods.push(args?.method ?? '?')
        return original(args)
      }
      patched.__u163wrapped = true
    }
    window.dispatchEvent(new Event('blur'))
    const hadFocusBefore = document.hasFocus()
    window.dispatchEvent(new Event('focus'))
    await new Promise((r) => setTimeout(r, 1500))
    return {
      methods,
      hadFocusBefore,
      focusedAfter: document.hasFocus(),
      visibility: document.visibilityState
    }
  })
  record('phaseC.focus-edge', calls)
  const immediate = await sample(page, 'C.immediate', wt)
  await page.waitForTimeout(3000)
  const plus3s = await sample(page, 'C.plus3s', wt)

  const assert = (name, pass, got) => {
    out.assertions[name] = { pass, got }
  }
  const stable = (s) => s.hostGroups === 2
  assert('1_host_still_2_groups', stable(immediate) && stable(plus3s), {
    immediate: immediate.hostGroups,
    plus3s: plus3s.hostGroups
  })
  assert(
    '2_local_catches_up_2_groups',
    immediate.storeGroups === 2 &&
      immediate.domStrips === 2 &&
      plus3s.storeGroups === 2 &&
      plus3s.domStrips === 2,
    {
      immediate: [immediate.storeGroups, immediate.domStrips],
      plus3s: [plus3s.storeGroups, plus3s.domStrips]
    }
  )
  const baselineActive = baseline.local.activeGroupId
  const keptActive =
    baselineActive == null ||
    (immediate.local.activeGroupId === baselineActive &&
      plus3s.local.activeGroupId === baselineActive)
  assert('3_local_active_not_overwritten', keptActive, {
    baselineActive,
    immediate: immediate.local.activeGroupId,
    plus3s: plus3s.local.activeGroupId
  })
  const moves = calls.methods.filter((m) => m === 'session.tabs.move')
  assert(
    '4_no_outbound_tabs_move',
    moves.length === 0 && calls.methods.includes('session.tabs.list'),
    { methods: calls.methods, forbidden: moves }
  )
  assert('0_baseline_local_1_group', baseline.storeGroups === 1, {
    baselineStoreGroups: baseline.storeGroups,
    hostGroups: baseline.hostGroups
  })
  assert('0b_host_split_local_stayed_1', diverged.hostGroups === 2 && diverged.storeGroups === 1, {
    hostGroups: diverged.hostGroups,
    storeGroups: diverged.storeGroups,
    hostSplit
  })
  out.verdict =
    out.assertions['0_baseline_local_1_group'].pass &&
    out.assertions['0b_host_split_local_stayed_1'].pass
      ? Object.values(out.assertions).every((a) => a.pass)
        ? 'PASS'
        : 'FAIL'
      : 'INVALID'
  if (out.verdict === 'INVALID') {
    out.invalidReason =
      'scenario A precondition unavailable: baseline local != 1 group, or the host split reached the local store'
  }
  await page.screenshot({ path: path.join(EVIDENCE, 'C-cold-open.png') }).catch(() => {})
  await app.close()
}

try {
  await main()
} catch (error) {
  out.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error)
  out.verdict = 'INVALID'
} finally {
  try {
    await closeApp(APP)
  } catch {}
  writeEvidence()
  console.log(
    JSON.stringify(
      { verdict: out.verdict, assertions: out.assertions, error: out.error, evidence: EVIDENCE },
      null,
      2
    )
  )
}
