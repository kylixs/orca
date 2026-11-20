/**
 * U174 / U175 independent audit probes (auditor-authored; fix tests are not reused).
 *
 * U174: three consecutive 100-worktree graph syncs must read each persisted host
 * partition exactly once per sync, while first-open and content-frame host split
 * preservation still hold.
 *
 * U175: a headless hydrate that masks a dropped renderer snapshot must ask for a
 * republish, but a renderer replaying its stale frame (no hydrate masking) must
 * still be skipped instead of being adopted again.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { TEST_REPO_ID, store } from './orca-runtime-test-fixtures.spec'

const WT_A = `${TEST_REPO_ID}::/tmp/u174-u175-a`
const WT_B = `${TEST_REPO_ID}::/tmp/u174-u175-b`

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

function internalsOf(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function makeTerminalTab(worktreeId: string, id: string, index: number) {
  return {
    id,
    ptyId: `persisted-pty-${index}`,
    worktreeId,
    title: `Tab ${index}`,
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: index + 1
  }
}

function makeSplitSession(worktrees: readonly string[]): WorkspaceSessionState {
  const tabsByWorktree: WorkspaceSessionState['tabsByWorktree'] = {}
  const tabGroups: NonNullable<WorkspaceSessionState['tabGroups']> = {}
  const tabGroupLayouts: NonNullable<WorkspaceSessionState['tabGroupLayouts']> = {}
  for (const [index, worktreeId] of worktrees.entries()) {
    const left = `left-${index}-tab`
    const right = `right-${index}-tab`
    tabsByWorktree[worktreeId] = [
      makeTerminalTab(worktreeId, left, 0),
      makeTerminalTab(worktreeId, right, 1)
    ]
    tabGroups[worktreeId] = [
      {
        id: `left-group-${index}`,
        worktreeId,
        activeTabId: left,
        tabOrder: [left]
      },
      {
        id: `right-group-${index}`,
        worktreeId,
        activeTabId: right,
        tabOrder: [right]
      }
    ]
    tabGroupLayouts[worktreeId] = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: `left-group-${index}` },
      second: { type: 'leaf', groupId: `right-group-${index}` }
    }
  }
  return {
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: worktrees[0] ?? WT_A,
    activeTabId: null,
    tabsByWorktree,
    terminalLayoutsByTabId: {},
    tabGroups,
    tabGroupLayouts
  }
}

function makeRuntimeTabSession(worktreeId: string): WorkspaceSessionState {
  return {
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: worktreeId,
    activeTabId: null,
    tabsByWorktree: {
      // serve-owned pty: makes it a headless hydration target.
      [worktreeId]: [{ ...makeTerminalTab(worktreeId, 'serve-tab', 0), ptyId: 'serve-pty-1' }]
    },
    terminalLayoutsByTabId: {}
  }
}

// A stale desktop frame: one group, even when the host persisted a split.
function rendererFrame(
  worktree: string,
  epoch: string,
  version: number,
  titles?: readonly string[]
): RuntimeMobileSessionTabsSnapshot {
  const index = worktree.endsWith(WT_B) ? 1 : 0
  const ids = [`left-${index}-tab`, `right-${index}-tab`]
  return {
    worktree,
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: 'renderer-group',
    activeTabId: `${ids[0]}::leaf`,
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'renderer-group',
        activeTabId: ids[0]!,
        tabOrder: [...ids]
      }
    ],
    tabs: ids.map((id, tabIndex) => ({
      type: 'terminal' as const,
      id: `${id}::leaf`,
      parentTabId: id,
      leafId: 'leaf',
      title: titles?.[tabIndex] ?? id,
      isActive: tabIndex === 0
    }))
  }
}

// An empty renderer publication: the shape the U174 amplification was measured
// with (the retirement fence is the only other per-tab session reader, and an
// empty tab list has no tab to fence).
function emptyRendererFrame(
  worktree: string,
  epoch: string,
  version: number
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: epoch,
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function makeSync(runtime: OrcaRuntimeService) {
  return (
    mobileSessionTabs: RuntimeMobileSessionTabsSnapshot[],
    unchangedMobileSessionWorktrees?: string[]
  ) =>
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs,
      ...(unchangedMobileSessionWorktrees
        ? { unchangedMobileSessionWorktrees }
        : {})
    })
}

describe('U174 independent probe', () => {
  it('reads the host partition once per 100-worktree sync and preserves the host split', async () => {
    const worktrees = Array.from(
      { length: 100 },
      (_, index) => `${TEST_REPO_ID}::/tmp/u174-probe-${index}`
    )
    const session = makeSplitSession(worktrees)
    let storeReads = 0
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession: () => {
        storeReads += 1
        return session
      },
      getWorkspaceSessionHostIds: () => ['local']
    } as never)

    const sync = makeSync(runtime)
    const sample = worktrees[0]!
    const expectedGroups = ['left-group-0', 'right-group-0']

    for (let pass = 0; pass < 3; pass += 1) {
      const before = storeReads
      const result = sync(
        worktrees.map((worktree) => emptyRendererFrame(worktree, 'u174-probe-epoch', pass + 1))
      )
      expect(storeReads - before).toBe(1)
      expect(result.mobileSessionResyncWorktrees).toBeUndefined()
      expect(
        internalsOf(runtime).mobileSessionTabsByWorktree.get(sample)?.tabGroups?.map((g) => g.id)
      ).toEqual(expectedGroups)
    }

    expect(storeReads).toBe(3)

    const listed = await runtime.listMobileSessionTabs(`id:${sample}`)
    expect(listed.tabGroups?.map((group) => group.id)).toEqual(expectedGroups)
  })

  it('preserves the host split across a first-open frame and a content frame', async () => {
    const session = makeSplitSession([WT_A])
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)
    const sync = makeSync(runtime)

    sync([rendererFrame(WT_A, 'u174-layout-epoch', 1)])
    expect(
      internalsOf(runtime).mobileSessionTabsByWorktree.get(WT_A)?.tabGroups?.map((g) => g.id)
    ).toEqual(['left-group-0', 'right-group-0'])

    // Content-only frame: same layout, renamed title and a newer version.
    sync([rendererFrame(WT_A, 'u174-layout-epoch', 2, ['renamed'])])
    const listed = await runtime.listMobileSessionTabs(`id:${WT_A}`)
    expect(listed.tabGroups?.map((group) => group.id)).toEqual(['left-group-0', 'right-group-0'])
    expect(listed.tabs).toHaveLength(2)
  })
})

describe('U175 independent probe', () => {
  it('asks for a republish when a headless hydrate masks a dropped renderer snapshot', () => {
    let session = makeRuntimeTabSession(WT_A)
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      }
    } as never)
    const sync = makeSync(runtime)

    sync([rendererFrame(WT_A, 'u175-masked-epoch', 1)])
    expect(internalsOf(runtime).mobileSessionTabsByWorktree.has(WT_A)).toBe(true)

    // Main drops the accepted snapshot while the renderer still thinks it is delivered.
    internalsOf(runtime).mobileSessionTabsByWorktree.delete(WT_A)

    const masked = sync([], [WT_A])
    expect(masked.mobileSessionResyncWorktrees).toEqual([WT_A])
    const rebuilt = internalsOf(runtime).mobileSessionTabsByWorktree.get(WT_A)
    expect(rebuilt?.publicationEpoch).toMatch(/^headless-hydrated:/)
    expect(rebuilt?.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))).toContain(
      'serve-tab'
    )
  })

  it('does not ask for a republish while a headless-preserved snapshot still carries the accepted tabs', async () => {
    const session = makeSplitSession([WT_A])
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)
    const sync = makeSync(runtime)

    sync([rendererFrame(WT_A, 'u175-replay-epoch', 1)])
    const storedAfterFirstOpen = internalsOf(runtime).mobileSessionTabsByWorktree.get(WT_A)
    expect(storedAfterFirstOpen?.publicationEpoch).toMatch(/^headless-hydrated:/)

    const unchanged = sync([], [WT_A])
    expect(unchanged.mobileSessionResyncWorktrees).toBeUndefined()

    // The renderer replays its stale first frame (same epoch and version).
    const replay = sync([rendererFrame(WT_A, 'u175-replay-epoch', 1)], [])
    expect(replay.mobileSessionResyncWorktrees).toBeUndefined()
    // Same stored object: the stale frame was skipped, not adopted again.
    expect(internalsOf(runtime).mobileSessionTabsByWorktree.get(WT_A)).toBe(storedAfterFirstOpen)

    const listed = await runtime.listMobileSessionTabs(`id:${WT_A}`)
    expect(listed.tabGroups?.map((group) => group.id)).toEqual(['left-group-0', 'right-group-0'])
  })

  it('keeps the unchanged path resync-free for a second worktree the renderer withholds', () => {
    const session = makeSplitSession([WT_A, WT_B])
    const runtime = new OrcaRuntimeService({
      ...store,
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local']
    } as never)
    const sync = makeSync(runtime)

    sync([rendererFrame(WT_A, 'u175-both-epoch', 1), rendererFrame(WT_B, 'u175-both-epoch', 1)])
    const result = sync([rendererFrame(WT_A, 'u175-both-epoch', 2)], [WT_A, WT_B])
    expect(result.mobileSessionResyncWorktrees).toBeUndefined()
    expect(internalsOf(runtime).mobileSessionTabsByWorktree.has(WT_B)).toBe(true)
  })
})
