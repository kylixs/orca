/**
 * Asynchronous audit-export worker (U201 E6). Pure runtime: no HTTP. Drains a
 * `queued` job by paging the audit chain (newest-first, cursor = last seq),
 * re-sorts ascending, writes one object file atomically, and records the
 * terminal state. Any failure leaves no artifact behind.
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import type { AuditQuery, AuditQueryResult } from './audit.ts'
import {
  AUDIT_EXPORT_CSV_EOL,
  AUDIT_EXPORT_CSV_HEADER,
  serializeAuditCsv,
  serializeAuditJsonl,
  toAuditCsvRow,
  toAuditJsonlLine
} from './audit-export-format.ts'
import type {
  AuditExportFormat,
  AuditExportJob,
  AuditExportJobError,
  AuditExportJobStore
} from './audit-export-jobs.ts'
import {
  isValidAuditExportJobId,
  resolveAuditExportObjectPath
} from './audit-export-jobs.ts'
import type { AuditEvent } from './store.ts'

/** Size limits are injectable because the final values are not yet ratified (design D4). */
export const DEFAULT_AUDIT_EXPORT_MAX_EVENTS = 100_000
export const DEFAULT_AUDIT_EXPORT_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_AUDIT_EXPORT_PAGE_SIZE = 200
/** The remote audit writer caps a page at 200; a larger ask is silently truncated there. */
export const AUDIT_EXPORT_MAX_PAGE_SIZE = 200

export const AUDIT_EXPORT_ERROR_TOO_LARGE = 'EXPORT_TOO_LARGE'
export const AUDIT_EXPORT_ERROR_WRITE_FAILED = 'EXPORT_WRITE_FAILED'
export const AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE = 'EXPORT_AUDIT_UNAVAILABLE'

export type AuditExportSkipReason = 'not-found' | 'expired' | 'not-queued'

export type AuditExportRunResult =
  | { jobId: string; status: 'succeeded'; totalEvents: number; bytes: number; objectPath: string }
  | { jobId: string; status: 'failed'; error: AuditExportJobError }
  | { jobId: string; status: 'skipped'; reason: AuditExportSkipReason }

/** Terminal audit event (U201 E6): acceptance is recorded by the HTTP route. */
export type AuditExportTerminalAuditEvent = {
  eventType: string
  actor?: string
  targetType: string
  targetId: string
  result: 'success' | 'failure'
  traceId?: string
  metadata?: Record<string, unknown>
}

export type AuditExportAuditSink = {
  append: (event: AuditExportTerminalAuditEvent) => Promise<void>
}

export type AuditExportWorkerOptions = {
  store: AuditExportJobStore
  /** Same shape as `AuditChain.query`; injected so tests need no real chain. */
  query: (filter: AuditQuery) => AuditQueryResult
  /** Terminal (`phase: finished`) events are best-effort; failures never alter the job. */
  audit?: AuditExportAuditSink
  now?: () => number
  maxEvents?: number
  maxBytes?: number
  pageSize?: number
}

