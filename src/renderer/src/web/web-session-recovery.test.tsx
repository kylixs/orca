// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type * as WebRuntimeEnvironmentModule from './web-runtime-environment'
import type { WebRuntimeConnectionState } from './web-runtime-connection-frame-router'
import type { StoredWebRuntimeEnvironment } from './web-runtime-environment'
import type * as WebRuntimeSessionModule from './preload-api/web-runtime-session'
import type * as WebSessionRecoveryModule from './web-session-recovery'
import type { WebRuntimeSessionClient } from './web-runtime-client'

function cloudEnvironment(): StoredWebRuntimeEnvironment {
  const id = 'web-cloud-live'
  return {
    id,
    name: 'Cloud (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: 'runtime-live',
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
    call: async () => {
      throw new Error('unit fake does not call')
    },
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
        environmentId: 'web-cloud-live',
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

async function seedAdoptedCloudSession(): Promise<{
  environmentModule: typeof WebRuntimeEnvironmentModule
  environment: StoredWebRuntimeEnvironment
  subscriber: ReturnType<typeof controlledClient>
  session: typeof WebRuntimeSessionModule
  recovery: typeof WebSessionRecoveryModule
}> {
  vi.resetModules()
  const environmentModule = await import('./web-runtime-environment')
  const environment = cloudEnvironment()
  environmentModule.saveStoredWebRuntimeEnvironment(environment)
  const session = await import('./preload-api/web-runtime-session')
  const recovery = await import('./web-session-recovery')
  const subscriber = controlledClient('connected')
  session.adoptWebRuntimeClient(subscriber.client, environment)
  return { environmentModule, environment, subscriber, session, recovery }
}

afterEach(cleanup)

describe('web session cloud recovery', () => {
  it('returns signed-out with a notice and clears the stored environment when the session ends', async () => {
    const { environmentModule, subscriber, recovery } = await seedAdoptedCloudSession()
    const onSignedOut = vi.fn()
    const view = renderHook(() => recovery.useWebSessionRecovery(onSignedOut))
    expect(view.result.current.status).toBe('active')

    act(() => {
      subscriber.setState('disconnected')
      subscriber.publish('disconnected')
    })

    expect(onSignedOut).toHaveBeenCalledTimes(1)
    expect(view.result.current.status).toBe('signed-out')
    if (view.result.current.status !== 'signed-out') {
      throw new Error('expected a signed-out recovery state')
    }
    expect(view.result.current.notice).toMatch(/cloud session ended/i)
    expect(environmentModule.readStoredWebRuntimeEnvironment()).toBeNull()
    expect(subscriber.close).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a healthy or reconnecting state change', async () => {
    const { environmentModule, subscriber, recovery } = await seedAdoptedCloudSession()
    const onSignedOut = vi.fn()
    const view = renderHook(() => recovery.useWebSessionRecovery(onSignedOut))

    act(() => {
      subscriber.publish('connecting')
      subscriber.setState('connected')
      subscriber.publish('ready')
      subscriber.setState('connecting')
      subscriber.publish('disconnected')
    })

    expect(view.result.current.status).toBe('active')
    expect(onSignedOut).not.toHaveBeenCalled()
    expect(environmentModule.readStoredWebRuntimeEnvironment()).not.toBeNull()
    expect(subscriber.close).not.toHaveBeenCalled()
  })
})
