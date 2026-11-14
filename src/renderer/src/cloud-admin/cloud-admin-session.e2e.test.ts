// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import {
  browseCloudDirectory,
  cloudWorktreeSelector,
  previewCloudFile
} from '../../../shared/cloud-file-browser'
import { readField, readString } from '../../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../../../main/persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../../main/persistence-test-harness'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../../../main/runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../../../main/runtime/rpc/methods/worktree-create-managed'
import { PROJECT_PROVISION_METHODS } from '../../../main/runtime/rpc/methods/project-provision'
import {
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
import { installRealPtyController } from '../../../main/cloud-platform/cloud-terminal-e2e-fixture'
import type { CloudBridge } from '../cloud/use-cloud-session'
import { createCloudBrowserBridge } from '../cloud/cloud-browser-bridge'
import type { WebCloudDeviceKeyStorage } from '../web/web-cloud-device-key'

/**
 * M54: the admin session page's browser bridge against the real stack — a real
 * platform process, a real enrolled TLS runtime, and two projects on one host.
 * Proves the routing that a single-project smoke test cannot: B's workspace is
 * readable through B and refused through A, and a path outside A is refused.
 *
 * W5b extends it with the workspace's live surface (FR-3.9): the real host
 * method table (project.provision included), a real PTY behind the terminal
 * panel's RPCs, the file tree's read-only preview, and the no-terminal grant
 * that renders the placeholder — its refusal audited, never bare forbidden.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm54-admin-session-page')
const W5B_EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'w5b-terminal-e2e')
const PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'download']
/** A viewer grant: the workspace view's terminal pane must stay a placeholder. */
const VIEWER_PERMISSIONS = ['open', 'file:read']
const TERMINAL_ECHO_MARKER = 'ORCA_W5B_PTY_ECHO_OK'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

function saveW5bEvidence(file: string, content: unknown): void {
  mkdirSync(W5B_EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(W5B_EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
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
  writeFileSync(join(path, marker), `${marker}\n`)
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

function runtimeIdOf(outcome: CloudRpcOutcome): string | null {
  return outcome.ok ? readString(outcome.result, 'runtimeId') : null
}

/** Polls the host's buffer read until the PTY echoed the marker back. */
async function waitForTerminalLine(
  rpc: (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome>,
  handle: string,
  needle: string,
  timeoutMs = 30_000
): Promise<CloudRpcOutcome> {
  const started = Date.now()
  let last: CloudRpcOutcome | null = null
  while (Date.now() - started < timeoutMs) {
    last = await rpc('terminal.read', { terminal: handle, screen: true, limit: 200 })
    if (last.ok) {
      const tail = readField(last.result, 'tail')
      if (Array.isArray(tail) && tail.some((line) => String(line).includes(needle))) {
        return last
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return last ?? { ok: false, code: 'terminal_read_timeout', message: `no echo of ${needle}` }
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let bridge: CloudBridge
let adminToken = ''
let rootA = ''
let rootB = ''
let rootViewer = ''
let projectA = ''
let projectB = ''
let projectViewer = ''
const hostMethodDenials: unknown[] = []

async function createProject(
  key: string,
  path: string,
  adminToken: string,
  permissions: readonly string[] = PERMISSIONS
): Promise<string> {
  const res = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ key, name: key, hostId: admission.host()!.hostId, path })
  })
  expect(res.status, await res.clone().text()).toBe(201)
  const id = readString(await res.json(), 'id')
  if (id === null) {
    throw new Error(`project ${key} has no id`)
  }
  await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions
    })
  })
  return id
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m54-admin-')))
  rootA = join(base, 'alpha-service')
  rootB = join(base, 'beta-service')
  rootViewer = join(base, 'viewer-service')
  initRepo(rootA, 'alpha-marker.txt')
  initRepo(rootB, 'beta-marker.txt')
  initRepo(rootViewer, 'viewer-marker.txt')

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m54-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-alpha',
    path: rootA,
    displayName: 'alpha-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'repo-beta',
    path: rootB,
    displayName: 'beta-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.addRepo({
    id: 'repo-viewer',
    path: rootViewer,
    displayName: 'viewer-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)
  // The terminal pane talks to a real shell, not a scripted stream.
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm54-admin' })
  })
  adminToken = readString(await admin.json(), 'accessToken') ?? ''
  if (adminToken === '') {
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
      ORCA_CLOUD_HOST_NAME: 'dev-m54',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m54-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m54-',
    service,
    tls: makeSelfSignedTls('dev-m54'),
    // The table a cloud-admitted host installs (cloudAdmissionOption): without
    // the provision methods the open flow only ever saw method_not_found.
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS, ...PROJECT_PROVISION_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  // Production wiring (attachCloudRuntime): host refusals reach the platform chain.
  cloud.runtime.setCloudHostAudit((event) => {
    if (event.eventType === 'method_denied') {
      hostMethodDenials.push(event)
    }
    admission.client?.reportAudit(event)
  })
  await admission.client!.refresh()

  projectA = await createProject('m54-alpha', rootA, adminToken)
  projectB = await createProject('m54-beta', rootB, adminToken)
  projectViewer = await createProject('m54-viewer', rootViewer, adminToken, VIEWER_PERMISSIONS)
  // Grant changes invalidate tickets minted before them.
  await new Promise((resolve) => setTimeout(resolve, 1200))

  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    location: { protocol: 'https:' }
  })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  bridge = createCloudBrowserBridge({
    apiUrl: platform.url,
    deviceName: 'm54-admin-session',
    deviceKeyStore: new DeviceKeyStorage()
  })
}, 120_000)

