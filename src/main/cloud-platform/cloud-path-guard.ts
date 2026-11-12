import { isAbsolute, join } from 'node:path'
import { cloudMethodAccess } from './cloud-rpc-permission'
import { cloudGitAccessOf, cloudGitPathsOf } from './cloud-git-scope'
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
  const gitAccess = cloudGitAccessOf(method)
  if (gitAccess !== null) {
    return gitAccess
  }
  const access = cloudMethodAccess(method)
  return access === 'file:read' ? 'read' : access === 'file:write' ? 'write' : null
}

export async function checkCloudRpcPath(args: {
  runtime: CloudPathGuardRuntime
  roots: CloudPathRoots
  method: string
  params: unknown
}): Promise<CloudPathDecision | null> {
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
