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

// Why: U161 R3 — two environments can share a worktreeId, so an env-less bucket keeps legacy
// marks from answering another environment's scoped query.
const LEGACY_ENVIRONMENT_KEY = ''

const marksByEnvironmentId = new Map<string, Map<string, UserInitiatedCreateMark>>()

function environmentKey(environmentId: string | null | undefined): string {
  return environmentId ?? LEGACY_ENVIRONMENT_KEY
}

function sweepExpiredMarks(now: number): void {
  for (const [environmentKey, marks] of marksByEnvironmentId) {
    for (const [tabId, mark] of marks) {
      if (now - mark.markedAt > USER_INITIATED_CREATE_TTL_MS) {
        marks.delete(tabId)
      }
    }
    if (marks.size === 0) {
      marksByEnvironmentId.delete(environmentKey)
    }
  }
}

function findMark(
  tabId: string,
  environmentId?: string | null
): { environmentKey: string; mark: UserInitiatedCreateMark } | undefined {
  if (environmentId != null) {
    const mark = marksByEnvironmentId.get(environmentId)?.get(tabId)
    return mark === undefined ? undefined : { environmentKey: environmentId, mark }
  }
  // Why: legacy callers passed no environment; tab ids are unique per renderer, so any bucket owns it.
  for (const [environmentKey, marks] of marksByEnvironmentId) {
    const mark = marks.get(tabId)
    if (mark !== undefined) {
      return { environmentKey, mark }
    }
  }
  return undefined
}

function deleteMark(tabId: string, environmentId?: string | null): void {
  if (environmentId != null) {
    const marks = marksByEnvironmentId.get(environmentId)
    marks?.delete(tabId)
    if (marks?.size === 0) {
      marksByEnvironmentId.delete(environmentId)
    }
    return
  }
  for (const [environmentKey, marks] of marksByEnvironmentId) {
    if (marks.delete(tabId) && marks.size === 0) {
      marksByEnvironmentId.delete(environmentKey)
    }
  }
}

export function markUserInitiatedTerminalCreate(
  tabId: string,
  worktreeId?: string,
  environmentId?: string | null
): void {
  if (tabId) {
    const now = Date.now()
    // Why: failed/aborted creates never reach a consumer, so expire their marks on the next write.
    sweepExpiredMarks(now)
    const key = environmentKey(environmentId)
    const marks = marksByEnvironmentId.get(key) ?? new Map<string, UserInitiatedCreateMark>()
    marks.set(tabId, {
      ...(worktreeId ? { worktreeId } : {}),
      markedAt: now
    })
    marksByEnvironmentId.set(key, marks)
  }
}

export function peekUserInitiatedTerminalCreate(
  tabId: string,
  environmentId?: string | null
): boolean {
  const found = findMark(tabId, environmentId)
  if (found === undefined) {
    return false
  }
  if (Date.now() - found.mark.markedAt > USER_INITIATED_CREATE_TTL_MS) {
    marksByEnvironmentId.get(found.environmentKey)?.delete(tabId)
    return false
  }
  return true
}

/**
 * U161: a host frame that predates the create must not steal the tab the user just opened, so the
 * host-active follow stands down for the whole worktree while any create gesture is in flight.
 * A scoped query never sees an env-less legacy mark, so two environments sharing a worktreeId
 * cannot suppress each other (U161 R3).
 */
export function peekUserInitiatedTerminalCreateForWorktree(
  worktreeId: string,
  environmentId?: string | null
): boolean {
  if (!worktreeId) {
    return false
  }
  sweepExpiredMarks(Date.now())
  const buckets =
    environmentId != null
      ? [marksByEnvironmentId.get(environmentId)]
      : [...marksByEnvironmentId.values()]
  return buckets.some((marks) => {
    if (marks === undefined) {
      return false
    }
    for (const mark of marks.values()) {
      if (mark.worktreeId === worktreeId) {
        return true
      }
    }
    return false
  })
}

export function consumeUserInitiatedTerminalCreate(
  tabId: string,
  environmentId?: string | null
): void {
  deleteMark(tabId, environmentId)
}

/** Drop the mark when the create fails or aborts, so a later remount cannot replay the gesture. */
export function discardUserInitiatedTerminalCreate(
  tabId: string,
  environmentId?: string | null
): void {
  deleteMark(tabId, environmentId)
}

export function clearUserInitiatedTerminalCreateForTests(): void {
  marksByEnvironmentId.clear()
}
