// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  clearRuntimeCompatibilityCacheForTests,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  CLOUD_SESSION_CHAT_UNAVAILABLE,
  getNativeChatSessionTransport
} from './native-chat-session-transport'

const ENV_CLOUD = 'env-cloud'
const ENV_NATIVE = 'env-native'
// `web-runtime-environment` keeps its storage key private; the shape here is what it parses.
const WEB_ENVIRONMENT_STORAGE_KEY = 'orca.web.runtimeEnvironment.v1'

const cloudProject = {
  projectId: 'proj_1',
  projectKey: 'payment',
  hostId: 'host_1',
  registeredAt: 1
}

const initialState = useAppStore.getInitialState()

const nativeChatReadSession = vi.fn()
const nativeChatSubscribe = vi.fn()
const runtimeEnvironmentsCall = vi.fn()
const runtimeEnvironmentsSubscribe = vi.fn()

function environmentRow(
  id: string,
  extras: Partial<PublicKnownRuntimeEnvironment> = {}
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 100,
    updatedAt: 100,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: 101,
    endpoints: [
      { id: `ws-${id}`, kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }
    ],
    preferredEndpointId: `ws-${id}`,
    ...extras
  }
}

function seedEnvironments(environments: PublicKnownRuntimeEnvironment[]): void {
  useAppStore.setState({ ...initialState, runtimeEnvironments: environments }, true)
}

function storeWebRow(row: Record<string, unknown>): void {
  window.localStorage.setItem(WEB_ENVIRONMENT_STORAGE_KEY, JSON.stringify(row))
}

function webRow(cloudLoginRequired: boolean): Record<string, unknown> {
  return {
    id: ENV_CLOUD,
    name: ENV_CLOUD,
    createdAt: 100,
    updatedAt: 100,
    lastUsedAt: null,
    runtimeId: null,
    pairingRevision: 101,
    endpoints: [
      {
        id: 'ws-web',
        kind: 'websocket',
        label: 'WS',
        endpoint: 'wss://example.invalid',
        deviceToken: 'tok'
      }
    ],
    preferredEndpointId: 'ws-web',
    cloudLoginRequired
  }
}

/** Flush the compat-gate await chain inside callRuntimeRpc. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve))
}

function setWebClient(value: boolean): void {
  ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = value
}

describe('getNativeChatSessionTransport — cloud session skip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    useAppStore.setState({ ...initialState }, true)
    window.localStorage.clear()
    setWebClient(false)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        nativeChat: { readSession: nativeChatReadSession, subscribe: nativeChatSubscribe },
        runtimeEnvironments: {
          call: runtimeEnvironmentsCall,
          subscribe: runtimeEnvironmentsSubscribe
        }
      }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    window.localStorage.clear()
    setWebClient(false)
  })

  it('answers the read with the unavailable copy and sends no RPC on a cloud project host', async () => {
    seedEnvironments([environmentRow(ENV_CLOUD, { cloudProject }), environmentRow(ENV_NATIVE)])
    const transport = getNativeChatSessionTransport(ENV_CLOUD)

    const result = await transport.readSession('claude', 'sess-1', 40, '/t/path')

    expect(result).toEqual({ error: CLOUD_SESSION_CHAT_UNAVAILABLE })
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
    expect(nativeChatReadSession).not.toHaveBeenCalled()
  })

  it('emits one unavailable snapshot and arms no stream on a cloud project host', () => {
    seedEnvironments([environmentRow(ENV_CLOUD, { cloudProject })])
    const onFrame = vi.fn()
    const transport = getNativeChatSessionTransport(ENV_CLOUD)

    const cleanup = transport.subscribe(
      { subscriptionId: 'sub-1', agent: 'claude', sessionId: 'sess-1' },
      onFrame
    )

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(onFrame.mock.calls[0][0]).toMatchObject({
      type: 'snapshot',
      messages: [],
      hasMore: false,
      error: CLOUD_SESSION_CHAT_UNAVAILABLE
    })
    expect(runtimeEnvironmentsSubscribe).not.toHaveBeenCalled()
    expect(typeof cleanup).toBe('function')
    expect(() => cleanup()).not.toThrow()
  })

  it('skips on the web client whose stored row carries the spent-ticket marker', async () => {
    setWebClient(true)
    storeWebRow(webRow(true))
    const transport = getNativeChatSessionTransport(ENV_CLOUD)

    const result = await transport.readSession('claude', 'sess-1', 40)

    expect(result).toEqual({ error: CLOUD_SESSION_CHAT_UNAVAILABLE })
    expect(nativeChatReadSession).not.toHaveBeenCalled()
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
  })

  it('keeps the runtime transport for a native environment beside the cloud one', async () => {
    seedEnvironments([environmentRow(ENV_CLOUD, { cloudProject }), environmentRow(ENV_NATIVE)])
    markRuntimeEnvironmentCompatible(ENV_NATIVE)
    runtimeEnvironmentsCall.mockResolvedValue({ ok: true, result: { messages: [] } })

    await getNativeChatSessionTransport(ENV_NATIVE).readSession('claude', 'sess-1', 40, '/t/path')
    await flush()

    expect(runtimeEnvironmentsCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentsCall.mock.calls[0][0]).toMatchObject({
      selector: ENV_NATIVE,
      method: 'nativeChat.readSession'
    })
  })

  it('keeps the local adapter for a paired (non-cloud) web row', async () => {
    setWebClient(true)
    storeWebRow(webRow(false))
    nativeChatReadSession.mockResolvedValue({ messages: [] })

    await getNativeChatSessionTransport(ENV_CLOUD).readSession('claude', 'sess-1', 40)

    expect(nativeChatReadSession).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentsCall).not.toHaveBeenCalled()
  })
})
