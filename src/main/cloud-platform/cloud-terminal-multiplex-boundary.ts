import type { CloudPathRoots } from './cloud-path-boundary'
import { checkCloudTerminalHandleScope } from './cloud-terminal-handle-scope'
import { cloudTerminalHandleOf } from './cloud-terminal-scope'
import { pathDenialDetails, type CloudDenialDetails } from './cloud-denial-details'

/**
 * Per-subscribe workspace boundary for the multiplex transport (W9A-7).
 *
 * `terminal.multiplex` opens one connection that many terminal streams share, and
 * only the subscribe frame names a target handle. Every other frame (input, ack,
 * resize, snapshot request) addresses a streamId whose PTY binding is host state
 * created exclusively by a subscribe, so checking each subscribe — at the moment
 * the host resolves the handle to a live PTY — covers every frame without
 * re-resolving the same handle per keystroke. The verdict is the same write-root
 * check the unary terminal methods get, so multiplex is not a second, looser
 * route to a teammate's shell.
 */

/** Stream error the client sees when a subscribe targets another workspace's PTY. */
export const TERMINAL_MULTIPLEX_WORKSPACE_SCOPE_ERROR = 'terminal_workspace_scope'

export type CloudMultiplexDenialReporter = (details: CloudDenialDetails, method: string) => void

export type CloudMultiplexStreamBoundary = (
  terminalHandle: string
) => Promise<{ ok: true } | { ok: false; code: string }>

export function createCloudMultiplexStreamBoundary(deps: {
  runtime: {
    resolveTerminalContext?(
      terminalHandle: string
    ): { worktreeId: string; connectionId: string | null } | null
    resolveWorktreeRootPath(worktreeSelector: string): Promise<string>
  }
  roots: CloudPathRoots
  onCloudDenial?: CloudMultiplexDenialReporter
}): CloudMultiplexStreamBoundary {
  return async (terminalHandle) => {
    // Same input shaping as the unary handle guard: `term_x:c1` addresses `term_x`.
    const decision = await checkCloudTerminalHandleScope({
      runtime: deps.runtime,
      roots: deps.roots,
      terminalHandle: cloudTerminalHandleOf(terminalHandle)
    })
    if (decision.ok) {
      return { ok: true }
    }
    // Why the audit here, not in the dispatcher: the dispatcher only saw the
    // envelope, which carries no address — the frame is where the boundary bit.
    deps.onCloudDenial?.(pathDenialDetails(decision.reason), 'terminal.multiplex')
    return { ok: false, code: TERMINAL_MULTIPLEX_WORKSPACE_SCOPE_ERROR }
  }
}
