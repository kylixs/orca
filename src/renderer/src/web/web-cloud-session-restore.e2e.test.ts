// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseJsonText, readString } from '../../../shared/json-fields'
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
import { createCloudBrowserBridge } from '../cloud/cloud-browser-bridge'
import type { CloudBridge } from '../cloud/use-cloud-session'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import type { WebCloudSessionStorage } from './web-cloud-session-storage'

/**
 * M66: a browser reload keeps the admin cloud login. Real platform + real
 * enrolled TLS runtime; "reload" is a new bridge over the same injected storage.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm66-session-persistence')
const PROJECT_KEY = 'm66-restore-project'
const PERMISSIONS = ['open', 'terminal', 'file:read', 'file:write', 'download']

class MemoryDeviceKeyStorage implements WebCloudDeviceKeyStorage {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }
}

class MemorySessionStorage implements WebCloudSessionStorage {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }

  remove(): void {
    this.value = null
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'config', 'user.email', 'e2e@example.com')
  git(path, 'config', 'user.name', 'e2e')
  writeFileSync(join(path, 'README.md'), '# m66\n')
  git(path, 'add', '.')
  git(path, 'commit', '-qm', 'init')
}

/** Captures the newest platform-issued access token so the test can revoke it. */
const latestAccessToken = { value: '' }

const recordingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const response = await fetch(input, init)
  if (url.endsWith('/v1/auth/login') || url.endsWith('/v1/auth/refresh')) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null)
    const token = readString(body, 'accessToken')
    if (token !== null) {
      latestAccessToken.value = token
    }
  }
  return response
}

function saveEvidence(content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'browser-reload.json'), JSON.stringify(content, null, 2))
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectId = ''
let deviceKeys: MemoryDeviceKeyStorage
let sessions: MemorySessionStorage
let bridge: CloudBridge | null = null

function makeBridge(): CloudBridge {
  return createCloudBrowserBridge({
    apiUrl: platform.url,
    deviceName: 'm66-web',
    deviceKeyStore: deviceKeys,
    sessionStorage: sessions,
    fetchImpl: recordingFetch
  })
}

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-m66-web-')))
  const projectRoot = join(base, 'restore-project')
  initRepo(projectRoot)

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-m66-web-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-m66',
    path: projectRoot,
    displayName: 'restore-project',
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm66-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m66-restore',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m66-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m66-',
    service,
    tls: makeSelfSignedTls('dev-m66-restore'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const created = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      path: projectRoot
    })
  })
  expect(created.status, await created.clone().text()).toBe(201)
  projectId = readString(await created.json(), 'id') ?? ''
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: PERMISSIONS
    })
  })
  // Grant changes invalidate tickets minted before them.
  await new Promise((resolve) => setTimeout(resolve, 1200))

  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    location: { protocol: 'https:' }
  })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  deviceKeys = new MemoryDeviceKeyStorage()
  sessions = new MemorySessionStorage()
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

describe('浏览器重载后恢复云会话（真实平台 + 真实票据/TLS Runtime）', () => {
  it('M66-2 同存储的新 bridge 自动登录并打开工作区；平台作废后清除存储并签退', async () => {
    const first = makeBridge()
    const signedIn = await first.login('zhangsan', 'Passw0rd!')
    expect(signedIn.status, JSON.stringify(signedIn)).toBe('signed-in')
    const storedAfterLogin = parseJsonText(sessions.value ?? '')
    const deviceId = readString(storedAfterLogin, 'deviceId')
    expect(deviceId).not.toBeNull()
    expect(sessions.value).not.toBeNull()
    // The saved login must not duplicate the device secret owned by the key store.
    const secretKeyB64 = readString(parseJsonText(deviceKeys.value ?? ''), 'secretKeyB64') ?? ''
    expect(sessions.value ?? '').not.toContain(secretKeyB64)

    // "Reload": a brand-new bridge with the same storage and key identity.
    const reloaded = makeBridge()
    bridge = reloaded
    const restoredState = await reloaded.getState()
    expect(restoredState.status).toBe('signed-in')
    if (restoredState.status !== 'signed-in') {
      throw new Error('reloaded bridge must restore the login')
    }
    expect(restoredState.displayName.length).toBeGreaterThan(0)
    expect(restoredState.projects.some((project) => project.id === projectId)).toBe(true)

    const listed = await reloaded.listProjects()
    expect(listed.some((project) => project.id === projectId)).toBe(true)

    const opened = await reloaded.openWorkspace(projectId)
    expect(opened.ok, JSON.stringify(opened)).toBe(true)
    if (!opened.ok) {
      throw new Error('restored session must open the workspace')
    }
    expect(opened.workspacePath ?? '').not.toBe('')

    const storedBeforeRevoke = parseJsonText(sessions.value ?? '')
    expect(readString(storedBeforeRevoke, 'deviceId')).toBe(deviceId)

    // The platform kills this login; a reload must not come back signed in.
    expect(latestAccessToken.value).not.toBe('')
    const revoked = await fetch(`${platform.url}/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${latestAccessToken.value}` }
    })
    expect(revoked.ok).toBe(true)

    const afterRevoke = makeBridge()
    const stateAfterRevoke = await afterRevoke.getState()
    expect(stateAfterRevoke).toEqual({ status: 'signed-out' })
    expect(sessions.value).toBeNull()
    await expect(afterRevoke.listProjects()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })

    // The device identity survives the failed restore; only the login is gone.
    const deviceAfterRevoke = loadOrCreateWebCloudDeviceKey(deviceKeys)
    expect(deviceAfterRevoke.publicKeyB64).toBe(
      readString(parseJsonText(deviceKeys.value ?? ''), 'publicKeyB64')
    )

    saveEvidence({
      reloadRestored: {
        status: restoredState.status,
        displayName: restoredState.displayName,
        projects: restoredState.projects.map((project) => project.id),
        listProjects: listed.map((project) => project.id),
        openedWorkspace: opened.workspacePath ?? null
      },
      deviceIdStable: true,
      storage: {
        afterLogin: { present: true, deviceId },
        afterFailedRestore: { present: sessions.value !== null }
      },
      revocation: {
        state: stateAfterRevoke,
        storageCleared: sessions.value === null,
        listProjectsCode: 'NOT_SIGNED_IN'
      },
      negativeControl: {
        change: 'getState never restores the saved browser session',
        expected: 'the reloaded bridge stays signed-out and the suite turns red',
        evidence: 'negative-control-browser.json'
      }
    })
  }, 180_000)
})
