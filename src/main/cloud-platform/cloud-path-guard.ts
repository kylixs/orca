import { isAbsolute, join } from 'node:path'
import { cloudMethodAccess } from './cloud-rpc-permission'
import {
  CLOUD_FILE_PATH_PARAMS,
  CLOUD_FILE_UNBOUNDED_METHODS,
  CLOUD_FILE_WORKTREE_ONLY_METHODS,
  type CloudFilePaths
} from './cloud-file-path-params'
import { cloudGitAccessOf, cloudGitPathsOf } from './cloud-git-scope'
import { PROJECT_ROOT_METHODS, checkProjectRootTarget } from './cloud-repo-add-scope'
import { checkCloudAgentScope, cloudAgentScopeOf } from './cloud-agent-scope'
import {
  cloudTerminalHandleOf,
  cloudTerminalHandleParam,
  cloudTerminalScopeOf
} from './cloud-terminal-scope'
import { checkCloudTerminalRestore } from './cloud-terminal-restore-scope'
import { checkCloudTerminalHandleScope } from './cloud-terminal-handle-scope'
import {
  MANAGED_CREATE_METHOD,
  cloudWorktreeAccessOf,
  isCloudRepoScopedWorktreeMethod
} from './cloud-worktree-scope'
import {
  checkCloudTargetScope,
  checkCloudWorktreeScope,
  type CloudPathDecision,
  type CloudPathRoots
} from './cloud-path-boundary'
import {
  checkCloudSessionTabsScope,
  cloudSessionTabsScopeOf,
  type CloudSessionTabsGuardRuntime
} from './cloud-session-tabs-scope'

/**
 * Applies the ticket's roots to a file RPC before its handler runs (design §8.3).
 *
 * Both halves of the address are client-controlled: which worktree the call names
 * and which relative path it reads or writes. Method permissions alone would let a
 * cloud session browse any worktree on the host, so the selector is resolved here
 * and checked against the project, and the target against the write root.
 */

export type CloudPathGuardRuntime = CloudSessionTabsGuardRuntime & {
  resolveRepoRootPath: (repoSelector: string) => Promise<string>
  /** Which worktree a live terminal handle belongs to, if it is still running. */
  resolveTerminalContext?: (
    terminalHandle: string
  ) => { worktreeId: string; connectionId: string | null } | null
  /** Which worktree an agent session runs in, from its durable record or live terminal. */
  resolveAgentSessionContext?: (sessionId: string) => { worktreeId: string } | null
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return null
  }
  const field: unknown = key in value ? Reflect.get(value, key) : undefined
  return typeof field === 'string' ? field : null
}

