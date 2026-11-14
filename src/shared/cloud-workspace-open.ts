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
  | { ok: true; workspacePath: string; created: boolean; provisioned: boolean }
  | { ok: false; code: string; message?: string }

export type ProvisionCloudProjectResult =
  | { ok: true; provisioned: boolean }
  | { ok: false; code: string; message?: string }

/** Clone can take minutes on a large repository; keep the RPC alive well past a probe. */
const PROVISION_TIMEOUT_MS = 600_000

/**
 * The workspace containment verdict shared by the open flow and the host's
 * `workspace.info`, so both answer "is this the ticket's own checkout" alike.
 */
export function isInsideWorkspaceRoot(root: string, candidate: string): boolean {
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
    if (path !== null && isInsideWorkspaceRoot(workspaceRoot, path)) {
      return path
    }
  }
  return null
}

/**
 * Makes the host's project root a checkout. Idempotent, so every open can call it.
 *
 * A host predating this method answers `method_not_found`; that is not a failure,
 * because such a host already works for admin-prepared repositories.
 */
export async function provisionCloudProjectOverRpc(
  rpc: CloudWorkspaceRpc
): Promise<ProvisionCloudProjectResult> {
  const reply = await rpc('project.provision', {}, PROVISION_TIMEOUT_MS)
  if (!reply.ok) {
    // Why the message check too: cloud scopes reject an unregistered method as
    // `forbidden` before the dispatcher can answer `method_not_found`. That exact
    // message is the only signal that distinguishes a pre-M57 host from a ticket
    // that genuinely lacks the `open` permission.
    if (
      reply.code === 'method_not_found' ||
      (reply.code === 'forbidden' &&
        (reply.message ?? '').includes('is not available to cloud sessions'))
    ) {
      return { ok: true, provisioned: false }
    }
    return { ok: false, code: reply.code, message: reply.message }
  }
  if (readField(reply.result, 'ok') === true) {
    return { ok: true, provisioned: readField(reply.result, 'provisioned') === true }
  }
  const message = readString(reply.result, 'message')
  return {
    ok: false,
    code: readString(reply.result, 'code') ?? 'PROVISION_FAILED',
    ...(message !== null ? { message } : {})
  }
}

export async function openCloudWorkspaceOverRpc(
  rpc: CloudWorkspaceRpc,
  projectId: string,
  roots: CloudWorkspaceRoots
): Promise<OpenCloudWorkspaceResult> {
  const { projectRoot, workspaceRoot, defaultBranch } = roots
  const repo = `path:${projectRoot}`
  const branch = defaultBranch || 'main'

  // Why not continue on failure: creating a worktree against a missing repo would
  // replace the real cause with a vaguer "repo unknown" error.
  const provision = await provisionCloudProjectOverRpc(rpc)
  if (!provision.ok) {
    return { ok: false, code: provision.code, message: provision.message }
  }

  const listed = await rpc('worktree.list', { repo }, 15_000)
  if (listed.ok) {
    const existing = existingWorkspacePath(listed.result, workspaceRoot)
    if (existing !== null) {
      return {
        ok: true,
        workspacePath: existing,
        created: false,
        provisioned: provision.provisioned
      }
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
    if (path === null) {
      return { ok: false, code: 'WORKSPACE_PATH_MISSING' }
    }
    // A racer that joined the winner's in-flight create gets the same worktree
    // back; the host says so, and only the winner may claim it built the checkout.
    const createdByThisCall = readField(created.result, 'createdByThisCall') !== false
    return {
      ok: true,
      workspacePath: path,
      created: createdByThisCall,
      provisioned: provision.provisioned
    }
  }
  // A racer may have created it between the listing and the create; re-list once
  // so a concurrent open of the same project still lands on a real checkout.
  const recheck = await rpc('worktree.list', { repo }, 15_000)
  if (recheck.ok) {
    const existing = existingWorkspacePath(recheck.result, workspaceRoot)
    if (existing !== null) {
      return {
        ok: true,
        workspacePath: existing,
        created: false,
        provisioned: provision.provisioned
      }
    }
  }
  return { ok: false, code: created.code, message: created.message }
}
