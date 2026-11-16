// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { cloudWorktreeSelector } from '../../../shared/cloud-file-browser'
import { readArray, readField, readNumber, readString } from '../../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../../../main/persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../../main/persistence-test-harness'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import {
  CLOUD_HOST_METHODS,
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../../../main/startup/cloud-runtime-admission'
import {
  makeSelfSignedTls,
  REPO_ROOT,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from '../../../main/cloud-platform/cloud-session-e2e-harness'
import {
  installRealPtyController,
  waitForEvent
} from '../../../main/cloud-platform/cloud-terminal-e2e-fixture'
import type { CloudBridge } from '../cloud/use-cloud-session'
import { createCloudBrowserBridge } from '../cloud/cloud-browser-bridge'
import type { WebCloudDeviceKeyStorage } from '../web/web-cloud-device-key'
import { createBrowserUuid } from '@/lib/browser-uuid'

/**
 * U96 B-令8: two clients of the same host session — the simple workspace and
 * Orca Web — against the real stack (platform, TLS host, real PTYs).
 *
 * E8 open/input sync; E8b known id-contract defect; E9 suspend + reopen keeps
 * the PTY; E9b known close-retirement defect; E10 bidirectional fit conflict.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'u96-b8')
const PERMISSIONS = ['open', 'terminal', 'file:read', 'file:write']

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(path: string, marker: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'e2e@example.com')
  git(path, 'config', 'user.name', 'e2e')
  writeFileSync(join(path, 'README.md'), `# ${marker}\n`)
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

class DeviceKeyStorage implements WebCloudDeviceKeyStorage {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let hostStore: Store
let adminToken = ''
let userToken = ''
let projectId = ''

async function createProject(key: string, path: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({ key, name: key, hostId: admission.host()!.hostId, path })
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const id = readString(await res.json(), 'id')
  if (id === null) {
    throw new Error(`project ${key} has no id`)
  }
  await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: PERMISSIONS
    })
  })
  return id
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-u96-b8-')))
  const root = join(base, 'u96-service')
  initRepo(root, 'u96-b8-marker.txt')

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-u96-b8-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, {
    dataFile: join(dataDir, 'orca-data.json')
  })
  hostStore = store
  store.addRepo({
    id: 'repo-u96-b8',
    path: root,
    displayName: 'u96-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u96-b8-admin' })
  })
  adminToken = readString(await admin.json(), 'accessToken') ?? ''
  const user = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'zhangsan', password: 'Passw0rd!', deviceName: 'u96-b8-user' })
  })
  userToken = readString(await user.json(), 'accessToken') ?? ''
  if (adminToken === '' || userToken === '') {
    throw new Error('platform login failed')
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
      ORCA_CLOUD_HOST_NAME: 'dev-u96-b8',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-u96-b8-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-u96-b8-',
    service,
    tls: makeSelfSignedTls('dev-u96-b8'),
    methods: CLOUD_HOST_METHODS
  })
  admission.bindRuntime(cloud.runtime)
  cloud.runtime.setCloudHostAudit((event) => admission.client?.reportAudit(event))
  await admission.client!.refresh()

  projectId = await createProject('u96-service', root)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  vi.stubGlobal('window', { setTimeout, clearTimeout, location: { protocol: 'https:' } })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}, 120_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

type StreamSubscription = { unsubscribe: () => void }

async function openClient(deviceName: string): Promise<CloudBridge> {
  const client = createCloudBrowserBridge({
    apiUrl: platform.url,
    deviceName,
    deviceKeyStore: new DeviceKeyStorage()
  })
  const state = await client.login('zhangsan', 'Passw0rd!')
  if (state.status !== 'signed-in') {
    throw new Error(`client login failed: ${JSON.stringify(state)}`)
  }
  let opened = await client.openWorkspace(projectId)
  for (let attempt = 0; (!opened.ok || !opened.workspacePath) && attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    opened = await client.openWorkspace(projectId)
  }
  if (!opened.ok || !opened.workspacePath) {
    throw new Error(`client open failed: ${JSON.stringify(opened)}`)
  }
  return client
}

async function closeClient(client: CloudBridge): Promise<void> {
  await client.closeProject(projectId)
  await client.logout()
}

async function subscribeAs(
  client: CloudBridge,
  method: string,
  params: Record<string, unknown>,
  events: unknown[]
): Promise<StreamSubscription> {
  const subscribe = client.subscribe
  if (!subscribe) {
    throw new Error('the browser bridge must expose subscribe')
  }
  const outcome = await subscribe.call(client, projectId, method, params, {
    onEvent: (event) => events.push(event),
    onClose: () => {}
  })
  if (!outcome.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(outcome)}`)
  }
  return outcome.subscription
}

/** The shell's identity request: tab id without ':', leaf id a bare UUID. */
function clientTerminalIdentity(): { tabId: string; leafId: string } {
  const leafId = createBrowserUuid()
  return { tabId: `terminal-${leafId}`, leafId }
}

function snapshotHasTab(snapshot: unknown, tabId: string): boolean {
  return (readArray(snapshot, 'tabs') ?? []).some((tab) => readString(tab, 'parentTabId') === tabId)
}

function terminalHandleOf(outcome: CloudRpcOutcome): string | null {
  return readString(readField(outcome.ok ? outcome.result : null, 'terminal'), 'handle')
}

/** The host mints the session row; read back the ids it actually assigned. */
async function hostRowForHandle(
  client: CloudBridge,
  worktree: string,
  handle: string
): Promise<{ tabId: string; leafId: string }> {
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    const list = await client.rpc('session.tabs.list', { worktree }, projectId)
    const row = (readArray(list.ok ? list.result : null, 'tabs') ?? []).find(
      (tab) => readString(tab, 'terminal') === handle
    )
    const tabId = readString(row ?? null, 'parentTabId')
    const leafId = readString(row ?? null, 'leafId')
    if (tabId !== null && leafId !== null) {
      return { tabId, leafId }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`session row for ${handle} never appeared`)
}

function hasDataChunk(events: readonly unknown[], needle: string): boolean {
  return events.some(
    (event) =>
      readString(event, 'type') === 'data' && (readString(event, 'chunk') ?? '').includes(needle)
  )
}

function fitEventFor(events: readonly unknown[], cols: number, rows: number): unknown | null {
  return (
    events.find(
      (event) =>
        readString(event, 'type') === 'fit-override-changed' &&
        readString(event, 'mode') === 'remote-desktop-fit' &&
        readNumber(event, 'cols') === cols &&
        readNumber(event, 'rows') === rows
    ) ?? null
  )
}

async function waitForTerminalLine(
  rpc: (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome>,
  handle: string,
  needle: string,
  timeoutMs = 30_000
): Promise<CloudRpcOutcome> {
  const started = Date.now()
  let last: CloudRpcOutcome | null = null
  while (Date.now() - started < timeoutMs) {
    last = await rpc('terminal.read', { terminal: handle, limit: 200 })
    if (last.ok) {
      const tail = readField(readField(last.result, 'terminal'), 'tail')
      if (Array.isArray(tail) && tail.some((line) => String(line).includes(needle))) {
        return last
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return {
    ok: false,
    code: 'ECHO_TIMEOUT',
    message: `the PTY never echoed '${needle}'; last=${JSON.stringify(last)}`
  }
}

/** Whether any host partition durably lists this tab (the mirror a restart/reopen reads). */
function hostPersistedTabIds(): string[] {
  const hostIds = hostStore.getWorkspaceSessionHostIds?.() ?? ['local']
  return hostIds.flatMap((hostId) =>
    Object.values(hostStore.getWorkspaceSession(hostId).tabsByWorktree)
      .flat()
      .map((tab) => tab.id)
  )
}

/** PTY teardown is asynchronous; poll until the handle refuses reads or reports a non-running status. */
async function waitForTerminalGone(
  rpc: (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome>,
  handle: string,
  timeoutMs = 8000
): Promise<CloudRpcOutcome> {
  const settled = (outcome: CloudRpcOutcome): boolean =>
    !outcome.ok || readString(readField(outcome.result, 'terminal'), 'status') !== 'running'
  const started = Date.now()
  let last = await rpc('terminal.read', { terminal: handle, limit: 10 })
  while (!settled(last) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    last = await rpc('terminal.read', { terminal: handle, limit: 10 })
  }
  return last
}

describe('U96 B-令8 双端同步真栈（简易工作区 + Orca Web）', () => {
  it('E8 一端新建另一端可见；两端输入共享同一 PTY', async () => {
    const simple = await openClient('u96-b8-simple')
    const web = await openClient('u96-b8-orca-web')
    const opened = await simple.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const worktree = cloudWorktreeSelector(opened.workspacePath)
    const simpleEvents: unknown[] = []
    const webEvents: unknown[] = []
    const simpleSub = await subscribeAs(
      simple,
      'session.tabs.subscribe',
      { worktree },
      simpleEvents
    )
    const webSub = await subscribeAs(web, 'session.tabs.subscribe', { worktree }, webEvents)
    const terminalEvents: unknown[] = []
    const webTerminalEvents: unknown[] = []
    let simpleTermSub: StreamSubscription | null = null
    let webTermSub: StreamSubscription | null = null
    let webHandle: string | null = null

    try {
      await simple.rpc('session.tabs.list', { worktree }, projectId)

      // The ids mirror the shell's request; the host adopts them as the row ids.
      const requestedA = clientTerminalIdentity()
      const created = await simple.rpc(
        'terminal.create',
        { worktree, ...requestedA, title: 'U96 A' },
        projectId
      )
      expect(created.ok, JSON.stringify(created)).toBe(true)
      const handle = terminalHandleOf(created)
      if (handle === null) {
        throw new Error('simple workspace terminal handle missing')
      }
      const rowA = await hostRowForHandle(simple, worktree, handle)
      await waitForEvent(webEvents, (event) => snapshotHasTab(event, rowA.tabId))

      // 反向：Orca Web 新建 → 简易工作区看到同一行。
      const requestedB = clientTerminalIdentity()
      const createdWeb = await web.rpc(
        'terminal.create',
        { worktree, ...requestedB, title: 'U96 B' },
        projectId
      )
      expect(createdWeb.ok, JSON.stringify(createdWeb)).toBe(true)
      webHandle = terminalHandleOf(createdWeb)
      if (webHandle === null) {
        throw new Error('orca web terminal handle missing')
      }
      const webHandleValue = webHandle
      const rowB = await hostRowForHandle(web, worktree, webHandleValue)
      await waitForEvent(simpleEvents, (event) => snapshotHasTab(event, rowB.tabId))

      // 同一 PTY：两端分别订阅，任一端输入，另一端都收到同一输出。
      simpleTermSub = await subscribeAs(
        simple,
        'terminal.subscribe',
        {
          terminal: handle,
          client: { id: 'u96-simple', type: 'desktop' },
          viewport: { cols: 90, rows: 28 },
          capabilities: { desktopViewportClaims: 1 }
        },
        terminalEvents
      )
      await waitForEvent(terminalEvents, (event) => readString(event, 'type') === 'scrollback')
      const simpleMarker = 'U96_B8_SIMPLE_INPUT'
      await simple.rpc(
        'terminal.send',
        { terminal: handle, text: `echo ${simpleMarker}\n` },
        projectId
      )
      await waitForEvent(terminalEvents, (event) => hasDataChunk([event], simpleMarker))

      webTermSub = await subscribeAs(
        web,
        'terminal.subscribe',
        {
          terminal: handle,
          client: { id: 'u96-web', type: 'desktop' },
          viewport: { cols: 120, rows: 40 },
          capabilities: { desktopViewportClaims: 1 }
        },
        webTerminalEvents
      )
      await waitForEvent(webTerminalEvents, (event) => readString(event, 'type') === 'scrollback')
      const webMarker = 'U96_B8_WEB_INPUT'
      await web.rpc('terminal.send', { terminal: handle, text: `echo ${webMarker}\n` }, projectId)
      await waitForEvent(webTerminalEvents, (event) => hasDataChunk([event], webMarker))
      const echoed = await waitForTerminalLine(
        (method, params) => simple.rpc(method, params ?? {}, projectId),
        handle,
        webMarker
      )
      expect(echoed.ok, JSON.stringify(echoed)).toBe(true)

      saveEvidence('e8-dual-client-sync.json', {
        created,
        createdWeb,
        requestedIds: { a: requestedA, b: requestedB },
        hostIds: { a: rowA, b: rowB },
        mirroredToWeb: snapshotHasTab(webEvents.at(-1), rowA.tabId),
        mirroredToSimple: snapshotHasTab(simpleEvents.at(-1), rowB.tabId),
        samePty: { simpleMarker, webMarker, crossRead: echoed }
      })
    } finally {
      simpleTermSub?.unsubscribe()
      webTermSub?.unsubscribe()
      simpleSub.unsubscribe()
      webSub.unsubscribe()
      if (webHandle !== null) {
        await web.rpc('terminal.close', { terminal: webHandle }, projectId)
      }
      await closeClient(web)
      await closeClient(simple)
    }
  }, 180_000)

  it('E8b 客户端 terminal-<uuid>/<uuid> 被宿主采纳，行 id 与本地标签一致（U107）', async () => {
    const simple = await openClient('u96-b8-simple')
    const opened = await simple.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const worktree = cloudWorktreeSelector(opened.workspacePath)
    const requested = clientTerminalIdentity()
    const created = await simple.rpc(
      'terminal.create',
      { worktree, ...requested, title: 'U96 id contract' },
      projectId
    )
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const handle = terminalHandleOf(created)
    if (handle === null) {
      throw new Error('id-contract terminal handle missing')
    }
    try {
      const row = await hostRowForHandle(simple, worktree, handle)
      expect(row.tabId).toBe(requested.tabId)
      expect(row.leafId).toBe(requested.leafId)
    } finally {
      await closeClient(simple)
    }
  })

  it('E9 suspend 保 PTY 且重开恢复同 tab', async () => {
    const simple = await openClient('u96-b8-simple')
    const opened = await simple.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const worktree = cloudWorktreeSelector(opened.workspacePath)
    const marker = 'U96_B8_SUSPEND_ALIVE'
    const created = await simple.rpc(
      'terminal.create',
      {
        worktree,
        ...clientTerminalIdentity(),
        title: 'U96 Suspend'
      },
      projectId
    )
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const handle = terminalHandleOf(created)
    if (handle === null) {
      throw new Error('suspend terminal handle missing')
    }
    const row = await hostRowForHandle(simple, worktree, handle)
    await simple.rpc('terminal.send', { terminal: handle, text: `echo ${marker}\n` }, projectId)
    const alive = await waitForTerminalLine(
      (method, params) => simple.rpc(method, params ?? {}, projectId),
      handle,
      marker
    )
    expect(alive.ok, JSON.stringify(alive)).toBe(true)

    // Suspend = destroy the iframe/socket, never terminal.close.
    await simple.closeProject(projectId)
    const probe = await openClient('u96-b8-suspend-probe')
    try {
      const probeRead = await probe.rpc(
        'terminal.read',
        { terminal: handle, limit: 200 },
        projectId
      )
      expect(probeRead.ok, JSON.stringify(probeRead)).toBe(true)
      const tail = readField(readField(probeRead.ok ? probeRead.result : null, 'terminal'), 'tail')
      expect(Array.isArray(tail) && tail.some((line) => String(line).includes(marker))).toBe(true)
      const probeList = await probe.rpc('session.tabs.list', { worktree }, projectId)
      expect(
        (readArray(probeList.ok ? probeList.result : null, 'tabs') ?? []).some(
          (tab) =>
            readString(tab, 'parentTabId') === row.tabId && readString(tab, 'terminal') === handle
        ),
        JSON.stringify(probeList)
      ).toBe(true)

      // Reopen the simple workspace: same tab id and same PTY handle replay the marker.
      const reopened = await simple.openWorkspace(projectId)
      expect(reopened.ok, JSON.stringify(reopened)).toBe(true)
      const replayEvents: unknown[] = []
      const replaySub = await subscribeAs(
        simple,
        'terminal.subscribe',
        {
          terminal: handle,
          client: { id: 'u96-reopen', type: 'desktop' },
          viewport: { cols: 90, rows: 28 },
          capabilities: { desktopViewportClaims: 1 }
        },
        replayEvents
      )
      try {
        await waitForEvent(
          replayEvents,
          (event) => readString(event, 'type') === 'scrollback' || hasDataChunk([event], marker)
        )
      } finally {
        replaySub.unsubscribe()
      }
      const reopenedList = await simple.rpc('session.tabs.list', { worktree }, projectId)
      expect(
        (readArray(reopenedList.ok ? reopenedList.result : null, 'tabs') ?? []).some(
          (tab) =>
            readString(tab, 'parentTabId') === row.tabId && readString(tab, 'terminal') === handle
        ),
        JSON.stringify(reopenedList)
      ).toBe(true)

      saveEvidence('e9-suspend-end.json', {
        marker,
        suspendKeptPty: probeRead,
        rowKept: probeList,
        reopened: { list: reopenedList }
      })
    } finally {
      await closeClient(probe)
      await closeClient(simple)
    }
  }, 180_000)

  it('E9b 显式 close 后 PTY 终止、行退役', async () => {
    const simple = await openClient('u96-b8-simple')
    const web = await openClient('u96-b8-close-web')
    const opened = await simple.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const worktree = cloudWorktreeSelector(opened.workspacePath)
    const created = await simple.rpc('terminal.create', { worktree, title: 'U96 end' }, projectId)
    const handle = terminalHandleOf(created)
    if (handle === null) {
      throw new Error('end terminal handle missing')
    }
    const row = await hostRowForHandle(simple, worktree, handle)
    // The mirror, not just the in-memory snapshot: a restart/reopen reads this row.
    const persistedTabIds = hostPersistedTabIds()
    expect(persistedTabIds, JSON.stringify(persistedTabIds)).toContain(row.tabId)
    const webEvents: unknown[] = []
    const webSub = await subscribeAs(web, 'session.tabs.subscribe', { worktree }, webEvents)
    try {
      await waitForEvent(webEvents, (event) => snapshotHasTab(event, row.tabId))
      const beforeClose = webEvents.length
      const ended = await simple.rpc(
        'session.tabs.close',
        { worktree, tabId: row.tabId, reason: 'user' },
        projectId
      )
      expect(ended.ok, JSON.stringify(ended)).toBe(true)
      const afterEnd = await simple.rpc('session.tabs.list', { worktree }, projectId)
      expect(
        (readArray(afterEnd.ok ? afterEnd.result : null, 'tabs') ?? []).some(
          (tab) => readString(tab, 'parentTabId') === row.tabId
        )
      ).toBe(false)
      // The other client must see the retirement, not just the closing one.
      await waitForEvent(webEvents.slice(beforeClose), (event) => !snapshotHasTab(event, row.tabId))
      const webList = await web.rpc('session.tabs.list', { worktree }, projectId)
      expect(
        (readArray(webList.ok ? webList.result : null, 'tabs') ?? []).some(
          (tab) => readString(tab, 'parentTabId') === row.tabId
        )
      ).toBe(false)
      const dead = await waitForTerminalGone(
        (method, params) => simple.rpc(method, params ?? {}, projectId),
        handle
      )
      const deadStatus = readString(readField(dead.ok ? dead.result : null, 'terminal'), 'status')
      expect(dead.ok === false || deadStatus === 'exited', JSON.stringify(dead)).toBe(true)
    } finally {
      webSub.unsubscribe()
      await closeClient(web)
      await closeClient(simple)
    }
  })

  it('E10 双端尺寸冲突：一端 claim 后另一端收到 fit-override-changed 数据帧', async () => {
    const simple = await openClient('u96-b8-simple')
    const web = await openClient('u96-b8-fit-web')
    const opened = await simple.openWorkspace(projectId)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error(`open failed: ${JSON.stringify(opened)}`)
    }
    const worktree = cloudWorktreeSelector(opened.workspacePath)
    const created = await simple.rpc(
      'terminal.create',
      { worktree, tabId: 'terminal:u96-fit', leafId: 'leaf:u96-fit', title: 'U96 Fit' },
      projectId
    )
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const handle = terminalHandleOf(created)
    if (handle === null) {
      throw new Error('fit terminal handle missing')
    }
    const simpleEvents: unknown[] = []
    const webEvents: unknown[] = []
    const simpleSub = await subscribeAs(
      simple,
      'terminal.subscribe',
      {
        terminal: handle,
        client: { id: 'u96-simple', type: 'desktop' },
        viewport: { cols: 90, rows: 28 },
        capabilities: { desktopViewportClaims: 1 }
      },
      simpleEvents
    )
    const webSub = await subscribeAs(
      web,
      'terminal.subscribe',
      {
        terminal: handle,
        client: { id: 'u96-web', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { desktopViewportClaims: 1 }
      },
      webEvents
    )
    try {
      await waitForEvent(simpleEvents, (event) => readString(event, 'type') === 'scrollback')
      await waitForEvent(webEvents, (event) => readString(event, 'type') === 'scrollback')

      // Orca Web 主动 claim 自己的尺寸 → 简易工作区收到冲突提示的数据源。
      const webClaim = await web.rpc(
        'terminal.updateViewport',
        {
          terminal: handle,
          client: { id: 'u96-web', type: 'desktop' },
          viewport: { cols: 120, rows: 40 },
          claim: true
        },
        projectId
      )
      expect(webClaim.ok, JSON.stringify(webClaim)).toBe(true)
      await waitForEvent(simpleEvents, (event) => fitEventFor([event], 120, 40) !== null)

      // 反方向 claim：另一端同样收到事件，证明冲突是双向可见的。
      const simpleClaim = await simple.rpc(
        'terminal.updateViewport',
        {
          terminal: handle,
          client: { id: 'u96-simple', type: 'desktop' },
          viewport: { cols: 90, rows: 28 },
          claim: true
        },
        projectId
      )
      expect(simpleClaim.ok, JSON.stringify(simpleClaim)).toBe(true)
      await waitForEvent(webEvents, (event) => fitEventFor([event], 90, 28) !== null)

      saveEvidence('e10-fit-conflict.json', {
        webClaim,
        simpleClaim,
        simpleSaw: simpleEvents.filter(
          (event) => readString(event, 'type') === 'fit-override-changed'
        ),
        webSaw: webEvents.filter((event) => readString(event, 'type') === 'fit-override-changed')
      })
    } finally {
      simpleSub.unsubscribe()
      webSub.unsubscribe()
      await web.rpc('terminal.close', { terminal: handle }, projectId)
      await closeClient(web)
      await closeClient(simple)
    }
  }, 180_000)
})
