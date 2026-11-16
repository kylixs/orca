/**
 * U153: a user's "New tab" click is a focus gesture the host must persist. A pane mount alone is
 * not — restored/mirrored panes reuse the same create path. Mark only click-created tabs here;
 * the pane transport consumes the mark once it has the host tabId/leafId from `terminal.create`.
 */
const USER_INITIATED_CREATE_TTL_MS = 2 * 60_000

const markedAtByTabId = new Map<string, number>()

function sweepExpiredMarks(now: number): void {
  for (const [tabId, markedAt] of markedAtByTabId) {
    if (now - markedAt > USER_INITIATED_CREATE_TTL_MS) {
      markedAtByTabId.delete(tabId)
    }
  }
}

export function markUserInitiatedTerminalCreate(tabId: string): void {
  if (tabId) {
    const now = Date.now()
    // Why: failed/aborted creates never reach a consumer, so expire their marks on the next write.
    sweepExpiredMarks(now)
    markedAtByTabId.set(tabId, now)
  }
}

export function peekUserInitiatedTerminalCreate(tabId: string): boolean {
  const markedAt = markedAtByTabId.get(tabId)
  if (markedAt === undefined) {
    return false
  }
  if (Date.now() - markedAt > USER_INITIATED_CREATE_TTL_MS) {
    markedAtByTabId.delete(tabId)
    return false
  }
  return true
}

export function consumeUserInitiatedTerminalCreate(tabId: string): void {
  markedAtByTabId.delete(tabId)
}

/** Drop the mark when the create fails or aborts, so a later remount cannot replay the gesture. */
export function discardUserInitiatedTerminalCreate(tabId: string): void {
  markedAtByTabId.delete(tabId)
}

export function clearUserInitiatedTerminalCreateForTests(): void {
  markedAtByTabId.clear()
}
