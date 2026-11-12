import { readArray, readField, readString } from '../../shared/json-fields'
import type { CloudConnectClient } from './cloud-connect-client'

/**
 * Design §8.3 step 3: after connecting, open the user's existing checkout for the
 * branch, or create it with `worktree.createManaged`.
 *
 * Both calls are repo-scoped, so the host answers them only for this project
 * (M38/M40 boundaries). The chosen worktree is filtered to the ticket's
 * workspace root, because listing a repo also returns teammates' checkouts.
 */

export type EnsureWorkspaceResult =
  | { ok: true; workspacePath: string; created: boolean; capabilities: string[] }
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

export async function ensureCloudWorkspace(
  client: CloudConnectClient,
  projectId: string
): Promise<EnsureWorkspaceResult> {
  let ticket
  try {
    ticket = await client.openProject(projectId)
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : null
    return {
      ok: false,
      code: typeof code === 'string' ? code : 'OPEN_FAILED',
      message: error instanceof Error ? error.message : String(error)
    }
  }

  const { projectRoot, workspaceRoot, defaultBranch } = ticket.ticket.workspace
  const capabilities = ticket.ticket.host.capabilities
  const repo = `path:${projectRoot}`
  const branch = defaultBranch || 'main'

  const listed = await client.rpc('worktree.list', { repo }, 15_000)
  if (listed.ok) {
    const existing = existingWorkspacePath(listed.result, workspaceRoot)
    if (existing !== null) {
      return { ok: true, workspacePath: existing, created: false, capabilities }
    }
  }

  const created = await client.rpc(
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
      : { ok: true, workspacePath: path, created: true, capabilities }
  }
  // A racer may have created it between the listing and the create; re-list once
  // so a concurrent open of the same project still lands on a real checkout.
  const recheck = await client.rpc('worktree.list', { repo }, 15_000)
  if (recheck.ok) {
    const existing = existingWorkspacePath(recheck.result, workspaceRoot)
    if (existing !== null) {
      return { ok: true, workspacePath: existing, created: false, capabilities }
    }
  }
  return { ok: false, code: created.code, message: created.message }
}
