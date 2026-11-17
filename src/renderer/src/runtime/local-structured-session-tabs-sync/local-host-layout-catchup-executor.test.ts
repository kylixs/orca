import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
import { resetHostLayoutAdoptionForTests } from '../web-session-tabs-sync/host-layout-adoption'
import {
  resetHostSessionGroupIdMappingsForTests,
  resolveHostSessionGroupIdForWebSessionGroup
} from '../web-session-tabs-sync/tracking-mappings'
import type { WebSessionTabsSyncState } from '../web-session-tabs-sync/state'
import {
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
  WT,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import {
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionVersionByWorktree,
  resetLocalStructuredSessionVersionForTests
} from './inventory-generation-fence'
import {
  resetLocalHostLayoutCatchupForTests,
  runLocalHostLayoutCatchup,
  type LocalHostLayoutCatchupCall,
  type LocalHostLayoutCatchupOutcome,
  type RunLocalHostLayoutCatchupArgs
} from './run-local-host-layout-catchup'

const T1 = 'local-tab-1'
const T2 = 'local-tab-2'
const T3 = 'local-tab-3'
const LOCAL_GROUP = 'local-left'
const H1 = 'host-left'
const H2 = 'host-right'
const EPOCH = 'epoch-catchup'

type SyncState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState
type CatchupCommitPatch = WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>

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

function unifiedTerminalTab(id: string, sortOrder: number, groupId = LOCAL_GROUP): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: NOW + sortOrder
  }
}

/** One local group of {t1,t2}, with t3 still ungrouped locally. */
function localState(groupId = LOCAL_GROUP): SyncState {
  return makeState({
    activeTabId: T1,
    activeTabIdByWorktree: { [WT]: T1 },
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [WT]: 'terminal' },
    activeGroupIdByWorktree: { [WT]: groupId },
    tabsByWorktree: { [WT]: [terminalTab(T1, 0), terminalTab(T2, 1), terminalTab(T3, 2)] },
    unifiedTabsByWorktree: {
      [WT]: [
        unifiedTerminalTab(T1, 0, groupId),
        unifiedTerminalTab(T2, 1, groupId),
        unifiedTerminalTab(T3, 2, groupId)
      ]
    },
    groupsByWorktree: {
      [WT]: [
        {
          id: groupId,
          worktreeId: WT,
          activeTabId: T1,
          tabOrder: [T1, T2],
          recentTabIds: []
        }
      ]
    }
  })
}

function group(id: string, tabOrder: string[]) {
  return { id, tabOrder, activeTabId: tabOrder[0] ?? null, recentTabIds: [] }
}

/** Desktop local host: raw tab ids, two host groups, t3 in the new split. */
function hostSnapshot(overrides: Partial<RuntimeMobileSessionTabsResult> = {}) {
  return {
    worktree: WT,
    publicationEpoch: EPOCH,
    snapshotVersion: 3,
    activeGroupId: H1,
    activeTabId: T1,
    activeTabType: 'terminal',
    tabs: [
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
    ],
    tabGroups: [group(H1, [T1, T2]), group(H2, [T3])],
    tabGroupLayout: {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: H1 },
      second: { type: 'leaf' as const, groupId: H2 }
    },
    ...overrides
  }
}

function fakeCall(replies: ({ ok: boolean; result?: unknown } | Error)[]): {
  call: LocalHostLayoutCatchupCall
  calls: { method: string; params?: unknown }[]
} {
  const calls: { method: string; params?: unknown }[] = []
  const call: LocalHostLayoutCatchupCall = async (request) => {
    calls.push(request)
    const next = replies.shift()
    if (next instanceof Error) {
      throw next
    }
    return next ?? { ok: false }
  }
  return { call, calls }
}

async function run(
  state: SyncState,
  call: LocalHostLayoutCatchupCall,
  overrides: Partial<RunLocalHostLayoutCatchupArgs> = {}
): Promise<{ outcome: LocalHostLayoutCatchupOutcome; commits: CatchupCommitPatch[] }> {
  const commits: CatchupCommitPatch[] = []
  const outcome = await runLocalHostLayoutCatchup({
    worktreeId: WT,
    state,
    executionHostIsLocal: true,
    call,
    commit: (patch) => commits.push(patch),
    ...overrides
  })
  return { outcome, commits }
}

function mappingFor(groupId: string): string | null {
  return resolveHostSessionGroupIdForWebSessionGroup({
    environmentId: LOCAL_STRUCTURED_SESSION_OWNER,
    worktreeId: WT,
    groupId
  })
}

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  resetLocalStructuredSessionVersionForTests()
  resetLocalHostLayoutCatchupForTests()
  resetHostSessionGroupIdMappingsForTests()
  resetHostLayoutAdoptionForTests()
})

