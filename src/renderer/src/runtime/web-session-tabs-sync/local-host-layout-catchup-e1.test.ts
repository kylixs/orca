// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner'
import {
  HOST_LAYOUT_CATCHUP_STORAGE_KEY,
  useLocalHostLayoutCatchup
} from '../../app-shell/use-local-host-layout-catchup'
import type { LocalHostLayoutCatchupOptions } from '../../app-shell/use-local-host-layout-catchup'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
import {
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionVersionByWorktree,
  resetLocalStructuredSessionVersionForTests
} from '../local-structured-session-tabs-sync/inventory-generation-fence'
import {
  resetLocalHostLayoutCatchupForTests,
  runLocalHostLayoutCatchup,
  type LocalHostLayoutCatchupOutcome
} from '../local-structured-session-tabs-sync/run-local-host-layout-catchup'
import { resetHostLayoutAdoptionForTests } from './host-layout-adoption'
import type { WebSessionTabsSyncState } from './state'
import {
  resetHostSessionGroupIdMappingsForTests,
  setHostSessionGroupIdMapping
} from './tracking-mappings'
import {
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'

const T1 = 'e1-tab-1'
const T2 = 'e1-tab-2'
const T3 = 'e1-tab-3'
const LOCAL_GROUP = 'local-left'
const HOST_LEFT = 'host-left'
const HOST_RIGHT = 'host-right'
const EPOCH = 'epoch-e1'

type SyncState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState

function terminalTab(id: string, sortOrder: number): TerminalTab {
  return {
    id,
    ptyId: `local-pty-${id}`,
    worktreeId: WT,
    title: id,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: NOW + sortOrder
  }
}

function unifiedTerminalTab(id: string, sortOrder: number): Tab {
  return {
    id,
    entityId: id,
    groupId: LOCAL_GROUP,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: NOW + sortOrder
  }
}

/** Renderer side of E1: one local group of {t1,t2}; t3 exists locally but is ungrouped. */
function localState(): SyncState {
  return makeState({
    activeTabId: T1,
    activeTabIdByWorktree: { [WT]: T1 },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WT]: 'terminal' },
    activeGroupIdByWorktree: { [WT]: LOCAL_GROUP },
    tabsByWorktree: { [WT]: [terminalTab(T1, 0), terminalTab(T2, 1), terminalTab(T3, 2)] },
    unifiedTabsByWorktree: {
      [WT]: [unifiedTerminalTab(T1, 0), unifiedTerminalTab(T2, 1), unifiedTerminalTab(T3, 2)]
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: LOCAL_GROUP,
          worktreeId: WT,
          activeTabId: T1,
          tabOrder: [T1, T2],
          recentTabIds: []
        }
      ]
    }
  })
}

function hostGroup(id: string, tabOrder: string[]) {
  return { id, tabOrder, activeTabId: tabOrder[0] ?? null, recentTabIds: [] }
}

function hostTerminals(): RuntimeMobileSessionTabsResult['tabs'] {
  return [
    {
      type: 'terminal' as const,
      id: `${T1}::${LEAF_ID}`,
      title: T1,
      parentTabId: T1,
      leafId: LEAF_ID,
      isActive: true,
      status: 'ready' as const,
      terminal: `local-pty-${T1}`
    },
    {
      type: 'terminal' as const,
      id: `${T2}::${SECOND_LEAF_ID}`,
      title: T2,
      parentTabId: T2,
      leafId: SECOND_LEAF_ID,
      isActive: false,
      status: 'ready' as const,
      terminal: `local-pty-${T2}`
    },
    {
      type: 'terminal' as const,
      id: `${T3}::${THIRD_LEAF_ID}`,
      title: T3,
      parentTabId: T3,
      leafId: THIRD_LEAF_ID,
      isActive: false,
      status: 'ready' as const,
      terminal: `local-pty-${T3}`
    }
  ]
}

