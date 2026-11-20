import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { WORKSPACE_INFO_METHODS } from '../runtime/rpc/methods/workspace-info'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import { makeSelfSignedTls, startCloudRuntime, startPlatform } from './cloud-session-e2e-harness'
import { startCloudRuntimeAdmission } from '../startup/cloud-runtime-admission'
import { CloudConnectClient } from './cloud-connect-client'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

const OUT = join(process.cwd(), 'evidence', 'u96-a8')
const MARKER_ONE = 'U96_A8_LIVE_ONE'
const MARKER_TWO = 'U96_A8_LIVE_TWO'

type CallReply = { ok: true; result: unknown } | { ok: false; code: string; message?: string }

type ProbeTab = {
  id: string | null
  title: string | null
  type: string | null
  ptyId: string | null
  handle: string | null
}

type ProbeGroup = { id: string | null; activeTabId: string | null; tabOrder: string[] }

type ProbeSnapshot = {
  worktree: string | null
  tabCount: number
  groupCount: number
  activeTabId: string | null
  activeGroupId: string | null
  tabs: ProbeTab[]
  groups: ProbeGroup[]
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'e2e@example.com')
  git(path, 'config', 'user.name', 'e2e')
  writeFileSync(join(path, 'README.md'), 'hello\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

let platform: Awaited<ReturnType<typeof startPlatform>>
let admission: ReturnType<typeof startCloudRuntimeAdmission>
let cloud: Awaited<ReturnType<typeof startCloudRuntime>>
let store: Store
let service: OrcaRuntimeService
let clientA: CloudConnectClient
let clientB: CloudConnectClient
let workspaceA = ''
let workspaceB = ''
let projectA = ''
let projectB = ''
const handles: Record<string, string> = {}

async function createProject(
  adminToken: string,
  key: string,
  projectPath: string
): Promise<string> {
  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key,
      name: key,
      hostId: admission.host()!.hostId,
      path: projectPath
    })
  })
  const id = readString(await created.json(), 'id') ?? ''
  if (created.status !== 201 || !id) {
    throw new Error(`project create failed: ${created.status}`)
  }
  await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read', 'file:write']
    })
  })
  return id
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u96-a8-')))
  const projectRootA = join(base, 'project-a')
  const projectRootB = join(base, 'project-b')
  initRepo(projectRootA)
  initRepo(projectRootB)
  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u96-a8-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-a',
    path: projectRootA,
    displayName: 'project-a',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'repo-b',
    path: projectRootB,
    displayName: 'project-b',
    badgeColor: 'gray',
    addedAt: 2
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u96-a8-admin' })
  })
  const adminToken = readString(await admin.json(), 'accessToken')
  if (adminToken === null) {
    throw new Error('admin login failed')
  }
  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }
  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-u96-a8',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u96-a8-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-u96-a8-',
    service,
    tls: makeSelfSignedTls('dev-u96-a8'),
    methods: [...ALL_RPC_METHODS, ...WORKSPACE_INFO_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  projectA = await createProject(adminToken, 'u96-a8-project-a', projectRootA)
  projectB = await createProject(adminToken, 'u96-a8-project-b', projectRootB)

  clientA = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await clientA.login('zhangsan', 'Passw0rd!')
  const ensuredA = await ensureCloudWorkspace(clientA, projectA)
  if (!ensuredA.ok) {
    throw new Error(`workspace A ensure failed: ${ensuredA.code}`)
  }
  workspaceA = ensuredA.workspacePath

  clientB = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await clientB.login('zhangsan', 'Passw0rd!')
  const ensuredB = await ensureCloudWorkspace(clientB, projectB)
  if (!ensuredB.ok) {
    throw new Error(`workspace B ensure failed: ${ensuredB.code}`)
  }
  workspaceB = ensuredB.workspacePath
})

function installRealPtyController(target: OrcaRuntimeService): void {
  const terminals = new Map<string, { write(data: string): void; kill(): void }>()
  let seq = 0
  target.setPtyController({
    spawn: async (opts) => {
      const nodePty = await import('node-pty')
      const id = `pty-a8-${++seq}`
      const term = nodePty.spawn(process.env.SHELL ?? '/bin/sh', [], {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd ?? process.cwd(),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? tmpdir(),
          TERM: 'xterm-256color',
          PS1: '$ '
        }
      })
      term.onData((data) => target.onPtyData(id, data, Date.now()))
      terminals.set(id, { write: (data) => term.write(data), kill: () => term.kill() })
      return { id, pid: term.pid }
    },
    write: (ptyId, data) => {
      terminals.get(ptyId)?.write(data)
      return true
    },
    kill: (ptyId) => {
      terminals.get(ptyId)?.kill()
      return true
    },
    getForegroundProcess: async () => null
  })
}

