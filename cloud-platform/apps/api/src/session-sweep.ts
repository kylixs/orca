/**
 * D18 / U233 F6: periodic session housekeeping. Expiry is discovered lazily on
 * refresh; this sweep reaps the credentials a client never came back for.
 *
 * No persistence, no FIFO, no new endpoint — it only deletes store entries that
 * can no longer authenticate anyone and keeps `revocations` untouched.
 */

import type { Session, Store } from './store.ts'

export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000
/** Fixed by the decision: long enough to cover the refresh-token grace window. */
export const SESSION_RETENTION_MS = 60_000

const SWEEP_ENV = 'ORCA_CLOUD_SESSION_SWEEP_MS'

type Env = Record<string, string | undefined>

/** Blank/invalid falls back to the default; an explicit `0` disables the sweep. */
export function resolveSessionSweepIntervalMs(env: Env = process.env): number {
  const raw = env[SWEEP_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_SESSION_SWEEP_INTERVAL_MS
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SESSION_SWEEP_INTERVAL_MS
}

export type SessionSweepDeps = {
  store: Store
  now: () => number
  /** The server's first-revocation gate, so an expired session is audited once. */
  revokeSessionOnce: (session: Session) => boolean
  /** Best-effort `session.expired` writer, called only when the revoke wins. */
  recordExpired: (session: Session) => void
}

/**
 * One pass. Expired live sessions are revoked now and deleted only after
 * retention, so the grace window never loses a session mid-rotation.
 */
export function sweepSessionsOnce(deps: SessionSweepDeps): void {
  const { store, now, revokeSessionOnce, recordExpired } = deps
  const at = now()

  for (const session of store.sessions.values()) {
    if (session.revokedAt === null && session.refreshExpiresAt < at) {
      if (revokeSessionOnce(session)) recordExpired(session)
    }
  }

  for (const [sessionId, session] of store.sessions) {
    if (session.revokedAt === null || session.revokedAt + SESSION_RETENTION_MS > at) continue
    for (const [digest, owner] of store.refreshTokens) {
      if (owner === sessionId) store.refreshTokens.delete(digest)
    }
    store.sessions.delete(sessionId)
  }

  for (const [token, entry] of store.accessTokens) {
    const session = store.sessions.get(entry.sessionId)
    if (!session || session.revokedAt !== null || entry.expiresAt < at) {
      store.accessTokens.delete(token)
    }
  }

  // Covers sessions removed outside this sweep as well as the loop above.
  for (const [digest, sessionId] of store.refreshTokens) {
    if (!store.sessions.has(sessionId)) store.refreshTokens.delete(digest)
  }
}

export type SessionSweepHandle = {
  sweep: () => void
  stop: () => void
}

export type StartSessionSweepOptions = SessionSweepDeps & { intervalMs?: number }

/**
 * `intervalMs: 0` returns an inert handle so the caller needs no branch. Any
 * tick failure is logged, never rethrown: housekeeping must not crash the API.
 */
export function startSessionSweep(options: StartSessionSweepOptions): SessionSweepHandle {
  const requested = options.intervalMs
  const intervalMs =
    requested !== undefined && Number.isSafeInteger(requested) && requested >= 0
      ? requested
      : DEFAULT_SESSION_SWEEP_INTERVAL_MS

  const run = (): void => {
    try {
      sweepSessionsOnce(options)
    } catch (error) {
      console.error('[session-sweep] failed:', error)
    }
  }

  // `0` is the kill switch: no startup prune and no timer.
  if (intervalMs === 0) return { sweep: run, stop: () => {} }

  // Same pattern as audit-export cleanup: prune once at startup, then tick.
  run()
  const timer = setInterval(run, intervalMs)
  // Never hold process exit open for housekeeping.
  timer.unref()
  return { sweep: run, stop: () => clearInterval(timer) }
}
