/**
 * Audit export cleanup runtime (U202 E9): one env-configured store per process
 * plus a startup/immediate and periodic prune. Storage-only; no HTTP surface.
 */
import {
  AuditExportJobStore,
  DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT,
  DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT,
  DEFAULT_AUDIT_EXPORT_ROOT,
  DEFAULT_AUDIT_EXPORT_TTL_MS
} from './audit-export-jobs.ts'

/** Work order §3.4: expired export dirs are swept every five minutes. */
export const DEFAULT_AUDIT_EXPORT_CLEANUP_INTERVAL_MS = 5 * 60_000

type Env = Record<string, string | undefined>

/** Invalid or blank env falls back rather than disabling cleanup/quota. */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : fallback
}

/**
 * Work order §3.4 names ORCA_AUDIT_EXPORT_DIR; ORCA_AUDIT_EXPORT_ROOT stays as
 * a compatibility alias. DIR wins, then ROOT, then the default location.
 */
export function createAuditExportStore(env: Env = process.env): AuditExportJobStore {
  const dir = (env.ORCA_AUDIT_EXPORT_DIR ?? '').trim()
  const legacyRoot = (env.ORCA_AUDIT_EXPORT_ROOT ?? '').trim()
  return new AuditExportJobStore({
    root: dir || legacyRoot || DEFAULT_AUDIT_EXPORT_ROOT,
    ttlMs: positiveInt(env.ORCA_AUDIT_EXPORT_TTL_MS, DEFAULT_AUDIT_EXPORT_TTL_MS),
    perUserActiveLimit: positiveInt(
      env.ORCA_AUDIT_EXPORT_PER_USER_LIMIT,
      DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT
    ),
    globalActiveLimit: positiveInt(
      env.ORCA_AUDIT_EXPORT_GLOBAL_LIMIT,
      DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT
    )
  })
}

export type AuditExportCleanupOptions = {
  /** Only recovery and pruning are needed, so tests can substitute a double. */
  store: Pick<AuditExportJobStore, 'recoverInterrupted' | 'pruneExpired'>
  intervalMs?: number
  onError?: (error: unknown) => void
}

export type AuditExportCleanupHandle = {
  stop: () => void
  runNow: () => void
}

/**
 * Recovers interrupted jobs once, before the first prune, then prunes
 * immediately and on an unref'd interval. Failures are reported, never
 * rethrown: housekeeping must not crash the long-lived API process.
 */
export function startAuditExportCleanup(
  options: AuditExportCleanupOptions
): AuditExportCleanupHandle {
  const requested = options.intervalMs
  const intervalMs =
    requested !== undefined && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : DEFAULT_AUDIT_EXPORT_CLEANUP_INTERVAL_MS

  const report = (error: unknown): void => {
    if (options.onError) {
      options.onError(error)
    } else {
      console.error('[audit-export] cleanup failed:', error)
    }
  }

  let recoveryAttempted = false
  const runNow = (): void => {
    if (!recoveryAttempted) {
      recoveryAttempted = true
      try {
        options.store.recoverInterrupted()
      } catch (error) {
        report(error)
      }
    }
    try {
      options.store.pruneExpired()
    } catch (error) {
      report(error)
    }
  }

  runNow()
  const timer = setInterval(runNow, intervalMs)
  // Never hold process exit open for housekeeping.
  timer.unref()

  return {
    runNow,
    stop: () => clearInterval(timer)
  }
}
