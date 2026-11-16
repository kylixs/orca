/**
 * Which terminal RPCs a cloud session may drive, and whose shell they address.
 *
 * `terminal` permission alone is not a boundary: the client picks the worktree a
 * PTY is created in, and every later call names some terminal handle. A shell in
 * another team's checkout can read and rewrite it, so both addresses are checked
 * against the ticket's workspace root rather than trusted.
 *
 * Methods that act on the host's own window (tabs, focus, global close, fit
 * preferences) are refused: a headless cloud host has no window for them to act
 * on, and their answers describe other users' work.
 */

export type CloudTerminalScope =
  | { kind: 'create' }
  | { kind: 'handle' }
  /** A stream transport: the envelope names no terminal, so every subscribe frame is checked instead. */
  | { kind: 'multiplex' }
  /** Names one worktree; the listing is bounded to that worktree's workspace root. */
  | { kind: 'list' }
  /** Claims orphan PTYs; worktree, each claimed handle, and the proposed topology must agree. */
  | { kind: 'adopt' }
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
 * The desktop workspace pane's second transport. Its envelope carries no
 * terminal, so admission is unconditional here and the boundary moves to the
 * frames: every subscribe names a handle, and that handle is checked against the
 * ticket's workspace root where the host resolves it
 * (`cloud-terminal-multiplex-boundary.ts`).
 */
export const CLOUD_TERMINAL_MULTIPLEX_METHODS: ReadonlySet<string> = new Set(['terminal.multiplex'])

/** Names a worktree only: the selector boundary is the whole call. */
const LIST_METHODS: ReadonlySet<string> = new Set(['terminal.list'])

/** Claims live orphan PTYs into named tabs; every address in the request is checked. */
const ADOPT_METHODS: ReadonlySet<string> = new Set(['terminal.adoptOrphans'])

/** Host-desktop or host-global methods, refused regardless of their selector. */
export const CLOUD_TERMINAL_DENIED_METHODS: ReadonlySet<string> = new Set([
  'terminal.split',
  'terminal.closeAll',
  'terminal.closeTab',
  'terminal.sleep',
  'terminal.focus',
  'terminal.show',
  'terminal.resolveActive',
  'terminal.resolvePane',
  'terminal.recoverPane',
  'terminal.resolveIdentity',
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
  if (CLOUD_TERMINAL_MULTIPLEX_METHODS.has(method)) {
    return { kind: 'multiplex' }
  }
  if (LIST_METHODS.has(method)) {
    return { kind: 'list' }
  }
  if (ADOPT_METHODS.has(method)) {
    return { kind: 'adopt' }
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
  return `Method '${method}' acts on the host's own window and is not available to cloud sessions.`
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

/** The tab/pane a claim lands in; the terminal handle itself is checked separately. */
export type CloudTerminalOrphanClaim = { tabId: string; leafId: string }

// Mirrors the parse caps in `session-tabs-schemas-params.ts`: an unparsed request
// reaches this guard, so its layout walk needs the same depth/node limits.
const MAX_ORPHAN_LAYOUT_DEPTH = 64
const MAX_ORPHAN_LAYOUT_NODES = 1024

/**
 * Null when the proposed topology names exactly the claimed tabs and leaf ids,
 * otherwise a refusal message. The handler re-validates; this keeps a mismatched
 * request from reaching it on the strength of a workspace selector alone.
 */
export function cloudTerminalTopologyMismatch(
  topology: unknown,
  claims: readonly CloudTerminalOrphanClaim[]
): string | null {
  if (!topology || typeof topology !== 'object') {
    return 'The proposed topology must describe the claimed tabs.'
  }
  const tabs: unknown = Reflect.get(topology, 'tabs')
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return 'The proposed topology must describe at least one claimed tab.'
  }
  const claimedLeafIdsByTabId = new Map<string, Set<string>>()
  for (const claim of claims) {
    const leafIds = claimedLeafIdsByTabId.get(claim.tabId) ?? new Set<string>()
    leafIds.add(claim.leafId)
    claimedLeafIdsByTabId.set(claim.tabId, leafIds)
  }
  // One topology entry per claimed tab: extra tabs would restore unclaimed panes.
  if (tabs.length !== claimedLeafIdsByTabId.size) {
    return 'The proposed topology does not match the claimed tabs.'
  }
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object') {
      return 'The proposed topology is malformed.'
    }
    const tabId: unknown = Reflect.get(tab, 'tabId')
    if (typeof tabId !== 'string' || tabId.length === 0) {
      return 'The proposed topology names no tab.'
    }
    const claimedLeafIds = claimedLeafIdsByTabId.get(tabId)
    if (claimedLeafIds === undefined) {
      return 'The proposed topology names a tab this call does not claim.'
    }
    const topologyLeafIds = collectLayoutLeafIds(Reflect.get(tab, 'root'))
    if (
      topologyLeafIds === null ||
      topologyLeafIds.size !== claimedLeafIds.size ||
      [...topologyLeafIds].some((leafId) => !claimedLeafIds.has(leafId))
    ) {
      return 'The proposed topology does not match the claimed panes.'
    }
    const activeLeafId: unknown = Reflect.get(tab, 'activeLeafId')
    if (typeof activeLeafId !== 'string' || !topologyLeafIds.has(activeLeafId)) {
      return 'The proposed topology names an active pane it does not contain.'
    }
    const expandedLeafId: unknown = Reflect.get(tab, 'expandedLeafId')
    if (
      expandedLeafId !== null &&
      expandedLeafId !== undefined &&
      (typeof expandedLeafId !== 'string' || !topologyLeafIds.has(expandedLeafId))
    ) {
      return 'The proposed topology names an expanded pane it does not contain.'
    }
  }
  return null
}

function collectLayoutLeafIds(root: unknown): Set<string> | null {
  const leafIds = new Set<string>()
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }]
  let count = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    if (
      current.depth > MAX_ORPHAN_LAYOUT_DEPTH ||
      ++count > MAX_ORPHAN_LAYOUT_NODES ||
      !current.node ||
      typeof current.node !== 'object'
    ) {
      return null
    }
    const type: unknown = Reflect.get(current.node, 'type')
    if (type === 'leaf') {
      const leafId: unknown = Reflect.get(current.node, 'leafId')
      if (typeof leafId !== 'string' || leafId.length === 0) {
        return null
      }
      // Duplicate leaves would let two claims share one pane address.
      if (leafIds.has(leafId)) {
        return null
      }
      leafIds.add(leafId)
      continue
    }
    if (type !== 'split') {
      return null
    }
    stack.push(
      { node: Reflect.get(current.node, 'first'), depth: current.depth + 1 },
      { node: Reflect.get(current.node, 'second'), depth: current.depth + 1 }
    )
  }
  return leafIds
}
