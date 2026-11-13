// @vitest-environment happy-dom
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../../../shared/remote-runtime-shared-control-test-server'
import type { WebRuntimeConnectionState } from '../web-runtime-connection-frame-router'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { WebRuntimeClient, type WebRuntimeSessionClient } from '../web-runtime-client'

const STATUS_REPLY: RuntimeRpcResponse<unknown> = {
  id: 'status.get',
  ok: true,
  result: { runtimeId: 'runtime-42' },
  _meta: { runtimeId: 'runtime-42' }
}

function cloudEnvironment(id = 'web-cloud-1'): StoredWebRuntimeEnvironment {
  return {
    id,
    name: 'Cloud (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    cloudLoginRequired: true,
    preferredEndpointId: `ws-${id}`,
    endpoints: [
      {
        id: `ws-${id}`,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://127.0.0.1:9',
        deviceToken: 'device-token',
        publicKeyB64: 'host-key'
      }
    ]
  }
}

function fakeClient(state: { value: WebRuntimeConnectionState }): {
  client: WebRuntimeSessionClient
  close: ReturnType<typeof vi.fn>
  attachStatusOwner: ReturnType<typeof vi.fn>
} {
  const close = vi.fn()
  const attachStatusOwner = vi.fn()
  const client: WebRuntimeSessionClient = {
    get connectionState() {
      return state.value
    },
    call: async () => STATUS_REPLY,
    subscribe: async () => {
      throw new Error('unit fake does not subscribe')
    },
    close,
    attachStatusOwner
  }
  return { client, close, attachStatusOwner }
}

describe('web runtime session cloud handoff', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await closeSharedControlTestServers()
  })

  it('returns the adopted client by identity instead of constructing another', async () => {
    const session = await import('./web-runtime-session')
    const environment = cloudEnvironment()
    const fake = fakeClient({ value: 'connected' })

    session.adoptWebRuntimeClient(fake.client, environment)

    expect(session.webRuntimeState.activeClient).toBe(fake.client)
    expect(session.webRuntimeState.activeClientEnvironmentId).toBe(environment.id)
    expect(session.webRuntimeState.activeEnvironment).toBe(environment)
    expect(session.getClientForEnvironment(environment)).toBe(fake.client)
    expect(fake.attachStatusOwner).toHaveBeenCalledTimes(1)
    expect(fake.close).not.toHaveBeenCalled()
  })

  it('re-adopting the same client keeps it open', async () => {
    const session = await import('./web-runtime-session')
    const environment = cloudEnvironment()
    const fake = fakeClient({ value: 'connected' })

    session.adoptWebRuntimeClient(fake.client, environment)
    session.adoptWebRuntimeClient(fake.client, environment)

    expect(session.getClientForEnvironment(environment)).toBe(fake.client)
    expect(fake.close).not.toHaveBeenCalled()
  })

  it('closes the previously active client when a different one is adopted', async () => {
    const session = await import('./web-runtime-session')
    const environment = cloudEnvironment()
    const first = fakeClient({ value: 'connected' })
    const second = fakeClient({ value: 'connected' })

    session.adoptWebRuntimeClient(first.client, environment)
    session.adoptWebRuntimeClient(second.client, environment)

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(session.getClientForEnvironment(environment)).toBe(second.client)
  })

  it('never constructs a client for a cloud environment without an adoption', async () => {
    const session = await import('./web-runtime-session')

    expect(() => session.getClientForEnvironment(cloudEnvironment())).toThrow(
      /cloud session ended/i
    )
  })

  it('reports an ended session once the adopted cloud socket is gone', async () => {
    const session = await import('./web-runtime-session')
    const environment = cloudEnvironment()
    const state: { value: WebRuntimeConnectionState } = { value: 'connected' }
    const fake = fakeClient(state)

    session.adoptWebRuntimeClient(fake.client, environment)
    state.value = 'disconnected'

    expect(() => session.getClientForEnvironment(environment)).toThrow(/cloud session ended/i)
  })

  it('publishes disconnected through the status owner when the socket drops', async () => {
    vi.stubGlobal('WebSocket', WebSocket)
    const session = await import('./web-runtime-session')
    const server = await createSharedControlTestServer({
      resultForRequest: () => ({ runtimeId: 'runtime-handoff', capabilities: [] })
    })
    const client = new WebRuntimeClient(server.pairing, { reconnect: false })
    try {
      session.adoptWebRuntimeClient(client, cloudEnvironment())

      await expect
        .poll(() => session.readWebRuntimeStatusSnapshots()[0]?.verification, { timeout: 3_000 })
        .toBe('verified')
      server.closeClients()
      await expect
        .poll(() => session.readWebRuntimeStatusSnapshots()[0]?.transport, { timeout: 3_000 })
        .toBe('disconnected')
    } finally {
      client.close()
    }
  })
})
