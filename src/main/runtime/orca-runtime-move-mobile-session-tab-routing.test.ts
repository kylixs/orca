import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
import { getMobileSessionTabGroupLayoutSignature } from './mobile-session-tab-group-layout-signature'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

function setMobileSessionSnapshot(
  runtime: OrcaRuntimeService,
  snapshot: RuntimeMobileSessionTabsSnapshot
): void {
  ;(
    runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
  ).mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
}

function markRendererPublished(
  runtime: OrcaRuntimeService,
  worktree: string,
  layout: Pick<RuntimeMobileSessionTabsSnapshot, 'tabGroups' | 'tabGroupLayout'>
): void {
  // Only an authoritative-window publication whose group layout still matches
  // the host makes a forwarded move applicable.
  ;(
    runtime as unknown as {
      acceptedRendererMobileSnapshotByWorktree: Map<string, unknown>
    }
  ).acceptedRendererMobileSnapshotByWorktree.set(worktree, {
    publicationEpoch: 'renderer-epoch',
    rendererVersion: 1,
    rendererTabCount: 2,
    rendererTabIdentityKeys: new Set(['left-tab::leaf-1', 'right-tab::leaf-1']),
    rendererTabGroupLayoutSignature: getMobileSessionTabGroupLayoutSignature(layout)
  })
}

function syncRendererSnapshots(
  runtime: OrcaRuntimeService,
  snapshots: RuntimeMobileSessionTabsSnapshot[],
  unchangedWorktreeIds?: string[]
): void {
  ;(
    runtime as unknown as {
      syncMobileSessionTabs(
        snapshots: RuntimeMobileSessionTabsSnapshot[],
        unchangedWorktreeIds?: string[]
      ): Set<string>
    }
  ).syncMobileSessionTabs(snapshots, unchangedWorktreeIds)
}

function twoTabSnapshot(worktree = TEST_WORKTREE_ID): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer-epoch',
    snapshotVersion: 4,
    activeGroupId: 'group-left',
    activeTabId: 'left-tab::leaf-1',
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group-left', activeTabId: 'left-tab', tabOrder: ['left-tab', 'right-tab'] }],
    tabs: [
      {
        type: 'terminal',
        id: 'left-tab::leaf-1',
        parentTabId: 'left-tab',
        leafId: 'leaf-1',
        title: 'Left',
        isActive: true
      },
      {
        type: 'terminal',
        id: 'right-tab::leaf-1',
        parentTabId: 'right-tab',
        leafId: 'leaf-1',
        title: 'Right',
        isActive: false
      }
    ]
  }
}

function makeTwoTabHeadlessSession() {
  return makeWorkspaceSessionWithHeadlessTerminal({
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: [
        {
          id: 'host-tab',
          ptyId: 'persisted-pty',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Left',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        },
        {
          id: 'host-tab-2',
          ptyId: 'persisted-pty-2',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Right',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 2
        }
      ]
    },
    terminalLayoutsByTabId: {
      'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty' }),
      'host-tab-2': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty-2' })
    },
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        {
          id: getHeadlessMobileSessionGroupId(TEST_WORKTREE_ID),
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: 'host-tab',
          tabOrder: ['host-tab', 'host-tab-2']
        }
      ]
    }
  })
}

