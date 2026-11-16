/**
 * U153: a user's "New tab" click is a focus gesture the host must persist. A pane mount alone is
 * not — restored/mirrored panes reuse the same create path. Mark only click-created tabs here;
 * the pane transport consumes the mark once it has the host tabId/leafId from `terminal.create`.
 */
const USER_INITIATED_CREATE_TTL_MS = 2 * 60_000

type UserInitiatedCreateMark = {
  worktreeId?: string
  markedAt: number
}

const marksByTabId = new Map<string, UserInitiatedCreateMark>()

function sweepExpiredMarks(now: number): void {
  for (const [tabId, mark] of marksByTabId) {
    if (now - mark.markedAt > USER_INITIATED_CREATE_TTL_MS) {
      marksByTabId.delete(tabId)
    }
  }
}

export function markUserInitiatedTerminalCreate(tabId: string, worktreeId?: string): void {
  if (tabId) {
    const now = Date.now()
    // Why: failed/aborted creates never reach a consumer, so expire their marks on the next write.
    sweepExpiredMarks(now)
    marksByTabId.set(tabId, {
      ...(worktreeId ? { worktreeId } : {}),
      markedAt: now
    })
  }
}

export function peekUserInitiatedTerminalCreate(tabId: string): boolean {
  const mark = marksByTabId.get(tabId)
  if (mark === undefined) {
    return false
  }
  if (Date.now() - mark.markedAt > USER_INITIATED_CREATE_TTL_MS) {
    marksByTabId.delete(tabId)
    return false
  }
  return true
}

/**
 * U161: a host frame that predates the create must not steal the tab the user just opened, so the
 * host-active follow stands down for the whole worktree while any create gesture is in flight.
 */
export function peekUserInitiatedTerminalCreateForWorktree(worktreeId: string): boolean {
  if (!worktreeId) {
    return false
  }
  const now = Date.now()
  sweepExpiredMarks(now)
  for (const mark of marksByTabId.values()) {
    if (mark.worktreeId === worktreeId) {
      return true
    }
  }
  return false
}

export function consumeUserInitiatedTerminalCreate(tabId: string): void {
  marksByTabId.delete(tabId)
}

/** Drop the mark when the create fails or aborts, so a later remount cannot replay the gesture. */
export function discardUserInitiatedTerminalCreate(tabId: string): void {
  marksByTabId.delete(tabId)
}

export function clearUserInitiatedTerminalCreateForTests(): void {
  marksByTabId.clear()
}
