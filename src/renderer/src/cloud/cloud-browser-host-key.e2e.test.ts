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
import { createCloudBrowserBridge } from './cloud-browser-bridge'
import type { BrowserCloudClient } from './cloud-browser-bridge-replies'
import type { WebCloudDeviceKeyStorage } from '../web/web-cloud-device-key'
import type { WebPairingOffer } from '../web/web-pairing'
import type { WebCloudSessionStorage } from '../web/web-cloud-session-storage'
import { WebRuntimeClient } from '../web/web-runtime-client'

/**
 * M82 (AC-29, browser half): the admin console pins a host's E2EE key too. A real
 * platform, a real enrolled TLS runtime, a real browser bridge and a real WSS
 * socket; the substituted-key case must be refused before any socket is opened.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm82-web-host-key')
const PROJECT_KEY = 'm82-web-host-key-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

class MemoryStore implements WebCloudDeviceKeyStorage {
  value: string | null = null
  read(): string | null {
    return this.value
  }
  write(value: string): void {
    this.value = value
  }
}

class MemoryText implements WebCloudSessionStorage {
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

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectId = ''
let hostId = ''
let hostCredential = ''

beforeAll(async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('WebSocket', WebSocket)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm82-admin' })
  })
  const adminToken = readString(await adminRes.json(), 'accessToken') ?? ''
  expect(adminToken).not.toBe('')
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
      ORCA_CLOUD_HOST_NAME: 'dev-m82-web',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m82-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready
  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m82-',
    tls: makeSelfSignedTls('dev-m82-web')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()
  hostId = admission.host()!.hostId
  hostCredential = admission.host()!.credential

  const createRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: 'M82 Browser Host Key',
      hostId,
      path: mkdtempSync(join(tmpdir(), 'orca-m82-project-'))
    })
  })
  expect(createRes.status, await createRes.clone().text()).toBe(201)
  projectId = readString(await createRes.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })
  expect(grant.status).toBe(200)
}, 120_000)

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  vi.unstubAllGlobals()
})

function advertiseKey(e2eePublicKeyB64: string): Promise<Response> {
  return fetch(`${platform.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostCredential}` },
    body: JSON.stringify({ status: 'online', e2eePublicKeyB64 })
  })
}

function makeBridge(): {
  bridge: ReturnType<typeof createCloudBrowserBridge>
  hostTrust: MemoryText
  /** Socket creations, so "refused before opening anything" is measurable. */
  counters: { opened: number }
} {
  const hostTrust = new MemoryText()
  const counters = { opened: 0 }
  const bridge = createCloudBrowserBridge({
    apiUrl: platform.url,
    deviceName: 'm82-web',
    deviceKeyStore: new MemoryStore(),
    sessionStorage: new MemoryText(),
    hostTrustStorage: hostTrust,
    clientFactory: (offer: WebPairingOffer, secretKeyB64: string): BrowserCloudClient => {
      counters.opened += 1
      return new WebRuntimeClient(offer, { deviceSecretKeyB64: secretKeyB64 })
    }
  })
  return { bridge, hostTrust, counters }
}

describe('浏览器侧主机公钥固定（真实平台 + 真实 TLS Runtime + 真实 WSS）', () => {
  it('M82-1 首次固定、平台换钥时在开 socket 前拒绝，重新核对后恢复', async () => {
    const { bridge, hostTrust, counters } = makeBridge()
    const sockets = (): number => counters.opened
    await bridge.login('zhangsan', 'Passw0rd!')

    const first = await bridge.openProject(projectId)
    expect(first.ok, JSON.stringify(first)).toBe(true)
    if (!first.ok) {
      throw new Error('expected the first open to succeed')
    }
    const realFingerprint = first.hostFingerprint
    expect(realFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    await bridge.closeProject(projectId)
    const socketsAfterFirst = sockets()

    // The platform now hands out a different key for the same host.
    const rogueKey = Buffer.alloc(32, 0x33).toString('base64')
    expect((await advertiseKey(rogueKey)).status).toBe(200)

    const refused = await bridge.openProject(projectId)
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      throw new Error('expected a refusal')
    }
    expect(refused.code).toBe('FINGERPRINT_MISMATCH')
    expect(refused.hostKey).toMatchObject({
      hostId,
      pinnedFingerprint: realFingerprint
    })
    expect(refused.hostKey?.seenFingerprint).not.toBe(realFingerprint)
    // No socket was created for the substituted key.
    expect(sockets()).toBe(socketsAfterFirst)

    // Re-verification pins what the mismatch exposed, exactly once.
    expect(await bridge.trustHostKey?.(hostId)).toEqual({ ok: true })
    expect(await bridge.trustHostKey?.(hostId)).toEqual({
      ok: false,
      code: 'HOST_KEY_NOT_PENDING'
    })
    expect(hostTrust.value).toContain(refused.hostKey?.seenFingerprint ?? '')

    // The platform goes back to the real key: that is now a mismatch against the
    // re-verified pin, and confirming again restores the original fingerprint.
    const realKey = cloud.serverPublicKeyB64
    expect((await advertiseKey(realKey)).status).toBe(200)
    const second = await bridge.openProject(projectId)
    expect(second.ok).toBe(false)
    if (second.ok) {
      throw new Error('expected a second refusal')
    }
    expect(second.hostKey?.pinnedFingerprint).toBe(refused.hostKey?.seenFingerprint)
    expect(second.hostKey?.seenFingerprint).toBe(realFingerprint)
    expect(await bridge.trustHostKey?.(hostId)).toEqual({ ok: true })

    const reopened = await bridge.openProject(projectId)
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true)
    if (!reopened.ok) {
      throw new Error('expected the reopen to succeed')
    }
    expect(reopened.hostFingerprint).toBe(realFingerprint)

    saveEvidence('m82-web-host-key.json', {
      hostId,
      realFingerprint,
      firstOpen: { ok: first.ok, route: first.route },
      refusal: refused.hostKey,
      socketsBeforeSubstitution: socketsAfterFirst,
      socketsAfterRefusal: socketsAfterFirst,
      reopenedFingerprint: reopened.hostFingerprint,
      persisted: hostTrust.value !== null
    })
    bridge.logout()
  }, 90_000)
})
