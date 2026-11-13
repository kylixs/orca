import { readArray, readField, readString } from './json-fields'

/**
 * Design §8.3 step 3, transport-agnostic: open the user's existing checkout for
 * the branch, or create it with `worktree.createManaged`.
 *
 * Both callers (the desktop main process and the admin browser bridge) hold a
 * live cloud RPC whose ticket names the same `workspaceRoot`, so the selection
 * logic lives here instead of being written twice.
 */

export type CloudWorkspaceRoots = {
  projectRoot: string
  workspaceRoot: string
  defaultBranch: string
}

export type CloudWorkspaceRpcResult =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message?: string }

export type CloudWorkspaceRpc = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
) => Promise<CloudWorkspaceRpcResult>

export type OpenCloudWorkspaceResult =
  | { ok: true; workspacePath: string; created: boolean }
  | { ok: false; code: string; message?: string }

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true
  }
  const separator = root.endsWith('/') || root.endsWith('\\') ? '' : '/'
  return candidate.startsWith(`${root}${separator}`)
}

/** Branch names may contain `/`; the directory cannot. */
function worktreeNameForBranch(branch: string): string {
  return branch.replace(/[/\\]+/g, '-').replace(/^-+|-+$/g, '')
}

function existingWorkspacePath(result: unknown, workspaceRoot: string): string | null {
  for (const record of readArray(result, 'worktrees') ?? []) {
    const path = readString(record, 'path')
    if (path !== null && isInside(workspaceRoot, path)) {
      return path
    }
  }
  return null
}

export async function openCloudWorkspaceOverRpc(
  rpc: CloudWorkspaceRpc,
  projectId: string,
  roots: CloudWorkspaceRoots
): Promise<OpenCloudWorkspaceResult> {
  const { projectRoot, workspaceRoot, defaultBranch } = roots
  const repo = `path:${projectRoot}`
  const branch = defaultBranch || 'main'

  const listed = await rpc('worktree.list', { repo }, 15_000)
  if (listed.ok) {
    const existing = existingWorkspacePath(listed.result, workspaceRoot)
    if (existing !== null) {
      return { ok: true, workspacePath: existing, created: false }
    }
  }

  const created = await rpc(
    'worktree.createManaged',
    {
      repo,
      workspaceRoot,
      name: worktreeNameForBranch(branch),
      baseBranch: branch,
      // A retried open must not mint a second checkout for the same user+branch.
      idempotencyKey: `cloud-open:${projectId}:${branch}`
    },
    120_000
  )
  if (created.ok) {
    const path = readString(readField(created.result, 'worktree'), 'path')
    return path === null
      ? { ok: false, code: 'WORKSPACE_PATH_MISSING' }
      : { ok: true, workspacePath: path, created: true }
  }
  // A racer may have created it between the listing and the create; re-list once
  // so a concurrent open of the same project still lands on a real checkout.
  const recheck = await rpc('worktree.list', { repo }, 15_000)
  if (recheck.ok) {
    const existing = existingWorkspacePath(recheck.result, workspaceRoot)
    if (existing !== null) {
      return { ok: true, workspacePath: existing, created: false }
    }
  }
  return { ok: false, code: created.code, message: created.message }
}
