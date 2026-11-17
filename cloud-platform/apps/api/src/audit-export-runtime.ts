/**
 * Audit export cleanup runtime (U202 E9): one env-configured store per process
 * plus a startup/immediate and periodic prune. Storage-only; no HTTP surface.
 */
import {
  AuditExportJobStore,
  DEFAULT_AUDIT_EXPORT_DOWNLOAD_TOKEN_TTL_MS,
  DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT,
  DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT,
  DEFAULT_AUDIT_EXPORT_ROOT,
  DEFAULT_AUDIT_EXPORT_TTL_MS
} from './audit-export-jobs.ts'

/** Work order §3.4: expired export dirs are swept every five minutes. */
export const DEFAULT_AUDIT_EXPORT_CLEANUP_INTERVAL_MS = 5 * 60_000
/** U206 F17: low-frequency rescue for queued jobs no replica's drain picked up. */
export const DEFAULT_AUDIT_EXPORT_SWEEP_INTERVAL_MS = 15_000

type Env = Record<string, string | undefined>

/** Invalid or blank env falls back rather than disabling cleanup/quota. */
function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : fallback
}

/** Server-side env resolution; keeping it here avoids duplicating the parse rules. */
export function resolveAuditExportSweepIntervalMs(env: Env = process.env): number {
  return positiveInt(env.ORCA_AUDIT_EXPORT_SWEEP_MS, DEFAULT_AUDIT_EXPORT_SWEEP_INTERVAL_MS)
}

/** Download-link lifetime: config/env override, then the five-minute default. */
export function resolveAuditExportTokenTtlMs(env: Env = process.env): number {
  return positiveInt(env.ORCA_AUDIT_EXPORT_TOKEN_TTL_MS, DEFAULT_AUDIT_EXPORT_DOWNLOAD_TOKEN_TTL_MS)
}

/** `ApiConfig` overrides for the process-wide store; absent fields use env. */
export type AuditExportStoreOverrides = {
  dir?: string
  ttlMs?: number
  perUserActiveLimit?: number
  globalActiveLimit?: number
  now?: () => number
}

/**
 * Work order §3.4 names ORCA_AUDIT_EXPORT_DIR; ORCA_AUDIT_EXPORT_ROOT stays as
 * a compatibility alias. An explicit override wins, then DIR, then ROOT, then
 * the default location.
 */
export function createAuditExportStore(
  env: Env = process.env,
  overrides: AuditExportStoreOverrides = {}
): AuditExportJobStore {
  const dir = (overrides.dir ?? '').trim() || (env.ORCA_AUDIT_EXPORT_DIR ?? '').trim()
  const legacyRoot = (env.ORCA_AUDIT_EXPORT_ROOT ?? '').trim()
  return new AuditExportJobStore({
    root: dir || legacyRoot || DEFAULT_AUDIT_EXPORT_ROOT,
    ttlMs:
      overrides.ttlMs ?? positiveInt(env.ORCA_AUDIT_EXPORT_TTL_MS, DEFAULT_AUDIT_EXPORT_TTL_MS),
    perUserActiveLimit:
      overrides.perUserActiveLimit ??
      positiveInt(env.ORCA_AUDIT_EXPORT_PER_USER_LIMIT, DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT),
    globalActiveLimit:
      overrides.globalActiveLimit ??
      positiveInt(env.ORCA_AUDIT_EXPORT_GLOBAL_LIMIT, DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT),
    now: overrides.now
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

export type AuditExportSweepOptions = {
  /** Only the read-only queued listing is needed, so tests can substitute a double. */
  store: Pick<AuditExportJobStore, 'listQueuedIds'>
  /** The owning process's drain trigger; one pass per call, never awaited here. */
  trigger: () => void
  intervalMs?: number
  onError?: (error: unknown) => void
}

export type AuditExportSweepHandle = { stop: () => void }

/**
 * U206 F17: a job accepted by another replica (or whose in-process trigger was
 * lost) has no request to drain it. This unref'd tick rescues any queued job;
 * sweeps across replicas may race, but `markRunning` claims a job once. A
 * poisoned tick is reported, never rethrown, so it cannot stop later ticks.
 */
export function startAuditExportSweep(options: AuditExportSweepOptions): AuditExportSweepHandle {
  const requested = options.intervalMs
  const intervalMs =
    requested !== undefined && Number.isSafeInteger(requested) && requested > 0
      ? requested
      : DEFAULT_AUDIT_EXPORT_SWEEP_INTERVAL_MS

  const report = (error: unknown): void => {
    if (options.onError) {
      options.onError(error)
    } else {
      console.error('[audit-export] sweep failed:', error)
    }
  }

  const run = (): void => {
    try {
      if (options.store.listQueuedIds().length > 0) {
        options.trigger()
      }
    } catch (error) {
      report(error)
    }
  }

  const timer = setInterval(run, intervalMs)
  // Never hold process exit open for housekeeping.
  timer.unref()

  return { stop: () => clearInterval(timer) }
}
