import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerDirectSshStateIpcBridge } from './direct-ssh-state-ipc-bridge'
import type { DirectSshBridgeRuntime } from './direct-ssh-bridge-runtime'

const cloudScope = vi.hoisted(() => ({ active: false }))
vi.mock('@/web/web-cloud-session-scope', () => ({
  isActiveWebClientCloudSession: () => cloudScope.active
}))

const hydrateDirectSshInitialState = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('./direct-ssh-initial-state-hydration', () => ({
  hydrateDirectSshInitialState
}))

function stubWindow(): void {
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    api: {
      ui: {},
      ssh: {
        listTargets: () => Promise.resolve([]),
        listRemovedTargetLabels: () => Promise.resolve({}),
        getState: () => Promise.resolve(null),
        listPortForwards: () => Promise.resolve([]),
        listDetectedPorts: () => Promise.resolve([]),
        onCredentialRequest: () => () => {},
        onCredentialResolved: () => () => {},
        onPortForwardsChanged: () => () => {},
        onDetectedPortsChanged: () => () => {},
        onStateChanged: () => () => {}
      }
    }
  })
}

function bridgeRuntime(): DirectSshBridgeRuntime {
  const runtime = {
    reconnectAuthorityByTarget: new Map(),
    reconnectCoordinator: {
      requestReconnect: vi.fn(async () => ({ status: 'complete' })),
      replaceAuthority: vi.fn(),
      correctUnboundTerminals: vi.fn(() => 0),
      invalidate: vi.fn()
    },
    currentAuthority: () => null,
    terminalActions: () => ({}),
    prepareAndSync: vi.fn(async () => {}),
    isStopped: () => false,
    addDeadline: vi.fn(),
    removeDeadline: vi.fn(),
    stop: vi.fn()
  }
  // SAFETY: the stub only feeds the cloud-scope branch at register time; the bridge
  // reads none of the remaining runtime fields before that gate returns.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this stub only exercises the register-time cloud-scope branch, which reads no other runtime field.
  return runtime as unknown as DirectSshBridgeRuntime
}

describe('direct SSH hydration under a cloud session', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    hydrateDirectSshInitialState.mockClear()
    cloudScope.active = false
  })

  it('never starts the ssh.listTargets walk in a cloud session', () => {
    cloudScope.active = true
    stubWindow()
    const unsubs: (() => void)[] = []
    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    expect(hydrateDirectSshInitialState).not.toHaveBeenCalled()
    for (const unsub of unsubs) {
      unsub()
    }
  })

  it('still hydrates on a paired (non-cloud) client', () => {
    cloudScope.active = false
    stubWindow()
    const unsubs: (() => void)[] = []
    registerDirectSshStateIpcBridge(unsubs, bridgeRuntime())
    expect(hydrateDirectSshInitialState).toHaveBeenCalledTimes(1)
    for (const unsub of unsubs) {
      unsub()
    }
  })
})