function makeThreeTabHeadlessSession() {
  return makeWorkspaceSessionWithHeadlessTerminal({
    tabsByWorktree: {
      [TEST_WORKTREE_ID]: ['host-tab', 'host-tab-2', 'host-tab-3'].map((id, index) => ({
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
    terminalLayoutsByTabId: Object.fromEntries(
      ['host-tab', 'host-tab-2', 'host-tab-3'].map((id, index) => [
        id,
        makeHeadlessTerminalLayout({
          [HEADLESS_LEAF_ID]: `persisted-pty${index === 0 ? '' : `-${index + 1}`}`
        })
      ])
    ),
    tabGroups: {
      [TEST_WORKTREE_ID]: [
        {
          id: getHeadlessMobileSessionGroupId(TEST_WORKTREE_ID),
          worktreeId: TEST_WORKTREE_ID,
          activeTabId: 'host-tab',
          tabOrder: ['host-tab', 'host-tab-2', 'host-tab-3']
        }
      ]
    }
  })
}

describe('moveMobileSessionTab ownership routing', () => {
  it('applies the move headlessly when the window never published the worktree', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'persisted-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Left',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'host-tab-2',
            ptyId: 'persisted-pty-2',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Right',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty' }),
        'host-tab-2': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'persisted-pty-2' })
      },
      tabGroups: {
        [TEST_WORKTREE_ID]: [
          {
            id: getHeadlessMobileSessionGroupId(TEST_WORKTREE_ID),
            worktreeId: TEST_WORKTREE_ID,
            activeTabId: 'host-tab',
            tabOrder: ['host-tab', 'host-tab-2']
          }
        ]
      }
    })
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const moveSessionTab = vi.fn()
    runtime.setNotifier({ moveSessionTab } as never)

    const result = await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: 'host-tab-2',
      // Why: target the group the hydrated single-group snapshot actually names.
      targetGroupId: getHeadlessMobileSessionGroupId(TEST_WORKTREE_ID),
      splitDirection: 'right'
    })

    expect(result).toEqual({ moved: true })
    expect(moveSessionTab).not.toHaveBeenCalled()
    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listed.tabGroups).toHaveLength(2)
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]).toHaveLength(2)
  })

  it('forwards to the window when it published the worktree and reports applied', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn().mockResolvedValue(true)
    runtime.setNotifier({ moveSessionTab } as never)
    const snapshot = twoTabSnapshot()
    setMobileSessionSnapshot(runtime, snapshot)
    markRendererPublished(runtime, TEST_WORKTREE_ID, snapshot)
    const before = structuredClone(snapshot)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'split',
        tabId: 'right-tab',
        targetGroupId: 'group-left',
        splitDirection: 'right'
      })
    ).resolves.toEqual({ moved: true })

    expect(moveSessionTab).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      kind: 'split',
      tabId: 'right-tab',
      targetGroupId: 'group-left',
      splitDirection: 'right'
    })
    // The renderer owns this layout; main must not fork it.
    const after = (
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      }
    ).mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
    expect(after?.snapshotVersion).toBe(before.snapshotVersion)
    expect(after?.tabGroups).toEqual(before.tabGroups)
  })

  it('reports moved:false when a published window refuses and headless cannot apply it', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)
    const snapshot = twoTabSnapshot()
    // Ghost group: visible in tabGroups (so forwarding accepts the target) but
    // absent from the layout tree (so the host must refuse it).
    snapshot.tabGroups = [
      ...(snapshot.tabGroups ?? []),
      { id: 'ghost-group', activeTabId: 'ghost-tab', tabOrder: ['ghost-tab'] }
    ]
    snapshot.tabs = [
      ...snapshot.tabs,
      {
        type: 'file',
        id: 'ghost-tab',
        title: 'Ghost',
        filePath: 'ghost.md',
        relativePath: 'ghost.md',
        language: 'markdown',
        isDirty: false,
        isActive: false
      }
    ]
    snapshot.tabGroupLayout = { type: 'leaf', groupId: 'group-left' }
    setMobileSessionSnapshot(runtime, snapshot)
    markRendererPublished(runtime, TEST_WORKTREE_ID, snapshot)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: 'right-tab',
        targetGroupId: 'ghost-group'
      })
    ).resolves.toEqual({ moved: false })

    expect(moveSessionTab).toHaveBeenCalledTimes(1)
    const after = (
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      }
    ).mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
    expect(after?.snapshotVersion).toBe(4)
    expect(after?.tabGroups).toEqual(snapshot.tabGroups)
    expect(after?.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'group-left' })
  })

  it('falls back headlessly and persists when the published window refuses the move', async () => {
    const session = makeTwoTabHeadlessSession()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)
    const beforeListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    markRendererPublished(runtime, TEST_WORKTREE_ID, beforeListed)
    const groupId = beforeListed.tabGroups![0]!.id

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'split',
        tabId: 'host-tab-2',
        targetGroupId: groupId,
        splitDirection: 'right'
      })
    ).resolves.toEqual({ moved: true })

    expect(moveSessionTab).toHaveBeenCalledTimes(1)
    const afterListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterListed.tabGroups).toHaveLength(2)
    expect(afterListed.snapshotVersion).toBeGreaterThan(beforeListed.snapshotVersion)
    // The fallback landed on disk, not just in memory.
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]).toHaveLength(2)
  })

  it('keeps a headless split when the next move would reach a stale renderer snapshot', async () => {
    const session = makeThreeTabHeadlessSession()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    // The window refuses the split (it is not focused on this worktree), so v2's
    // fallback lands it headlessly and the renderer's accepted frame stays one group.
    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)
    const initial = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const sourceGroupId = initial.tabGroups![0]!.id
    markRendererPublished(runtime, TEST_WORKTREE_ID, initial)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'split',
        tabId: 'host-tab-2',
        targetGroupId: sourceGroupId,
        splitDirection: 'right'
      })
    ).resolves.toEqual({ moved: true })
    expect(moveSessionTab).toHaveBeenCalledTimes(1)
    const afterSplit = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterSplit.tabGroups).toHaveLength(2)
    const splitGroup = afterSplit.tabGroups!.find((group) =>
      group.tabOrder.includes('host-tab-2')
    )!
    // A stale renderer would happily apply this move to its one-group layout and
    // ack success, so the test proves the host never asks it.
    moveSessionTab.mockClear()
    moveSessionTab.mockResolvedValue(true)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: 'host-tab-3',
        targetGroupId: splitGroup.id
      })
    ).resolves.toEqual({ moved: true })

    expect(moveSessionTab).not.toHaveBeenCalled()
    const afterMove = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterMove.tabGroups).toHaveLength(2)
    const movedGroup = afterMove.tabGroups!.find((group) =>
      group.tabOrder.includes('host-tab-3')
    )!
    expect(movedGroup.id).toBe(splitGroup.id)
    expect(afterMove.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
    // The split survived on disk, not just in the in-memory projection.
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]).toHaveLength(2)
  })

  it('forwards again once the renderer republishes the host split layout', async () => {
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
    const splitGroup = afterSplit.tabGroups!.find((group) =>
      group.tabOrder.includes('host-tab-2')
    )!
    // Simulates the renderer observing the host broadcast: the accepted snapshot
    // now carries the two-group layout.
    markRendererPublished(runtime, TEST_WORKTREE_ID, afterSplit)
    moveSessionTab.mockClear()
    moveSessionTab.mockResolvedValue(true)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: 'host-tab-3',
        targetGroupId: splitGroup.id
      })
    ).resolves.toEqual({ moved: true })

    expect(moveSessionTab).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale renderer republish collapse a host-authored split', async () => {
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
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabGroups).toHaveLength(
      2
    )
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
      tabs: ['host-tab', 'host-tab-2', 'host-tab-3'].map((id, index) => ({
        type: 'terminal' as const,
        id: `${id}::leaf`,
        parentTabId: id,
        leafId: 'leaf',
        title: id,
        isActive: index === 0
      }))
    })

    // The renderer's next graph sync replays the one-group frame it never updated.
    syncRendererSnapshots(runtime, [staleFrame(50)])
    const afterStale = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterStale.tabGroups).toHaveLength(2)
    expect(afterStale.tabGroupLayout).toMatchObject({ type: 'split', direction: 'horizontal' })

    // The unchanged branch must neither request a resync nor drop the accepted
    // renderer publication, or the next replay would be accepted unconditionally.
    syncRendererSnapshots(runtime, [], [TEST_WORKTREE_ID])
    syncRendererSnapshots(runtime, [staleFrame(51)])
    const afterSecondReplay = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterSecondReplay.tabGroups).toHaveLength(2)
    expect(afterSecondReplay.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
  })

  it('lets a renderer that authors a different layout take the groups back', async () => {
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

    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-authored',
        snapshotVersion: 60,
        activeGroupId: 'renderer-a',
        activeTabId: 'host-tab::leaf',
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: 'renderer-a',
            activeTabId: 'host-tab',
            tabOrder: ['host-tab', 'host-tab-2']
          },
          { id: 'renderer-b', activeTabId: 'host-tab-3', tabOrder: ['host-tab-3'] }
        ],
        tabGroupLayout: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'renderer-a' },
          second: { type: 'leaf', groupId: 'renderer-b' }
        },
        tabs: ['host-tab', 'host-tab-2', 'host-tab-3'].map((id, index) => ({
          type: 'terminal' as const,
          id: `${id}::leaf`,
          parentTabId: id,
          leafId: 'leaf',
          title: id,
          isActive: index === 0
        }))
      }
    ])

    const afterAuthored = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterAuthored.tabGroups?.map((group) => group.id)).toEqual([
      'renderer-a',
      'renderer-b'
    ])
    expect(afterAuthored.tabGroupLayout).toMatchObject({
      type: 'split',
      direction: 'vertical'
    })
  })

  it('does not treat preserved host tabs as a stale renderer layout', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn().mockResolvedValue(true)
    runtime.setNotifier({ moveSessionTab } as never)
    markRendererPublished(runtime, TEST_WORKTREE_ID, twoTabSnapshot())
    const withPreservedTab: RuntimeMobileSessionTabsSnapshot = {
      ...twoTabSnapshot(),
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
    }
    setMobileSessionSnapshot(runtime, withPreservedTab)

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

  it('does not apply a headless fallback when the window applied the move', async () => {
    const session = makeTwoTabHeadlessSession()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const moveSessionTab = vi.fn().mockResolvedValue(true)
    runtime.setNotifier({ moveSessionTab } as never)
    const beforeListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    markRendererPublished(runtime, TEST_WORKTREE_ID, beforeListed)
    const groupId = beforeListed.tabGroups![0]!.id

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'split',
        tabId: 'host-tab-2',
        targetGroupId: groupId,
        splitDirection: 'right'
      })
    ).resolves.toEqual({ moved: true })

    expect(moveSessionTab).toHaveBeenCalledTimes(1)
    const afterListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    // The renderer owns the layout; the host must not write a duplicate split.
    expect(afterListed.snapshotVersion).toBe(beforeListed.snapshotVersion)
    expect(afterListed.tabGroups).toHaveLength(1)
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]).toHaveLength(1)
  })

  it('rejects a move for a retired surface without creating a group', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn().mockResolvedValue(true)
    runtime.setNotifier({ moveSessionTab } as never)
    setMobileSessionSnapshot(runtime, twoTabSnapshot())

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'split',
        tabId: 'retired-tab',
        targetGroupId: 'group-left',
        splitDirection: 'right'
      })
    ).rejects.toThrow('tab_not_found')

    expect(moveSessionTab).not.toHaveBeenCalled()
    const after = (
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      }
    ).mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
    expect(after?.tabGroups).toHaveLength(1)
  })

  it('reports moved:false for a headless move-to-group whose target group is gone', async () => {
    const session = makeTwoTabHeadlessSession()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const beforeListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const beforePersisted = structuredClone(getSession().tabGroups)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: 'host-tab-2',
        targetGroupId: 'deleted-group'
      })
    ).resolves.toEqual({ moved: false })

    const afterListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterListed.snapshotVersion).toBe(beforeListed.snapshotVersion)
    expect(afterListed.tabGroups).toEqual(beforeListed.tabGroups)
    // Nothing was persisted: the stored groups still describe one group.
    expect(getSession().tabGroups).toEqual(beforePersisted)
    expect(getSession().tabGroups?.[TEST_WORKTREE_ID]).toHaveLength(1)
  })

  it('reports moved:false for a headless split whose target group is gone', async () => {
    const session = makeTwoTabHeadlessSession()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const beforeListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const beforePersisted = structuredClone(getSession().tabGroups)

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'split',
        tabId: 'host-tab-2',
        targetGroupId: 'deleted-group',
        splitDirection: 'right'
      })
    ).resolves.toEqual({ moved: false })

    const afterListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    // No orphan group outside the layout tree and no version bump.
    expect(afterListed.snapshotVersion).toBe(beforeListed.snapshotVersion)
    expect(afterListed.tabGroups).toHaveLength(1)
    expect(afterListed.tabGroupLayout).toBeUndefined()
    expect(getSession().tabGroups).toEqual(beforePersisted)
  })
})
