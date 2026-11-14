import {
  checkCloudTargetScope,
  type CloudPathDecision,
  type CloudPathRoots
} from './cloud-path-boundary'

/**
 * Whether a live terminal handle sits inside the caller's write root.
 *
 * A terminal is a shell: driving a handle writes to whatever directory that shell
 * is in, so the handle's own worktree is the boundary — not the project. Shared
 * by the unary handle methods and the multiplex subscribe frame, so a shell in a
 * teammate's checkout is equally undriveable over either transport.
 */
export async function checkCloudTerminalHandleScope(args: {
  runtime: {
    resolveTerminalContext?(
      terminalHandle: string
    ): { worktreeId: string; connectionId: string | null } | null
    resolveWorktreeRootPath(worktreeSelector: string): Promise<string>
  }
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
