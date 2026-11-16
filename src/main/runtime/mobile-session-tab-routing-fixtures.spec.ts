import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'
import { getMobileSessionSnapshotTabIdentityKeys } from './mobile-session-tab-merge'
import {
  getMobileSessionAuthoredLayoutDigest,
  getMobileSessionTabGroupLayoutSignature
} from './mobile-session-tab-group-layout-signature'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

export function setMobileSessionSnapshot(
  runtime: OrcaRuntimeService,
  snapshot: RuntimeMobileSessionTabsSnapshot
): void {
  ;(
    runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
  ).mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
}

export function getStoredMobileSessionSnapshot(
  runtime: OrcaRuntimeService,
  worktree: string
): RuntimeMobileSessionTabsSnapshot | undefined {
  return (
    runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    }
  ).mobileSessionTabsByWorktree.get(worktree)
}

export function markRendererPublished(
  runtime: OrcaRuntimeService,
  worktree: string,
  layout: Pick<RuntimeMobileSessionTabsSnapshot, 'tabGroups' | 'tabGroupLayout' | 'tabs'>
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
    rendererTabCount: layout.tabs.length,
    rendererTabIdentityKeys: new Set(
      layout.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
    ),
    rendererTabGroupLayoutSignature: getMobileSessionTabGroupLayoutSignature(layout),
    rendererAuthoredLayoutDigest: getMobileSessionAuthoredLayoutDigest(layout)
  })
}

export function syncRendererSnapshots(
  runtime: OrcaRuntimeService,
  snapshots: RuntimeMobileSessionTabsSnapshot[],
  unchangedWorktreeIds?: string[],
  resyncWorktreeIds = new Set<string>()
): Set<string> {
  ;(
    runtime as unknown as {
      syncMobileSessionTabs(
        snapshots: RuntimeMobileSessionTabsSnapshot[],
        unchangedWorktreeIds?: string[],
        resyncWorktreeIds?: Set<string>
      ): Set<string>
    }
  ).syncMobileSessionTabs(snapshots, unchangedWorktreeIds, resyncWorktreeIds)
  return resyncWorktreeIds
}

export function terminalSnapshotTabs(ids: string[]): RuntimeMobileSessionTabsSnapshot['tabs'] {
  return ids.map((id, index) => ({
    type: 'terminal' as const,
    id: `${id}::leaf`,
    parentTabId: id,
    leafId: 'leaf',
    title: id,
    isActive: index === 0
  }))
}

export function twoTabSnapshot(worktree = TEST_WORKTREE_ID): RuntimeMobileSessionTabsSnapshot {
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

export function makeThreeTabHeadlessSession() {
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
