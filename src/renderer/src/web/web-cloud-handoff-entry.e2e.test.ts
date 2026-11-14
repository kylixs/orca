// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readArray, readString } from '../../../shared/json-fields'
import {
  REPO_ROOT,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from '../../../main/cloud-platform/cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../../../main/startup/cloud-runtime-admission'
import {
  enterWorkspaceViaWebHandoff,
  readWebCloudHandoffEntry,
  type WebCloudHandoffEntry
} from './web-cloud-handoff-entry'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import {
  createLocalStorageWebCloudSessionStorage,
  readPersistedWebCloudSession
} from './web-cloud-session-storage'
import { readStoredWebRuntimeEnvironment } from './web-runtime-environment'

/**
 * M122 (FR-3.10, W7b): the browser side of the one-time handoff. A real platform
 * mints the entry URL, and the real entry module trades its hash code for a
 * session and opens the named project — plus every way the entry falls back to
 * the sign-in form instead.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'w7b-handoff-web')
const PROJECT_KEY = 'w7b-handoff-project'

/**
 * The entry module statically pulls in the preload session, whose import reads
 * `window.localStorage`; the stub must exist before any import runs.
 */
const browserStorage = vi.hoisted(() => {
  const values = new Map<string, string>()
  const localStorage: Storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    },
    removeItem: (key: string): void => {
      values.delete(key)
    },
    clear: (): void => values.clear(),
    get length(): number {
      return values.size
    },
    key: (index: number): string | null => Array.from(values.keys())[index] ?? null
  }
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    localStorage,
    location: { protocol: 'http:' }
  })
  return localStorage
})

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

class KeyStorage implements WebCloudDeviceKeyStorage {
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
let projectId = ''
const deviceStore = new KeyStorage()

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function login(username: string, password: string, deviceName: string): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName })
  })
  return readString(await res.json(), 'accessToken') ?? ''
}

/** Issues a handoff URL for one project and splits the entry the web page reads. */
async function issueHandoff(
  token: string,
  id: string
): Promise<WebCloudHandoffEntry & { rawUrl: string }> {
  const res = await fetch(`${platform.url}/v1/projects/${id}/web-handoff`, {
    method: 'POST',
    headers: auth(token)
  })
  expect(res.status).toBe(201)
  const rawUrl = readString(await res.json(), 'url') ?? ''
  const url = new URL(rawUrl)
  const entry = readWebCloudHandoffEntry({ hash: url.hash, search: url.search })
  expect(entry, `the issued URL must parse as a handoff entry: ${rawUrl}`).not.toBeNull()
  return { ...entry!, rawUrl }
}

function enter(entry: WebCloudHandoffEntry) {
  return enterWorkspaceViaWebHandoff({
    entry,
    deviceKeyStore: deviceStore,
    sessionStorage: createLocalStorageWebCloudSessionStorage(browserStorage)
  })
}

beforeAll(async () => {
  // The socket global is only touched at connect time, so a body-level stub works.
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  platform = await startPlatform()
  const adminToken = await login('admin', 'Adm1n!', 'w7b-admin')
  expect(adminToken).not.toBe('')

  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  const hostToken = readString(await tokenRes.json(), 'token') ?? ''
  expect(hostToken).not.toBe('')

  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-w7b-handoff',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-w7b-host-')) }
  )
  expect(started).not.toBeNull()
  admission = started!
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-w7b-',
    tls: makeSelfSignedTls('dev-w7b-handoff')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const createRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: 'W7B Handoff Project',
      hostId: admission.host()!.hostId,
      path: mkdtempSync(join(tmpdir(), 'orca-w7b-project-'))
    })
  })
  expect(createRes.status).toBe(201)
  projectId = readString(await createRes.json(), 'id') ?? ''
  const grantRes = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })
  expect(grantRes.status).toBe(200)
}, 60_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

