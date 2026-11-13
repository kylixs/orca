import type { CloudOpenResult, CloudProjectEnvironment } from '../../../shared/cloud-platform-ipc'
import { selectCloudInitialWorktreeId } from '../../../shared/cloud-initial-worktree'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { cloudProjectRepoTarget, type CloudProjectRepoPorts } from './cloud-project-repos'
import type { CloudBridge } from './use-cloud-session'

export function rendererRepoPorts(bridge: CloudBridge): CloudProjectRepoPorts {
  const state = () => useAppStore.getState()
  return {
    // The canonical runtime-repo add: main routes `repo.add` to the environment's host.
    addRepo: (target) =>
      state().addRepoPath(target.path, 'git', {
        runtimeEnvironmentId: target.environmentId,
        displayName: target.displayName
      }),
    // Why renderer-only: `repo.update` is not open to cloud sessions, and the
    // platform name is what the sidebar should show.
    renameRepo: ({ repo, displayName }) => {
      const identity = getRepoHostIdentity(repo)
      useAppStore.setState((s) => ({
        repos: s.repos.map((entry) =>
          getRepoHostIdentity(entry) === identity ? { ...entry, displayName } : entry
        )
      }))
    },
    purgeRepos: (environmentIds) => state().purgeStaleRuntimeHostState(environmentIds),
    signOut: async () => {
      await bridge.logout()
      // Why: main retired every cloud environment; this re-read also publishes
      // the removal so host pickers stop offering them.
      await state().hydrateRuntimeEnvironmentStatuses()
    }
  }
}

/**
 * Lands a signed-in user on their own checkout: the host opened (or created) a
 * worktree, and the sidebar knows that worktree by `<repoId>::<path>`.
 */
export async function selectInitialWorktree(args: {
  opened: CloudOpenResult
  environments: readonly CloudProjectEnvironment[]
  projectId: string
  isCancelled: () => boolean
}): Promise<void> {
  const workspacePath = args.opened.ok ? args.opened.workspacePath : undefined
  if (!workspacePath) {
    // Why: older sidecars may not record a checkout; leave the default view alone.
    return
  }
  const environment = args.environments.find((entry) => entry.projectId === args.projectId)
  if (!environment) {
    return
  }
  const target = cloudProjectRepoTarget(environment)
  const state = () => useAppStore.getState()
  const repo = state().repos.find(
    (row) => getRepoExecutionHostId(row) === target.executionHostId && row.path === target.path
  )
  if (!repo) {
    return
  }
  const select = (): string | null =>
    selectCloudInitialWorktreeId({
      workspacePath,
      repo,
      worktrees: state().worktreesByRepo[repo.id] ?? []
    })
  let worktreeId = select()
  if (worktreeId === null) {
    // Why: the repo row was just added, so its sidebar worktrees are not loaded yet.
    await state().fetchWorktrees(repo.id)
    if (args.isCancelled()) {
      return
    }
    worktreeId = select()
  }
  if (worktreeId !== null) {
    state().setActiveWorktree(worktreeId, target.executionHostId)
  }
}
