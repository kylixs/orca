/**
 * U96 B-令3: who owns the PTY of a terminal tab.
 *
 * `hostTerminal` comes from the host session-tab projection: a string is a live
 * handle, null is a row whose PTY the host is still restoring, and undefined
 * means the tab was never projected (legacy or admin page) so the pane creates.
 */

export type CloudTerminalBootPlan =
  | { kind: 'attach'; handle: string }
  | { kind: 'pending' }
  | { kind: 'create' }

export function planCloudTerminalBoot(
  hostTerminal: string | null | undefined,
  hostOwnsPty: boolean
): CloudTerminalBootPlan {
  if (hostTerminal !== undefined && hostTerminal !== null) {
    return { kind: 'attach', handle: hostTerminal }
  }
  // A projected pending row, or a tab whose PTY the host action layer is creating.
  return hostTerminal === null || hostOwnsPty ? { kind: 'pending' } : { kind: 'create' }
}
