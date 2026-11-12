/**
 * Which terminal RPCs a cloud session may drive, and whose shell they address.
 *
 * `terminal` permission alone is not a boundary: the client picks the worktree a
 * PTY is created in, and every later call names some terminal handle. A shell in
 * another team's checkout can read and rewrite it, so both addresses are checked
 * against the ticket's workspace root rather than trusted.
 *
 * Methods that act on the host's own window (tabs, focus, global close, fit
 * preferences) and the multiplex transport are refused: a headless cloud host has
 * no window for them to act on, and their answers describe other users' work.
 */

export type CloudTerminalScope =
  | { kind: 'create' }
  | { kind: 'handle' }
  | { kind: 'deny'; message: string }

/** Creates a PTY; `worktree` must resolve inside the caller's workspace root. */
const CREATE_METHODS: ReadonlySet<string> = new Set(['terminal.create'])

/** Address a live terminal by handle; the handle's worktree is the boundary. */
export const CLOUD_TERMINAL_HANDLE_METHODS: ReadonlySet<string> = new Set([
  'terminal.send',
  'terminal.subscribe',
  'terminal.unsubscribe',
  'terminal.read',
  'terminal.wait',
  'terminal.close',
  'terminal.stop',
  'terminal.stopExact',
  'terminal.rename',
  'terminal.clearBuffer',
  'terminal.resetInputModes',
  'terminal.inspectProcess',
  'terminal.isRunningAgent',
  'terminal.agentStatus',
  'terminal.resizeForClient',
  'terminal.updateViewport',
  'terminal.restoreFit',
  'terminal.getDisplayMode',
  'terminal.setDisplayMode',
  'terminal.setViewerColors'
])

/**
 * Host-desktop or host-global methods. `terminal.multiplex` is a second transport
 * whose frames are not covered by this table, so it stays closed until it is.
 */
export const CLOUD_TERMINAL_DENIED_METHODS: ReadonlySet<string> = new Set([
  'terminal.split',
  'terminal.closeAll',
  'terminal.closeTab',
  'terminal.sleep',
  'terminal.focus',
  'terminal.show',
  'terminal.list',
  'terminal.resolveActive',
  'terminal.resolvePane',
  'terminal.recoverPane',
  'terminal.resolveIdentity',
  'terminal.multiplex',
  'terminal.getAutoRestoreFit',
  'terminal.setAutoRestoreFit'
])

export function cloudTerminalScopeOf(method: string): CloudTerminalScope | null {
  if (CREATE_METHODS.has(method)) {
    return { kind: 'create' }
  }
  if (CLOUD_TERMINAL_HANDLE_METHODS.has(method)) {
    return { kind: 'handle' }
  }
  if (CLOUD_TERMINAL_DENIED_METHODS.has(method)) {
    return { kind: 'deny', message: deniedMessage(method) }
  }
  // Fail closed: a terminal method nobody classified is not "harmless".
  if (method.startsWith('terminal.')) {
    return { kind: 'deny', message: deniedMessage(method) }
  }
  return null
}

function deniedMessage(method: string): string {
  const hostWindow = method !== 'terminal.multiplex' && method !== 'terminal.list'
  return hostWindow
    ? `Method '${method}' acts on the host's own window and is not available to cloud sessions.`
    : `Method '${method}' is not available to cloud sessions.`
}

/**
 * The field that carries the terminal address. `terminal.unsubscribe` names the
 * subscription instead of the terminal, and a client-scoped subscription id is
 * `${terminal}:${clientId}` — the guard splits that before resolving.
 */
export const CLOUD_TERMINAL_HANDLE_PARAM = 'terminal'

export function cloudTerminalHandleParam(method: string): string {
  return method === 'terminal.unsubscribe' ? 'subscriptionId' : CLOUD_TERMINAL_HANDLE_PARAM
}

/** `term_x:c1` addresses `term_x`; a bare handle addresses itself. */
export function cloudTerminalHandleOf(subscriptionId: string): string {
  const cut = subscriptionId.indexOf(':')
  return cut <= 0 ? subscriptionId : subscriptionId.slice(0, cut)
}
