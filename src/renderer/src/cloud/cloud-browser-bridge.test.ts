// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ownEntries, parseJsonText, readString } from '../../../shared/json-fields'
import type { WebCloudDeviceKeyStorage } from '../web/web-cloud-device-key'
import type { WebPairingOffer } from '../web/web-pairing'
import { createCloudBrowserBridge, type BrowserCloudClient } from './cloud-browser-bridge'

/** The bridge's contract: project-scoped routing, one client per open project. */

const HOST_KEY_B64 = Buffer.alloc(32, 0x07).toString('base64')
const PROJECTS = [
  {
    id: 'proj-1',
    key: 'alpha',
    name: 'Alpha',
    hostName: 'dev-1',
    hostStatus: 'online',
    permissions: ['open', 'terminal', 'file:read']
  },
  {
    id: 'proj-2',
    key: 'beta',
    name: 'Beta',
    hostName: 'dev-1',
    hostStatus: 'online',
    permissions: ['open', 'terminal', 'file:read']
  }
]

class DeviceKeyStorage implements WebCloudDeviceKeyStorage {
  value: string | null = null
  writes: string[] = []

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
    this.writes.push(value)
  }
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(claims)}.signature`
}

function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function ticketReply(projectId: string, devicePublicKeyB64: string): Record<string, unknown> {
  return {
    credential: jwt({
      deviceToken: `device-token-${projectId}`,
      deviceId: 'device-1',
      devicePubKey: devicePublicKeyB64,
      host: 'host-1',
      perms: ['open', 'terminal', 'file:read']
    }),
    expiresIn: 300,
    host: {
      id: 'host-1',
      name: 'dev-m54',
      fingerprint: 'fp',
      tlsFingerprint: 'tf',
      e2eePublicKeyB64: HOST_KEY_B64,
      capabilities: ['terminal']
    },
    endpoints: {
      direct: [{ priority: 1, url: 'wss://runtime.test' }],
      relay: [{ priority: 9, url: 'wss://relay.test' }]
    },
    workspace: {
      projectRoot: `/srv/${projectId}`,
      workspaceRoot: `/srv/${projectId}/.orca-worktrees/zhangsan`,
      defaultBranch: 'main'
    }
  }
}

type ScriptedPlatform = {
  fetchImpl: typeof fetch
  requests: string[]
  devicePublicKeyB64: () => string
}

function scriptedPlatform(): ScriptedPlatform {
  const requests: string[] = []
  let devicePublicKey = ''
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/v1/auth/login')) {
      const body = typeof init?.body === 'string' ? parseJsonText(init.body) : null
      devicePublicKey = readString(body, 'devicePubKey') ?? ''
      return jsonReply({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        user: {
          id: 'user-1',
          username: 'zhangsan',
          displayName: '张三',
          roles: [],
          permissions: []
        },
        device: { id: 'device-1' }
      })
    }
    if (url.endsWith('/v1/projects')) {
      return jsonReply({ projects: PROJECTS })
    }
    const connect = /\/v1\/projects\/([^/]+)\/connect$/.exec(url)
    if (connect) {
      const projectId = decodeURIComponent(connect[1])
      return jsonReply(ticketReply(projectId, devicePublicKey))
    }
    return jsonReply({ error: { code: 'not_found', message: url } }, 404)
  }
  return { fetchImpl, requests, devicePublicKeyB64: () => devicePublicKey }
}

type FakeCall = { projectId: string; method: string; params: unknown }

function scriptedFactory(offers: WebPairingOffer[], calls: FakeCall[]) {
  return (offer: WebPairingOffer): BrowserCloudClient => {
    offers.push(offer)
    const projectId = offer.deviceToken.replace('device-token-', '')
    return {
      connectionState: 'connected',
      call: async (method: string, params?: unknown) => {
        calls.push({ projectId, method, params })
        return {
          id: `fake-${projectId}`,
          ok: true,
          result: { runtimeId: 'runtime-1', projectId },
          _meta: { runtimeId: 'runtime-1' }
        }
      },
      close: () => undefined
    }
  }
}

function makeBridge(): {
  bridge: ReturnType<typeof createCloudBrowserBridge>
  storage: DeviceKeyStorage
  offers: WebPairingOffer[]
  calls: FakeCall[]
  platform: ScriptedPlatform
} {
  const storage = new DeviceKeyStorage()
  const offers: WebPairingOffer[] = []
  const calls: FakeCall[] = []
  const platform = scriptedPlatform()
  const bridge = createCloudBrowserBridge({
    apiUrl: 'http://platform.test',
    deviceName: 'm54-admin',
    deviceKeyStore: storage,
    fetchImpl: platform.fetchImpl,
    clientFactory: scriptedFactory(offers, calls)
  })
  return { bridge, storage, offers, calls, platform }
}

describe('浏览器 CloudBridge', () => {
  it('按 projectId 路由到各自的连接，关掉一个不影响另一个', async () => {
    const { bridge, calls } = makeBridge()
    const state = await bridge.login('zhangsan', 'Passw0rd!')
    expect(state.status).toBe('signed-in')
    if (state.status !== 'signed-in') {
      throw new Error('login expected to succeed')
    }
    expect(state.projects.map((project) => project.id)).toEqual(['proj-1', 'proj-2'])

    const openedA = await bridge.openProject('proj-1')
    const openedB = await bridge.openProject('proj-2')
    expect(openedA).toMatchObject({ ok: true, projectId: 'proj-1', route: 'direct' })
    expect(openedB).toMatchObject({ ok: true, projectId: 'proj-2', route: 'direct' })

    const rpcA = await bridge.rpc('status.get', {}, 'proj-1')
    const rpcB = await bridge.rpc('status.get', {}, 'proj-2')
    expect(rpcA.ok && rpcB.ok).toBe(true)
    expect(
      calls.filter((call) => call.method === 'status.get').map((call) => call.projectId)
    ).toEqual(['proj-1', 'proj-2', 'proj-1', 'proj-2'])
    // The probe and the routed call both went to their own project's client.
    expect(rpcA.ok ? rpcA.result : null).toMatchObject({ projectId: 'proj-1' })
    expect(rpcB.ok ? rpcB.result : null).toMatchObject({ projectId: 'proj-2' })

    await bridge.closeProject('proj-1')
    expect(await bridge.rpc('status.get', {}, 'proj-1')).toEqual({
      ok: false,
      code: 'NOT_CONNECTED'
    })
    expect((await bridge.rpc('status.get', {}, 'proj-2')).ok).toBe(true)

    const signedOut = await bridge.logout()
    expect(signedOut).toEqual({ status: 'signed-out' })
    expect(await bridge.rpc('status.get', {}, 'proj-2')).toEqual({
      ok: false,
      code: 'NOT_SIGNED_IN'
    })
  })

  it('offer 与桥状态不含设备私钥，持久化只写调用方注入的设备身份', async () => {
    const { bridge, storage, offers, platform } = makeBridge()
    await bridge.login('zhangsan', 'Passw0rd!')
    await bridge.openProject('proj-1')

    expect(offers).toHaveLength(1)
    expect(offers[0].cloud?.devicePublicKeyB64).toBe(platform.devicePublicKeyB64())

    const persisted = storage.read() ?? ''
    const stored = parseJsonText(persisted)
    const secretKeyB64 = readString(stored, 'secretKeyB64') ?? ''
    expect(secretKeyB64.length).toBeGreaterThan(0)
    expect(
      ownEntries(stored)
        .map(([key]) => key)
        .sort()
    ).toEqual(['publicKeyB64', 'secretKeyB64'])
    expect(persisted).not.toContain('access-1')
    expect(persisted).not.toContain('refresh-1')
    expect(persisted).not.toContain('device-token-')

    // The offer carries the public key and the single-use ticket, never the secret.
    expect(JSON.stringify(offers[0])).not.toContain(secretKeyB64)
    expect(JSON.stringify(await bridge.getState())).not.toContain(secretKeyB64)
    // Exactly one write: the injected store created the identity on first use.
    expect(storage.writes).toHaveLength(1)
  })
})
