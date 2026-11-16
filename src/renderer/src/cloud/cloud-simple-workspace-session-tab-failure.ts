/**
 * U112 D4/D5 classification for the simple workspace's session-tabs channel.
 * §2.2: only `forbidden` / `method_not_found` are one-shot degradations; a
 * transient transport failure must retry (stream) or leave the action retryable,
 * and a row the peer already retired is a success, not a failure.
 */

/** §2.2: only these prove the host can never serve the method for this session. */
const PERMANENT_SYNC_FAILURE_CODES: ReadonlySet<string> = new Set([
  'forbidden',
  'method_not_found',
  'rpc_method_not_found',
  'method_not_supported'
])

/** A row the peer already retired: a repeated close succeeded, it is not a failure. */
const MISSING_TAB_CODES: ReadonlySet<string> = new Set([
  'tab_not_found',
  'terminal_tab_not_found',
  'session_tab_not_found'
])

/** U112 D5 (§2.2 step 4): transient drops retry with backoff, then degrade. */
export const SESSION_TABS_RECONNECT_DELAYS_MS = [500, 1_000, 2_000]

export type SessionTabsFailure = { code: string; message?: string }

export function isPermanentSyncFailure(failure: SessionTabsFailure): boolean {
  return PERMANENT_SYNC_FAILURE_CODES.has(failure.code)
}

export function isMissingTabFailure(failure: SessionTabsFailure): boolean {
  // Why the message: the dispatcher flattens a thrown `tab_not_found` to runtime_error.
  return (
    MISSING_TAB_CODES.has(failure.code) ||
    (failure.message !== undefined && MISSING_TAB_CODES.has(failure.message))
  )
}

/** U112 D4: a failed action retires only itself, never the whole sync channel. */
export type DegradedActions = { activate: boolean; close: boolean; create: boolean }

export function freshDegradedActions(): DegradedActions {
  return { activate: false, close: false, create: false }
}