afterAll(async () => {
  await bridge?.logout()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

describe('M54 管理员浏览器会话页（真实平台 + 真实 TLS Runtime）', () => {
  it('登录后按项目打开工作区、路由到各自连接并列出真实文件，越界路径被拒', async () => {
    const signedIn = await bridge.login('zhangsan', 'Passw0rd!')
    expect(signedIn.status, JSON.stringify(signedIn)).toBe('signed-in')

    const openedA = await bridge.openWorkspace(projectA)
    const openedB = await bridge.openWorkspace(projectB)
    expect(openedA.ok, JSON.stringify(openedA)).toBe(true)
    expect(openedB.ok, JSON.stringify(openedB)).toBe(true)
    if (!openedA.ok || !openedB.ok) {
      throw new Error('both workspaces must open')
    }
    expect(openedA.workspacePath).toBeTruthy()
    expect(openedB.workspacePath).toBeTruthy()
    if (!openedA.workspacePath || !openedB.workspacePath) {
      throw new Error('both workspaces must have a path')
    }

    const statusA = await bridge.rpc('status.get', {}, projectA)
    const statusB = await bridge.rpc('status.get', {}, projectB)
    const runtimeIdA = runtimeIdOf(statusA)
    const runtimeIdB = runtimeIdOf(statusB)
    expect(runtimeIdA, JSON.stringify(statusA)).toEqual(expect.any(String))
    expect(runtimeIdB).toBe(runtimeIdA)

    const rpcA = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectA)
    const rpcB = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectB)

    const listingA = await browseCloudDirectory(rpcA, openedA.workspacePath)
    const listingB = await browseCloudDirectory(rpcB, openedB.workspacePath)
    expect(listingA.ok, JSON.stringify(listingA)).toBe(true)
    expect(listingB.ok, JSON.stringify(listingB)).toBe(true)
    if (!listingA.ok || !listingB.ok) {
      throw new Error('both listings must succeed')
    }
    const namesA = listingA.entries.map((entry) => entry.name)
    const namesB = listingB.entries.map((entry) => entry.name)
    expect(namesA).toEqual(expect.arrayContaining(['README.md', 'alpha-marker.txt']))
    expect(namesB).toEqual(expect.arrayContaining(['README.md', 'beta-marker.txt']))
    expect(namesA).not.toContain('beta-marker.txt')
    expect(namesB).not.toContain('alpha-marker.txt')

    // B's checkout through A's client is outside A's project root.
    const crossProject = await rpcA('files.readDir', {
      worktree: cloudWorktreeSelector(openedB.workspacePath),
      relativePath: ''
    })
    const outsideProject = await rpcA('files.readDir', {
      worktree: cloudWorktreeSelector(openedA.workspacePath),
      relativePath: openedB.workspacePath
    })
    expect(crossProject.ok).toBe(false)
    expect(outsideProject.ok).toBe(false)
    if (!crossProject.ok) {
      expect(crossProject.code).toBe('forbidden')
    }
    if (!outsideProject.ok) {
      expect(outsideProject.code).toBe('forbidden')
    }

    const evidence = {
      projects: { projectA, projectB, rootA, rootB },
      workspaces: { a: openedA.workspacePath, b: openedB.workspacePath },
      statusGet: { projectA: statusA, projectB: statusB },
      listings: { projectA: listingA, projectB: listingB },
      refusals: { crossProject, outsideProject }
    }
    saveEvidence('m54-admin-session.json', evidence)
    console.log('[m54] admin session:', JSON.stringify(evidence))

    await bridge.closeProject(projectA)
    expect(await bridge.rpc('status.get', {}, projectA)).toEqual({
      ok: false,
      code: 'NOT_CONNECTED'
    })
    expect((await bridge.rpc('status.get', {}, projectB)).ok).toBe(true)
  }, 180_000)

  it('W5b-1 打开项目后终端面板的 PTY 全链路：输入回显、视口更新，文件树打开只读预览', async () => {
    const opened = await bridge.openWorkspace(projectA)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    if (!opened.ok || !opened.workspacePath) {
      throw new Error('the workspace must open with a path')
    }
    const rpc = (method: string, params?: Record<string, unknown>) =>
      bridge.rpc(method, params ?? {}, projectA)

    // The panel's boot: create the PTY inside the user's own checkout.
    const created = await rpc('terminal.create', {
      worktree: cloudWorktreeSelector(opened.workspacePath),
      title: 'cloud-admin'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) {
      throw new Error('terminal.create refused')
    }
    const handle = readString(readField(created.result, 'terminal'), 'handle')
    expect(handle, JSON.stringify(created)).toEqual(expect.any(String))
    if (handle === null) {
      throw new Error('terminal handle missing')
    }

    // The shell is real: keystrokes go to a PTY and the echo comes back through
    // the host's own buffer read. (The panel's stream itself rides a second
    // socket, which today's one-shot ticket refuses — recorded in the W5b
    // evidence, dispatched separately.)
    const sent = await rpc('terminal.send', {
      terminal: handle,
      text: `echo ${TERMINAL_ECHO_MARKER}\n`
    })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    const read = await waitForTerminalLine(rpc, handle, TERMINAL_ECHO_MARKER)
    expect(read.ok, JSON.stringify(read)).toBe(true)

    // The panel's resize path keeps the host grid in step with the pane.
    const resized = await rpc('terminal.updateViewport', {
      terminal: handle,
      client: { id: 'w5b-e2e', type: 'desktop' },
      viewport: { cols: 100, rows: 30 }
    })
    expect(resized.ok, JSON.stringify(resized)).toBe(true)

    // The panel's teardown: close the PTY with the workspace.
    const closed = await rpc('terminal.close', { terminal: handle })
    expect(closed.ok, JSON.stringify(closed)).toBe(true)

    // The file tree's open action: a read-only preview of a tracked file.
    const preview = await previewCloudFile(rpc, opened.workspacePath, 'README.md')
    expect(preview.ok, JSON.stringify(preview)).toBe(true)
    if (preview.ok) {
      expect(preview.preview.isBinary).toBe(false)
      expect(preview.preview.content).toContain('alpha-marker')
    }

    saveW5bEvidence('w5b-admin-workspace-terminal.json', {
      projectA,
      workspacePath: opened.workspacePath,
      terminal: created,
      echoRead: read,
      viewportUpdate: resized,
      preview,
      permissions: opened.permissions ?? null
    })

    await bridge.closeProject(projectA)
  }, 120_000)

  it('W5b-2 无 terminal 授权：只到 project_connect（占位态数据），PTY 拒绝带审计而非裸 forbidden', async () => {
    const opened = await bridge.openProject(projectViewer)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    if (!opened.ok) {
      throw new Error('project_connect must succeed for a viewer')
    }
    // The exact state the workspace gate renders the placeholder from: a live
    // link and the ticket's grants, with no terminal among them and no
    // checkout path (the viewer cannot create one).
    expect(opened.permissions ?? []).toEqual(expect.arrayContaining(['open', 'file:read']))
    expect(opened.permissions ?? []).not.toContain('terminal')
    expect(opened.workspacePath).toBeUndefined()

    const refused = await bridge.rpc(
      'terminal.create',
      { worktree: cloudWorktreeSelector(rootViewer), title: 'w5b-viewer' },
      projectViewer
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.code).toBe('forbidden')
      expect(refused.message).toContain("'terminal'")
      expect(refused.message).not.toContain('not available to mobile clients')
    }

    // Files stay readable: the viewer's panes are read-only, not dead.
    const listing = await bridge.rpc(
      'files.readDir',
      { worktree: cloudWorktreeSelector(rootViewer), relativePath: '' },
      projectViewer
    )
    expect(listing.ok, JSON.stringify(listing)).toBe(true)

    // The refusal reached the security log instead of dying as bare forbidden.
    await admission.client!.refresh()
    const audited = await fetch(`${platform.url}/v1/audit/events?eventType=host.method_denied`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    expect(audited.status, await audited.clone().text()).toBe(200)
    const events = readField(await audited.json(), 'events')
    const auditEvents = Array.isArray(events) ? events : []
    const matches = auditEvents.filter(
      (event) =>
        readString(readField(event, 'metadata'), 'method') === 'terminal.create' &&
        readString(readField(event, 'metadata'), 'denial') === 'PERMISSION_MISSING'
    )
    expect(matches.length, JSON.stringify(auditEvents)).toBeGreaterThan(0)

    saveW5bEvidence('w5b-viewer-no-terminal.json', {
      projectViewer,
      opened,
      refused,
      hostMethodDenials,
      platformAuditMatches: matches
    })

    await bridge.closeProject(projectViewer)
  }, 120_000)
})
