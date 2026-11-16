import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  connectCloudProject,
  WEB_CLOUD_CONNECT_ERROR_CODE,
  WebCloudConnectError,
  type ConnectCloudProjectInput,
  type WebCloudConnectClient,
  type WebCloudConnectClientFactory
} from './web-cloud-connect'
import type { WebPairingOffer } from './web-pairing'
import {
  loadOrCreateWebCloudDeviceKey,
  type WebCloudDeviceKeyStorage,
  type WebCloudDeviceIdentity
} from './web-cloud-device-key'
import { WebCloudSessionError } from './web-cloud-session'

/** Standard base64 host key; ticket parsing requires a usable E2EE key. */
const HOST_KEY_B64 = Buffer.alloc(32, 0x07).toString('base64')
const TICKET_CREDENTIAL = `header.${Buffer.from(
  JSON.stringify({
    deviceToken: 'device-token-1',
    deviceId: 'device-1',
    host: 'host-1',
    perms: ['open', 'terminal']
  })
).toString('base64url')}.signature`

type FetchCall = {
  url: string
  method: string
  body: string | null
  authorization: string | null
}

type Reply = { status?: number; body: unknown }

function scriptedFetch(handler: (call: FetchCall) => Reply): {
  fetchImpl: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      authorization: new Headers(init?.headers).get('authorization')
    }
    calls.push(call)
    const reply = handler(call)
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { fetchImpl, calls }
}

function projectRow(id: string, name: string): Record<string, unknown> {
  return {
    id,
    key: id,
    name,
    hostName: 'dev-host',
    hostStatus: 'online',
    permissions: ['open', 'terminal']
  }
}

/** Visible but not openable, like an admin account's first row in `/v1/projects`. */
function restrictedProjectRow(id: string, name: string): Record<string, unknown> {
  return { ...projectRow(id, name), permissions: ['download'] }
}

function ticketBody(): Record<string, unknown> {
  return {
    credential: TICKET_CREDENTIAL,
    expiresIn: 300,
    host: {
      id: 'host-1',
      name: 'dev-host',
      fingerprint: 'fp',
      tlsFingerprint: 'tf',
      e2eePublicKeyB64: HOST_KEY_B64,
      capabilities: ['terminal']
    },
    endpoints: {
      direct: [{ priority: 1, url: 'wss://runtime.example' }],
      relay: []
    },
    workspace: {
      projectRoot: '/repo',
      workspaceRoot: '/repo/ws',
      defaultBranch: 'main'
    }
  }
}

function loginBody(): Record<string, unknown> {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    user: {
      id: 'user-1',
      username: 'zhangsan',
      displayName: '张三',
      dept: '支付',
      roles: ['developer'],
      permissions: ['read']
    },
    device: { id: 'device-1', name: 'm49-web' }
  }
}

function statusSuccess(): RuntimeRpcResponse<unknown> {
  return {
    id: 'status-1',
    ok: true,
    result: { deviceScope: 'runtime', runtimeId: 'runtime-42' },
    _meta: { runtimeId: 'runtime-42' }
  }
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

type FakeClient = {
  client: WebCloudConnectClient
  calls: { method: string; options: unknown }[]
  close: ReturnType<typeof vi.fn>
}

function fakeClientFactory(reply: RuntimeRpcResponse<unknown>): {
  factory: WebCloudConnectClientFactory
  offers: WebPairingOffer[]
  secrets: string[]
  client: FakeClient
} {
  const offers: WebPairingOffer[] = []
  const secrets: string[] = []
  const calls: { method: string; options: unknown }[] = []
  const close = vi.fn()
  const client: WebCloudConnectClient = {
    connectionState: 'connected',
    attachStatusOwner: () => undefined,
    subscribe: async () => {
      throw new Error('unit fake does not subscribe')
    },
    call: async (method, _params, options) => {
      calls.push({ method, options })
      return reply
    },
    close
  }
  const factory: WebCloudConnectClientFactory = (offer, secret) => {
    offers.push(offer)
    secrets.push(secret)
    return client
  }
  return { factory, offers, secrets, client: { client, calls, close } }
}

function scriptedPlatform(
  options: {
    projects?: unknown[]
    loginReply?: Reply
  } = {}
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  return scriptedFetch((call) => {
    if (call.url.endsWith('/v1/auth/login')) {
      return options.loginReply ?? { body: loginBody() }
    }
    if (call.url.endsWith('/v1/projects')) {
      return {
        body: {
          projects: options.projects ?? [projectRow('project-1', 'Payments')]
        }
      }
    }
    if (call.url.endsWith('/connect')) {
      return { status: 201, body: ticketBody() }
    }
    return {
      status: 404,
      body: { error: { code: 'not_found', message: 'unknown route' } }
    }
  })
}

function input(
  store: WebCloudDeviceKeyStorage,
  extras: Partial<ConnectCloudProjectInput> = {}
): ConnectCloudProjectInput {
  return {
    apiUrl: 'https://cloud.example',
    username: 'zhangsan',
    password: 'Passw0rd!',
    deviceName: 'm49-web',
    deviceKeyStore: store,
    ...extras
  }
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (reason: unknown) => reason
  )
}

