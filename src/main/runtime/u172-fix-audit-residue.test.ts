/**
 * U172 fix v2 pins (independent audit follow-up). Four probes:
 *  - residue 2: a content/focus-only renderer frame after the first-open
 *    host-layout preservation must not collapse the host split.
 *  - residue 1: the accepted baseline seeded from the host must not make the
 *    move forwarding gate claim the renderer matches the host.
 *  - residue 3: a persisted single-group layout is dropped by hydration, so
 *    `firstOpenHostLayoutAuthority` never sees it (identity takeover only).
 *  - residue 4: a first renderer frame that beats the first hydrate must
 *    cold-hydrate the persisted layout before it is accepted.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import {
  makeThreeTabHeadlessSession,
  syncRendererSnapshots,
  terminalSnapshotTabs
} from './mobile-session-tab-routing-fixtures.spec'
import { HEADLESS_LEAF_ID, makeHeadlessTerminalLayout } from './orca-runtime-test-fixtures.spec'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
import { getMobileSessionTabGroupLayoutSignature } from './mobile-session-tab-group-layout-signature'

const HOST_GROUP_LEFT = 'host-group-left'
const HOST_GROUP_RIGHT = 'host-group-right'

function makeHostSplitSession() {
  const session = makeThreeTabHeadlessSession()
  session.tabGroups = {
    [TEST_WORKTREE_ID]: [
      {
        id: HOST_GROUP_LEFT,
        worktreeId: TEST_WORKTREE_ID,
        activeTabId: 'host-tab',
        tabOrder: ['host-tab']
      },
      {
        id: HOST_GROUP_RIGHT,
        worktreeId: TEST_WORKTREE_ID,
        activeTabId: 'host-tab-2',
        tabOrder: ['host-tab-2', 'host-tab-3']
      }
    ]
  }
  session.tabGroupLayouts = {
    [TEST_WORKTREE_ID]: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: HOST_GROUP_LEFT },
      second: { type: 'leaf', groupId: HOST_GROUP_RIGHT }
    }
  }
  session.activeGroupIdByWorktree = { [TEST_WORKTREE_ID]: HOST_GROUP_LEFT }
  return session
}

function staleOneGroupFrame(overrides: Partial<RuntimeMobileSessionTabsSnapshot> = {}) {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer-epoch',
    snapshotVersion: 1,
    activeGroupId: 'renderer-group',
    activeTabId: 'host-tab::leaf',
    activeTabType: 'terminal' as const,
    tabGroups: [
      {
        id: 'renderer-group',
        activeTabId: 'host-tab',
        tabOrder: ['host-tab', 'host-tab-2', 'host-tab-3']
      }
    ],
    tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3']),
    ...overrides
  }
}

function hostGroupIds(result: { tabGroups?: { id: string }[] }): string[] {
  return (result.tabGroups ?? []).map((group) => group.id)
}

describe('U172 audit residue 2: content-only frame after first-open preservation', () => {
  it('keeps the host split when the renderer republishes renamed tabs (same stale layout)', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    // First open: the host snapshot already exists (mobile list before publish).
    expect(hostGroupIds(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`))).toEqual([
      HOST_GROUP_LEFT,
      HOST_GROUP_RIGHT
    ])
    // First open: host split is preserved.
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])
    expect(hostGroupIds(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`))).toEqual([
      HOST_GROUP_LEFT,
      HOST_GROUP_RIGHT
    ])

    // Renderer content changed (renamed tab), layout untouched: same stale 1 group.
    const renamedTabs = terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
    renamedTabs[0] = { ...renamedTabs[0]!, title: 'renamed-tab-1' }
    syncRendererSnapshots(runtime, [staleOneGroupFrame({ snapshotVersion: 2, tabs: renamedTabs })])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(hostGroupIds(after)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
  })

  it('keeps the host split when the renderer republishes a focus-only change', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])
    syncRendererSnapshots(runtime, [
      staleOneGroupFrame({ snapshotVersion: 2, activeTabId: 'host-tab-2::leaf' })
    ])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(hostGroupIds(after)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
  })
})

describe('U172 audit residue 1: forwarding gate after first-open preservation', () => {
  it('keeps the host signature as the baseline but gates on the raw frame', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const frame = staleOneGroupFrame()

    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    syncRendererSnapshots(runtime, [frame])

    const internals = runtime as unknown as {
      acceptedRendererMobileSnapshotByWorktree: Map<
        string,
        {
          rendererTabGroupLayoutSignature: string
          rendererRawLayoutSignature?: string
          hostLayoutAuthorityPending?: boolean
        }
      >
      acceptedRendererMobileSessionLayoutMatchesHost(
        worktreeId: string,
        snapshot: RuntimeMobileSessionTabsSnapshot
      ): boolean
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const accepted = internals.acceptedRendererMobileSnapshotByWorktree.get(TEST_WORKTREE_ID)!
    const hostSnapshot = internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)!

    // The host-seeded baseline still describes the preserved host layout.
    expect(accepted.rendererTabGroupLayoutSignature).toBe(
      getMobileSessionTabGroupLayoutSignature(hostSnapshot)
    )
    // The raw frame it was seeded from is retained for the forwarding gate.
    expect(accepted.hostLayoutAuthorityPending).toBe(true)
    expect(accepted.rendererRawLayoutSignature).toBe(getMobileSessionTabGroupLayoutSignature(frame))
    expect(accepted.rendererRawLayoutSignature).not.toBe(
      getMobileSessionTabGroupLayoutSignature(hostSnapshot)
    )
    // Therefore the gate no longer claims the stale renderer matches the host.
    expect(
      internals.acceptedRendererMobileSessionLayoutMatchesHost(TEST_WORKTREE_ID, hostSnapshot)
    ).toBe(false)
  })

  it('applies a mobile move headlessly instead of forwarding it to the stale window', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)

    const result = await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: 'host-tab-2',
      targetGroupId: HOST_GROUP_LEFT,
      splitDirection: 'right'
    })

    // Not forwarded to the window whose layout is still stale.
    expect(moveSessionTab).not.toHaveBeenCalled()
    expect(result).toEqual({ moved: true })
    // The host applied the split itself: the tab left its original group.
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const hostSnapshot = internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)!
    expect(
      hostSnapshot.tabGroups?.find((group) => group.id === HOST_GROUP_RIGHT)?.tabOrder
    ).not.toContain('host-tab-2')
    expect(hostSnapshot.tabGroups?.length).toBe(3)
  })

  it('does not let a stale renderer swallow a move whose target id overlaps', async () => {
    // The pre-split group keeps its id when the host adds the second group, so
    // the stale renderer still owns that id and would ack a move into it.
    const SHARED_GROUP = 'shared-persisted-group'
    const session = makeHostSplitSession()
    session.tabGroups = {
      [TEST_WORKTREE_ID]: [
        {
          id: SHARED_GROUP,
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: 'host-tab',
          tabOrder: ['host-tab']
        },
        {
          id: HOST_GROUP_RIGHT,
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: 'host-tab-2',
          tabOrder: ['host-tab-2', 'host-tab-3']
        }
      ]
    }
    session.tabGroupLayouts = {
      [TEST_WORKTREE_ID]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: SHARED_GROUP },
        second: { type: 'leaf', groupId: HOST_GROUP_RIGHT }
      }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    const staleFrame = staleOneGroupFrame()
    staleFrame.tabGroups = [
      {
        id: SHARED_GROUP,
        activeTabId: 'host-tab',
        tabOrder: ['host-tab', 'host-tab-2', 'host-tab-3']
      }
    ]
    syncRendererSnapshots(runtime, [staleFrame])

    // The desktop window would ack against its stale one-group layout.
    const moveSessionTab = vi.fn().mockResolvedValue(true)
    runtime.setNotifier({ moveSessionTab } as never)

    const result = await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'move-to-group',
      tabId: 'host-tab-2',
      targetGroupId: SHARED_GROUP
    })

    // Applied by the host: the move is not claimed by the stale window/acked
    // true and then silently lost.
    expect(moveSessionTab).not.toHaveBeenCalled()
    expect(result).toEqual({ moved: true })
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const hostSnapshot = internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)!
    expect(
      hostSnapshot.tabGroups?.find((group) => group.id === HOST_GROUP_RIGHT)?.tabOrder
    ).not.toContain('host-tab-2')
  })
})

describe('U172 audit residue 3: persisted single-group layout', () => {
  it('drops the persisted single-group layout on cold hydrate', async () => {
    const groupId = getHeadlessMobileSessionGroupId(TEST_WORKTREE_ID)
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: ['host-tab'].map((id, index) => ({
          id,
          ptyId: `persisted-pty${index === 0 ? '' : `-${index + 1}`}`,
          worktreeId: TEST_WORKTREE_ID,
          title: `Tab ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: index + 1
        }))
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty' })
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: groupId,
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'host-tab',
            tabOrder: ['host-tab']
          }
        ]
      }
    })
    session.tabGroupLayouts = {
      [TEST_WORKTREE_ID]: { type: 'leaf', groupId }
    }
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const hostBefore = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
    const stored = internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)!

    // The persisted single-group layout never reaches the snapshot.
    expect(stored.tabGroupLayout).toBeUndefined()
    expect(hostBefore.tabGroupLayout).toBeUndefined()

    // A stale renderer one-group frame therefore takes over uncontested.
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])
    expect(hostGroupIds(await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`))).toEqual([
      'renderer-group'
    ])
  })
})

describe('U172 audit residue 4: first frame before any hydrate', () => {
  it('cold-hydrates the persisted split before accepting the first stale frame', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    // No listMobileSessionTabs first: the renderer publication arrives cold.
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(hostGroupIds(after)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
  })
})