describe('orca web 一次性 handoff 自动进入（真实平台 + 真实 TLS Runtime）', () => {
  it('W7b-1 hash 读码→换发→自动打开指定项目进工作区，URL 不携带令牌', async () => {
    const issued = await issueHandoff(await login('zhangsan', 'Passw0rd!', 'w7b-issuer'), projectId)
    const pageUrl = new URL(issued.rawUrl)
    expect([...pageUrl.searchParams.keys()]).toEqual(['api'])
    expect(issued.apiUrl).toBe(platform.url)
    expect(issued.projectId).toBe(projectId)

    const result = await enter(issued)
    expect(result.status).toBe('entered')
    if (result.status !== 'entered') {
      throw new Error('unreachable')
    }
    expect(result.projectName).toBe('W7B Handoff Project')
    expect(result.runtimeId.length).toBeGreaterThan(0)

    // The workspace really opened: the adopted environment carries the live
    // runtime id, and the exchanged session is persisted for the next page.
    const environment = readStoredWebRuntimeEnvironment()
    expect(environment?.runtimeId).toBe(result.runtimeId)
    expect(environment?.name).toBe('W7B Handoff Project (cloud session)')
    const persisted = readPersistedWebCloudSession(
      createLocalStorageWebCloudSessionStorage(browserStorage),
      platform.url
    )
    expect(persisted?.displayName?.length).toBeGreaterThan(0)
    expect(persisted?.accessToken.length).toBeGreaterThan(0)

    // The exchange enrolled a named device, not an unknown row (W7a audit n-3).
    const devicesRes = await fetch(`${platform.url}/v1/me/devices`, {
      headers: auth(persisted!.accessToken)
    })
    expect(devicesRes.status).toBe(200)
    // Shape-checked reads: a mistyped reply fails the assertions below, not the parse.
    const devices = (readArray(await devicesRes.json(), 'devices') ?? []).map((device) => ({
      name: readString(device, 'name'),
      revokedAt: readString(device, 'revokedAt')
    }))
    expect(devices.some((device) => device.name === 'Orca Web' && device.revokedAt === null)).toBe(
      true
    )

    saveEvidence('w7b-1-auto-entry.json', {
      issuedUrlHost: pageUrl.host,
      issuedUrlPath: pageUrl.pathname,
      searchParams: [...pageUrl.searchParams.entries()],
      hashKeys: [...new URLSearchParams(pageUrl.hash.replace(/^#/, '')).keys()],
      apiParam: issued.apiUrl,
      projectName: result.projectName,
      runtimeId: result.runtimeId,
      environmentName: environment?.name,
      persistedDeviceId: persisted?.deviceId,
      enrolledDeviceNames: devices.map((device) => device.name)
    })
  }, 30_000)

  it('W7b-2 code 重放 410：回落登录表单，提示已用且预填平台地址', async () => {
    const issued = await issueHandoff(await login('zhangsan', 'Passw0rd!', 'w7b-issuer'), projectId)
    const first = await enter(issued)
    expect(first.status).toBe('entered')

    const replay = await enter(issued)
    expect(replay.status).toBe('failed')
    if (replay.status !== 'failed') {
      throw new Error('unreachable')
    }
    expect(replay.apiUrl).toBe(platform.url)
    expect(replay.notice).toContain('expired or was already used')
    saveEvidence('w7b-2-replay-410.json', {
      code: 'HANDOFF_GONE',
      fallback: replay.status,
      notice: replay.notice,
      prefilledApiUrl: replay.apiUrl
    })
  }, 30_000)

  it('W7b-3 换发前授权被撤：403 回落提示无权限', async () => {
    const adminToken = await login('admin', 'Adm1n!', 'w7b-admin-revoke')
    const issued = await issueHandoff(await login('zhangsan', 'Passw0rd!', 'w7b-issuer'), projectId)
    const revoke = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      headers: auth(adminToken),
      body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
    })
    expect(revoke.status).toBe(200)
    try {
      const result = await enter(issued)
      expect(result.status).toBe('failed')
      if (result.status !== 'failed') {
        throw new Error('unreachable')
      }
      expect(result.notice).toContain('no longer has access')
      saveEvidence('w7b-3-permission-lost-403.json', {
        code: 'PROJECT_FORBIDDEN',
        fallback: result.status,
        notice: result.notice
      })
    } finally {
      const restore = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
        method: 'PUT',
        headers: auth(adminToken),
        body: JSON.stringify({
          subjectType: 'group',
          subjectId: 'team-payment',
          permissions: ['open', 'terminal', 'file:read']
        })
      })
      expect(restore.status).toBe(200)
    }
  }, 30_000)

  it('W7b-4 平台不可达：网络错误回落登录表单', async () => {
    const issued = await issueHandoff(await login('zhangsan', 'Passw0rd!', 'w7b-issuer'), projectId)
    const result = await enter({ ...issued, apiUrl: 'http://127.0.0.1:9' })
    expect(result.status).toBe('failed')
    if (result.status !== 'failed') {
      throw new Error('unreachable')
    }
    expect(result.notice).toContain('cannot be reached')
    expect(result.apiUrl).toBe('http://127.0.0.1:9')
    saveEvidence('w7b-4-network-error.json', {
      fallback: result.status,
      notice: result.notice,
      prefilledApiUrl: result.apiUrl
    })
  }, 30_000)

  it('W7b-5 换发复用既有设备：同浏览器两次进入只有一个设备行', async () => {
    const issued = await issueHandoff(await login('zhangsan', 'Passw0rd!', 'w7b-issuer'), projectId)
    const first = await enter(issued)
    expect(first.status).toBe('entered')
    const persisted = readPersistedWebCloudSession(
      createLocalStorageWebCloudSessionStorage(browserStorage),
      platform.url
    )
    const firstDeviceId = persisted?.deviceId

    const second = await enter(
      await issueHandoff(await login('zhangsan', 'Passw0rd!', 'w7b-issuer'), projectId)
    )
    expect(second.status).toBe('entered')
    const after = readPersistedWebCloudSession(
      createLocalStorageWebCloudSessionStorage(browserStorage),
      platform.url
    )
    expect(after?.deviceId).toBe(firstDeviceId)

    const identity = loadOrCreateWebCloudDeviceKey(deviceStore)
    expect(identity.publicKeyB64.length).toBeGreaterThan(0)
    saveEvidence('w7b-5-device-reuse.json', {
      firstDeviceId,
      secondDeviceId: after?.deviceId,
      reused: after?.deviceId === firstDeviceId
    })
  }, 30_000)
})
