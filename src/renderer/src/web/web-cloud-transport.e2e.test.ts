// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { headerText } from '../../../shared/http-header-text'
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
  CloudConnectClient,
  type CloudConnectTicket
} from '../../../main/cloud-platform/cloud-connect-client'
import { readTicketClaims } from '../../../main/cloud-platform/cloud-connect-response'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'
import {
  WebPairingCloudKeyError,
  webRuntimeSubprotocols,
  type WebPairingOffer
} from './web-pairing'

/**
 * M47: the real browser transport connected to a real cloud host. The offer carries
 * a ticket and the device key only as WebSocket subprotocols, exactly as a browser
 * would send them; the host's admission gate and the E2EE handshake both must accept it.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm47-web-cloud-transport')
const PROJECT_KEY = 'm47-web-transport-project'

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

function requiredProtocols(offer: WebPairingOffer): string[] {
  const protocols = webRuntimeSubprotocols(offer)
  if (!protocols) {
    throw new Error('expected a cloud offer to produce subprotocols')
  }
  return protocols
}

function offerFor(ticket: CloudConnectTicket, devicePublicKeyB64: string): WebPairingOffer {
  const deviceToken = readTicketClaims(ticket.credential).deviceToken
  if (deviceToken === null) {
    throw new Error('ticket has no device token')
  }
  return {
    v: 2,
    endpoint: cloud.endpoint,
    deviceToken,
    publicKeyB64: ticket.host.e2eePublicKeyB64,
    cloud: { credential: ticket.credential, devicePublicKeyB64 }
  }
}

const clock = { now: () => Date.now(), isDocumentVisible: () => true }

/** The platform-registered secret the browser would load from its key store. */
function deviceSecretKey(): string {
  return Buffer.from(desktop.deviceKeyPair().secretKey).toString('base64')
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ws implements every member the transport touches; only DOM's dispatchEvent is absent and never called.
const WebSocketImpl = WebSocket as unknown as typeof globalThis.WebSocket

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectId = ''
let desktop: CloudConnectClient

type UpgradeAttempt = { status: number; reject: string | undefined }

/** Opens the upgrade with no device header, exactly as a browser would. */
function attemptUpgrade(protocols: string[]): Promise<UpgradeAttempt> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cloud.endpoint, protocols, {
      rejectUnauthorized: false,
      handshakeTimeout: 5000
    })
    ws.once('unexpected-response', (_request, response) => {
      resolve({
        status: response.statusCode ?? 0,
        reject: headerText(response.headers['x-orca-reject'])
      })
      ws.terminate()
    })
    ws.once('open', () => {
      ws.close()
      reject(new Error('expected the upgrade to be refused'))
    })
    ws.once('error', reject)
  })
}

beforeAll(async () => {
  // The browser transport reads window timers and the WebSocket global; inject
  // the Node equivalents so the real code path runs headlessly.
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('WebSocket', WebSocket)
  // The test runtime uses a throwaway certificate for a real wss:// endpoint.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm47-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-web-transport',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m47-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m47-',
    tls: makeSelfSignedTls('dev-web-transport')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      path: mkdtempSync(join(tmpdir(), 'orca-m47-project-'))
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  projectId = readString(await create.json(), 'id') ?? ''
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
})

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

describe('浏览器传输层携带云票据（真实平台 + 真实 TLS Runtime）', () => {
  it('M47-1 子协议票据 + 设备公钥完成升级，status.get 返回真实 runtimeId', async () => {
    const ticket = await desktop.requestTicket(projectId)
    const offer = offerFor(ticket, desktop.devicePubKeyB64)
    const protocols = requiredProtocols(offer)
    const states: string[] = []
    const transport = new WebRuntimeConnectionTransport(
      offer,
      clock,
      { reconnect: false, onStateChanged: (state) => states.push(state) },
      { WebSocketImpl, deviceSecretKeyB64: deviceSecretKey() }
    )
    try {
      await transport.waitForConnected(15_000)
      const reply = await transport.call('status.get', undefined, { timeoutMs: 15_000 })
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      if (!reply.ok) {
        throw new Error(`status.get failed: ${reply.error.code} ${reply.error.message}`)
      }
      expect(reply._meta.runtimeId.length).toBeGreaterThan(0)
      saveEvidence('m47-1-web-cloud-transport-positive.json', {
        protocols: redactProtocols(protocols),
        devicePublicKeyB64: desktop.devicePubKeyB64,
        states,
        reply
      })
    } finally {
      transport.close()
    }
  }, 30_000)

  it('M47-2 设备公钥与票据不匹配：传输层不会进入 connected，升级被 device_mismatch 拒绝', async () => {
    const ticket = await desktop.requestTicket(projectId)
    const strangerKey = Buffer.from(randomBytes(32)).toString('base64')
    const offer = offerFor(ticket, strangerKey)
    const states: string[] = []
    const transport = new WebRuntimeConnectionTransport(
      offer,
      clock,
      { reconnect: false, onStateChanged: (state) => states.push(state) },
      { WebSocketImpl, deviceSecretKeyB64: deviceSecretKey() }
    )
    try {
      const error = await transport.waitForConnected(8000).then(
        () => null,
        (reason: unknown) => reason
      )
      expect(error).toBeInstanceOf(Error)
      expect(states).not.toContain('connected')
      expect(transport.state).not.toBe('connected')

      // Why a raw probe: the browser API hides the HTTP status of a refused
      // upgrade, so this is the only way to show the refusal was the device binding.
      const probeTicket = await desktop.requestTicket(projectId)
      const probeOffer = offerFor(probeTicket, strangerKey)
      const outcome = await attemptUpgrade(requiredProtocols(probeOffer))
      expect(outcome.status).toBe(401)
      expect(outcome.reject).toBe('device_mismatch')
      saveEvidence('m47-2-web-cloud-transport-wrong-device-key.json', {
        states,
        transportError: error instanceof Error ? error.message : String(error),
        upgrade: outcome
      })
    } finally {
      transport.close()
    }
  }, 30_000)

  it('M47-3 云端 offer 缺少设备私钥时在构造期失败，而不是退回无凭据连接', () => {
    const offer: WebPairingOffer = {
      v: 2,
      endpoint: cloud.endpoint,
      deviceToken: 'token',
      publicKeyB64: cloud.serverPublicKeyB64,
      cloud: { credential: 'header.payload.signature', devicePublicKeyB64: desktop.devicePubKeyB64 }
    }
    expect(() => new WebRuntimeConnectionTransport(offer, clock, {}, { WebSocketImpl })).toThrow(
      WebPairingCloudKeyError
    )
  })
})
