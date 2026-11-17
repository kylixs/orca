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

export function createAuditExportStore(env: Env = process.env): AuditExportJobStore {
  const root = (env.ORCA_AUDIT_EXPORT_ROOT ?? '').trim()
  return new AuditExportJobStore({
    root: root || DEFAULT_AUDIT_EXPORT_ROOT,
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
  /** Only pruning is needed, so tests can substitute a throwing double. */
  store: Pick<AuditExportJobStore, 'pruneExpired'>
  intervalMs?: number
  onError?: (error: unknown) => void
}

export type AuditExportCleanupHandle = {
  stop: () => void
  runNow: () => void
}

/**
 * Runs one prune immediately, then on an unref'd interval. A failed sweep is
 * reported, never rethrown: cleanup must not crash the long-lived API process.
 */
export function startAuditExportCleanup(
  options: AuditExportCleanupOptions
): AuditExportCleanupHandle {
  const requested = options.intervalMs
  const intervalMs =
    requested !== undefined && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : DEFAULT_AUDIT_EXPORT_CLEANUP_INTERVAL_MS

  const runNow = (): void => {
    try {
      options.store.pruneExpired()
    } catch (error) {
      if (options.onError) {
        options.onError(error)
      } else {
        console.error('[audit-export] cleanup failed:', error)
      }
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
