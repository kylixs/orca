/**
 * Asynchronous audit-export worker (U201 E6). Pure runtime: no HTTP. Drains a
 * `queued` job by paging the audit chain (newest-first, cursor = last seq),
 * re-sorts ascending, writes one object file atomically, and records the
 * terminal state. Any failure leaves no artifact behind.
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { AuditQuery, AuditQueryResult } from './audit.ts'
import {
  AUDIT_EXPORT_CSV_BOM,
  AUDIT_EXPORT_CSV_EOL,
  AUDIT_EXPORT_CSV_HEADER,
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
  /** Local chain answers synchronously; a remote writer answers with a promise. */
  query: (filter: AuditQuery) => AuditQueryResult | Promise<AuditQueryResult>
  /** Terminal (`phase: finished`) events are best-effort; failures never alter the job. */
  audit?: AuditExportAuditSink
  now?: () => number
  maxEvents?: number
  maxBytes?: number
  pageSize?: number
  /** Test seam: simulates short writes (ENOSPC) after the file is created. */
  writeChunk?: (filePath: string, body: string) => Promise<void>
}

type ChunkFile = { path: string; bytes: number }

type StreamResult =
  | { ok: true; chunks: ChunkFile[]; bytes: number; totalEvents: number }
  | { ok: false; code: string }

/**
 * Client-visible messages are fixed per code: `job.error` is polled by admins
 * and auditors, so exception text and absolute paths must never reach it.
 */
const failureMessage = (code: string): string => {
  switch (code) {
    case AUDIT_EXPORT_ERROR_TOO_LARGE:
      return '导出数据超过上限。'
    case AUDIT_EXPORT_ERROR_WRITE_FAILED:
      return '导出产物写入失败。'
    case AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE:
      return '审计查询不可用。'
    default:
      return '导出失败。'
  }
}