afterAll(async () => {
  clientA?.close()
  clientB?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

async function call(
  client: CloudConnectClient,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<CallReply> {
  const reply = await client.rpc(method, params ?? {}, timeoutMs)
  return reply.ok
    ? { ok: true, result: reply.result }
    : { ok: false, code: reply.code, message: reply.message }
}

function summarize(snapshot: unknown): ProbeSnapshot {
  const tabs = Array.isArray(readField(snapshot, 'tabs'))
    ? (readField(snapshot, 'tabs') as unknown[])
    : []
  const groups = Array.isArray(readField(snapshot, 'tabGroups'))
    ? (readField(snapshot, 'tabGroups') as unknown[])
    : []
  return {
    worktree: readString(snapshot, 'worktree'),
    tabCount: tabs.length,
    groupCount: groups.length,
    activeTabId: readString(snapshot, 'activeTabId'),
    activeGroupId: readString(snapshot, 'activeGroupId'),
    tabs: tabs.map((tab) => ({
      id: readString(tab, 'id') ?? readString(tab, 'parentTabId'),
      title: readString(tab, 'title'),
      type: readString(tab, 'type'),
      ptyId: readString(readField(tab, 'terminal'), 'ptyId'),
      handle: readString(readField(tab, 'terminal'), 'handle')
    })),
    groups: groups.map((group) => ({
      id: readString(group, 'id'),
      activeTabId: readString(group, 'activeTabId'),
      tabOrder: Array.isArray(readField(group, 'tabOrder'))
        ? (readField(group, 'tabOrder') as string[])
        : []
    }))
  }
}

function writeResult(name: string, value: unknown): void {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`)
}

function parentIdOf(surfaceId: string | null): string | null {
  // Public terminal-tab ids are `parentTabId::leafId`; groups address the parent.
  return surfaceId?.includes('::') ? (surfaceId.split('::')[0] ?? null) : surfaceId
}

it('U96 A8-A1: 3 tabs / 2 groups / active tab / live markers survive a client reconnect', async () => {
  const selector = { worktree: `path:${workspaceA}` }
  const out: Record<string, unknown> = { workspaceA, markers: [MARKER_ONE, MARKER_TWO] }

  const before = summarize((await call(clientA, 'session.tabs.list', selector)).result)
  out['list.before'] = before

  for (const index of [1, 2, 3]) {
    const created = await call(clientA, 'terminal.create', {
      ...selector,
      title: `U96 A8 terminal ${index}`,
      tabId: `u96-a8-tab-${index}`,
      leafId: `u96-a8-leaf-${index}`
    })
    out[`terminal.create.${index}`] = created
    const handle = readString(readField(readField(created, 'result'), 'terminal'), 'handle')
    if (handle) {
      handles[`terminal${index}`] = handle
    }
    if ((index === 1 || index === 2) && handle) {
      await call(clientA, 'terminal.send', {
        terminal: handle,
        text: `printf '${index === 1 ? MARKER_ONE : MARKER_TWO}\\n'\r`
      })
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const afterCreate = summarize((await call(clientA, 'session.tabs.list', selector)).result)
  out['list.afterCreate'] = afterCreate
  const termIds = afterCreate.tabs.filter((tab) => tab.type === 'terminal').map((tab) => tab.id)
  const targetGroup = afterCreate.groups[0]?.id ?? null
  const [term1, term2, term3] = termIds
  expect(afterCreate.tabCount, 'three terminals in the inventory').toBeGreaterThanOrEqual(3)
  expect(term1 && term2 && term3, 'all three terminal surfaces listed').toBeTruthy()

  // Group 2 via a right split of the second tab (headless move-to-group needs an
  // existing target; split is the real group-creating gesture — U99 made it land).
  out['session.tabs.move.split'] = await call(clientA, 'session.tabs.move', {
    kind: 'split',
    worktree: `path:${workspaceA}`,
    tabId: term2,
    targetGroupId: targetGroup,
    splitDirection: 'right'
  })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const afterSplit = summarize((await call(clientA, 'session.tabs.list', selector)).result)
  out['list.afterSplit'] = afterSplit
  const secondGroup = afterSplit.groups.find((group) => group.id !== targetGroup)?.id ?? null
  expect(afterSplit.groupCount, 'the split creates a second group').toBe(2)
  expect(parentIdOf(term2), 'split group owns the split tab').toBe(
    afterSplit.groups.find((group) => group.id === secondGroup)?.tabOrder[0]
  )

  out['session.tabs.move.third'] = await call(clientA, 'session.tabs.move', {
    kind: 'move-to-group',
    worktree: `path:${workspaceA}`,
    tabId: term3,
    targetGroupId: secondGroup
  })
  out['session.tabs.activate.second'] = await call(clientA, 'session.tabs.activate', {
    worktree: `path:${workspaceA}`,
    tabId: term2
  })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const beforeReconnect = summarize((await call(clientA, 'session.tabs.list', selector)).result)
  out['list.beforeReconnect'] = beforeReconnect
  expect(beforeReconnect.groupCount, 'two groups before the client reconnects').toBe(2)
  expect(beforeReconnect.activeTabId, 'the active tab is the split group tab').toBe(term2)
  expect(beforeReconnect.activeGroupId, 'the active group follows activation').toBe(secondGroup)
  out['terminal.read.one.before'] = handles['terminal1']
    ? await call(clientA, 'terminal.read', { terminal: handles['terminal1'] })
    : null
  out['terminal.read.two.before'] = handles['terminal2']
    ? await call(clientA, 'terminal.read', { terminal: handles['terminal2'] })
    : null

  // Close the page-equivalent client; the host and its PTYs keep running.
  clientA.close()
  await new Promise((resolve) => setTimeout(resolve, 800))

  // A page reload keeps the browser profile, so the same platform device (and
  // its client-scoped tab selection) comes back — a fresh device would model a
  // second client, which is A6's isolation case instead.
  const reopened = new CloudConnectClient(
    { apiUrl: platform.url, tlsRejectUnauthorized: false },
    clientA.deviceIdentity()
  )
  const ensured = await ensureCloudWorkspace(reopened, projectA)
  out['reopen.ensure'] = ensured
  expect(ensured.ok, 'the reopened client re-ensures the same workspace').toBe(true)

  const afterReconnect = summarize((await call(reopened, 'session.tabs.list', selector)).result)
  out['list.afterReconnect'] = afterReconnect
  writeResult('a1-a2-probe-result.json', out)
  expect(afterReconnect.tabCount, 'tab count restored').toBe(beforeReconnect.tabCount)
  expect(afterReconnect.groupCount, 'group count restored').toBe(2)
  expect(afterReconnect.activeTabId, 'active tab restored').toBe(beforeReconnect.activeTabId)
  expect(afterReconnect.activeGroupId, 'active group restored').toBe(beforeReconnect.activeGroupId)
  expect(
    afterReconnect.groups.map((group) => ({ id: group.id, tabOrder: group.tabOrder })),
    'each group keeps its own tab order'
  ).toEqual(beforeReconnect.groups.map((group) => ({ id: group.id, tabOrder: group.tabOrder })))

  const readOne = handles['terminal1']
    ? await call(reopened, 'terminal.read', { terminal: handles['terminal1'] })
    : { ok: false as const, code: 'missing_handle' }
  const readTwo = handles['terminal2']
    ? await call(reopened, 'terminal.read', { terminal: handles['terminal2'] })
    : { ok: false as const, code: 'missing_handle' }
  out['terminal.read.one.afterReconnect'] = readOne
  out['terminal.read.two.afterReconnect'] = readTwo
  expect(JSON.stringify(readOne), 'marker one replays after the reconnect').toContain(MARKER_ONE)
  expect(JSON.stringify(readTwo), 'marker two replays after the reconnect').toContain(MARKER_TWO)

  // A2/A8 data layer: the host persisted the tabs into workspaceSession, so a
  // restart rehydrates them; a closed tab retires and cannot resurrect them.
  const session = store.getWorkspaceSession?.() ?? null
  const persistedKey = Object.keys(session?.tabsByWorktree ?? {}).find((key) =>
    key.includes('/.orca-worktrees/zhangsan/')
  )
  const persistedTabs = persistedKey
    ? (session?.tabsByWorktree?.[persistedKey] ?? []).map((tab) => tab.id)
    : []
  out['restart.persistedSession'] = {
    worktreeKey: persistedKey ?? null,
    tabIds: persistedTabs,
    layoutTabIds: Object.keys(session?.terminalLayoutsByTabId ?? {})
  }
  expect(persistedTabs.length, 'restart source keeps every live tab').toBe(beforeReconnect.tabCount)

  const closeTarget = handles['terminal1']
  out['terminal.close'] = closeTarget
    ? await call(reopened, 'terminal.close', { terminal: closeTarget })
    : 'no handle'
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  const afterClose = summarize((await call(reopened, 'session.tabs.list', selector)).result)
  out['list.afterClose'] = afterClose
  const persistedAfterClose = persistedKey
    ? (store.getWorkspaceSession?.()?.tabsByWorktree?.[persistedKey] ?? []).map((tab) => tab.id)
    : []
  out['restart.persistedSessionAfterClose'] = persistedAfterClose
  expect(afterClose.tabCount, 'closing a terminal retires its inventory row').toBe(
    beforeReconnect.tabCount - 1
  )
  expect(persistedAfterClose.length, 'a closed tab cannot resurrect after a restart').toBe(
    beforeReconnect.tabCount - 1
  )

  writeResult('a1-a2-probe-result.json', out)
}, 240_000)

it('U96 A8-A9: two projects keep independent tab groups; listAll stays inside the ticket', async () => {
  const out: Record<string, unknown> = { workspaceA, workspaceB }
  const selectorA = { worktree: `path:${workspaceA}` }
  const selectorB = { worktree: `path:${workspaceB}` }

  const createdB = await call(clientB, 'terminal.create', {
    ...selectorB,
    title: 'U96 A8 project B terminal',
    tabId: 'u96-a8-b-tab-1',
    leafId: 'u96-a8-b-leaf-1'
  })
  out['projectB.terminal.create'] = createdB
  await new Promise((resolve) => setTimeout(resolve, 800))

  const listA = summarize((await call(clientB, 'session.tabs.list', selectorA)).result)
  const listB = summarize((await call(clientB, 'session.tabs.list', selectorB)).result)
  out['projectB.list.A'] = listA
  out['projectB.list.B'] = listB
  expect(listB.tabCount, 'project B has its own tab').toBeGreaterThanOrEqual(2)
  // The ticket projection fails closed: another project's worktree yields an
  // empty inventory, never the other project's rows.
  expect(listA.tabCount, "another project's tabs never leak into this ticket").toBe(0)

  // Project A still sees its own tabs; opening B did not overwrite them.
  const reopenedA = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await reopenedA.login('zhangsan', 'Passw0rd!')
  const ensuredA = await ensureCloudWorkspace(reopenedA, projectA)
  expect(ensuredA.ok, 'reopen project A').toBe(true)
  const listAOwn = summarize((await call(reopenedA, 'session.tabs.list', selectorA)).result)
  out['projectA.listAfterB'] = listAOwn
  expect(listAOwn.tabCount, 'project A keeps its own tabs after B opens').toBeGreaterThanOrEqual(2)
  expect(
    listAOwn.tabs.some((tab) => (tab.title ?? '').includes('project B')),
    "project B's tab never appears in project A"
  ).toBe(false)
  reopenedA.close()

  const listAll = await call(clientB, 'session.tabs.listAll')
  out['projectB.listAll'] = listAll
  const snapshots = Array.isArray(readField(readField(listAll, 'result'), 'snapshots'))
    ? (readField(readField(listAll, 'result'), 'snapshots') as unknown[])
    : []
  const worktrees = snapshots.map((snapshot) => readString(snapshot, 'worktree') ?? '')
  out['projectB.listAll.worktrees'] = worktrees
  expect(snapshots.length, 'the cloud projection drops every other project worktree').toBe(1)
  expect(worktrees[0], 'only the ticket project checkout is visible').toContain(workspaceB)

  const crossScope = await call(clientB, 'session.tabs.list', selectorA)
  out['projectB.crossScopeList'] = crossScope
  expect(crossScope.ok, 'a cross-project worktree selector is refused').toBe(false)
  if (!crossScope.ok) {
    expect(crossScope.code, 'the refusal carries a scope reason').toMatch(/scope|forbidden/)
  }

  writeResult('a9-probe-result.json', out)
}, 120_000)
