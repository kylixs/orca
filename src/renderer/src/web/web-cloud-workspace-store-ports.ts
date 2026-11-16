import type { PreloadApi } from '../../../preload/api-types'
import { toRuntimeExecutionHostId, getRepoExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { useAppStore } from '../store'
import { requestHostLayoutAdoption } from '../runtime/web-session-tabs-sync/host-layout-adoption'
import { waitForHostSessionMirrorHydration } from '../runtime/host-session-mirror-hydration'
import { getPathDisplayName } from '../store/terminals/workspace-terminal-placeholders'
import { cloudSessionProjectDisplayName } from './web-cloud-connect'
import { readStoredWebRuntimeEnvironment } from './web-runtime-environment'
import { subscribeWebRuntimeStatus } from './preload-api/web-runtime-session'

/**
 * The store-side half of the cloud workspace bootstrap (W13): how the phases
 * reach `window.api` and the app store. The bootstrap module owns when each
 * phase runs; this module owns what touching the store and the web namespace
 * actually does, so suites can inject both.
 */

export type WebCloudWorkspaceBootstrapApi = NonNullable<Partial<PreloadApi>['cloudWorkspace']>

export type WebCloudWorkspaceBootstrapPorts = {
  /** The web-only namespace; null on desktop and for hosts without it. */
  api: () => WebCloudWorkspaceBootstrapApi | null
  environment: () => { id: string; name: string } | null
  /** Seeding mutates store state the boot chain still owns; wait for it to land. */
  hydrationSettled: () => boolean
  /** Transport transitions; the one reconnect allowance reads them. */
  subscribeTransport: (
    listener: (transport: RuntimeHostStatusSnapshot['transport']) => void
  ) => () => void
  /** Idempotent by (executionHostId, path) — the desktop cloud entry's rule. */
  ensureRepoRow: (input: {
    path: string
    displayName: string
    runtimeEnvironmentId: string
  }) => Promise<Repo | null>
  worktreesForRepo: (repoId: string) => readonly Worktree[]
  fetchWorktrees: (repoId: string, executionHostId: ExecutionHostId) => Promise<unknown>
  /**
   * Resolves once the host's restored tab inventory has been applied to the
   * store (or the wait times out). Without it a fresh page seeds a terminal
   * before the restored tabs land and renders an extra tab.
   */
  waitForSessionTabsRestore: (input: { environmentId: string; worktreeId: string }) => Promise<void>
  activateWorkspace: (input: {
    worktreeId: string
    executionHostId: ExecutionHostId
    /** §4.3: only a `file:read` grant may reveal the explorer (and its file RPCs). */
    mountExplorer: boolean
  }) => void
}

/** The sidebar row shows the project name, falling back to the checkout's own. */
export function cloudWorkspaceProjectDisplayName(
  environmentName: string,
  projectRoot: string
): string {
  const name = cloudSessionProjectDisplayName(environmentName).trim()
  return name || getPathDisplayName(projectRoot, projectRoot)
}

/** A restored inventory normally lands in well under a second; a host that never publishes must not wedge activation. */
const SESSION_TABS_RESTORE_WAIT_MS = 5_000

export function defaultWebCloudWorkspacePorts(): WebCloudWorkspaceBootstrapPorts {
  return {
    api: () => window.api?.cloudWorkspace ?? null,
    environment: () => {
      const environment = readStoredWebRuntimeEnvironment()
      return environment ? { id: environment.id, name: environment.name } : null
    },
    hydrationSettled: () => useAppStore.getState().hydrationSucceeded,
    subscribeTransport: (listener) =>
      subscribeWebRuntimeStatus((snapshot) => listener(snapshot.transport)),
    ensureRepoRow: async ({ path, displayName, runtimeEnvironmentId }) => {
      const state = useAppStore.getState()
      const executionHostId = toRuntimeExecutionHostId(runtimeEnvironmentId)
      const existing = state.repos.find(
        (repo) => getRepoExecutionHostId(repo) === executionHostId && repo.path === path
      )
      if (existing) {
        return existing
      }
      return state.addRepoPath(path, 'git', { runtimeEnvironmentId, displayName })
    },
    worktreesForRepo: (repoId) => useAppStore.getState().worktreesByRepo[repoId] ?? [],
    fetchWorktrees: (repoId, executionHostId) =>
      useAppStore.getState().fetchWorktrees(repoId, { executionHostId }),
    waitForSessionTabsRestore: ({ environmentId, worktreeId }) =>
      waitForHostSessionMirrorHydration(environmentId, worktreeId, SESSION_TABS_RESTORE_WAIT_MS),
    activateWorkspace: ({ worktreeId, executionHostId, mountExplorer }) => {
      const state = useAppStore.getState()
      // Why an explicit entry request: re-entering the same checkout keeps activeWorktreeId, so
      // the tab stream does not reinstall and the host layout would stay suppressed (U113).
      requestHostLayoutAdoption(worktreeId)
      // Why the local pipeline and not activateAndRevealWorktree: a cloud ticket's
      // host refuses both host-notify paths (`worktree.activate`, `session.tabs.*`)
      // and 'live' host authority suppresses local seeding, so the checkout would
      // land without any terminal. This tab pipeline is what ends in `terminal.create`.
      if (state.activeView !== 'terminal') {
        state.setActiveView('terminal')
      }
      state.setActiveWorktree(worktreeId, executionHostId)
      if ((state.tabsByWorktree[worktreeId] ?? []).length === 0) {
        const tab = state.createTab(worktreeId)
        state.setActiveTab(tab.id)
      }
      const ui = useAppStore.getState()
      if (mountExplorer && (!ui.rightSidebarOpen || ui.rightSidebarTab !== 'explorer')) {
        ui.setRightSidebarTab('explorer')
        ui.setRightSidebarOpen(true)
      }
    }
  }
}
