// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../../shared/cloud-workspace-info'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { useAppStore } from '../../store'
import {
  recordWebCloudSessionCapabilities,
  resetWebCloudSessionCapabilities
} from '../../web/web-cloud-session-capabilities'
import { refreshWebRuntimeSessionTabsSnapshot } from '../web-runtime-session-snapshot'
import { replaceRuntimeEnvironmentRevisions } from '../runtime-environment-revision'
import { installActiveSessionTabsSubscription } from './active-session-subscription'
import { installGlobalSessionTabsSubscriptions } from './global-session-subscription'

const CLOUD_ENVIRONMENT_ID = 'cloud-u96'

let subscribe: ReturnType<typeof vi.fn>
let call: ReturnType<typeof vi.fn>

function cloudEnvironment(): PublicKnownRuntimeEnvironment {
  return {
    id: CLOUD_ENVIRONMENT_ID,
    name: 'payment-service (cloud session)',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    cloudProject: {
      projectId: 'proj-u96',
      projectKey: 'proj-u96',
      hostId: 'host-u96',
      registeredAt: 1
    },
    preferredEndpointId: 'ws-1',
    endpoints: []
  }
}

function globalRefs(): Parameters<typeof installGlobalSessionTabsSubscriptions>[0]['refs'] {
  return {
    activeRuntimeEnvironmentId: { current: CLOUD_ENVIRONMENT_ID },
    activeRuntimeWorktreeKey: { current: null },
    visibilityResumeOmissions: { current: new Map() },
    snapshotReceipt: { current: () => {} },
    snapshotApply: { current: () => true },
    snapshotAccepted: { current: () => {} },
    ownerRevisions: { current: new Map() }
  }
}

function installGlobal(): () => void {
  return (
    installGlobalSessionTabsSubscriptions({
      runtimeSessionMirrorEnvironmentKey: `${CLOUD_ENVIRONMENT_ID}\u0001ws-1\u00011\u00011`,
      workspaceSessionReady: true,
      refs: globalRefs()
    }) ?? (() => {})
  )
}

function installActive(): () => void {
  return (
    installActiveSessionTabsSubscription({
      activeWorktreeId: 'repo::/checkout',
      activeWorktreeRuntimeEnvironmentId: CLOUD_ENVIRONMENT_ID,
      activeWorktreeRuntimeConnectionGeneration: 1,
      activeWorktreeRuntimePairingRevision: 1,
      workspaceSessionReady: true,
      visibilitySnapshotReceipt: { current: () => {} },
      visibilitySnapshotApply: { current: () => true },
      visibilitySnapshotAccepted: { current: () => {} }
    }) ?? (() => {})
  )
}

function subscribedMethods(): string[] {
  return subscribe.mock.calls.map(([request]) => {
    const { method } = request as { method: string }
    return method
  })
}

beforeEach(() => {
  subscribe = vi.fn(async () => ({ unsubscribe: vi.fn() }))
  // Why a never-settling call: the one-shot inventory listAll must stay inert so the
  // assertion sees only the stream subscription.
  call = vi.fn(() => new Promise<never>(() => {}))
  Object.assign(window, { api: { runtimeEnvironments: { subscribe, call } } })
  resetWebCloudSessionCapabilities()
  // The capability record is fenced by the pairing revision it was probed against (D4).
  replaceRuntimeEnvironmentRevisions([
    { id: CLOUD_ENVIRONMENT_ID, createdAt: 1, pairingRevision: 1 }
  ])
  useAppStore.setState({ runtimeEnvironments: [cloudEnvironment()] })
})

afterEach(() => {
  resetWebCloudSessionCapabilities()
  replaceRuntimeEnvironmentRevisions([])
  useAppStore.setState({ runtimeEnvironments: [] })
})

describe('cloud session-tabs capability gate (U96)', () => {
  it('subscribes the global restore chain when the host advertised the capability', () => {
    recordWebCloudSessionCapabilities(CLOUD_ENVIRONMENT_ID, [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
    installGlobal()()

    expect(subscribedMethods()).toEqual(['session.tabs.subscribeAll'])
  })

  it('skips the global subscription for an old host (no capability)', () => {
    installGlobal()()

    expect(subscribedMethods()).toEqual([])
  })

  it('subscribes the active restore stream when the host advertised the capability', () => {
    recordWebCloudSessionCapabilities(CLOUD_ENVIRONMENT_ID, [CLOUD_SESSION_TABS_RESTORE_CAPABILITY])
    installActive()()

    expect(subscribedMethods()).toEqual(['session.tabs.subscribe'])
  })

  it('skips the active subscription for an old host (no capability)', () => {
    installActive()()

    expect(subscribedMethods()).toEqual([])
  })

  it('makes zero restore RPCs on an old host — no list, no orphan probe, no warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      // Both subscription installers run first: an old host must not even open
      // the streams that would later carry the restore chain.
      installGlobal()()
      installActive()()
      await refreshWebRuntimeSessionTabsSnapshot(CLOUD_ENVIRONMENT_ID, 'wt-u96')

      // Why one count covers A11: the orphan recovery (`terminal.list` /
      // `terminal.adoptOrphans`) only runs downstream of this session.tabs.list,
      // so zero total calls proves all three families stayed silent.
      expect(call).not.toHaveBeenCalled()
      expect(subscribedMethods()).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
