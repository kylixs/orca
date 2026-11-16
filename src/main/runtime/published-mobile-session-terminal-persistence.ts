import type { TerminalLayoutSnapshot, TerminalTab } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  cloneTerminalLayoutSnapshot,
  collectPersistedTerminalLeafIds
} from './mobile-session-layout-projection'
import { advanceTerminalTopologyRevision } from '../persistence/terminal-topology/terminal-topology-membership'

export type PublishedMobileSessionTerminalPersistenceInput = {
  session: WorkspaceSessionState
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  title: string
  /** Layout published for the tab; carries the split topology and its PTY handles. */
  parentLayout: TerminalLayoutSnapshot
  activation?: boolean
  startupCwd?: string
  launchAgent?: TuiAgent
  viewMode?: 'terminal' | 'chat'
  incarnationId?: string | null
}

/**
 * Durably records a headless/cloud-created terminal tab in the workspace session.
 * Why: `storeMobileSessionSnapshot` is memory-only, so a host restart dropped the
 * client's tabs until hydration learned them from this row. Returns the same
 * session object when nothing changed, so idempotent republishes don't rewrite.
 */
export function persistPublishedMobileSessionTerminalTab(
  input: PublishedMobileSessionTerminalPersistenceInput
): WorkspaceSessionState | null {
  const { session, worktreeId, tabId, leafId, ptyId, parentLayout, activation, incarnationId } =
    input
  const persistedTabs = session.tabsByWorktree[worktreeId] ?? []
  const persistedTab = persistedTabs.find((tab) => tab.id === tabId)
  const tabsChanged = !persistedTab || persistedTab.ptyId !== ptyId
  const nextTabs = tabsChanged
    ? persistedTab
      ? persistedTabs.map((tab) => (tab.id === tabId ? { ...tab, ptyId } : tab))
      : [...persistedTabs, buildPublishedTerminalTab(persistedTabs, input)]
    : persistedTabs
  const nextLayouts = buildPublishedTerminalLayouts(session, tabId, leafId, ptyId, parentLayout)
  const paneKey = `${tabId}:${leafId}`
  const nextIncarnations =
    incarnationId && session.terminalPtyIncarnationsByPaneKey?.[paneKey] !== incarnationId
      ? {
          ...session.terminalPtyIncarnationsByPaneKey,
          [paneKey]: incarnationId
        }
      : session.terminalPtyIncarnationsByPaneKey
  const nextActiveTabId = activation && session.activeTabId !== tabId ? tabId : session.activeTabId
  const nextActiveTabIdByWorktree =
    activation && session.activeTabIdByWorktree?.[worktreeId] !== tabId
      ? { ...session.activeTabIdByWorktree, [worktreeId]: tabId }
      : session.activeTabIdByWorktree

  if (
    !tabsChanged &&
    nextLayouts === session.terminalLayoutsByTabId &&
    nextIncarnations === session.terminalPtyIncarnationsByPaneKey &&
    nextActiveTabIdByWorktree === session.activeTabIdByWorktree &&
    nextActiveTabId === session.activeTabId
  ) {
    return null
  }
  const next: WorkspaceSessionState = {
    ...session,
    activeTabId: nextActiveTabId,
    ...(nextActiveTabIdByWorktree ? { activeTabIdByWorktree: nextActiveTabIdByWorktree } : {}),
    tabsByWorktree: tabsChanged
      ? { ...session.tabsByWorktree, [worktreeId]: nextTabs }
      : session.tabsByWorktree,
    terminalLayoutsByTabId: nextLayouts,
    ...(nextIncarnations ? { terminalPtyIncarnationsByPaneKey: nextIncarnations } : {})
  }
  // Why: membership rebasing treats a prior close's topology revision as authoritative,
  // so a spawn that does not advance it is silently dropped after any close in the repo.
  return tabsChanged ? advanceTerminalTopologyRevision(next, worktreeId) : next
}

function buildPublishedTerminalTab(
  persistedTabs: readonly TerminalTab[],
  input: PublishedMobileSessionTerminalPersistenceInput
): TerminalTab {
  const { worktreeId, tabId, ptyId, title, startupCwd, launchAgent, viewMode } = input
  const sortOrder = persistedTabs.reduce((max, tab) => Math.max(max, tab.sortOrder), -1) + 1
  return {
    id: tabId,
    ptyId,
    worktreeId,
    title,
    defaultTitle: title,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: Date.now(),
    ...(startupCwd ? { startupCwd } : {}),
    ...(launchAgent ? { launchAgent } : {}),
    ...(viewMode ? { viewMode } : {})
  }
}

function buildPublishedTerminalLayouts(
  session: WorkspaceSessionState,
  tabId: string,
  leafId: string,
  ptyId: string,
  parentLayout: TerminalLayoutSnapshot
): WorkspaceSessionState['terminalLayoutsByTabId'] {
  const existing = session.terminalLayoutsByTabId?.[tabId]
  if (!existing) {
    return {
      ...session.terminalLayoutsByTabId,
      [tabId]: cloneTerminalLayoutSnapshot(parentLayout)
    }
  }
  // Why: a split republishes a layout the persisted row has not seen. Trust the
  // live topology there; otherwise keep the stored tree and only refresh the handle.
  if (
    !collectPersistedTerminalLeafIds(existing).includes(leafId) ||
    existing.ptyIdsByLeafId?.[leafId] !== ptyId
  ) {
    return {
      ...session.terminalLayoutsByTabId,
      [tabId]: cloneTerminalLayoutSnapshot(parentLayout)
    }
  }
  return session.terminalLayoutsByTabId
}