function collectPaths(params: unknown, spec: CloudFilePaths): string[] {
  const paths: string[] = []
  for (const key of spec.singular) {
    const value = stringField(params, key)
    if (value !== null) {
      paths.push(value)
    }
  }
  for (const key of spec.plural) {
    if (!params || typeof params !== 'object' || !(key in params)) {
      continue
    }
    const value: unknown = key in params ? Reflect.get(params, key) : undefined
    if (!Array.isArray(value)) {
      continue
    }
    for (const entry of value) {
      if (typeof entry === 'string') {
        paths.push(entry)
      }
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
  return (
    PROJECT_ROOT_METHODS.has(method) ||
    cloudPathAccessOf(method) !== null ||
    cloudWorktreeAccessOf(method) !== null ||
    cloudTerminalScopeOf(method) !== null ||
    cloudAgentScopeOf(method) !== null ||
    cloudSessionTabsScopeOf(method) !== null
  )
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
  const terminalScope = cloudTerminalScopeOf(args.method)
  if (terminalScope?.kind === 'deny') {
    return { ok: false, reason: 'terminal_host_scope', message: terminalScope.message }
  }
  if (terminalScope?.kind === 'multiplex') {
    // The envelope names no terminal (`TerminalMultiplex` params are `{}`); the
    // stream's own frames are bounded per subscribe by the multiplex boundary.
    return { ok: true }
  }
  if (terminalScope?.kind === 'list' || terminalScope?.kind === 'adopt') {
    return await checkCloudTerminalRestore(args, terminalScope.kind)
  }
  if (terminalScope) {
    return await checkCloudTerminal(args, terminalScope)
  }
  const agentScope = cloudAgentScopeOf(args.method)
  if (agentScope) {
    return await checkCloudAgentScope(args, agentScope)
  }
  const sessionTabsScope = cloudSessionTabsScopeOf(args.method)
  if (sessionTabsScope) {
    return await checkCloudSessionTabsScope({ ...args, scope: sessionTabsScope })
  }
  const denial = cloudWorktreeDenial(args.method)
  if (denial) {
    return { ok: false, reason: 'worktree_scope', message: denial.message }
  }
  if (PROJECT_ROOT_METHODS.has(args.method)) {
    return checkProjectRootTarget(args)
  }
  if (args.method === MANAGED_CREATE_METHOD) {
    return await checkManagedCreate(args)
  }
  if (isCloudRepoScopedWorktreeMethod(args.method)) {
    return await checkRepoScopedRead(args)
  }
  if (CLOUD_FILE_UNBOUNDED_METHODS.has(args.method)) {
    return {
      ok: false,
      reason: 'path_unbounded',
      message: `Method '${args.method}' addresses an absolute path outside the project and is not available to cloud sessions.`
    }
  }
  // Fail closed: a file method whose path fields nobody declared could be
  // carrying an unscoped path, and "no paths found" must not mean "allow".
  // Keyed on the method name alone, so a newly added `files.*` RPC is refused
  // even before anyone registers it for cloud sessions.
  const fileSpec = CLOUD_FILE_PATH_PARAMS[args.method]
  if (
    fileSpec === undefined &&
    !CLOUD_FILE_WORKTREE_ONLY_METHODS.has(args.method) &&
    args.method.startsWith('files.')
  ) {
    return {
      ok: false,
      reason: 'path_unverifiable',
      message: `Method '${args.method}' has no declared path scope and is not available to cloud sessions.`
    }
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

  const paths = [
    ...(fileSpec ? collectPaths(args.params, fileSpec) : []),
    ...cloudGitPathsOf(args.params)
  ]
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

/**
 * `worktree.list`/`detectedList` name a repo, not a worktree. Answering them is
 * what lets a client decide whether to create the user's checkout, so the repo is
 * checked against the project rather than the call being refused outright.
 */
async function checkRepoScopedRead(args: {
  runtime: CloudPathGuardRuntime
  roots: CloudPathRoots
  params: unknown
}): Promise<CloudPathDecision> {
  const repoSelector = stringField(args.params, 'repo')
  if (repoSelector === null) {
    return {
      ok: false,
      reason: 'repo_required',
      message: 'This call must name a repository.'
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
  return checkCloudTargetScope(args.roots, 'read', repoPath)
}

/**
 * A terminal is a shell: creating one runs commands in a directory, and driving
 * an existing handle writes to whatever directory that shell is in. Both are
 * therefore bounded by the caller's workspace root, not the project — a teammate's
 * checkout is readable but must not be drivable.
 */
async function checkCloudTerminal(
  args: { runtime: CloudPathGuardRuntime; roots: CloudPathRoots; method: string; params: unknown },
  scope: { kind: 'create' } | { kind: 'handle' }
): Promise<CloudPathDecision> {
  if (scope.kind === 'create') {
    const selector = stringField(args.params, 'worktree')
    if (selector === null) {
      return {
        ok: false,
        reason: 'terminal_worktree_required',
        message: 'A cloud terminal must name the workspace it opens in.'
      }
    }
    let worktreePath: string
    try {
      worktreePath = await args.runtime.resolveWorktreeRootPath(selector)
    } catch {
      return {
        ok: false,
        reason: 'worktree_unknown',
        message: 'This worktree is not available to the cloud session.'
      }
    }
    return checkCloudTargetScope(args.roots, 'write', worktreePath)
  }
  const handle = stringField(args.params, cloudTerminalHandleParam(args.method))
  if (handle === null) {
    return {
      ok: false,
      reason: 'terminal_unknown',
      message: 'This call names no terminal.'
    }
  }
  return checkCloudTerminalHandleScope({
    runtime: args.runtime,
    roots: args.roots,
    terminalHandle: cloudTerminalHandleOf(handle)
  })
}
