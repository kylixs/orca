// @vitest-environment happy-dom
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../../../shared/remote-runtime-shared-control-test-server'
import type { WebRuntimeConnectionState } from '../web-runtime-connection-frame-router'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { WebRuntimeClient } from '../web-runtime-client'
import type { WebRuntimeSessionClient } from '../web-runtime-session-client'

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

function pairedEnvironment(): StoredWebRuntimeEnvironment {
  const environment = cloudEnvironment('web-paired-1')
  delete environment.cloudLoginRequired
  return environment
}

/** A client whose status owner can be driven snapshot-by-snapshot. */
function controlledClient(initialState: WebRuntimeConnectionState): {
  client: WebRuntimeSessionClient
  close: ReturnType<typeof vi.fn>
  setState: (state: WebRuntimeConnectionState) => void
  publish: (transport: RuntimeHostStatusSnapshot['transport']) => void
} {
  const state: { value: WebRuntimeConnectionState } = { value: initialState }
  const close = vi.fn()
  let publishStatus: ((snapshot: RuntimeHostStatusSnapshot) => void) | null = null
  const client: WebRuntimeSessionClient = {
    get connectionState() {
      return state.value
    },
    call: async () => STATUS_REPLY,
    subscribe: async () => {
      throw new Error('unit fake does not subscribe')
    },
    close,
    attachStatusOwner: (options) => {
      publishStatus = options.publish
    }
  }
  return {
    client,
    close,
    setState: (next) => {
      state.value = next
    },
    publish: (transport) => {
      if (!publishStatus) {
        throw new Error('status owner not attached')
      }
      publishStatus({
        environmentId: 'web-cloud-1',
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 0,
        status: null,
        verification: 'unavailable',
        transport
      })
    }
  }
}

describe('web runtime session cloud session ended signal', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('fires exactly once per adopted cloud client on a terminal disconnect', async () => {
    const session = await import('./web-runtime-session')
    const fake = controlledClient('connected')
    session.adoptWebRuntimeClient(fake.client, cloudEnvironment())
    const first = vi.fn()
    const second = vi.fn()
    session.subscribeCloudSessionEnded(first)
    session.subscribeCloudSessionEnded(second)

    fake.setState('disconnected')
    fake.publish('disconnected')
    fake.publish('disconnected')

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does not fire while the cloud client is connecting or retrying', async () => {
    const session = await import('./web-runtime-session')
    const fake = controlledClient('connecting')
    session.adoptWebRuntimeClient(fake.client, cloudEnvironment())
    const listener = vi.fn()
    session.subscribeCloudSessionEnded(listener)

    fake.publish('connecting')
    fake.setState('connected')
    fake.publish('ready')
    fake.setState('connecting')
    fake.publish('disconnected')

    expect(listener).not.toHaveBeenCalled()
  })

  it('fires on an authentication rejection, which is equally terminal', async () => {
    const session = await import('./web-runtime-session')
    const fake = controlledClient('connected')
    session.adoptWebRuntimeClient(fake.client, cloudEnvironment())
    const listener = vi.fn()
    session.subscribeCloudSessionEnded(listener)

    fake.setState('auth-failed')
    fake.publish('disconnected')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not fire for an ordinary paired environment', async () => {
    const session = await import('./web-runtime-session')
    const fake = controlledClient('connected')
    session.adoptWebRuntimeClient(fake.client, pairedEnvironment())
    const listener = vi.fn()
    session.subscribeCloudSessionEnded(listener)

    fake.setState('disconnected')
    fake.publish('disconnected')

    expect(listener).not.toHaveBeenCalled()
  })

  it('fires once for each freshly adopted cloud client', async () => {
    const session = await import('./web-runtime-session')
    const first = controlledClient('connected')
    session.adoptWebRuntimeClient(first.client, cloudEnvironment())
    const listener = vi.fn()
    session.subscribeCloudSessionEnded(listener)
    first.setState('disconnected')
    first.publish('disconnected')

    const second = controlledClient('connected')
    session.adoptWebRuntimeClient(second.client, cloudEnvironment('web-cloud-2'))
    second.setState('disconnected')
    second.publish('disconnected')

    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('stops delivery after unsubscribe', async () => {
    const session = await import('./web-runtime-session')
    const fake = controlledClient('connected')
    session.adoptWebRuntimeClient(fake.client, cloudEnvironment())
    const listener = vi.fn()
    const unsubscribe = session.subscribeCloudSessionEnded(listener)
    unsubscribe()

    fake.setState('disconnected')
    fake.publish('disconnected')

    expect(listener).not.toHaveBeenCalled()
  })
})

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
