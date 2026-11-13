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
import {
  cloudPairingOfferFromTicket,
  listCloudProjects,
  loginToCloud,
  requestCloudTicket,
  WebCloudSessionError,
  type WebCloudSession
} from './web-cloud-session'
import {
  createLocalStorageWebCloudDeviceKey,
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage,
  type WebCloudDeviceIdentity
} from './web-cloud-device-key'
import { webRuntimeSubprotocols } from './web-pairing'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'

/**
 * M48: the real browser chain. A browser device identity logs into a real
 * platform process, lists a project, fetches a real Ed25519 ticket, and maps it
 * to a cloud offer; the real transport then upgrades a real WSS endpoint.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm48-web-cloud-session')
const PROJECT_KEY = 'm48-web-session-project'
const HIDDEN_PROJECT_KEY = 'm48-web-session-hidden'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

/** The credential is a bearer ticket; evidence keeps only its shape. */
function redactProtocols(protocols: string[]): string[] {
  return protocols.map((protocol) =>
    protocol.startsWith('orca-cred.') ? 'orca-cred.<redacted>' : protocol
  )
}

function requiredProtocols(offer: Parameters<typeof webRuntimeSubprotocols>[0]): string[] {
  const protocols = webRuntimeSubprotocols(offer)
  if (!protocols) {
    throw new Error('expected a cloud offer to produce subprotocols')
  }
  return protocols
}

class MemoryStorage implements WebCloudDeviceKeyStorage {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }
}

const clock = { now: () => Date.now(), isDocumentVisible: () => true }

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ws implements every member the transport touches; only DOM's dispatchEvent is absent and never called.
const WebSocketImpl = WebSocket as unknown as typeof globalThis.WebSocket

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let visibleProjectId = ''
let hiddenProjectId = ''
let identity: WebCloudDeviceIdentity

async function captureError(run: () => Promise<unknown>): Promise<WebCloudSessionError> {
  const error = await run().then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(WebCloudSessionError)
  if (!(error instanceof WebCloudSessionError)) {
    throw new Error('expected WebCloudSessionError')
  }
  return error
}

