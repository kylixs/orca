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
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { connectCloudProject, type WebCloudConnectClientFactory } from './web-cloud-connect'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage,
  type WebCloudDeviceIdentity
} from './web-cloud-device-key'
import { WebRuntimeConnectionTransport } from './web-runtime-connection-transport'

/**
 * M49: the real cloud entry. A real platform process, a real enrolled TLS
 * runtime, and the browser's real connectCloudProject drive a real WSS upgrade.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm49-web-cloud-connect')
const PROJECT_KEY = 'm49-web-connect-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
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
const store = new MemoryStorage()

beforeAll(async () => {
  // The transport reads window timers and the WebSocket global; inject the Node
  // equivalents so the real browser code path runs headlessly.
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'm49-admin'
    })
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
      ORCA_CLOUD_HOST_NAME: 'dev-web-connect',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m49-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m49-',
    tls: makeSelfSignedTls('dev-web-connect')
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
      name: 'M49 Browser Project',
      hostId: admission.host()!.hostId,
      path: mkdtempSync(join(tmpdir(), 'orca-m49-project-'))
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

  identity = loadOrCreateWebCloudDeviceKey(store)
}, 60_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

function connect(extra: Partial<Parameters<typeof connectCloudProject>[0]> = {}) {
  return connectCloudProject({
    apiUrl: platform.url,
    username: 'zhangsan',
    password: 'Passw0rd!',
    deviceName: 'm49-web',
    deviceKeyStore: store,
    projectId,
    ...extra
  })
}

/**
 * The module validates with the ticket it returns, which consumes it. This probe
 * replies without opening the socket, leaving the returned ticket fresh for the
 * transport assertion below.
 */
const probeStatusReply: RuntimeRpcResponse<unknown> = {
  id: 'probe',
  ok: true,
  result: { deviceScope: 'runtime' },
  _meta: { runtimeId: 'probe-runtime' }
}

const probeFactory: WebCloudConnectClientFactory = () => ({
  call: async () => probeStatusReply,
  close: () => undefined
})

describe('浏览器云端登录入口（真实平台 + 真实 TLS Runtime）', () => {
  it('M49-1 connectCloudProject 返回真实 runtimeId，且设备私钥不进入 offer', async () => {
    const result = await connect()

    expect(result.runtimeId.length).toBeGreaterThan(0)
    expect(result.projectName).toBe('M49 Browser Project')
    expect(result.environmentName).toBe('M49 Browser Project')
    expect(result.offer.endpoint).toBe(cloud.endpoint)
    expect(result.offer.cloud?.devicePublicKeyB64).toBe(identity.publicKeyB64)
    expect(result.offer.publicKeyB64).toBe(cloud.serverPublicKeyB64)
    expect(result.deviceSecretKeyB64).toBe(identity.secretKeyB64)
    const serializedOffer = JSON.stringify(result.offer)
    expect(serializedOffer).not.toContain(identity.secretKeyB64)
    expect(serializedOffer).not.toContain('secretKeyB64')

    saveEvidence('m49-1-web-cloud-connect.json', {
      runtimeId: result.runtimeId,
      environmentName: result.environmentName,
      offer: {
        v: result.offer.v,
        endpoint: result.offer.endpoint,
        deviceToken: '<redacted>',
        publicKeyB64: result.offer.publicKeyB64,
        scope: result.offer.scope,
        cloud: {
          credential: '<redacted>',
          devicePublicKeyB64: result.offer.cloud?.devicePublicKeyB64
        }
      },
      secretLeakedIntoOffer: serializedOffer.includes(identity.secretKeyB64)
    })
  }, 30_000)

  it('M49-2 连续调用换新票据，返回的 offer 被真实传输接受', async () => {
    const first = await connect()
    const second = await connect()
    expect(first.runtimeId.length).toBeGreaterThan(0)
    expect(second.runtimeId.length).toBeGreaterThan(0)
    expect(first.offer.cloud?.credential).not.toBe(second.offer.cloud?.credential)

    const accepted = await connect({ clientFactory: probeFactory })
    expect(accepted.offer.cloud?.credential).not.toBe(first.offer.cloud?.credential)
    expect(accepted.offer.cloud?.credential).not.toBe(second.offer.cloud?.credential)

    const transport = new WebRuntimeConnectionTransport(
      accepted.offer,
      clock,
      { reconnect: false },
      { WebSocketImpl, deviceSecretKeyB64: accepted.deviceSecretKeyB64 }
    )
    try {
      await transport.waitForConnected(15_000)
      expect(transport.state).toBe('connected')
      const reply = await transport.call('status.get', undefined, {
        timeoutMs: 15_000
      })
      expect(reply.ok, JSON.stringify(reply)).toBe(true)
      if (!reply.ok) {
        throw new Error(`status.get failed: ${reply.error.code} ${reply.error.message}`)
      }
      expect(reply._meta.runtimeId.length).toBeGreaterThan(0)

      saveEvidence('m49-2-web-cloud-connect-transport.json', {
        firstRuntimeId: first.runtimeId,
        secondRuntimeId: second.runtimeId,
        distinctTickets:
          new Set([
            first.offer.cloud?.credential,
            second.offer.cloud?.credential,
            accepted.offer.cloud?.credential
          ]).size === 3,
        transportState: transport.state,
        transportRuntimeId: reply._meta.runtimeId,
        reply
      })
    } finally {
      transport.close()
    }
  }, 45_000)
})
