import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { WebCloudConnectClient, WebCloudConnectClientFactory } from './web-cloud-connect'
import { loadOrCreateWebCloudDeviceKey } from './web-cloud-device-key'
import type { WebCloudSessionStorage } from './web-cloud-session-storage'
import { resumeWebCloudSession } from './web-cloud-session-resume'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'

/** U103-B1: reload resumes the saved login; URL project wins, dead auth clears. */

const API_URL = 'https://cloud.example'
const HOST_KEY_B64 = Buffer.alloc(32, 0x07).toString('base64')
const TICKET_CREDENTIAL = `header.${Buffer.from(
  JSON.stringify({
    deviceToken: 'device-token-1',
    deviceId: 'device-1',
    host: 'host-1',
    perms: ['open', 'terminal']
  })
).toString('base64url')}.signature`

class MemorySessionStorage implements WebCloudSessionStorage {
  value: string | null = null

  constructor(accessToken = 'access-1', refreshToken = 'refresh-1') {
    this.value = JSON.stringify({
      version: 1,
      apiUrl: API_URL,
      accessToken,
      refreshToken,
      deviceId: 'device-1',
      displayName: '张伟',
      savedAtMs: 1_700_000_000_000
    })
  }

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

class MemoryDeviceKeyStore {
  value: string | null = null

  read(): string | null {
    return this.value
  }

