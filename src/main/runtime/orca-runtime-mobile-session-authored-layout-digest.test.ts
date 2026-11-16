import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'
import {
  getStoredMobileSessionSnapshot,
  makeThreeTabHeadlessSession,
  markRendererPublished,
  setMobileSessionSnapshot,
  syncRendererSnapshots,
  terminalSnapshotTabs,
  twoTabSnapshot
} from './mobile-session-tab-routing-fixtures.spec'

async function splitHeadlessSession(
  runtime: OrcaRuntimeService
): Promise<ReturnType<OrcaRuntimeService['listMobileSessionTabs']>> {
  const moveSessionTab = vi.fn().mockResolvedValue(false)
  runtime.setNotifier({ moveSessionTab } as never)
  const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  markRendererPublished(runtime, TEST_WORKTREE_ID, initial)
  await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
    kind: 'split',
    tabId: 'host-tab-2',
    targetGroupId: initial.tabGroups![0]!.id,
    splitDirection: 'right'
  })
  return runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
}

describe('renderer-authored layout digest ownership', () => {
  it('takes the groups back when the renderer changes members without changing the shape', async () => {
    const session = makeThreeTabHeadlessSession()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const afterSplit = await splitHeadlessSession(runtime)
    // The renderer caught up with the host split, then authores a same-shape
    // member change: host-tab-3 joins the split group.
    markRendererPublished(runtime, TEST_WORKTREE_ID, afterSplit)
    const splitGroupId = afterSplit.tabGroups!.find((group) =>
      group.tabOrder.includes('host-tab-2')
    )!.id
    const authoredGroups = afterSplit.tabGroups!.map((group) => ({
      ...group,
      tabOrder:
        group.id === splitGroupId
          ? ['host-tab-3', ...group.tabOrder]
          : group.tabOrder.filter((tabId) => tabId !== 'host-tab-3')
    }))

    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-epoch',
        snapshotVersion: 60,
        activeGroupId: splitGroupId,
        activeTabId: 'host-tab-3::leaf',
        activeTabType: 'terminal',
        tabGroups: authoredGroups,
        tabGroupLayout: afterSplit.tabGroupLayout,
        tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
      }
    ])

    const afterAuthored = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterAuthored.tabGroups).toEqual(authoredGroups)
    expect(afterAuthored.publicationEpoch).toBe('renderer-epoch')
  })

  it('takes the groups back when the renderer only reorders tabs within a group', async () => {
    const session = makeThreeTabHeadlessSession()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const afterSplit = await splitHeadlessSession(runtime)
    markRendererPublished(runtime, TEST_WORKTREE_ID, afterSplit)
    const sourceGroup = afterSplit.tabGroups!.find(
      (group) => !group.tabOrder.includes('host-tab-2')
    )!
    const authoredGroups = afterSplit.tabGroups!.map((group) =>
      group.id === sourceGroup.id ? { ...group, tabOrder: group.tabOrder.toReversed() } : group
    )

    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-epoch',
        snapshotVersion: 60,
        activeGroupId: afterSplit.activeGroupId,
        activeTabId: afterSplit.activeTabId,
        activeTabType: 'terminal',
        tabGroups: authoredGroups,
        tabGroupLayout: afterSplit.tabGroupLayout,
        tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
      }
    ])

    const afterAuthored = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterAuthored.tabGroups).toEqual(authoredGroups)
  })

  it('keeps the host layout across repeated same-digest replays without asking for a resync', async () => {
    const session = makeThreeTabHeadlessSession()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const sourceGroupId = initial.tabGroups![0]!.id
    markRendererPublished(runtime, TEST_WORKTREE_ID, initial)
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: 'host-tab-2',
      targetGroupId: sourceGroupId,
      splitDirection: 'right'
    })
    const staleFrame = (snapshotVersion: number): RuntimeMobileSessionTabsSnapshot => ({
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer-epoch',
      snapshotVersion,
      activeGroupId: sourceGroupId,
      activeTabId: 'host-tab::leaf',
      activeTabType: 'terminal',
      tabGroups: [
        {
          id: sourceGroupId,
          activeTabId: 'host-tab',
          tabOrder: ['host-tab', 'host-tab-2', 'host-tab-3']
        }
      ],
      tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
    })

    const firstResync = syncRendererSnapshots(runtime, [staleFrame(50)])
    const unchangedResync = syncRendererSnapshots(runtime, [], [TEST_WORKTREE_ID])
    const secondResync = syncRendererSnapshots(runtime, [staleFrame(51)])

    expect(firstResync.size).toBe(0)
    expect(unchangedResync.size).toBe(0)
    expect(secondResync.size).toBe(0)
    const afterReplays = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterReplays.tabGroups).toHaveLength(2)
    expect(afterReplays.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
  })

  it('keeps a reload baseline frame and lets the next same-generation change take over', async () => {
    const session = makeThreeTabHeadlessSession()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const reloadGroupId = initial.tabGroups![0]!.id
    markRendererPublished(runtime, TEST_WORKTREE_ID, initial)
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: 'host-tab-2',
      targetGroupId: initial.tabGroups![0]!.id,
      splitDirection: 'right'
    })

    const reloadFrame = (
      snapshotVersion: number,
      tabOrder: string[]
    ): RuntimeMobileSessionTabsSnapshot => ({
      worktree: TEST_WORKTREE_ID,
      publicationEpoch: 'renderer-epoch-2',
      snapshotVersion,
      activeGroupId: reloadGroupId,
      activeTabId: `${tabOrder[0]}::leaf`,
      activeTabType: 'terminal',
      tabGroups: [{ id: reloadGroupId, activeTabId: tabOrder[0], tabOrder }],
      tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
    })

    // First frame of the new generation is the baseline: the host split survives
    // even though its member order differs from the accepted pre-reload frame.
    syncRendererSnapshots(runtime, [reloadFrame(1, ['host-tab', 'host-tab-3', 'host-tab-2'])])
    const afterBaseline = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterBaseline.tabGroups).toHaveLength(2)

    // The next same-generation frame changes the same shape and takes over.
    syncRendererSnapshots(runtime, [reloadFrame(2, ['host-tab-3', 'host-tab-2', 'host-tab'])])
    const afterHandback = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterHandback.tabGroups).toHaveLength(1)
    expect(afterHandback.tabGroups![0]!.tabOrder).toEqual(['host-tab-3', 'host-tab-2', 'host-tab'])
  })

  it('does not treat a host-preserved tab as a stale renderer layout', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn().mockResolvedValue(true)
    runtime.setNotifier({ moveSessionTab } as never)
    markRendererPublished(runtime, TEST_WORKTREE_ID, twoTabSnapshot())
    setMobileSessionSnapshot(runtime, {
      ...twoTabSnapshot(),
      publicationEpoch: 'headless:host-owned',
      snapshotVersion: 10,
      tabGroups: [
        {
          id: 'group-left',
          activeTabId: 'left-tab',
          tabOrder: ['left-tab', 'right-tab', 'preserved-tab']
        }
      ],
      tabs: [
        ...twoTabSnapshot().tabs,
        {
          type: 'file',
          id: 'preserved-tab',
          title: 'Preserved',
          filePath: 'preserved.md',
          relativePath: 'preserved.md',
          language: 'markdown',
          isDirty: false,
          isActive: false
        }
      ]
    })

    const resync = syncRendererSnapshots(runtime, [{ ...twoTabSnapshot(), snapshotVersion: 5 }])
    expect(resync.size).toBe(0)
    const afterSync = getStoredMobileSessionSnapshot(runtime, TEST_WORKTREE_ID)!
    expect(afterSync.tabGroups![0]!.tabOrder).toEqual(['left-tab', 'right-tab', 'preserved-tab'])
    expect(afterSync.publicationEpoch).toBe('headless:host-owned')

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'split',
        tabId: 'right-tab',
        targetGroupId: 'group-left',
        splitDirection: 'right'
      })
    ).resolves.toEqual({ moved: true })
    expect(moveSessionTab).toHaveBeenCalledTimes(1)
  })

  it('does not roll back a forwarded move when the renderer echoes it back', async () => {
    const session = makeThreeTabHeadlessSession()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    markRendererPublished(runtime, TEST_WORKTREE_ID, initial)
    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: 'host-tab-2',
      targetGroupId: initial.tabGroups![0]!.id,
      splitDirection: 'right'
    })
    const afterSplit = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    markRendererPublished(runtime, TEST_WORKTREE_ID, afterSplit)
    const splitGroupId = afterSplit.tabGroups!.find((group) =>
      group.tabOrder.includes('host-tab-2')
    )!.id
    moveSessionTab.mockClear()
    moveSessionTab.mockResolvedValue(true)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: 'host-tab-3',
        targetGroupId: splitGroupId
      })
    ).resolves.toEqual({ moved: true })
    expect(moveSessionTab).toHaveBeenCalledTimes(1)

    const echoedGroups = afterSplit.tabGroups!.map((group) => ({
      ...group,
      tabOrder:
        group.id === splitGroupId
          ? [group.tabOrder[0]!, 'host-tab-3', ...group.tabOrder.slice(1)]
          : group.tabOrder.filter((tabId) => tabId !== 'host-tab-3')
    }))
    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-epoch',
        snapshotVersion: 60,
        activeGroupId: splitGroupId,
        activeTabId: 'host-tab-3::leaf',
        activeTabType: 'terminal',
        tabGroups: echoedGroups,
        tabGroupLayout: afterSplit.tabGroupLayout,
        tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
      }
    ])
    const afterEcho = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterEcho.tabGroups).toEqual(echoedGroups)
    expect(afterEcho.publicationEpoch).toBe('renderer-epoch')

    // A later content-only resend must not flash the pre-move members back.
    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-epoch',
        snapshotVersion: 61,
        activeGroupId: splitGroupId,
        activeTabId: 'host-tab-3::leaf',
        activeTabType: 'terminal',
        tabGroups: echoedGroups,
        tabGroupLayout: afterSplit.tabGroupLayout,
        tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
      }
    ])
    const afterContentOnly = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterContentOnly.tabGroups).toEqual(echoedGroups)
  })

  it('does not revive a tab the host closed when the renderer replays its old frame', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn()
    runtime.setNotifier({ moveSessionTab } as never)
    markRendererPublished(runtime, TEST_WORKTREE_ID, twoTabSnapshot())
    // The host closed right-tab headlessly: same group/tree shape, one less member.
    setMobileSessionSnapshot(runtime, {
      ...twoTabSnapshot(),
      publicationEpoch: 'headless:host-owned',
      snapshotVersion: 10,
      activeTabId: 'left-tab::leaf-1',
      tabGroups: [{ id: 'group-left', activeTabId: 'left-tab', tabOrder: ['left-tab'] }],
      tabs: [twoTabSnapshot().tabs[0]!]
    })

    syncRendererSnapshots(runtime, [{ ...twoTabSnapshot(), snapshotVersion: 50 }])

    const afterReplay = getStoredMobileSessionSnapshot(runtime, TEST_WORKTREE_ID)!
    expect(afterReplay.tabGroups![0]!.tabOrder).toEqual(['left-tab'])
    expect(afterReplay.publicationEpoch).toBe('headless:host-owned')
  })

  it('does not take the groups back for a focus-only renderer frame', async () => {
    const session = makeThreeTabHeadlessSession()
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const afterSplit = await splitHeadlessSession(runtime)
    markRendererPublished(runtime, TEST_WORKTREE_ID, afterSplit)
    const splitGroup = afterSplit.tabGroups!.find((group) => group.tabOrder.includes('host-tab-2'))!
    const focusedGroups = afterSplit.tabGroups!.map((group) => ({
      ...group,
      activeTabId: group.tabOrder.at(-1)!
    }))

    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-epoch',
        snapshotVersion: 60,
        // Focus moves to the split group; only focus fields differ from accepted.
        activeGroupId: splitGroup.id,
        activeTabId: splitGroup.tabOrder[0]!,
        activeTabType: 'terminal',
        tabGroups: focusedGroups,
        tabGroupLayout: afterSplit.tabGroupLayout,
        tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
      }
    ])

    const afterFocus = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    // Layout ownership stays with the host; only the focus pointer is adopted.
    expect(afterFocus.publicationEpoch).toBe(afterSplit.publicationEpoch)
    expect(afterFocus.tabGroups!.map((group) => group.tabOrder)).toEqual(
      afterSplit.tabGroups!.map((group) => group.tabOrder)
    )
    expect(afterFocus.activeGroupId).toBe(splitGroup.id)
  })

  it('does not adopt an active group that does not hold the incoming active tab', () => {
    const runtime = new OrcaRuntimeService()
    runtime.setNotifier({ moveSessionTab: vi.fn() } as never)
    const layout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'group-left' },
      second: { type: 'leaf' as const, groupId: 'group-right' }
    }
    const incoming: RuntimeMobileSessionTabsSnapshot = {
      ...twoTabSnapshot(),
      snapshotVersion: 5,
      activeGroupId: 'group-left',
      activeTabId: 'right-tab::leaf-1',
      tabGroups: [
        { id: 'group-left', activeTabId: 'left-tab', tabOrder: ['left-tab'] },
        { id: 'group-right', activeTabId: 'right-tab', tabOrder: ['right-tab'] }
      ],
      tabGroupLayout: layout
    }
    setMobileSessionSnapshot(runtime, {
      ...incoming,
      publicationEpoch: 'headless:host-owned',
      snapshotVersion: 10,
      activeGroupId: 'group-right',
      activeTabId: 'right-tab::leaf-1'
    })
    markRendererPublished(runtime, TEST_WORKTREE_ID, incoming)

    syncRendererSnapshots(runtime, [incoming])

    const stored = getStoredMobileSessionSnapshot(runtime, TEST_WORKTREE_ID)!
    expect(stored.publicationEpoch).toBe('headless:host-owned')
    // The pair is inconsistent (right-tab lives in group-right), so keep the host focus.
    expect(stored.activeGroupId).toBe('group-right')
  })

  it('does not adopt an active group the host layout tree does not reference', () => {
    const runtime = new OrcaRuntimeService()
    runtime.setNotifier({ moveSessionTab: vi.fn() } as never)
    const incoming: RuntimeMobileSessionTabsSnapshot = {
      ...twoTabSnapshot(),
      snapshotVersion: 5,
      activeGroupId: 'group-orphan',
      activeTabId: 'right-tab::leaf-1'
    }
    setMobileSessionSnapshot(runtime, {
      ...incoming,
      publicationEpoch: 'headless:host-owned',
      snapshotVersion: 10,
      activeGroupId: 'group-left',
      activeTabId: 'left-tab::leaf-1',
      tabGroups: [
        { id: 'group-left', activeTabId: 'left-tab', tabOrder: ['left-tab', 'right-tab'] },
        { id: 'group-orphan', activeTabId: 'right-tab', tabOrder: ['right-tab'] }
      ],
      tabGroupLayout: { type: 'leaf', groupId: 'group-left' }
    })
    markRendererPublished(runtime, TEST_WORKTREE_ID, incoming)

    syncRendererSnapshots(runtime, [incoming])

    const stored = getStoredMobileSessionSnapshot(runtime, TEST_WORKTREE_ID)!
    expect(stored.publicationEpoch).toBe('headless:host-owned')
    // group-orphan is in tabGroups but not in the host tree: it cannot take focus.
    expect(stored.activeGroupId).toBe('group-left')
  })

  it('does not adopt an active group when the incoming frame omits its active tab', () => {
    const runtime = new OrcaRuntimeService()
    runtime.setNotifier({ moveSessionTab: vi.fn() } as never)
    const incoming: RuntimeMobileSessionTabsSnapshot = {
      ...twoTabSnapshot(),
      snapshotVersion: 5,
      activeGroupId: 'group-left',
      activeTabId: null
    }
    setMobileSessionSnapshot(runtime, {
      ...incoming,
      publicationEpoch: 'headless:host-owned',
      snapshotVersion: 10,
      activeGroupId: 'group-right',
      activeTabId: 'right-tab::leaf-1',
      tabGroups: [
        { id: 'group-left', activeTabId: 'left-tab', tabOrder: ['left-tab', 'right-tab'] },
        { id: 'group-right', activeTabId: 'right-tab', tabOrder: ['right-tab'] }
      ]
    })
    markRendererPublished(runtime, TEST_WORKTREE_ID, incoming)

    syncRendererSnapshots(runtime, [incoming])

    const stored = getStoredMobileSessionSnapshot(runtime, TEST_WORKTREE_ID)!
    expect(stored.publicationEpoch).toBe('headless:host-owned')
    // Without an active tab the pair cannot be validated: keep the host focus.
    expect(stored.activeGroupId).toBe('group-right')
  })

  it('compares against the digest of the raw frame, not of the merged snapshot', () => {
    const runtime = new OrcaRuntimeService()
    runtime.setNotifier({ moveSessionTab: vi.fn() } as never)
    const preservedAgent = {
      type: 'agent-session' as const,
      id: 'agent-session:preserved',
      title: 'Preserved agent',
      sessionId: 'preserved',
      agent: 'claude',
      isActive: false
    }
    // The host holds an agent-session tab the renderer knows nothing about.
    setMobileSessionSnapshot(runtime, {
      ...twoTabSnapshot(),
      publicationEpoch: 'headless:host-owned',
      snapshotVersion: 10,
      tabGroups: [
        {
          id: 'group-left',
          activeTabId: 'left-tab',
          tabOrder: ['left-tab', 'right-tab', 'agent-session:preserved']
        }
      ],
      tabs: [...twoTabSnapshot().tabs, preservedAgent]
    })
    const rawFrame = { ...twoTabSnapshot(), snapshotVersion: 5 }
    markRendererPublished(runtime, TEST_WORKTREE_ID, rawFrame)

    syncRendererSnapshots(runtime, [rawFrame])
    // First sync merges the preserved agent-session tab into the host layout, so
    // the merged snapshot's digest now differs from the raw frame's.
    expect(
      getStoredMobileSessionSnapshot(runtime, TEST_WORKTREE_ID)!.tabGroups![0]!.tabOrder
    ).toContain('agent-session:preserved')

    syncRendererSnapshots(runtime, [{ ...rawFrame, snapshotVersion: 6 }])

    // If the accepted digest were taken from the merged snapshot, this resend
    // would look authored and hand the layout back to the renderer.
    const stored = getStoredMobileSessionSnapshot(runtime, TEST_WORKTREE_ID)!
    expect(stored.publicationEpoch).toBe('headless:host-owned')
  })
})
