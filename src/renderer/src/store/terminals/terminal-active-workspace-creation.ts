import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { isCloudSessionEnvironmentId } from '@/lib/cloud-session-environment-membership'
import { markUserInitiatedTerminalCreate } from '@/runtime/web-session-user-initiated-create'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { isWebClientLocation } from '@/lib/web-client-location'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createActiveWorkspaceTerminalActions(
  _set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'openNewTerminalTabInActiveWorkspace'> {
  return {
    openNewTerminalTabInActiveWorkspace: async (groupId) => {
      const state = get()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        return
      }
      const workspaceScope = parseWorkspaceKey(worktreeId)
      const worktreeRoute =
        worktreeId === FLOATING_TERMINAL_WORKTREE_ID || workspaceScope?.type === 'folder'
          ? null
          : resolveWorktreeOperationRouteResult(state, worktreeId)
      if (worktreeRoute && worktreeRoute.kind !== 'resolved') {
        return
      }
      const runtimeEnvironmentId = worktreeRoute
        ? worktreeRoute.route.runtimeEnvironmentId
        : getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      // Why: a cloud host refuses session.tabs.* (O1 F7), so its terminals stay client-owned
      // and the pane spawns them with terminal.create.
      if (
        runtimeEnvironmentId &&
        !isCloudSessionEnvironmentId(state.runtimeEnvironments, runtimeEnvironmentId)
      ) {
        const { createWebRuntimeSessionTerminal } = await import('@/runtime/web-runtime-session')
        await createWebRuntimeSessionTerminal({
          worktreeId,
          environmentId: runtimeEnvironmentId,
          targetGroupId: groupId,
          activate: true
        })
        return
      }
      // Why: a paired web client's tabs come from the host mirror, so a local tab
      // would race it. A cloud session has no host-side creation path (its host
      // refuses session.tabs.*) — client-owned tabs are the only way it gets a
      // second terminal, so the guard must not swallow the create (U118).
      if (
        isWebClientLocation() &&
        !isCloudSessionEnvironmentId(state.runtimeEnvironments, runtimeEnvironmentId) &&
        worktreeId !== FLOATING_TERMINAL_WORKTREE_ID
      ) {
        return
      }
      const terminal = get().createTab(worktreeId, groupId)
      // Why: a cloud session's client-owned pane spawns through terminal.create; only this click
      // may persist the new tab as the host's selection when that create returns (U153).
      markUserInitiatedTerminalCreate(terminal.id)
      get().setActiveTab(terminal.id)
      get().setActiveTabType('terminal', worktreeId)
      const latest = get()
      const currentTerminals = latest.tabsByWorktree[worktreeId] ?? []
      const currentEditors = latest.openFiles.filter((file) => file.worktreeId === worktreeId)
      const currentBrowsers = latest.browserTabsByWorktree[worktreeId] ?? []
      const stored = latest.tabBarOrderByWorktree[worktreeId]
      const validIds = new Set([
        ...currentTerminals.map((tab) => tab.id),
        ...currentEditors.map((file) => file.id),
        ...currentBrowsers.map((tab) => tab.id)
      ])
      const base = (stored ?? []).filter((id) => validIds.has(id))
      const inBase = new Set(base)
      for (const id of validIds) {
        if (!inBase.has(id)) {
          base.push(id)
        }
      }
      // Why: Cmd+J shares the titlebar-button creation path, so append the new terminal after mixed editor/browser tabs, not first.
      get().setTabBarOrder(worktreeId, [...base.filter((id) => id !== terminal.id), terminal.id])
      focusTerminalTabSurface(terminal.id)
    }
  }
}
