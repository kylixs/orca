import { defineMethod } from '../core'
import { WorktreeManagedCreate } from '../../../../shared/rpc-contract/worktree-managed-create-params'

/**
 * Cloud-managed worktree creation (design §8.3 / T301a).
 *
 * Kept out of ALL_RPC_METHODS: the design says a non-managed build must not offer
 * it, so the launch path adds it only when cloud admission is active.
 *
 * The host forces `nestWorkspaces: false` (the caller's root is the final parent)
 * and refuses remote repos, because the ticket's workspace root is a local path —
 * honouring it on an SSH checkout would silently place the worktree elsewhere.
 */
export const MANAGED_WORKTREE_METHODS = [
  defineMethod({
    name: 'worktree.createManaged',
    permission: 'workspace',
    params: WorktreeManagedCreate,
    handler: async (params, { runtime }) =>
      runtime.dedupeWorktreeCreate(params.repo, params.idempotencyKey, async () => {
        const repo = await runtime.showRepo(params.repo)
        if (repo.connectionId) {
          throw new Error('managed_workspace_remote_unsupported')
        }
        return runtime.createManagedWorktree({
          repoSelector: params.repo,
          workspaceRoot: params.workspaceRoot,
          name: params.name ?? '',
          ...(params.baseBranch ? { baseBranch: params.baseBranch } : {}),
          ...(params.compareBaseRef ? { compareBaseRef: params.compareBaseRef } : {}),
          ...(params.branchNameOverride ? { branchNameOverride: params.branchNameOverride } : {}),
          ...(params.displayName ? { displayName: params.displayName } : {}),
          telemetrySource: 'unknown'
        })
      })
  })
] as const