describe('U163 V4: local host layout catch-up executor', () => {
  it('applies one list reply: preseed → layout-only apply once, no moves or republication', async () => {
    const state = localState()
    const { call, calls } = fakeCall([{ ok: true, result: hostSnapshot() }])

    const { outcome, commits } = await run(state, call)

    expect(outcome).toEqual({ status: 'applied', groupCount: 2 })
    expect(calls.map((request) => request.method)).toEqual(['session.tabs.list'])
    expect(calls.some((request) => request.method === 'session.tabs.move')).toBe(false)
    expect(calls[0]?.params).toEqual({ worktree: WT })
    expect(commits).toHaveLength(1)

    const merged = { ...state, ...commits[0] }
    // B4-b: the exact member set is preseeded before apply, so the old group merges into H1.
    expect(merged.groupsByWorktree[WT]?.map((entry) => entry.id)).toEqual([H1, H2])
    expect(merged.groupsByWorktree[WT]?.some((entry) => entry.id === LOCAL_GROUP)).toBe(false)
    // V3: local focus survives the host's active tab.
    expect(merged.activeTabIdByWorktree[WT]).toBe(T1)
    expect(merged.activeGroupIdByWorktree[WT]).toBe(H1)
    // V4 records the applied publication for C7.
    expect(localStructuredSessionVersionByWorktree.get(WT)).toEqual({
      publicationEpoch: EPOCH,
      snapshotVersion: 3
    })
  })

  it('defers without listing while a local publish is pending', async () => {
    const { call, calls } = fakeCall([{ ok: true, result: hostSnapshot() }])

    const { outcome, commits } = await run(localState(), call, { pendingPublish: true })

    expect(outcome).toEqual({ status: 'deferred', reason: 'pending-publish' })
    expect(calls).toHaveLength(0)
    expect(commits).toHaveLength(0)
  })

  it('skips without listing while a user gesture is active', async () => {
    const { call, calls } = fakeCall([{ ok: true, result: hostSnapshot() }])

    const { outcome, commits } = await run(localState(), call, { gestureActive: true })

    expect(outcome).toEqual({ status: 'skipped', reason: 'gesture-active' })
    expect(calls).toHaveLength(0)
    expect(commits).toHaveLength(0)
  })

  it('refuses an unmapped host-backed group: no store write, no publication', async () => {
    const { call, calls } = fakeCall([
      {
        ok: true,
        result: hostSnapshot({
          tabGroups: [group(H1, [T1]), group(H2, [T2])],
          tabGroupLayout: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: H1 },
            second: { type: 'leaf', groupId: H2 }
          }
        })
      }
    ])

    const { outcome, commits } = await run(localState(), call)

    expect(outcome).toEqual({ status: 'skipped', reason: 'catchup:unmapped-group' })
    expect(calls).toHaveLength(1)
    expect(commits).toHaveLength(0)
    expect(mappingFor(LOCAL_GROUP)).toBeNull()
    expect(localStructuredSessionVersionByWorktree.has(WT)).toBe(false)
    expect(localStructuredSessionEpochHistoryByWorktree.has(WT)).toBe(false)
  })

  it('applies a literal-equal group id without a preseeded mapping', async () => {
    // The local group already carries the host's id, so the apply path indexes it directly.
    const state = localState(H1)
    const { call, calls } = fakeCall([{ ok: true, result: hostSnapshot() }])

    const { outcome, commits } = await run(state, call)

    expect(outcome).toEqual({ status: 'applied', groupCount: 2 })
    expect(calls.map((request) => request.method)).toEqual(['session.tabs.list'])
    expect(commits).toHaveLength(1)
    const merged = { ...state, ...commits[0] }
    expect(merged.groupsByWorktree[WT]?.map((entry) => entry.id)).toEqual([H1, H2])
  })

  it('still refuses an ambiguous member-set match when ids differ', async () => {
    // Two host groups share {t1,t2}, so no unique match exists and the frame must not apply.
    const { call, calls } = fakeCall([
      {
        ok: true,
        result: hostSnapshot({
          tabGroups: [group('host-a', [T1, T2]), group('host-b', [T1, T2])],
          tabGroupLayout: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'host-a' },
            second: { type: 'leaf', groupId: 'host-b' }
          }
        })
      }
    ])

    const { outcome, commits } = await run(localState(), call)

    expect(outcome).toEqual({ status: 'skipped', reason: 'catchup:unmapped-group' })
    expect(calls).toHaveLength(1)
    expect(commits).toHaveLength(0)
    expect(mappingFor(LOCAL_GROUP)).toBeNull()
  })

  it('skips a reply that is not newer than the applied cursor', async () => {
    localStructuredSessionVersionByWorktree.set(WT, {
      publicationEpoch: EPOCH,
      snapshotVersion: 3
    })
    const { call, calls } = fakeCall([{ ok: true, result: hostSnapshot() }])

    const { outcome, commits } = await run(localState(), call)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'catchup:freshness:same-lineage-not-newer'
    })
    expect(calls).toHaveLength(1)
    expect(commits).toHaveLength(0)
    expect(mappingFor(LOCAL_GROUP)).toBeNull()
  })

  it('records a list failure without throwing, and retries on the next trigger', async () => {
    const { call, calls } = fakeCall([
      new Error('runtime unavailable'),
      { ok: true, result: hostSnapshot() }
    ])
    const state = localState()

    const failed = await run(state, call)
    expect(failed.outcome).toEqual({
      status: 'failed',
      reason: 'catchup:failed',
      error: expect.any(Error)
    })
    expect(failed.commits).toHaveLength(0)
    expect(localStructuredSessionVersionByWorktree.has(WT)).toBe(false)

    const retried = await run(state, call)
    expect(retried.outcome).toEqual({ status: 'applied', groupCount: 2 })
    expect(calls).toHaveLength(2)
  })

  it('single-flights concurrent triggers into one session.tabs.list', async () => {
    const { call, calls } = fakeCall([
      { ok: true, result: hostSnapshot() },
      { ok: true, result: hostSnapshot() }
    ])
    const state = localState()

    const [first, second] = await Promise.all([run(state, call), run(state, call)])

    expect(first.outcome).toEqual({ status: 'applied', groupCount: 2 })
    // The coalesced rerun lands inside the coalesce window and skips without a second list.
    expect(second.outcome).toEqual({ status: 'skipped', reason: 'recently-caught-up' })
    expect(calls.filter((request) => request.method === 'session.tabs.list')).toHaveLength(1)
  })
})
