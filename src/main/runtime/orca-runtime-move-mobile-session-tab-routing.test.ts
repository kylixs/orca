import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
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

function markRendererPublished(runtime: OrcaRuntimeService, worktree: string): void {
  // Only an authoritative-window publication makes a forwarded move applicable.
  ;(
    runtime as unknown as {
      acceptedRendererMobileSnapshotByWorktree: Map<string, unknown>
    }
  ).acceptedRendererMobileSnapshotByWorktree.set(worktree, {
    publicationEpoch: 'renderer-epoch',
    rendererVersion: 1,
    rendererTabCount: 2,
    rendererTabIdentityKeys: new Set(['left-tab::leaf-1', 'right-tab::leaf-1'])
  })
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
    markRendererPublished(runtime, TEST_WORKTREE_ID)
    setMobileSessionSnapshot(runtime, twoTabSnapshot())
    const before = structuredClone(twoTabSnapshot())

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
    markRendererPublished(runtime, TEST_WORKTREE_ID)
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
    markRendererPublished(runtime, TEST_WORKTREE_ID)
    const beforeListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
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

  it('does not apply a headless fallback when the window applied the move', async () => {
    const session = makeTwoTabHeadlessSession()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const moveSessionTab = vi.fn().mockResolvedValue(true)
    runtime.setNotifier({ moveSessionTab } as never)
    markRendererPublished(runtime, TEST_WORKTREE_ID)
    const beforeListed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
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
