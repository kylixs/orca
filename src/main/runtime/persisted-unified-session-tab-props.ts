import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

export function getPersistedUnifiedSessionTabProps(
  session: WorkspaceSessionState | null | undefined,
  worktreeId: string,
  tabId: string
): Pick<Tab, 'color' | 'isPinned'> | null {
  const tab = session?.unifiedTabs?.[worktreeId]?.find(
    (candidate) => candidate.id === tabId || candidate.entityId === tabId
  )
  return tab ? { color: tab.color, isPinned: tab.isPinned } : null
}
