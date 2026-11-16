import {
  checkCloudTargetScope,
  type CloudPathDecision,
  type CloudPathRoots
} from './cloud-path-boundary'
import { cloudTerminalHandleOf } from './cloud-terminal-scope'

type TerminalScopeRuntime = {
  resolveTerminalContext?(
    terminalHandle: string
  ): { worktreeId: string; connectionId: string | null } | null
  resolveWorktreeRootPath(worktreeSelector: string): Promise<string>
}

/**
 * Whether a live terminal handle sits inside the caller's write root.
 *
 * A terminal is a shell: driving a handle writes to whatever directory that shell
 * is in, so the handle's own worktree is the boundary — not the project. Shared
 * by the unary handle methods and the multiplex subscribe frame, so a shell in a
 * teammate's checkout is equally undriveable over either transport.
 */
export async function checkCloudTerminalHandleScope(args: {
  runtime: TerminalScopeRuntime
  roots: CloudPathRoots
  terminalHandle: string
}): Promise<CloudPathDecision> {
  // A host that cannot say which worktree a handle belongs to cannot prove the
  // handle is the caller's, so the call is refused rather than assumed in scope.
  const context = args.runtime.resolveTerminalContext?.(args.terminalHandle) ?? null
  if (context === null) {
    return {
      ok: false,
      reason: 'terminal_unknown',
      message: 'This terminal is not available to the cloud session.'
    }
  }
  let worktreePath: string
  try {
    worktreePath = await args.runtime.resolveWorktreeRootPath(`id:${context.worktreeId}`)
  } catch {
    return {
      ok: false,
      reason: 'terminal_unknown',
      message: 'This terminal is not available to the cloud session.'
    }
  }
  return checkCloudTargetScope(args.roots, 'write', worktreePath)
}

/**
 * U96 T-B6: the fit preference. Reading the host-global value is harmless; a
 * write must name the terminal it applies to, because a cloud ticket serves
 * several users on one host and must never change the shared preference.
 */
export async function checkCloudFitScope(args: {
  runtime: TerminalScopeRuntime
  roots: CloudPathRoots
  scope: 'fit-read' | 'fit-write'
  params: unknown
}): Promise<CloudPathDecision> {
  if (args.scope === 'fit-read') {
    return { ok: true }
  }
  const raw =
    args.params !== null && typeof args.params === 'object'
      ? Reflect.get(args.params, 'terminal')
      : undefined
  if (typeof raw !== 'string' || raw.length === 0) {
    return {
      ok: false,
      reason: 'terminal_unknown',
      message: 'A cloud session must name the terminal whose fit preference it changes.'
    }
  }
  return await checkCloudTerminalHandleScope({
    runtime: args.runtime,
    roots: args.roots,
    terminalHandle: cloudTerminalHandleOf(raw)
  })
}
