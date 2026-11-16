/**
 * U153: a user's "New tab" click is a focus gesture the host must persist. A pane mount alone is
 * not — restored/mirrored panes reuse the same create path. Mark only click-created tabs here;
 * the pane transport consumes the mark once it has the host tabId/leafId from `terminal.create`.
 */
const USER_INITIATED_CREATE_TTL_MS = 2 * 60_000

const markedAtByTabId = new Map<string, number>()

export function markUserInitiatedTerminalCreate(tabId: string): void {
  if (tabId) {
    markedAtByTabId.set(tabId, Date.now())
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
