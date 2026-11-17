/**
 * U172 red pin: a freshly started host that already owns a headless layout
 * (persisted split, 2 groups) accepts the desktop renderer's first publication
 * unconditionally, because `acceptedRendererMobileSnapshotByWorktree` is empty
 * in a new process. The user-visible `session.tabs.list` projection must keep
 * the host-authored groups instead of collapsing to the renderer's stale one.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'
import {
  makeThreeTabHeadlessSession,
  syncRendererSnapshots,
  terminalSnapshotTabs
} from './mobile-session-tab-routing-fixtures.spec'

const HOST_GROUP_LEFT = 'host-group-left'
const HOST_GROUP_RIGHT = 'host-group-right'

// The host persisted a 2-group split before it restarted with no desktop window.
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

// A stale desktop frame: same tabs, but it never saw the host split (1 group).
function makeStaleOneGroupRendererFrame(): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer-epoch',
    snapshotVersion: 1,
    activeGroupId: 'renderer-group',
    activeTabId: 'host-tab::leaf',
    activeTabType: 'terminal',
    tabGroups: [
      {
        id: 'renderer-group',
        activeTabId: 'host-tab',
        tabOrder: ['host-tab', 'host-tab-2', 'host-tab-3']
      }
    ],
    tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
  }
}

describe('first-open host layout authority (U172)', () => {
  it('hydrates the persisted 2-group headless layout on a fresh host', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const hostBefore = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(hostBefore.tabGroups?.map((group) => group.id)).toEqual([
      HOST_GROUP_LEFT,
      HOST_GROUP_RIGHT
    ])
    expect(hostBefore.tabGroups?.map((group) => group.tabOrder)).toEqual([
      ['host-tab'],
      ['host-tab-2', 'host-tab-3']
    ])
  })

  it('keeps the host split when a new process accepts the first stale renderer publication', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    // Fresh runtime = cold start: no renderer publication was ever accepted.
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    // The mobile client's `session.tabs.list` projection before the desktop
    // attaches: the host's own 2-group layout.
    const hostBefore = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(hostBefore.tabGroups?.map((group) => group.id)).toEqual([
      HOST_GROUP_LEFT,
      HOST_GROUP_RIGHT
    ])

    // The desktop renderer attaches and publishes its stale 1-group layout.
    syncRendererSnapshots(runtime, [makeStaleOneGroupRendererFrame()])

    // Same projection after the publication: the host layout must survive.
    const afterPublication = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(
      afterPublication.tabGroups?.map((group) => ({
        id: group.id,
        tabOrder: group.tabOrder
      }))
    ).toEqual([
      { id: HOST_GROUP_LEFT, tabOrder: ['host-tab'] },
      { id: HOST_GROUP_RIGHT, tabOrder: ['host-tab-2', 'host-tab-3'] }
    ])
  })

  it('lets a genuinely authored layout take over after the first-open baseline', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    syncRendererSnapshots(runtime, [makeStaleOneGroupRendererFrame()])

    // The renderer authors a real change next: same generation, new digest.
    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-epoch',
        snapshotVersion: 2,
        activeGroupId: 'renderer-left',
        activeTabId: 'host-tab::leaf',
        activeTabType: 'terminal',
        tabGroups: [
          { id: 'renderer-left', activeTabId: 'host-tab', tabOrder: ['host-tab', 'host-tab-2'] },
          { id: 'renderer-right', activeTabId: 'host-tab-3', tabOrder: ['host-tab-3'] }
        ],
        tabGroupLayout: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'renderer-left' },
          second: { type: 'leaf', groupId: 'renderer-right' }
        },
        tabs: terminalSnapshotTabs(['host-tab', 'host-tab-2', 'host-tab-3'])
      }
    ])

    const afterAuthored = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(afterAuthored.tabGroups?.map((group) => group.id)).toEqual([
      'renderer-left',
      'renderer-right'
    ])
    expect(afterAuthored.tabGroupLayout).toMatchObject({ type: 'split', direction: 'vertical' })
  })
})