/** Desktop local host: two groups, member sets equal to the local ones, ids deliberately differ. */
function hostSnapshot(
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return makeSnapshot(hostTerminals(), {
    publicationEpoch: EPOCH,
    snapshotVersion: 3,
    activeGroupId: HOST_RIGHT,
    activeTabId: T3,
    tabGroups: [hostGroup(HOST_LEFT, [T1, T2]), hostGroup(HOST_RIGHT, [T3])],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: HOST_LEFT },
      second: { type: 'leaf', groupId: HOST_RIGHT }
    },
    ...overrides
  })
}

type CallRequest = { method: string; params?: unknown }

/** Wraps the host runtime's `call` so the test can both serve one reply and count outbound methods. */
function makeRuntimeCall(reply: RuntimeMobileSessionTabsResult | undefined, ok = true) {
  return vi.fn(async (_request: CallRequest) => ({ ok, result: reply }))
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

type HarnessOptions = {
  state: SyncState
  call: (request: CallRequest) => Promise<{ ok: boolean; result?: unknown }>
}

/** Mounts the V5 trigger hook; the focus event reaches the real V4 executor through the wrapper. */
function mountCatchup({ state, call }: HarnessOptions) {
  const commits: (WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>)[] = []
  const outcomes: LocalHostLayoutCatchupOutcome[] = []
  const options: LocalHostLayoutCatchupOptions = {
    getState: () => ({ activeWorktreeId: WT, workspaceSessionReady: true }),
    isWindowFocused: () => true,
    getVisible: () => true,
    isPublishPending: () => false,
    isGestureActive: () => false,
    subscribeVisibility: () => () => {},
    subscribeSystemResumed: () => () => {},
    subscribeStructuredReconnect: () => () => {},
    isWebClient: () => false,
    runCatchup: async (args) => {
      const outcome = await runLocalHostLayoutCatchup({
        ...args,
        state,
        executionHostIsLocal: true,
        call,
        commit: (patch) => commits.push(patch)
      })
      outcomes.push(outcome)
      return outcome
    }
  }
  const view = renderHook(() => useLocalHostLayoutCatchup(options))
  return { view, commits, outcomes }
}

async function runDirect(
  state: SyncState,
  call: (request: CallRequest) => Promise<{ ok: boolean; result?: unknown }>
): Promise<{
  outcome: LocalHostLayoutCatchupOutcome
  commits: (WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>)[]
}> {
  const commits: (WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>)[] = []
  const outcome = await runLocalHostLayoutCatchup({
    worktreeId: WT,
    state,
    executionHostIsLocal: true,
    call,
    commit: (patch) => commits.push(patch)
  })
  return { outcome, commits }
}

beforeEach(() => {
  window.localStorage.setItem(HOST_LAYOUT_CATCHUP_STORAGE_KEY, '1')
  resetWebSessionTabsSyncTestState()
  resetLocalStructuredSessionVersionForTests()
  resetLocalHostLayoutCatchupForTests()
  resetHostSessionGroupIdMappingsForTests()
  resetHostLayoutAdoptionForTests()
})

describe('U163 V7 E1: isolated-stack focus catch-up discriminator', () => {
  it('adopts host 2 groups from focus with no move, no host write, and unchanged local focus', async () => {
    const state = localState()
    const beforeActiveTabId = state.activeTabIdByWorktree[WT]
    const reply = hostSnapshot()
    deepFreeze(reply)
    const pristineReply = structuredClone(reply)
    const runtimeCall = makeRuntimeCall(reply)
    const harness = mountCatchup({ state, call: runtimeCall })

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()

    // ④ host 2 groups replace the renderer's single local group, members intact.
    expect(harness.outcomes).toEqual([{ status: 'applied', groupCount: 2 }])
    expect(harness.commits).toHaveLength(1)
    const merged = { ...state, ...harness.commits[0] }
    expect(merged.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([HOST_LEFT, HOST_RIGHT])
    expect(merged.groupsByWorktree[WT]?.map((group) => group.tabOrder)).toEqual([[T1, T2], [T3]])
    expect(merged.groupsByWorktree[WT]?.some((group) => group.id === LOCAL_GROUP)).toBe(false)
    expect(localStructuredSessionVersionByWorktree.get(WT)).toEqual({
      publicationEpoch: EPOCH,
      snapshotVersion: 3
    })

    // ① outbound traffic is one read: no session.tabs.move (and no other write method).
    const methods = runtimeCall.mock.calls.map(([request]) => request.method)
    const readOnlyMethods = new Set(['session.tabs.list', 'session.tabs.listAll'])
    expect(methods).toEqual(['session.tabs.list'])
    expect(methods).not.toContain('session.tabs.move')
    expect(methods.every((method) => readOnlyMethods.has(method))).toBe(true)

    // ② the frozen host reply is byte-for-byte unchanged by the catch-up.
    expect(structuredClone(reply)).toEqual(pristineReply)

    // ③ local active tab (and its type) survives the host's active tab.
    expect(merged.activeTabIdByWorktree[WT]).toBe(beforeActiveTabId)
    expect(merged.activeTabTypeByWorktree[WT]).toBe('terminal')
    expect(merged.activeGroupIdByWorktree[WT]).toBe(HOST_LEFT)
    expect(merged.groupsByWorktree[WT]?.[0]?.tabOrder).toContain(beforeActiveTabId)
  })

  it('applies no frame and records no cursor when the host reports tabGroups/tabGroupLayout missing', async () => {
    const reply = makeSnapshot(hostTerminals(), {
      publicationEpoch: EPOCH,
      snapshotVersion: 3
    })
    expect(reply.tabGroups).toBeUndefined()
    expect(reply.tabGroupLayout).toBeUndefined()
    const runtimeCall = makeRuntimeCall(reply)

    const { outcome, commits } = await runDirect(localState(), runtimeCall)

    expect(outcome).toEqual({ status: 'skipped', reason: 'host-layout-unreported' })
    expect(commits).toHaveLength(0)
    expect(localStructuredSessionVersionByWorktree.has(WT)).toBe(false)
    expect(localStructuredSessionEpochHistoryByWorktree.has(WT)).toBe(false)
  })

  it('drops an unknown tabGroupLayout group id instead of rejecting the frame or duplicating groups', async () => {
    const reply = hostSnapshot({
      tabGroupLayout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: HOST_LEFT },
        second: { type: 'leaf', groupId: 'host-ghost' }
      }
    })
    const runtimeCall = makeRuntimeCall(reply)

    const { outcome, commits } = await runDirect(localState(), runtimeCall)

    // Design §8.1: an unknown layout id is pruned, not a whole-frame rejection, and never a
    // duplicate group. The surviving frame is still applied as a normal 1→2 convergence.
    expect(outcome).toEqual({ status: 'applied', groupCount: 2 })
    expect(commits).toHaveLength(1)
    const merged = { ...localState(), ...commits[0] }
    expect(merged.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([HOST_LEFT, HOST_RIGHT])
    expect(merged.groupsByWorktree[WT]?.some((group) => group.id === 'host-ghost')).toBe(false)
    expect(merged.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: HOST_LEFT })
  })

  it('skips an unknown host tab member without duplicating or reshuffling its group', async () => {
    const scope = { environmentId: LOCAL_STRUCTURED_SESSION_OWNER, worktreeId: WT }
    setHostSessionGroupIdMapping({ ...scope, groupId: LOCAL_GROUP }, HOST_LEFT)
    const reply = hostSnapshot({
      tabGroups: [hostGroup(HOST_LEFT, [T1, T2, 'host-tab-unknown']), hostGroup(HOST_RIGHT, [T3])]
    })
    const runtimeCall = makeRuntimeCall(reply)

    const { outcome, commits } = await runDirect(localState(), runtimeCall)

    expect(outcome).toEqual({ status: 'applied', groupCount: 2 })
    const merged = { ...localState(), ...commits[0] }
    expect(merged.groupsByWorktree[WT]?.map((group) => group.id)).toEqual([HOST_LEFT, HOST_RIGHT])
    expect(merged.groupsByWorktree[WT]?.[0]?.tabOrder).toEqual([T1, T2])
  })
})
