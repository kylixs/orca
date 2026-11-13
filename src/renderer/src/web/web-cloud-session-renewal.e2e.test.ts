// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readString } from '../../../shared/json-fields'
import { readTicketClaims } from '../../../shared/cloud-platform-reply'
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
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceIdentity,
  type WebCloudDeviceKeyStorage
} from './web-cloud-device-key'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'

/**
 * M62: the browser session renews itself against a real platform, host, and TLS
 * runtime. The client's second-granularity expiry estimate outlives the real
 * 1.2s access token, so the first post-expiry call recovers through the 401 path.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm62-web-session-renewal')
const ACCESS_TTL_MS = 1200
const PROJECT_KEY = 'm62-renewal-project'

function saveEvidence(content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'm62-web-renewal.json'), JSON.stringify(content, null, 2))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
let projectId = ''
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

function login(refreshLeadMs = 0): Promise<WebCloudSession> {
  return loginToCloud({
    apiUrl: platform.url,
    username: 'zhangsan',
    password: 'Passw0rd!',
    devicePublicKeyB64: identity.publicKeyB64,
    deviceName: 'm62-web',
    refreshLeadMs
  })
}

beforeAll(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  platform = await startPlatform({ accessTtlMs: ACCESS_TTL_MS })
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm62-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-m62-renewal',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m62-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m62-',
    tls: makeSelfSignedTls('dev-m62-renewal')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const createRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      path: mkdtempSync(join(tmpdir(), `orca-m62-${PROJECT_KEY}-`))
    })
  })
  expect(createRes.status, await createRes.clone().text()).toBe(201)
  projectId = readString(await createRes.json(), 'id') ?? ''
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })

  identity = loadOrCreateWebCloudDeviceKey(new MemoryStorage())
}, 120_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

describe('浏览器云端会话续期（真实平台短 TTL + 真实票据/TLS Runtime）', () => {
  it('M62-1 access token 过期后自动续期并换取真实票据；会话作废后返回 SESSION_EXPIRED', async () => {
    const session = await login(0)
    const before = session.auth?.fingerprints()
    expect(before).toBeDefined()
    expect(session.expiresIn).toBe(2)

    // Why under the client estimate: the server's 1.2s token is already dead,
    // while round-up to 2s keeps ensureFresh from refreshing ahead of time.
    await sleep(ACCESS_TTL_MS + 300)
    const remainingBeforeCall = (session.auth?.accessTokenExpiresAt ?? 0) - Date.now()
    expect(remainingBeforeCall).toBeGreaterThan(0)

    const projects = await listCloudProjects(session)
    expect(projects.some((project) => project.id === projectId)).toBe(true)

    const after = session.auth?.fingerprints()
    expect(after?.access).not.toBe(before?.access)
    expect(after?.refresh).not.toBe(before?.refresh)

    const ticket = await requestCloudTicket(session, projectId, identity.publicKeyB64)
    expect(readTicketClaims(ticket.credential).deviceToken).not.toBeNull()
    const offer = cloudPairingOfferFromTicket(ticket, identity.publicKeyB64)
    expect(offer.cloud?.credential).toBe(ticket.credential)
    expect(offer.publicKeyB64).toBe(ticket.host.e2eePublicKeyB64)

    const states: string[] = []
    const transport = new WebRuntimeConnectionTransport(
      offer,
      clock,
      { reconnect: false, onStateChanged: (state) => states.push(state) },
      { WebSocketImpl, deviceSecretKeyB64: identity.secretKeyB64 }
    )
    let runtimeId = ''
    try {
      await transport.waitForConnected(15_000)
      const reply = await transport.call('status.get', undefined, { timeoutMs: 15_000 })
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      if (reply.ok) {
        runtimeId = reply._meta.runtimeId
      }
    } finally {
      transport.close()
    }
    expect(runtimeId.length).toBeGreaterThan(0)

    // Why a second session: logout revokes the server-side session by token, so
    // the renewed session above must stay usable for the rest of this scenario.
    const doomed = await login(0)
    const doomedToken = doomed.auth?.accessToken ?? doomed.accessToken
    const logout = await fetch(`${platform.url}/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${doomedToken}` }
    })
    expect(logout.ok).toBe(true)

    const error = await captureError(() =>
      requestCloudTicket(doomed, projectId, identity.publicKeyB64)
    )
    expect(error.code).toBe('SESSION_EXPIRED')
    expect(error.status).toBe(401)
    const locked = await captureError(() =>
      requestCloudTicket(doomed, projectId, identity.publicKeyB64)
    )
    expect(locked.code).toBe('SESSION_EXPIRED')

    saveEvidence({
      platformAccessTtlMs: ACCESS_TTL_MS,
      reportedExpiresInSeconds: session.expiresIn,
      clientEstimateRemainingMsBeforeExpiredCall: remainingBeforeCall,
      renewal: {
        fingerprintsBefore: before,
        fingerprintsAfter: after,
        projectsAfterExpiry: projects.map((project) => project.id),
        ticket: {
          hostId: ticket.host.id,
          endpoints: ticket.endpoints,
          deviceToken: '<redacted>',
          credential: '<redacted>'
        },
        offer: {
          endpoint: offer.endpoint,
          publicKeyB64: offer.publicKeyB64,
          devicePublicKeyB64: offer.cloud?.devicePublicKeyB64,
          credential: '<redacted>'
        },
        runtime: { runtimeId, states }
      },
      revocation: {
        code: error.code,
        status: error.status,
        message: error.message,
        fingerprintsAfterLogout: doomed.auth?.fingerprints(),
        locked: { code: locked.code, status: locked.status }
      }
    })
  }, 180_000)
})