  write(value: string): void {
    this.value = value
  }
}

function projectRow(id: string, permissions = ['open']): Record<string, unknown> {
  return {
    id,
    key: id,
    name: id,
    hostName: 'dev-host',
    hostStatus: 'online',
    permissions
  }
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

function statusSuccess(): RuntimeRpcResponse<unknown> {
  return {
    id: 'status-1',
    ok: true,
    result: { deviceScope: 'runtime', runtimeId: 'runtime-42' },
    _meta: { runtimeId: 'runtime-42' }
  }
}

function fakeClient(): WebCloudConnectClient {
  return {
    connectionState: 'connected',
    attachStatusOwner: () => undefined,
    subscribe: async () => {
      throw new Error('unit fake does not subscribe')
    },
    call: async () => statusSuccess(),
    close: vi.fn()
  }
}

type ScriptedReply = { status?: number; body: unknown }

function scriptedFetch(handler: (url: string, call: number) => ScriptedReply): {
  fetchImpl: typeof fetch
  urls: string[]
} {
  const urls: string[] = []
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    urls.push(url)
    const reply = handler(url, urls.length)
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { fetchImpl, urls }
}

function makeInput(
  storage: WebCloudSessionStorage,
  overrides: {
    projectId?: string | null
    fetchImpl: typeof fetch
    factory: WebCloudConnectClientFactory
    saveEnvironment?: (environment: StoredWebRuntimeEnvironment) => void
    adopt?: () => void
  }
): Parameters<typeof resumeWebCloudSession>[0] {
  const deviceKeyStore = new MemoryDeviceKeyStore()
  loadOrCreateWebCloudDeviceKey(deviceKeyStore)
  return {
    location: { apiUrl: API_URL, projectId: overrides.projectId ?? null },
    storage,
    deviceKeyStore,
    fetchImpl: overrides.fetchImpl,
    clientFactory: overrides.factory,
    saveEnvironment: overrides.saveEnvironment ?? (() => undefined),
    adopt: overrides.adopt ?? (() => undefined)
  }
}

function jsonSession(value: string | null): Record<string, unknown> | null {
  return value === null ? null : (JSON.parse(value) as Record<string, unknown>)
}

describe('resumeWebCloudSession', () => {
  it('刷新 access 后续会话，URL 的 project 压过记忆项目', async () => {
    const storage = new MemorySessionStorage()
    const platform = scriptedFetch((url, call) => {
      if (url.endsWith('/v1/projects') && call === 1) {
        return {
          status: 401,
          body: { error: { code: 'unauthorized', message: 'stale' } }
        }
      }
      if (url.endsWith('/v1/auth/refresh')) {
        return {
          body: {
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            expiresIn: 1800
          }
        }
      }
      if (url.endsWith('/v1/projects')) {
        return {
          body: {
            projects: [projectRow('proj_url'), projectRow('proj_memory')]
          }
        }
      }
      if (url.endsWith('/connect')) {
        return { status: 201, body: ticketBody() }
      }
      return {
        status: 404,
        body: { error: { code: 'not_found', message: 'unknown' } }
      }
    })
    const saved: StoredWebRuntimeEnvironment[] = []
    const adopt = vi.fn()

    const result = await resumeWebCloudSession(
      makeInput(storage, {
        projectId: 'proj_url',
        fetchImpl: platform.fetchImpl,
        factory: () => fakeClient(),
        saveEnvironment: (environment) => saved.push(environment),
        adopt
      })
    )

    expect(result).toMatchObject({
      status: 'resumed',
      projectId: 'proj_url',
      projectName: 'proj_url',
      runtimeId: 'runtime-42'
    })
    expect(platform.urls.some((url) => url.endsWith('/v1/auth/refresh'))).toBe(true)
    expect(platform.urls.some((url) => url.endsWith('/v1/projects/proj_url/connect'))).toBe(true)
    expect(platform.urls.some((url) => url.endsWith('/v1/projects/proj_memory/connect'))).toBe(
      false
    )
    expect(jsonSession(storage.value)).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2'
    })
    expect(saved).toHaveLength(1)
    expect(adopt).toHaveBeenCalledTimes(1)
  })

  it('URL 无 project 时使用记忆项目', async () => {
    const storage = new MemorySessionStorage()
    const platform = scriptedFetch((url) => {
      if (url.endsWith('/v1/projects')) {
        return {
          body: {
            projects: [projectRow('proj_first'), projectRow('proj_memory')]
          }
        }
      }
      if (url.endsWith('/connect')) {
        return { status: 201, body: ticketBody() }
      }
      return {
        status: 404,
        body: { error: { code: 'not_found', message: 'unknown' } }
      }
    })

    const result = await resumeWebCloudSession({
      ...makeInput(storage, {
        fetchImpl: platform.fetchImpl,
        factory: () => fakeClient()
      }),
      projectMemory: {
        read: () =>
          JSON.stringify({
            version: 1,
            byApiUrl: { [API_URL]: 'proj_memory' }
          }),
        write: () => undefined
      }
    })

    expect(result).toMatchObject({
      status: 'resumed',
      projectId: 'proj_memory'
    })
    expect(platform.urls.some((url) => url.endsWith('/v1/projects/proj_memory/connect'))).toBe(true)
  })

  it('refresh token 已死：清会话并报 expired，不打开任何项目', async () => {
    const storage = new MemorySessionStorage()
    const platform = scriptedFetch((url) => {
      if (url.endsWith('/v1/projects')) {
        return {
          status: 401,
          body: { error: { code: 'unauthorized', message: 'stale' } }
        }
      }
      if (url.endsWith('/v1/auth/refresh')) {
        return {
          status: 401,
          body: { error: { code: 'unauthorized', message: 'dead' } }
        }
      }
      return { status: 201, body: ticketBody() }
    })

    const result = await resumeWebCloudSession(
      makeInput(storage, {
        projectId: 'proj_url',
        fetchImpl: platform.fetchImpl,
        factory: () => fakeClient()
      })
    )

    expect(result).toEqual({ status: 'expired' })
    expect(storage.value).toBeNull()
    expect(platform.urls.some((url) => url.endsWith('/connect'))).toBe(false)
  })

  it('URL project 不可见：保留会话，不切换项目', async () => {
    const storage = new MemorySessionStorage()
    const platform = scriptedFetch((url) => {
      if (url.endsWith('/v1/projects')) {
        return { body: { projects: [projectRow('proj_other')] } }
      }
      return { status: 201, body: ticketBody() }
    })

    const result = await resumeWebCloudSession(
      makeInput(storage, {
        projectId: 'proj_gone',
        fetchImpl: platform.fetchImpl,
        factory: () => fakeClient()
      })
    )

    expect(result).toMatchObject({
      status: 'project-unavailable',
      code: 'PROJECT_NOT_VISIBLE'
    })
    expect(storage.value).not.toBeNull()
    expect(platform.urls.some((url) => url.endsWith('/connect'))).toBe(false)
  })

  it('刷新时网络中断：保留保存的登录，不清凭据', async () => {
    const storage = new MemorySessionStorage()
    let calls = 0
    const fetchImpl = (async (input: string | URL | Request) => {
      calls += 1
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/v1/projects')) {
        return new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 })
      }
      throw new TypeError('fetch failed')
    }) as typeof fetch

    const result = await resumeWebCloudSession(
      makeInput(storage, {
        projectId: 'proj_url',
        fetchImpl,
        factory: () => fakeClient()
      })
    )

    expect(result).toMatchObject({ status: 'error', code: 'network_error' })
    expect(calls).toBe(2)
    expect(storage.value).not.toBeNull()
  })

  it('网络失败保留保存的登录，供下次刷新重试', async () => {
    const storage = new MemorySessionStorage()
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    const result = await resumeWebCloudSession(
      makeInput(storage, {
        projectId: 'proj_url',
        fetchImpl,
        factory: () => fakeClient()
      })
    )

    expect(result.status).toBe('error')
    expect(storage.value).not.toBeNull()
  })
})
