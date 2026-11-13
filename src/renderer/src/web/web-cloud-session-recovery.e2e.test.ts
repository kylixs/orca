// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readString } from '../../../shared/json-fields'
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
import { connectCloudProject } from './web-cloud-connect'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import type * as WebRuntimeSessionModule from './preload-api/web-runtime-session'
import { MemoryStorage } from './web-preload-api-test-harness'

/**
 * M51: a real cloud socket, adopted by the real preload session, is killed at the
 * host. The session must report the ended session once instead of leaving the UI
 * on a dead screen; the next lookup must answer the ended error, not reconnect.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm51-cloud-session-recovery')
const PROJECT_KEY = 'm51-web-recovery-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
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
let projectId = ''
let session: typeof WebRuntimeSessionModule
let runtimeStopped = false
const keyStorage = new DeviceKeyStorage()

beforeAll(async () => {
  // The preload session reads its stored environment at module load and the
  // transport reads window timers, so install the Node equivalents first.
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    localStorage: new MemoryStorage(),
    location: { protocol: 'https:' }
  })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  session = await import('./preload-api/web-runtime-session')

  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm51-admin' })
  })
  const adminToken = readString(await adminRes.json(), 'accessToken') ?? ''
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
      ORCA_CLOUD_HOST_NAME: 'dev-web-recovery',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m51-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m51-',
    tls: makeSelfSignedTls('dev-web-recovery')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const createRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: 'M51 Recovery Project',
      hostId: admission.host()!.hostId,
      path: mkdtempSync(join(tmpdir(), 'orca-m51-project-'))
    })
  })
  expect(createRes.status, await createRes.clone().text()).toBe(201)
  projectId = readString(await createRes.json(), 'id') ?? ''
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })

  loadOrCreateWebCloudDeviceKey(keyStorage)
}, 60_000)

afterAll(async () => {
  session?.closeActiveRuntimeClients()
  admission?.client?.stop()
  if (!runtimeStopped) {
    await cloud?.runtime.stop()
  }
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

describe('M51 a dead cloud socket returns the browser to sign-in', () => {
  it('fires the ended signal once after the real host closes the connection', async () => {
    const connection = await connectCloudProject({
      apiUrl: platform.url,
      username: 'zhangsan',
      password: 'Passw0rd!',
      deviceName: 'm51-web',
      deviceKeyStore: keyStorage,
      projectId
    })
    expect(connection.runtimeId.length).toBeGreaterThan(0)
    expect(connection.environment.cloudLoginRequired).toBe(true)

    session.adoptWebRuntimeClient(connection.client, connection.environment)
    const preloadClient = session.getClientForEnvironment(connection.environment)
    expect(preloadClient).toBe(connection.client)

    // Real RPC over the adopted (already-upgraded) socket before anything is killed.
    const reply = await preloadClient.call('status.get', undefined, { timeoutMs: 15_000 })
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    if (!reply.ok) {
      throw new Error(`status.get failed: ${reply.error.code} ${reply.error.message}`)
    }
    expect(reply._meta.runtimeId).toBe(connection.runtimeId)

    const endedEvents: { at: number }[] = []
    const unsubscribe = session.subscribeCloudSessionEnded(() => {
      endedEvents.push({ at: Date.now() })
    })

    // Kill the connection for real: the host stops serving and drops the socket.
    runtimeStopped = true
    await cloud.runtime.stop()
    await expect.poll(() => endedEvents.length, { timeout: 15_000 }).toBe(1)
    // Why wait: a duplicate publication from the same drop must not add a second event.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(endedEvents).toHaveLength(1)
    unsubscribe()

    let lookupError = ''
    try {
      session.getClientForEnvironment(connection.environment)
    } catch (error) {
      lookupError = error instanceof Error ? error.message : String(error)
    }
    expect(lookupError).toMatch(/cloud session ended/i)
    expect(['disconnected', 'auth-failed']).toContain(connection.client.connectionState)

    saveEvidence('m51-session-recovery.json', {
      runtimeId: connection.runtimeId,
      preloadClientIsAdoptedClient: preloadClient === connection.client,
      realRpcBeforeKill: reply,
      endedSignal: { count: endedEvents.length, events: endedEvents },
      connectionStateAfterKill: connection.client.connectionState,
      endedLookupError: lookupError
    })
  }, 60_000)
})