beforeAll(async () => {
  // The transport reads window timers and the WebSocket global; inject the Node
  // equivalents so the real browser code path runs headlessly.
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('WebSocket', WebSocket)
  // The test runtime uses a throwaway certificate for a real wss:// endpoint.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm48-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-web-session',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m48-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m48-',
    tls: makeSelfSignedTls('dev-web-session')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const createProject = async (key: string): Promise<string> => {
    const response = await fetch(`${platform.url}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        key,
        name: key,
        hostId: admission.host()!.hostId,
        path: mkdtempSync(join(tmpdir(), `orca-m48-${key}-`))
      })
    })
    expect(response.status, await response.clone().text()).toBe(201)
    return readString(await response.json(), 'id') ?? ''
  }

  visibleProjectId = await createProject(PROJECT_KEY)
  hiddenProjectId = await createProject(HIDDEN_PROJECT_KEY)
  await fetch(`${platform.url}/v1/projects/${visibleProjectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })

  // The real browser key module: first call generates and persists the identity.
  identity = loadOrCreateWebCloudDeviceKey(new MemoryStorage())
})

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

function login(): Promise<WebCloudSession> {
  return loginToCloud({
    apiUrl: platform.url,
    username: 'zhangsan',
    password: 'Passw0rd!',
    devicePublicKeyB64: identity.publicKeyB64,
    deviceName: 'm48-web'
  })
}

describe('浏览器云端登录与取票（真实平台 + 真实 TLS Runtime）', () => {
  it('M48-1 login → projects → ticket → offer → status.get 返回真实 runtimeId', async () => {
    const session = await login()
    expect(session.accessToken.length).toBeGreaterThan(0)
    expect(session.deviceId.length).toBeGreaterThan(0)

    const projects = await listCloudProjects(session)
    const visible = projects.find((project) => project.id === visibleProjectId)
    expect(visible).toBeDefined()
    expect(projects.some((project) => project.id === hiddenProjectId)).toBe(false)

    const ticket = await requestCloudTicket(session, visibleProjectId, identity.publicKeyB64)
    expect(ticket.endpoints.direct.length).toBeGreaterThan(0)
    expect(ticket.host.e2eePublicKeyB64).toBe(cloud.serverPublicKeyB64)

    const offer = cloudPairingOfferFromTicket(ticket, identity.publicKeyB64)
    expect(offer.endpoint).toBe(cloud.endpoint)
    expect(offer.cloud?.credential).toBe(ticket.credential)
    expect(offer.cloud?.devicePublicKeyB64).toBe(identity.publicKeyB64)
    expect(offer.publicKeyB64).toBe(ticket.host.e2eePublicKeyB64)
    expect(offer.deviceToken.length).toBeGreaterThan(0)

    const protocols = requiredProtocols(offer)
    const states: string[] = []
    const transport = new WebRuntimeConnectionTransport(
      offer,
      clock,
      { reconnect: false, onStateChanged: (state) => states.push(state) },
      { WebSocketImpl, deviceSecretKeyB64: identity.secretKeyB64 }
    )
    try {
      await transport.waitForConnected(15_000)
      const reply = await transport.call('status.get', undefined, { timeoutMs: 15_000 })
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      if (!reply.ok) {
        throw new Error(`status.get failed: ${reply.error.code} ${reply.error.message}`)
      }
      expect(reply._meta.runtimeId.length).toBeGreaterThan(0)
      saveEvidence('m48-1-web-cloud-session-positive.json', {
        login: { deviceId: session.deviceId, username: session.user.username },
        projects,
        ticket: {
          endpoint: offer.endpoint,
          direct: ticket.endpoints.direct,
          relay: ticket.endpoints.relay,
          expiresIn: ticket.expiresIn,
          host: { id: ticket.host.id, name: ticket.host.name },
          e2eePublicKeyB64: ticket.host.e2eePublicKeyB64
        },
        offer: {
          v: offer.v,
          endpoint: offer.endpoint,
          deviceToken: '<redacted>',
          publicKeyB64: offer.publicKeyB64,
          scope: offer.scope,
          cloud: { credential: '<redacted>', devicePublicKeyB64: offer.cloud?.devicePublicKeyB64 }
        },
        protocols: redactProtocols(protocols),
        states,
        reply
      })
    } finally {
      transport.close()
    }
  }, 30_000)

  it('M48-2 wrong password surfaces INVALID_CREDENTIALS and yields no session', async () => {
    const error = await captureError(() =>
      loginToCloud({
        apiUrl: platform.url,
        username: 'zhangsan',
        password: 'wrong-password',
        devicePublicKeyB64: identity.publicKeyB64,
        deviceName: 'm48-web'
      })
    )
    expect(error.code).toBe('INVALID_CREDENTIALS')
    expect(error.status).toBe(401)
    saveEvidence('m48-2-web-cloud-session-invalid-credentials.json', {
      code: error.code,
      status: error.status,
      message: error.message
    })
  }, 30_000)

  it('M48-3 project the user cannot see surfaces PROJECT_NOT_FOUND', async () => {
    const session = await login()
    const error = await captureError(() =>
      requestCloudTicket(session, hiddenProjectId, identity.publicKeyB64)
    )
    expect(error.status).toBe(404)
    expect(error.code).toBe('PROJECT_NOT_FOUND')
    saveEvidence('m48-3-web-cloud-session-hidden-project.json', {
      code: error.code,
      status: error.status,
      message: error.message
    })
  }, 30_000)

  it('M48-4 localStorage factory names the persisted device key slot', () => {
    const store = new Map<string, string>()
    const storage: Storage = {
      get length() {
        return store.size
      },
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      removeItem: (key: string) => {
        store.delete(key)
      },
      setItem: (key: string, value: string) => {
        store.set(key, value)
      }
    }
    store.set('orca.webCloudDeviceKey', JSON.stringify(identity))
    const persisted = loadOrCreateWebCloudDeviceKey(createLocalStorageWebCloudDeviceKey(storage))
    expect(persisted).toEqual(identity)
    expect([...store.keys()]).toEqual(['orca.webCloudDeviceKey'])
  })
})
