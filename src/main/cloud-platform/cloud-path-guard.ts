import { isAbsolute, join } from 'node:path'
import { cloudMethodAccess } from './cloud-rpc-permission'
import { cloudGitAccessOf, cloudGitPathsOf } from './cloud-git-scope'
import { MANAGED_CREATE_METHOD, cloudWorktreeAccessOf } from './cloud-worktree-scope'
import {
  checkCloudTargetScope,
  checkCloudWorktreeScope,
  type CloudPathDecision,
  type CloudPathRoots
} from './cloud-path-boundary'

/**
 * Applies the ticket's roots to a file RPC before its handler runs (design §8.3).
 *
 * Both halves of the address are client-controlled: which worktree the call names
 * and which relative path it reads or writes. Method permissions alone would let a
 * cloud session browse any worktree on the host, so the selector is resolved here
 * and checked against the project, and the target against the write root.
 */

export type CloudPathGuardRuntime = {
  resolveWorktreeRootPath: (worktreeSelector: string) => Promise<string>
  resolveRepoRootPath: (repoSelector: string) => Promise<string>
}

/** Param names that carry a path; rename/copy contribute two. */
const PATH_PARAM_SUFFIX = 'elativePath'

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return null
  }
  const field: unknown = key in value ? Reflect.get(value, key) : undefined
  return typeof field === 'string' ? field : null
}

function relativePaths(params: unknown): string[] {
  if (!params || typeof params !== 'object') {
    return []
  }
  const paths: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (key.endsWith(PATH_PARAM_SUFFIX) && typeof value === 'string') {
      paths.push(value)
    }
  }
  return paths
}

/** Null when the method takes no project path, so non-file calls skip the check. */
export function cloudPathAccessOf(method: string): 'read' | 'write' | null {
  const worktreeAccess = cloudWorktreeAccessOf(method)
  if (worktreeAccess !== null) {
    return worktreeAccess.kind === 'deny' ? null : worktreeAccess.kind
  }
  const gitAccess = cloudGitAccessOf(method)
  if (gitAccess !== null) {
    return gitAccess
  }
  const access = cloudMethodAccess(method)
  return access === 'file:read' ? 'read' : access === 'file:write' ? 'write' : null
}

/** Whether a cloud session's call must pass the workspace boundary at all. */
export function isCloudPathGuardedMethod(method: string): boolean {
  return cloudPathAccessOf(method) !== null || cloudWorktreeAccessOf(method) !== null
}

/** A worktree method the host refuses outright, regardless of its selector. */
export function cloudWorktreeDenial(method: string): { message: string } | null {
  const access = cloudWorktreeAccessOf(method)
  return access?.kind === 'deny' ? { message: access.message } : null
}

export async function checkCloudRpcPath(args: {
  runtime: CloudPathGuardRuntime
  roots: CloudPathRoots
  method: string
  params: unknown
}): Promise<CloudPathDecision | null> {
  const denial = cloudWorktreeDenial(args.method)
  if (denial) {
    return { ok: false, reason: 'worktree_scope', message: denial.message }
  }
  if (args.method === MANAGED_CREATE_METHOD) {
    return await checkManagedCreate(args)
  }
  const access = cloudPathAccessOf(args.method)
  if (access === null) {
    return null
  }
  const selector = stringField(args.params, 'worktree')
  if (selector === null) {
    return { ok: false, reason: 'worktree_unknown', message: 'This call names no worktree.' }
  }

  let worktreePath: string
  try {
    worktreePath = await args.runtime.resolveWorktreeRootPath(selector)
  } catch {
    // Why: resolution failure is also how a selector naming someone else's host
    // fails; the handler's own error would not say the call was out of scope.
    return {
      ok: false,
      reason: 'worktree_unknown',
      message: 'This worktree is not available to the cloud session.'
    }
  }

  const worktreeScope = checkCloudWorktreeScope(args.roots, worktreePath)
  if (!worktreeScope.ok) {
    return worktreeScope
  }
  // Why the directory too, not just the target: a git call names no path but acts
  // on its working directory, so committing from the shared checkout must be
  // refused even though no relative path names anything outside the workspace.
  if (access === 'write') {
    const directoryScope = checkCloudTargetScope(args.roots, 'write', worktreePath)
    if (!directoryScope.ok) {
      return directoryScope
    }
  }

  const paths = [...relativePaths(args.params), ...cloudGitPathsOf(args.params)]
  for (const relativePath of paths) {
    // Why reject absolute paths: `join` would treat "/etc/passwd" as a relative
    // segment under the worktree, turning an escape attempt into a confusing 404.
    if (isAbsolute(relativePath)) {
      return {
        ok: false,
        reason: 'absolute_path',
        message: 'Paths are resolved from the worktree; absolute paths are refused.'
      }
    }
    const decision = checkCloudTargetScope(args.roots, access, join(worktreePath, relativePath))
    if (!decision.ok) {
      return decision
    }
  }
  return { ok: true }
}

/**
 * A managed create names both a repo and the parent directory it wants. The repo
 * must be this project's, or a session could check out another team's repository
 * into its own workspace and then read it; the directory must be inside the
 * ticket's workspace root, or creation would escape the write boundary that the
 * resulting worktree is supposed to live in.
 */
async function checkManagedCreate(args: {
  runtime: CloudPathGuardRuntime
  roots: CloudPathRoots
  params: unknown
}): Promise<CloudPathDecision> {
  const repoSelector = stringField(args.params, 'repo')
  const workspaceRoot = stringField(args.params, 'workspaceRoot')
  if (repoSelector === null || workspaceRoot === null) {
    return {
      ok: false,
      reason: 'managed_create_incomplete',
      message: 'Managed creation needs a repo and a workspace root.'
    }
  }
  let repoPath: string
  try {
    repoPath = await args.runtime.resolveRepoRootPath(repoSelector)
  } catch {
    return {
      ok: false,
      reason: 'repo_unknown',
      message: 'That repository is not available to the cloud session.'
    }
  }
  const repoScope = checkCloudTargetScope(args.roots, 'read', repoPath)
  if (!repoScope.ok) {
    return repoScope
  }
  return checkCloudTargetScope(args.roots, 'write', workspaceRoot)
}
