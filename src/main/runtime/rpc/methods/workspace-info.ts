import { defineMethod, type RpcContext } from '../core'
import { isInsideWorkspaceRoot } from '../../../../shared/cloud-workspace-open'
import type {
  CloudWorkspaceInfoResponse,
  CloudWorkspaceInfo
} from '../../../../shared/cloud-workspace-info'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreeRecord
} from '../../../../shared/runtime-worktree-contracts'

/**
 * Cloud workspace introspection (W13): the ticket's own project/workspace facts
 * plus the checkout the host already found inside the workspace root.
 *
 * Kept out of ALL_RPC_METHODS like project.provision — only a cloud-admitted
 * host holds a ticket to answer from, and the handler refuses every other
 * caller. The method takes no params, so the ticket is the only address source:
 * a client cannot probe another project, another user's checkout or a host path.
 */
export const WORKSPACE_INFO_METHODS = [
  defineMethod({
    name: 'workspace.info',
    permission: 'workspace',
    params: null,
    handler: async (_params, context): Promise<CloudWorkspaceInfoResponse> => {
      const cloud = context.cloud
      if (!cloud) {
        return {
          ok: false,
          code: 'CLOUD_SESSION_REQUIRED',
          message: 'This method is only available to a cloud session.'
        }
      }
      const checkout = await findWorkspaceCheckout(
        context.runtime,
        cloud.projectRoot,
        cloud.workspaceRoot
      )
      const info: CloudWorkspaceInfo = {
        project: {
          id: cloud.projectId,
          root: cloud.projectRoot,
          repoUrl: cloud.repoUrl,
          defaultBranch: cloud.defaultBranch
        },
        workspace: {
          root: cloud.workspaceRoot,
          path: checkout?.git.path ?? null,
          branch: checkout === null ? null : branchOfHeadRef(checkout.git.branch)
        },
        perms: [...cloud.perms]
      }
      return info
    }
  })
] as const

/**
 * The ticket's own checkout, found the way `worktree.list` answers a cloud
 * session: one repo-scoped scan of the project root, filtered to the workspace
 * root. An unregistered repo or a failed scan means "nothing ensured yet", not
 * an error — a first open has no checkout to find.
 */
async function findWorkspaceCheckout(
  runtime: RpcContext['runtime'],
  projectRoot: string,
  workspaceRoot: string
): Promise<RuntimeWorktreeRecord | null> {
  let listed: RuntimeWorktreeListResult
  try {
    listed = await runtime.listManagedWorktrees(`path:${projectRoot}`)
  } catch (error) {
    if (!isUnregisteredRepoError(error)) {
      console.warn('[cloud] workspace.info checkout scan failed unexpectedly:', error)
    }
    return null
  }
  return listed.worktrees.find((row) => isInsideWorkspaceRoot(workspaceRoot, row.git.path)) ?? null
}

/** The designed "nothing ensured yet" answer (W13a audit MIN-2 keeps the rest loud). */
function isUnregisteredRepoError(error: unknown): boolean {
  return error instanceof Error && error.message === 'repo_not_found'
}

/** Porcelain ref → branch name; a detached HEAD or folder workspace has none. */
function branchOfHeadRef(ref: string): string | null {
  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length)
  }
  return ref === '' ? null : ref
}