describe('connectCloudProject', () => {
  it('login → projects → ticket → offer → status.get returns the runtime binding', async () => {
    const store = new MemoryStorage()
    const identity: WebCloudDeviceIdentity = loadOrCreateWebCloudDeviceKey(store)
    const platform = scriptedPlatform()
    const fake = fakeClientFactory(statusSuccess())

    const result = await connectCloudProject(
      input(store, {
        fetchImpl: platform.fetchImpl,
        clientFactory: fake.factory,
        now: () => 1_700_000_000_000
      })
    )

    expect(result.offer.cloud?.credential).toBe(TICKET_CREDENTIAL)
    expect(result.offer.cloud?.devicePublicKeyB64).toBe(identity.publicKeyB64)
    expect(result.offer.endpoint).toBe('wss://runtime.example')
    expect(result.offer.scope).toBe('runtime')
    expect(result.runtimeId).toBe('runtime-42')
    expect(result.projectName).toBe('Payments')
    expect(result.environmentName).toBe('Payments')
    expect(result.deviceSecretKeyB64).toBe(identity.secretKeyB64)
    expect(fake.secrets).toEqual([identity.secretKeyB64])
    expect(fake.client.calls).toEqual([{ method: 'status.get', options: { timeoutMs: 15_000 } }])
    // The validated socket stays open: its ticket is already spent.
    expect(result.client).toBe(fake.client.client)
    expect(fake.client.close).not.toHaveBeenCalled()
    expect(result.environment).toMatchObject({
      name: 'Payments (cloud session)',
      runtimeId: 'runtime-42',
      cloudLoginRequired: true
    })
    expect(result.environment.endpoints[0]?.endpoint).toBe('wss://runtime.example')
    // The secret must never ride on the offer or anything the offer serialises to.
    expect(JSON.stringify(result.offer)).not.toContain(identity.secretKeyB64)
    expect(JSON.stringify(result.offer)).not.toContain('secretKeyB64')
    // Login/ticket requests carry only the public half.
    const loginCall = platform.calls.find((call) => call.url.endsWith('/v1/auth/login'))
    expect(loginCall?.body).toContain(identity.publicKeyB64)
    expect(loginCall?.body).not.toContain(identity.secretKeyB64)
  })

  it('honours an explicit projectId instead of the first visible project', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform({
      projects: [projectRow('project-1', 'Payments'), projectRow('project-2', 'Ledger')]
    })
    const fake = fakeClientFactory(statusSuccess())

    const result = await connectCloudProject(
      input(store, {
        projectId: 'project-2',
        fetchImpl: platform.fetchImpl,
        clientFactory: fake.factory
      })
    )

    expect(result.projectName).toBe('Ledger')
    expect(platform.calls.some((call) => call.url.endsWith('/v1/projects/project-2/connect'))).toBe(
      true
    )
  })

  it('skips a first row the account cannot open', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform({
      projects: [restrictedProjectRow('proj_payment', 'Payments'), projectRow('proj_demo', 'Demo')]
    })
    const fake = fakeClientFactory(statusSuccess())

    const result = await connectCloudProject(
      input(store, { fetchImpl: platform.fetchImpl, clientFactory: fake.factory })
    )

    expect(result.projectName).toBe('Demo')
    expect(result.projectId).toBe('proj_demo')
    expect(
      platform.calls.some((call) => call.url.endsWith('/v1/projects/proj_payment/connect'))
    ).toBe(false)
  })

  it('prefers the remembered project over the first visible one', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform({
      projects: [projectRow('project-1', 'Payments'), projectRow('project-2', 'Ledger')]
    })
    const fake = fakeClientFactory(statusSuccess())

    const result = await connectCloudProject(
      input(store, {
        rememberedProjectId: 'project-2',
        fetchImpl: platform.fetchImpl,
        clientFactory: fake.factory
      })
    )

    expect(result.projectId).toBe('project-2')
    expect(platform.calls.some((call) => call.url.endsWith('/v1/projects/project-2/connect'))).toBe(
      true
    )
  })

  it('falls back to an openable project when the remembered one is gone', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform({
      projects: [restrictedProjectRow('proj_payment', 'Payments'), projectRow('proj_demo', 'Demo')]
    })
    const fake = fakeClientFactory(statusSuccess())

    const result = await connectCloudProject(
      input(store, {
        rememberedProjectId: 'proj_removed',
        fetchImpl: platform.fetchImpl,
        clientFactory: fake.factory
      })
    )

    expect(result.projectId).toBe('proj_demo')
  })

  it('reports NO_OPENABLE_PROJECTS when no visible project grants open', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform({
      projects: [restrictedProjectRow('proj_payment', 'Payments')]
    })
    const factory = vi.fn()

    const error = await captureError(() =>
      connectCloudProject(input(store, { fetchImpl: platform.fetchImpl, clientFactory: factory }))
    )

    expect(error).toBeInstanceOf(WebCloudConnectError)
    if (!(error instanceof WebCloudConnectError)) {
      throw new Error('expected WebCloudConnectError')
    }
    expect(error.code).toBe(WEB_CLOUD_CONNECT_ERROR_CODE.noOpenableProjects)
    expect(factory).not.toHaveBeenCalled()
    expect(platform.calls.some((call) => call.url.endsWith('/connect'))).toBe(false)
  })

  it('rejects a mobile-scope runtime with MOBILE_SCOPE_REJECTED', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform()
    const fake = fakeClientFactory({
      id: 'status-1',
      ok: true,
      result: { deviceScope: 'mobile' },
      _meta: { runtimeId: 'runtime-42' }
    })

    const error = await captureError(() =>
      connectCloudProject(
        input(store, {
          fetchImpl: platform.fetchImpl,
          clientFactory: fake.factory
        })
      )
    )

    expect(error).toBeInstanceOf(WebCloudConnectError)
    if (!(error instanceof WebCloudConnectError)) {
      throw new Error('expected WebCloudConnectError')
    }
    expect(error.code).toBe(WEB_CLOUD_CONNECT_ERROR_CODE.mobileScopeRejected)
    expect(fake.client.close).toHaveBeenCalledTimes(1)
  })

  it('reports NO_PROJECTS when the account sees no projects', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform({ projects: [] })
    const factory = vi.fn()

    const error = await captureError(() =>
      connectCloudProject(input(store, { fetchImpl: platform.fetchImpl, clientFactory: factory }))
    )

    expect(error).toBeInstanceOf(WebCloudConnectError)
    if (!(error instanceof WebCloudConnectError)) {
      throw new Error('expected WebCloudConnectError')
    }
    expect(error.code).toBe(WEB_CLOUD_CONNECT_ERROR_CODE.noProjects)
    expect(factory).not.toHaveBeenCalled()
    expect(platform.calls.some((call) => call.url.endsWith('/connect'))).toBe(false)
  })

  it('maps a refused status.get to CONNECT_FAILED', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform()
    const fake = fakeClientFactory({
      id: 'status-1',
      ok: false,
      error: { code: 'internal', message: 'runtime exploded' }
    })

    const error = await captureError(() =>
      connectCloudProject(
        input(store, {
          fetchImpl: platform.fetchImpl,
          clientFactory: fake.factory
        })
      )
    )

    expect(error).toBeInstanceOf(WebCloudConnectError)
    if (!(error instanceof WebCloudConnectError)) {
      throw new Error('expected WebCloudConnectError')
    }
    expect(error.code).toBe(WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed)
    expect(error.message).toContain('runtime exploded')
    expect(fake.client.close).toHaveBeenCalledTimes(1)
  })

  it('closes the client when status.get itself throws', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform()
    const close = vi.fn()
    const factory: WebCloudConnectClientFactory = () => ({
      connectionState: 'connected',
      attachStatusOwner: () => undefined,
      subscribe: async () => {
        throw new Error('unit fake does not subscribe')
      },
      call: async () => {
        throw new Error('socket unavailable')
      },
      close
    })

    const error = await captureError(() =>
      connectCloudProject(input(store, { fetchImpl: platform.fetchImpl, clientFactory: factory }))
    )

    expect(error).toBeInstanceOf(WebCloudConnectError)
    if (!(error instanceof WebCloudConnectError)) {
      throw new Error('expected WebCloudConnectError')
    }
    expect(error.code).toBe(WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('maps a throwing client to CONNECT_FAILED', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform()
    const factory: WebCloudConnectClientFactory = () => {
      throw new Error('socket unavailable')
    }

    const error = await captureError(() =>
      connectCloudProject(input(store, { fetchImpl: platform.fetchImpl, clientFactory: factory }))
    )

    expect(error).toBeInstanceOf(WebCloudConnectError)
    if (!(error instanceof WebCloudConnectError)) {
      throw new Error('expected WebCloudConnectError')
    }
    expect(error.code).toBe(WEB_CLOUD_CONNECT_ERROR_CODE.connectFailed)
  })

  it('rethrows a platform error with its code and status untouched', async () => {
    const store = new MemoryStorage()
    const platform = scriptedPlatform({
      loginReply: {
        status: 401,
        body: {
          error: { code: 'INVALID_CREDENTIALS', message: 'bad password' }
        }
      }
    })
    const factory = vi.fn()

    const error = await captureError(() =>
      connectCloudProject(input(store, { fetchImpl: platform.fetchImpl, clientFactory: factory }))
    )

    expect(error).toBeInstanceOf(WebCloudSessionError)
    if (!(error instanceof WebCloudSessionError)) {
      throw new Error('expected WebCloudSessionError')
    }
    expect(error.code).toBe('INVALID_CREDENTIALS')
    expect(error.status).toBe(401)
    expect(factory).not.toHaveBeenCalled()
  })
})
