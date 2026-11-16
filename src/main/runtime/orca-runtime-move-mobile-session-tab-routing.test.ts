import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
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
            id: 'headless-terminals:wt',
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
      targetGroupId: 'headless-terminals:wt',
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

  it('reports moved:false when the published window cannot apply the move', async () => {
    const runtime = new OrcaRuntimeService()
    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)
    markRendererPublished(runtime, TEST_WORKTREE_ID)
    setMobileSessionSnapshot(runtime, twoTabSnapshot())

    await expect(
      runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
        kind: 'move-to-group',
        tabId: 'right-tab',
        targetGroupId: 'group-left'
      })
    ).resolves.toEqual({ moved: false })

    const after = (
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
      }
    ).mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)
    expect(after?.snapshotVersion).toBe(4)
    expect(after?.tabGroups).toHaveLength(1)
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
})