/** Distinguishes local write faults from query faults so the failure code is unchanged. */
class AuditExportWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuditExportWriteError'
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export class AuditExportWorker {
  private readonly store: AuditExportJobStore
  private readonly query: (filter: AuditQuery) => AuditQueryResult | Promise<AuditQueryResult>
  private readonly audit: AuditExportAuditSink | null
  private readonly clock: () => number
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly pageSize: number
  private readonly writeChunk: (filePath: string, body: string) => Promise<void>

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
    this.writeChunk =
      options.writeChunk ??
      ((filePath, body) => writeFile(filePath, body, { encoding: 'utf8', mode: 0o600 }))
  }

  /** Runs one job. A non-queued/expired/missing job is skipped, never mutated. */
  async runAuditExportJob(jobId: string): Promise<AuditExportRunResult> {
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
      return this.failJob(running, null, AUDIT_EXPORT_ERROR_WRITE_FAILED)
    }

    let streamed: StreamResult
    try {
      streamed = await this.writePagesToChunks(running, objectPath)
    } catch (error) {
      console.error('[audit-export]', error)
      const writeFailed = error instanceof AuditExportWriteError
      return this.failJob(
        running,
        objectPath,
        writeFailed ? AUDIT_EXPORT_ERROR_WRITE_FAILED : AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE
      )
    }
    if (!streamed.ok) {
      return this.failJob(running, objectPath, streamed.code)
    }

    // Chunks are already chronological; assembly streams them in reverse page order.
    let bytes: number
    try {
      bytes = await this.assembleObjectFile(objectPath, running.format, streamed.chunks)
    } catch (error) {
      console.error('[audit-export]', error)
      this.removeChunks(streamed.chunks)
      return this.failJob(running, objectPath, AUDIT_EXPORT_ERROR_WRITE_FAILED)
    }
    this.removeChunks(streamed.chunks)

    const done = this.store.markSucceeded(jobId, {
      totalEvents: streamed.totalEvents,
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
        totalEvents: streamed.totalEvents,
        bytes
      }
    })
    return {
      jobId,
      status: 'succeeded',
      totalEvents: streamed.totalEvents,
      bytes,
      objectPath
    }
  }

  /**
   * FIFO pass over queued jobs; serial so two jobs never write concurrently.
   * `markRunning` is the cross-call claim: every caller persists it before its
   * first await, so an overlapping pass sees the job as no longer queued.
   */
  async processQueuedAuditExports(limit?: number): Promise<AuditExportRunResult[]> {
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
    const results: AuditExportRunResult[] = []
    for (const job of jobs.slice(0, wanted)) {
      results.push(await this.runAuditExportJob(job.jobId))
    }
    return results
  }

  /**
   * Pages newest-first and writes each page, chronological internally, to its own
   * `.part-N` file. Only one page's events and serialized body are held at a time.
   */
  private async writePagesToChunks(
    job: AuditExportJob,
    objectPath: string
  ): Promise<StreamResult> {
    const chunks: ChunkFile[] = []
    const token = `${process.pid}.${randomBytes(6).toString('hex')}`
    let bytes =
      job.format === 'csv'
        ? Buffer.byteLength(
            AUDIT_EXPORT_CSV_BOM + AUDIT_EXPORT_CSV_HEADER + AUDIT_EXPORT_CSV_EOL,
            'utf8'
          )
        : 0
    let totalEvents = 0
    let cursor: number | undefined
    try {
      try {
        const dir = path.dirname(objectPath)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        chmodSync(dir, 0o700)
      } catch (error) {
        throw new AuditExportWriteError(errorMessage(error))
      }
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
        const page = await this.query(filter)
        if (page.events.length > 0) {
          // The chain returns newest-first; a chunk must be chronological too.
          const events = [...page.events].sort((a, b) => a.seq - b.seq)
          let body: string
          try {
            body = this.serializePage(job.format, events)
          } catch (error) {
            throw new AuditExportWriteError(errorMessage(error))
          }
          const chunkPath = `${objectPath}.${token}.part-${chunks.length}`
          // Register first: a short write (ENOSPC) still leaves a file to remove.
          const chunk: ChunkFile = { path: chunkPath, bytes: 0 }
          chunks.push(chunk)
          try {
            await this.writeChunk(chunkPath, body)
          } catch (error) {
            throw new AuditExportWriteError(errorMessage(error))
          }
          const chunkBytes = Buffer.byteLength(body, 'utf8')
          chunk.bytes = chunkBytes
          totalEvents += events.length
          bytes += chunkBytes
        }
        if (totalEvents > this.maxEvents) {
          this.removeChunks(chunks)
          return { ok: false, code: AUDIT_EXPORT_ERROR_TOO_LARGE }
        }
        if (bytes > this.maxBytes) {
          this.removeChunks(chunks)
          return { ok: false, code: AUDIT_EXPORT_ERROR_TOO_LARGE }
        }
        if (page.events.length === 0 || page.nextCursor === null) {
          return { ok: true, chunks, bytes, totalEvents }
        }
        // A cursor that fails to move would page forever; treat it as a query fault.
        if (cursor !== undefined && page.nextCursor >= cursor) {
          throw new Error(`审计分页游标未推进（${cursor} -> ${page.nextCursor}）`)
        }
        cursor = page.nextCursor
      }
    } catch (error) {
      this.removeChunks(chunks)
      throw error
    }
  }

  /** Freshest page first in `chunks`, so the final file is assembled back-to-front. */
  private async assembleObjectFile(
    objectPath: string,
    format: AuditExportFormat,
    chunks: readonly ChunkFile[]
  ): Promise<number> {
    const dir = path.dirname(objectPath)
    const tmp = `${objectPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      // CSV needs its BOM+header before any row; JSONL has no preamble.
      const preamble =
        format === 'csv'
          ? AUDIT_EXPORT_CSV_BOM + AUDIT_EXPORT_CSV_HEADER + AUDIT_EXPORT_CSV_EOL
          : ''
      await writeFile(tmp, preamble, {
        encoding: 'utf8',
        mode: 0o600
      })
      for (let index = chunks.length - 1; index >= 0; index -= 1) {
        const chunk = chunks[index]
        if (!chunk) {
          continue
        }
        await pipeline(
          createReadStream(chunk.path),
          createWriteStream(tmp, { flags: 'a', mode: 0o600 })
        )
      }
      const bytes = statSync(tmp).size
      renameSync(tmp, objectPath)
      return bytes
    } catch (error) {
      this.removeObjectFile(tmp)
      throw error
    }
  }

  private serializePage(format: AuditExportFormat, events: readonly AuditEvent[]): string {
    return format === 'csv'
      ? events.map((event) => toAuditCsvRow(event) + AUDIT_EXPORT_CSV_EOL).join('')
      : events.map(toAuditJsonlLine).join('')
  }

  private removeChunks(chunks: readonly ChunkFile[]): void {
    for (const chunk of chunks) {
      this.removeObjectFile(chunk.path)
    }
  }

  private removeObjectFile(filePath: string): void {
    try {
      rmSync(filePath, { recursive: true, force: true })
    } catch {
      // Best effort: the failure state is what the client polls.
    }
  }

  /**
   * Backstop for unregistered churn: scratch files live only beside the object,
   * so only `.part-`/`.tmp` entries in this job's dir are removed; job.json stays.
   */
  private sweepScratchFiles(objectPath: string): void {
    const dir = path.dirname(objectPath)
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue
      }
      if (entry.name.includes('.part-') || entry.name.endsWith('.tmp')) {
        this.removeObjectFile(path.join(dir, entry.name))
      }
    }
  }

  private failJob(
    job: AuditExportJob,
    objectPath: string | null,
    code: string
  ): AuditExportRunResult {
    const error: AuditExportJobError = { code, message: failureMessage(code) }
    if (objectPath) {
      this.removeObjectFile(objectPath)
      this.sweepScratchFiles(objectPath)
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
   * audit outage must not roll back a terminal state. The sink may be remote,
   * so rejection is handled off the caller's await path.
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
