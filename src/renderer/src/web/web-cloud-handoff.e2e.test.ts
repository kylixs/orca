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
  type WebCloudDeviceKeyStorage,
  type WebCloudDeviceIdentity
} from './web-cloud-device-key'
import type * as WebRuntimeSessionModule from './preload-api/web-runtime-session'
import { MemoryStorage } from './web-preload-api-test-harness'
import { webRuntimeSubprotocols } from './web-pairing'

/**
 * M50: the login probe consumes the ticket, so the App must adopt its live socket.
 * A real platform, a real enrolled TLS runtime, and the real preload session prove
 * the App's client is the one that already answered status.get.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm50-web-cloud-handoff')
const PROJECT_KEY = 'm50-web-handoff-project'

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

type ReplayProbe = { status: number; reject: string | null }

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    return value
  }
  return Array.isArray(value) ? (value[0] ?? null) : null
}

/** A second upgrade with the same credential must be refused: the probe spent it. */
function probeReusedCredential(endpoint: string, protocols: string[]): Promise<ReplayProbe> {
  return new Promise((resolve) => {
    const socket = new WebSocket(endpoint, protocols)
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (probe: ReplayProbe): void => {
      if (timer) {
        clearTimeout(timer)
      }
      resolve(probe)
    }
    timer = setTimeout(() => {
      socket.terminate()
      finish({ status: 0, reject: 'timeout' })
    }, 8_000)
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      finish({
        status: response.statusCode ?? 0,
        reject: headerValue(response.headers['x-orca-reject'])
      })
      socket.terminate()
    })
    socket.once('open', () => {
      finish({ status: 101, reject: null })
      socket.close()
    })
    socket.once('error', (error) => finish({ status: -1, reject: error.message }))
  })
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectId = ''
let identity: WebCloudDeviceIdentity
let session: typeof WebRuntimeSessionModule
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm50-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-web-handoff',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m50-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m50-',
    tls: makeSelfSignedTls('dev-web-handoff')
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
      name: 'M50 Handoff Project',
      hostId: admission.host()!.hostId,
      path: mkdtempSync(join(tmpdir(), 'orca-m50-project-'))
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

  identity = loadOrCreateWebCloudDeviceKey(keyStorage)
}, 60_000)

afterAll(async () => {
  session?.closeActiveRuntimeClients()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

describe('M50 cloud login hands the live runtime to the App', () => {
  it('adopts the client that answered status.get and serves a real RPC through the preload path', async () => {
    const connection = await connectCloudProject({
      apiUrl: platform.url,
      username: 'zhangsan',
      password: 'Passw0rd!',
      deviceName: 'm50-web',
      deviceKeyStore: keyStorage,
      projectId
    })
    expect(connection.runtimeId.length).toBeGreaterThan(0)
    expect(connection.offer.cloud?.devicePublicKeyB64).toBe(identity.publicKeyB64)
    expect(connection.environment.cloudLoginRequired).toBe(true)
    expect(connection.environment.runtimeId).toBe(connection.runtimeId)

    session.adoptWebRuntimeClient(connection.client, connection.environment)

    // The App's future preload reads resolve to the same live socket, not a rebuild.
    const preloadClient = session.getClientForEnvironment(connection.environment)
    expect(preloadClient).toBe(connection.client)

    const reply = await preloadClient.call('status.get', undefined, { timeoutMs: 15_000 })
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    if (!reply.ok) {
      throw new Error(`status.get failed: ${reply.error.code} ${reply.error.message}`)
    }
    expect(reply._meta.runtimeId).toBe(connection.runtimeId)
    expect(readString(reply.result, 'runtimeId')).toBe(connection.runtimeId)

    const protocols = webRuntimeSubprotocols(connection.offer)
    if (!protocols) {
      throw new Error('expected a cloud offer to produce subprotocols')
    }
    const ticketReuse = await probeReusedCredential(cloud.endpoint, protocols)
    expect(ticketReuse.status).toBe(401)
    expect(ticketReuse.reject).toBe('replayed')

    saveEvidence('m50-handoff.json', {
      runtimeId: connection.runtimeId,
      environment: {
        id: connection.environment.id,
        name: connection.environment.name,
        cloudLoginRequired: connection.environment.cloudLoginRequired,
        runtimeId: connection.environment.runtimeId
      },
      preloadClientIsAdoptedClient: preloadClient === connection.client,
      statusReply: reply,
      ticketReuse
    })

    session.closeActiveRuntimeClients()
    expect(() => session.getClientForEnvironment(connection.environment)).toThrow(
      /cloud session ended/i
    )
  }, 45_000)
})
