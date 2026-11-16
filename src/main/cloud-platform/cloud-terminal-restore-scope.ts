import {
  checkCloudTargetScope,
  resolveRealPath,
  type CloudPathDecision,
  type CloudPathRoots
} from './cloud-path-boundary'
import { checkCloudTerminalHandleScope } from './cloud-terminal-handle-scope'
import {
  cloudTerminalTopologyMismatch,
  type CloudTerminalOrphanClaim
} from './cloud-terminal-scope'

/**
 * U96 A-3: the restore path's two terminal methods, bounded per cloud ticket.
 *
 * `terminal.list` is host-wide unless it names a worktree, and
 * `terminal.adoptOrphans` writes host tab ownership for the handles it claims.
 * Both are admitted only inside the caller's workspace root, and adoption also
 * proves every claimed handle is a terminal of the worktree it names and that
 * the proposed topology claims exactly those tabs and panes.
 */

export type CloudTerminalRestoreScope = 'list' | 'adopt'

export type CloudTerminalRestoreRuntime = {
  resolveWorktreeRootPath: (worktreeSelector: string) => Promise<string>
  /** Absent on hosts that cannot answer; every claim then fails closed. */
  resolveTerminalContext?: (
    terminalHandle: string
  ) => { worktreeId: string; connectionId: string | null } | null
}

export async function checkCloudTerminalRestore(
  args: {
    runtime: CloudTerminalRestoreRuntime
    roots: CloudPathRoots
    params: unknown
  },
  scope: CloudTerminalRestoreScope
): Promise<CloudPathDecision> {
  const boundary = await checkWorktreeBoundary(args)
  if (!boundary.ok) {
    return boundary
  }
  if (scope === 'list') {
    return { ok: true }
  }
  const claims = terminalClaimsOf(args.params)
  if (claims === null) {
    return {
      ok: false,
      reason: 'terminal_unknown',
      message: 'This call names no terminal claims.'
    }
  }
  const claimsScope = await checkClaimsWorktree({
    ...args,
    worktreePath: boundary.worktreePath,
    claims
  })
  if (!claimsScope.ok) {
    return claimsScope
  }
  if (!args.params || typeof args.params !== 'object' || !('topology' in args.params)) {
    return { ok: true }
  }
  const topologyMismatch = cloudTerminalTopologyMismatch(
    Reflect.get(args.params, 'topology'),
    claims
  )
  if (topologyMismatch !== null) {
    return { ok: false, reason: 'terminal_unknown', message: topologyMismatch }
  }
  return { ok: true }
}

type CloudTerminalWorktreeBoundary =
  | { ok: true; worktreePath: string }
  | { ok: false; reason: string; message: string }

/** Write scope, because the inventory projection keeps only the caller's workspace root. */
async function checkWorktreeBoundary(args: {
  runtime: CloudTerminalRestoreRuntime
  roots: CloudPathRoots
  params: unknown
}): Promise<CloudTerminalWorktreeBoundary> {
  const selector = stringField(args.params, 'worktree')
  if (selector === null) {
    return {
      ok: false,
      reason: 'workspace_scope',
      message: 'This call must name a worktree inside your workspace.'
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
  const scope = checkCloudTargetScope(args.roots, 'write', worktreePath)
  if (!scope.ok) {
    return scope
  }
  return { ok: true, worktreePath }
}

type CloudTerminalClaim = CloudTerminalOrphanClaim & { terminal: string }

/** Null when any claim is missing an address; the schema rejects those later too. */
function terminalClaimsOf(params: unknown): CloudTerminalClaim[] | null {
  if (!params || typeof params !== 'object' || !('claims' in params)) {
    return null
  }
  const rawClaims: unknown = Reflect.get(params, 'claims')
  if (!Array.isArray(rawClaims) || rawClaims.length === 0) {
    return null
  }
  const claims: CloudTerminalClaim[] = []
  for (const rawClaim of rawClaims) {
    const terminal = stringField(rawClaim, 'terminal')
    const tabId = stringField(rawClaim, 'tabId')
    const leafId = stringField(rawClaim, 'leafId')
    if (terminal === null || tabId === null || leafId === null) {
      return null
    }
    claims.push({ terminal, tabId, leafId })
  }
  return claims
}

/**
 * A handle in a teammate's checkout is refused by the workspace root check, but
 * two worktrees inside the same workspace root would still pass it — adoption
 * must land every claim in the one worktree the call names.
 */
async function checkClaimsWorktree(args: {
  runtime: CloudTerminalRestoreRuntime
  roots: CloudPathRoots
  worktreePath: string
  claims: readonly CloudTerminalClaim[]
}): Promise<CloudPathDecision> {
  const expectedWorktreePath = resolveRealPath(args.worktreePath)
  for (const claim of args.claims) {
    const claimScope = await checkCloudTerminalHandleScope({
      runtime: args.runtime,
      roots: args.roots,
      terminalHandle: claim.terminal
    })
    if (!claimScope.ok) {
      return claimScope
    }
    const context = args.runtime.resolveTerminalContext?.(claim.terminal) ?? null
    if (context === null) {
      return claimTerminalUnknown()
    }
    let claimWorktreePath: string
    try {
      claimWorktreePath = await args.runtime.resolveWorktreeRootPath(`id:${context.worktreeId}`)
    } catch {
      return claimTerminalUnknown()
    }
    if (resolveRealPath(claimWorktreePath) !== expectedWorktreePath) {
      return {
        ok: false,
        reason: 'workspace_scope',
        message: 'Every claimed terminal must belong to the worktree this call names.'
      }
    }
  }
  return { ok: true }
}

function claimTerminalUnknown(): CloudPathDecision {
  return {
    ok: false,
    reason: 'terminal_unknown',
    message: 'A claimed terminal is not available to the cloud session.'
  }
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return null
  }
  const field: unknown = key in value ? Reflect.get(value, key) : undefined
  return typeof field === 'string' ? field : null
}