type CollectResult =
  | { ok: true; events: AuditEvent[]; bytes: number }
  | { ok: false; code: string; message: string }

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export class AuditExportWorker {
  private readonly store: AuditExportJobStore
  private readonly query: (filter: AuditQuery) => AuditQueryResult
  private readonly audit: AuditExportAuditSink | null
  private readonly clock: () => number
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly pageSize: number

  constructor(options: AuditExportWorkerOptions) {
    this.store = options.store
    this.query = options.query
    this.audit = options.audit ?? null
    this.clock = options.now ?? Date.now
    this.maxEvents = options.maxEvents ?? DEFAULT_AUDIT_EXPORT_MAX_EVENTS
    this.maxBytes = options.maxBytes ?? DEFAULT_AUDIT_EXPORT_MAX_BYTES
    const requested = Math.floor(options.pageSize ?? DEFAULT_AUDIT_EXPORT_PAGE_SIZE)
    this.pageSize =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, AUDIT_EXPORT_MAX_PAGE_SIZE)
        : AUDIT_EXPORT_MAX_PAGE_SIZE
  }

  /** Runs one job. A non-queued/expired/missing job is skipped, never mutated. */
  runAuditExportJob(jobId: string): AuditExportRunResult {
    const job = this.store.read(jobId)
    if (!job) {
      return { jobId, status: 'skipped', reason: 'not-found' }
    }
    if (job.expiresAt <= this.clock()) {
      return { jobId, status: 'skipped', reason: 'expired' }
    }
    if (job.status !== 'queued') {
      return { jobId, status: 'skipped', reason: 'not-queued' }
    }
    let running: AuditExportJob | null
    try {
      running = this.store.markRunning(jobId)
    } catch {
      // Lost a queued→running race to another worker; leave the job to that writer.
      return { jobId, status: 'skipped', reason: 'not-queued' }
    }
    if (!running) {
      return { jobId, status: 'skipped', reason: 'expired' }
    }

    const objectPath = resolveAuditExportObjectPath(this.store.root, jobId, running.format)
    if (!objectPath) {
      return this.failJob(running, null, {
        code: AUDIT_EXPORT_ERROR_WRITE_FAILED,
        message: '导出产物路径无效。'
      })
    }

    let collected: CollectResult
    try {
      collected = this.collect(running)
    } catch (error) {
      return this.failJob(running, objectPath, {
        code: AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE,
        message: `审计查询失败：${errorMessage(error)}`
      })
    }
    if (!collected.ok) {
      return this.failJob(running, objectPath, {
        code: collected.code,
        message: collected.message
      })
    }

    // The chain pages newest-first; export is chronological (design §4.5).
    let body: string
    let bytes: number
    try {
      collected.events.sort((a, b) => a.seq - b.seq)
      body = this.serialize(running.format, collected.events)
      bytes = Buffer.byteLength(body, 'utf8')
    } catch (error) {
      return this.failJob(running, objectPath, {
        code: AUDIT_EXPORT_ERROR_WRITE_FAILED,
        message: `导出序列化失败：${errorMessage(error)}`
      })
    }
    if (bytes > this.maxBytes) {
      return this.failJob(running, objectPath, {
        code: AUDIT_EXPORT_ERROR_TOO_LARGE,
        message: `导出字节数 ${bytes} 超过上限 ${this.maxBytes}。`
      })
    }

    try {
      this.writeObjectFile(objectPath, body)
    } catch (error) {
      return this.failJob(running, objectPath, {
        code: AUDIT_EXPORT_ERROR_WRITE_FAILED,
        message: `导出产物写入失败：${errorMessage(error)}`
      })
    }

    const done = this.store.markSucceeded(jobId, {
      totalEvents: collected.events.length,
      bytes
    })
    if (!done) {
      // Expired while running: keep the job pollable as expired, drop the artifact.
      this.removeObjectFile(objectPath)
      return { jobId, status: 'skipped', reason: 'expired' }
    }
    this.emitTerminalAudit({
      eventType: 'audit_export',
      actor: running.requestedByUsername,
      targetType: 'audit',
      targetId: jobId,
      result: 'success',
      metadata: {
        jobId,
        phase: 'finished',
        format: running.format,
        totalEvents: collected.events.length,
        bytes
      }
    })
    return {
      jobId,
      status: 'succeeded',
      totalEvents: collected.events.length,
      bytes,
      objectPath
    }
  }

  /** FIFO pass over queued jobs; the timer/route will call this later (E9). */
  processQueuedAuditExports(limit?: number): AuditExportRunResult[] {
    const jobs: AuditExportJob[] = []
    for (const entry of this.readRoot()) {
      if (!entry.isDirectory() || !isValidAuditExportJobId(entry.name)) {
        continue
      }
      const job = this.store.read(entry.name)
      // Expiry is derived, so an expired queued record is no longer work (E9 prunes it).
      if (job && job.status === 'queued' && job.expiresAt > this.clock()) {
        jobs.push(job)
      }
    }
    // Same-millisecond creates have no inherent order; jobId keeps the pass deterministic.
    jobs.sort((a, b) => a.createdAt - b.createdAt || (a.jobId < b.jobId ? -1 : 1))
    const wanted =
      limit === undefined || !Number.isFinite(limit)
        ? jobs.length
        : Math.max(0, Math.floor(limit))
    return jobs.slice(0, wanted).map((job) => this.runAuditExportJob(job.jobId))
  }

  private collect(job: AuditExportJob): CollectResult {
    const events: AuditEvent[] = []
    let bytes =
      job.format === 'csv'
        ? Buffer.byteLength(AUDIT_EXPORT_CSV_HEADER + AUDIT_EXPORT_CSV_EOL, 'utf8')
        : 0
    let cursor: number | undefined
    for (;;) {
      const filter: AuditQuery = {
        limit: this.pageSize,
        actor: job.query.actor,
        eventType: job.query.eventType,
        eventTypes: job.query.eventTypes,
        result: job.query.result,
        traceId: job.query.traceId,
        fileName: job.query.fileName,
        keyword: job.query.keyword,
        since: job.query.since,
        until: job.query.until,
        username: job.query.username,
        projectId: job.query.projectId,
        hostId: job.query.hostId,
        cursor
      }
      const page = this.query(filter)
      for (const event of page.events) {
        events.push(event)
        bytes += this.eventBytes(event, job.format)
      }
      if (events.length > this.maxEvents) {
        return {
          ok: false,
          code: AUDIT_EXPORT_ERROR_TOO_LARGE,
          message: `导出事件数 ${events.length} 超过上限 ${this.maxEvents}。`
        }
      }
      if (bytes > this.maxBytes) {
        return {
          ok: false,
          code: AUDIT_EXPORT_ERROR_TOO_LARGE,
          message: `导出字节数超过上限 ${this.maxBytes}。`
        }
      }
      if (page.events.length === 0 || page.nextCursor === null) {
        return { ok: true, events, bytes }
      }
      // A cursor that fails to move would page forever; treat it as a query fault.
      if (cursor !== undefined && page.nextCursor >= cursor) {
        throw new Error(`审计分页游标未推进（${cursor} -> ${page.nextCursor}）`)
      }
      cursor = page.nextCursor
    }
  }

  private eventBytes(event: AuditEvent, format: AuditExportFormat): number {
    const chunk =
      format === 'csv' ? toAuditCsvRow(event) + AUDIT_EXPORT_CSV_EOL : toAuditJsonlLine(event)
    return Buffer.byteLength(chunk, 'utf8')
  }

  private serialize(format: AuditExportFormat, events: readonly AuditEvent[]): string {
    return format === 'csv' ? serializeAuditCsv(events) : serializeAuditJsonl(events)
  }

  /** tmp+rename in the job dir, 0600; a failure removes the tmp so nothing partial survives. */
  private writeObjectFile(objectPath: string, body: string): void {
    const dir = path.dirname(objectPath)
    const tmp = `${objectPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, objectPath)
    } catch (error) {
      this.removeObjectFile(tmp)
      throw error
    }
  }

  private removeObjectFile(filePath: string): void {
    try {
      rmSync(filePath, { recursive: true, force: true })
    } catch {
      // Best effort: the failure state is what the client polls.
    }
  }

  private failJob(
    job: AuditExportJob,
    objectPath: string | null,
    error: AuditExportJobError
  ): AuditExportRunResult {
    if (objectPath) {
      this.removeObjectFile(objectPath)
    }
    try {
      this.store.markFailed(job.jobId, error)
    } catch {
      // An expired/gone job still surfaces the failure to the caller.
    }
    this.emitTerminalAudit({
      eventType: 'audit_export',
      actor: job.requestedByUsername,
      targetType: 'audit',
      targetId: job.jobId,
      result: 'failure',
      metadata: {
        jobId: job.jobId,
        phase: 'finished',
        format: job.format,
        errorCode: error.code
      }
    })
    return { jobId: job.jobId, status: 'failed', error }
  }

  /**
   * Best-effort by design: the job record is the client-visible truth, so an
   * audit outage must not roll back a terminal state. Remote writers are async
   * while `runAuditExportJob` is sync, so rejection is handled off the call.
   */
  private emitTerminalAudit(event: AuditExportTerminalAuditEvent): void {
    if (!this.audit) {
      return
    }
    try {
      void Promise.resolve(this.audit.append(event)).catch((error: unknown) => {
        console.error('[audit-export] terminal audit failed:', errorMessage(error))
      })
    } catch (error) {
      console.error('[audit-export] terminal audit failed:', errorMessage(error))
    }
  }

  private readRoot() {
    return existsSync(this.store.root)
      ? readdirSync(this.store.root, { withFileTypes: true })
      : []
  }
}
