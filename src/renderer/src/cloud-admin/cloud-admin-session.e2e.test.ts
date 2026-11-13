// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { browseCloudDirectory, cloudWorktreeSelector } from '../../../shared/cloud-file-browser'
import { readString } from '../../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../../../main/persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../../main/persistence-test-harness'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../../../main/runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../../../main/runtime/rpc/methods/worktree-create-managed'
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
import type { CloudBridge } from '../cloud/use-cloud-session'
import { createCloudBrowserBridge } from '../cloud/cloud-browser-bridge'
import type { WebCloudDeviceKeyStorage } from '../web/web-cloud-device-key'

/**
 * M54: the admin session page's browser bridge against the real stack — a real
 * platform process, a real enrolled TLS runtime, and two projects on one host.
 * Proves the routing that a single-project smoke test cannot: B's workspace is
 * readable through B and refused through A, and a path outside A is refused.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm54-admin-session-page')
const PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'download']

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

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let bridge: CloudBridge
let rootA = ''
let rootB = ''
let projectA = ''
let projectB = ''

async function createProject(key: string, path: string, adminToken: string): Promise<string> {
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
      permissions: PERMISSIONS
    })
  })
  return id
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m54-admin-')))
  rootA = join(base, 'alpha-service')
  rootB = join(base, 'beta-service')
  initRepo(rootA, 'alpha-marker.txt')
  initRepo(rootB, 'beta-marker.txt')

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
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm54-admin' })
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
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  projectA = await createProject('m54-alpha', rootA, adminToken)
  projectB = await createProject('m54-beta', rootB, adminToken)
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
})
