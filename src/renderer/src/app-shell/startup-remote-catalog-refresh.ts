import { timeRendererStartupStep } from '../startup/startup-diagnostics'
import type { StartupActions } from './startup-actions-selector'

type DeferredStartupRefreshActions = Pick<
  StartupActions,
  | 'awaitOwnerWorktreeVisibilityDefaultsHydration'
  | 'fetchReposForAllHosts'
  | 'fetchProjectGroupsForAllHosts'
  | 'fetchFolderWorkspacesForAllHosts'
  | 'fetchAllWorktrees'
  | 'pruneLastVisitedTimestamps'
  | 'fetchWorktreeLineage'
>

/**
 * Runs the post-hydration refresh the boot chain only starts (never awaits):
 * the remote catalog scan, then the full worktree scan and lineage. A cloud
 * (ticket) session answers none of those RPCs — the catalogs are desktop-owned
 * state the ticket never carries — so there is nothing to refresh.
 */
export function startDeferredRemoteStartupRefresh(args: {
  cloudRuntimeSession: boolean
  isCancelled: () => boolean
  actions: DeferredStartupRefreshActions
  /** Marks the deferred scan settled, whatever the outcome. */
  onSettled: () => void
}): void {
  void (async () => {
    const { cloudRuntimeSession, isCancelled, actions, onSettled } = args
    try {
      if (!cloudRuntimeSession) {
        try {
          // Why: remote rows must not render under a fallback visibility while their owner default is still loading.
          await timeRendererStartupStep('owner-visibility-defaults', () =>
            actions.awaitOwnerWorktreeVisibilityDefaultsHydration()
          )
          await timeRendererStartupStep('remote-catalog-refresh', async () => {
            await actions.fetchReposForAllHosts()
            await actions.fetchProjectGroupsForAllHosts()
            await actions.fetchFolderWorkspacesForAllHosts()
          })
        } catch (err) {
          console.warn('Remote startup catalog refresh failed:', err)
        }
        if (!isCancelled()) {
          try {
            await timeRendererStartupStep('remote-worktree-refresh', async () => {
              // Why: the full scan is not required for session recovery, so keep it off the startup-critical path.
              await actions.fetchAllWorktrees()
              // Why: the startup prune only saw session-referenced repos; use the deferred scan's
              // authoritative results to drop deleted-worktree visit timestamps that would
              // otherwise accumulate unbounded (disconnected SSH stays non-authoritative and is kept).
              actions.pruneLastVisitedTimestamps()
              await actions.fetchWorktreeLineage()
            })
          } catch (err) {
            console.warn('Deferred startup worktree refresh failed:', err)
          }
        }
      }
    } finally {
      if (!isCancelled()) {
        onSettled()
      }
    }
  })()
}
