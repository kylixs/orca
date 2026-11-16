import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export type ClientSessionTabSelection = {
  activeTabId: string | null
  activeGroupId: string | null
  activeTabIdByGroupId: Readonly<Record<string, string>>
}

export function topLevelTabId(tab: RuntimeMobileSessionClientTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

export function activateClientSessionTabSelection(
  snapshot: RuntimeMobileSessionTabsResult,
  selection: ClientSessionTabSelection,
  activeTabId: string
): ClientSessionTabSelection {
  const activeTab = snapshot.tabs.find((tab) => tab.id === activeTabId)
  if (!activeTab) {
    return selection
  }
  const activeTopLevelTabId = topLevelTabId(activeTab)
  const activeGroup = snapshot.tabGroups?.find((group) =>
    group.tabOrder.includes(activeTopLevelTabId)
  )
  return {
    activeTabId,
    activeGroupId: activeGroup?.id ?? selection.activeGroupId,
    activeTabIdByGroupId: activeGroup
      ? { ...selection.activeTabIdByGroupId, [activeGroup.id]: activeTopLevelTabId }
      : selection.activeTabIdByGroupId
  }
}

/** Why U162: the durable host active, leaf preferred, validated against the live tabs. */
export function resolveDurableActiveTabId(
  session: WorkspaceSessionState | null | undefined,
  snapshot: RuntimeMobileSessionTabsResult
): string | null {
  const { worktree: worktreeId, tabs } = snapshot
  const topLevelId = session?.activeTabIdByWorktree?.[worktreeId]
  if (!session || !topLevelId) {
    return null
  }
  const activeLeafId = session.terminalLayoutsByTabId?.[topLevelId]?.activeLeafId
  const match =
    (activeLeafId
      ? tabs.find(
          (tab) =>
            tab.id === activeLeafId ||
            (tab.type === 'terminal' &&
              tab.parentTabId === topLevelId &&
              tab.leafId === activeLeafId)
        )
      : undefined) ??
    tabs.find((tab) => tab.id === topLevelId) ??
    tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === topLevelId)
  return match?.id ?? null
}

/** The durable resume selection, or null when the device has its own persisted selection. */
export function resumeDurableClientSessionTabSelection(
  snapshot: RuntimeMobileSessionTabsResult,
  selection: ClientSessionTabSelection,
  durableActiveTabId: string | null | undefined
): ClientSessionTabSelection | null {
  return durableActiveTabId && snapshot.tabs.some((tab) => tab.id === durableActiveTabId)
    ? activateClientSessionTabSelection(snapshot, selection, durableActiveTabId)
    : null
}
