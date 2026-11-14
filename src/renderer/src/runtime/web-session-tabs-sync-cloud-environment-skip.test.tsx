// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as WebRuntimeSessionModule from './web-runtime-session'

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKeys: () => ({
    environmentKey: mocks.runtimeSessionMirrorEnvironmentKey(),
    resubscribeSignal: ''
  })
}))

vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
  }
})

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

vi.mock('./web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  return { ...actual, createWebRuntimeSessionTerminal: mocks.createTerminal }
})

import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from './host-live-terminal-probe'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'

const ENV_CLOUD = 'env-cloud'
const ENV_NATIVE = 'env-native'
const WORKTREE = 'repo-a::worktree-a'
const REVISION = 101

const cloudProject = {
  projectId: 'proj_1',
  projectKey: 'payment',
  hostId: 'host_1',
  registeredAt: 1
}

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
    pairingRevision: REVISION,
    endpoints: [
      { id: `ws-${id}`, kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }
    ],
    preferredEndpointId: `ws-${id}`,
    ...extras
  }
}

/** The web row carries its ticket marker outside the shared row type (web-runtime-environment). */
function cloudTicketRow(
  row: PublicKnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment & { cloudLoginRequired: true } {
  return { ...row, cloudLoginRequired: true }
}

function mirrorKey(environmentIds: string[]): string {
  return environmentIds
    .map((environmentId) => `${environmentId}\u0001runtime-1\u00010\u0001${REVISION}`)
    .join('\u0000')
}

const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe

const subscriptions: {
  request: Parameters<RuntimeSubscribe>[0]
  unsubscribe: ReturnType<typeof vi.fn>
}[] = []
const runtimeCall = vi.fn(async (_args: { method: string }) => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-test' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

function subscribedMethods(): string[] {
  return subscriptions.map(({ request }) => `${request.method}@${request.selector}`).sort()
}

/** The `session.tabs.*` RPCs a doomed mirror would still have spent on the host. */
function sessionTabsCallMethods(): string[] {
  return runtimeCall.mock.calls
    .map(([args]) => args.method)
    .filter((method) => method.startsWith('session.tabs'))
    .sort()
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function seedMirrorState(environments: PublicKnownRuntimeEnvironment[]): void {
  replaceRuntimeEnvironmentRevisions(environments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: WORKTREE,
      workspaceSessionReady: true,
      runtimeEnvironments: environments,
      // Why `status: null`: the installers never read a probe verdict, only the mirror key.
      runtimeStatusByEnvironmentId: new Map(
        environments.map((environment) => [
          environment.id,
          { status: null, checkedAt: 1, connectionGeneration: 1 }
        ])
      )
    },
    true
  )
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useWebSessionTabsSync on cloud-session environments', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_CLOUD)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(null)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    setDocumentVisibility('visible')
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearHostLiveTerminalProbesForTests()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    resetStaleDocumentVisibilityForTesting()
    setDocumentVisibility('visible')
    vi.useRealTimers()
  })

  async function renderMirror(): Promise<void> {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    return hook.unmount()
  }

  it('arms no mirror subscriptions or session.tabs calls on a cloud project host', async () => {
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(mirrorKey([ENV_CLOUD]))
    seedMirrorState([environmentRow(ENV_CLOUD, { cloudProject })])

    await renderMirror()

    expect(runtimeSubscribe).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('skips only the cloud host when it is paired beside a native one', async () => {
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(mirrorKey([ENV_CLOUD, ENV_NATIVE]))
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENV_NATIVE)
    seedMirrorState([environmentRow(ENV_CLOUD, { cloudProject }), environmentRow(ENV_NATIVE)])

    await renderMirror()

    expect(subscribedMethods()).toEqual([
      'session.tabs.subscribe@env-native',
      'session.tabs.subscribeAll@env-native'
    ])
    expect(sessionTabsCallMethods()).toEqual(['session.tabs.listAll'])
    expect(runtimeCall.mock.calls[0]?.[0]).toMatchObject({ selector: ENV_NATIVE })
  })

  it('keeps the mirror armed for native hosts', async () => {
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(mirrorKey([ENV_CLOUD, ENV_NATIVE]))
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENV_NATIVE)
    seedMirrorState([environmentRow(ENV_CLOUD), environmentRow(ENV_NATIVE)])

    await renderMirror()

    expect(subscribedMethods()).toEqual([
      'session.tabs.subscribe@env-native',
      'session.tabs.subscribeAll@env-cloud',
      'session.tabs.subscribeAll@env-native'
    ])
    expect(sessionTabsCallMethods()).toEqual(['session.tabs.listAll', 'session.tabs.listAll'])
  })

  it('skips a web row whose pairing came from a spent cloud ticket', async () => {
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(mirrorKey([ENV_CLOUD]))
    seedMirrorState([cloudTicketRow(environmentRow(ENV_CLOUD))])

    await renderMirror()

    expect(runtimeSubscribe).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
