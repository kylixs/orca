/**
 * File-backed audit export job records and lifecycle primitives (U201 E3).
 * Pure storage: no HTTP, no audit-chain writes. Each job lives in
 * `<root>/<jobId>/job.json`, written tmp+rename so a crash never leaves a torn
 * record. `expired` is derived from `expiresAt` and never persisted.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AuditQueryFilters } from './audit-query.ts'

export const AUDIT_EXPORT_JOB_ID_PATTERN = /^exp_[0-9a-f]{24}$/
export const AUDIT_EXPORT_JOB_FILE = 'job.json'
export const DEFAULT_AUDIT_EXPORT_ROOT = path.join(homedir(), '.orca-cloud', 'audit-exports')
export const DEFAULT_AUDIT_EXPORT_TTL_MS = 60 * 60_000
export const DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT = 2
export const DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT = 8
/** Download links are single-use and short-lived (design §4.2). */
export const DEFAULT_AUDIT_EXPORT_DOWNLOAD_TOKEN_TTL_MS = 5 * 60_000

/** Object keys are server constants; a client can never name the artifact. */
export const AUDIT_EXPORT_OBJECT_KEYS = { csv: 'events.csv', jsonl: 'events.jsonl' } as const

export type AuditExportFormat = keyof typeof AUDIT_EXPORT_OBJECT_KEYS
export type AuditExportObjectKey = (typeof AUDIT_EXPORT_OBJECT_KEYS)[AuditExportFormat]
export type AuditExportJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'
export type PersistedAuditExportStatus = Exclude<AuditExportJobStatus, 'expired'>
export type AuditExportJobError = { code: string; message: string }

export type AuditExportJob = {
  jobId: string
  requestedBy: string
  requestedByUsername: string
  /** Normalized filter snapshot, including the clamped since/until window. */
  query: AuditQueryFilters
  format: AuditExportFormat
  status: PersistedAuditExportStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  expiresAt: number
  objectKey: AuditExportObjectKey
  totalEvents: number | null
  bytes: number | null
  error: AuditExportJobError | null
  deleteAfterDownload: boolean
  downloadedAt: number | null
  downloadTokenHash: string | null
  downloadTokenExpiresAt: number | null
}

export function generateAuditExportJobId(): string {
  return `exp_${randomBytes(12).toString('hex')}`
}

export function isValidAuditExportJobId(jobId: string): boolean {
  return AUDIT_EXPORT_JOB_ID_PATTERN.test(jobId)
}

function isContainedRelative(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Resolves a job directory, refusing traversal, absolute paths, and non-hex ids. */
export function resolveAuditExportJobDir(root: string, jobId: string): string | null {
  if (!isValidAuditExportJobId(jobId)) {
    return null
  }
  const resolvedRoot = path.resolve(root)
  const dir = path.resolve(resolvedRoot, jobId)
  // Regex already excludes separators; this catches a bad root or future regex drift.
  if (path.dirname(dir) !== resolvedRoot || !isContainedRelative(resolvedRoot, dir)) {
    return null
  }
  return dir
}

export function resolveAuditExportObjectPath(
  root: string,
  jobId: string,
  format: AuditExportFormat
): string | null {
  const dir = resolveAuditExportJobDir(root, jobId)
  if (!dir) {
    return null
  }
  const file = path.resolve(dir, AUDIT_EXPORT_OBJECT_KEYS[format])
  return isContainedRelative(dir, file) ? file : null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
const PERSISTED_STATUSES = ['queued', 'running', 'succeeded', 'failed']

function isAuditExportJob(value: unknown): value is AuditExportJob {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.jobId === 'string' &&
    typeof value.requestedBy === 'string' &&
    typeof value.requestedByUsername === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.expiresAt === 'number' &&
    typeof value.objectKey === 'string' &&
    typeof value.deleteAfterDownload === 'boolean' &&
    isRecord(value.query) &&
    (value.format === 'csv' || value.format === 'jsonl') &&
    PERSISTED_STATUSES.some((status) => status === value.status)
  )
}

/** Writes 0600 tmp+rename; on failure removes the tmp so no half record survives. */
export function writeAuditExportJobFileAtomic(filePath: string, job: AuditExportJob): void {
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(job)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, filePath)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export type AuditExportJobStoreOptions = {
  root?: string
  ttlMs?: number
  perUserActiveLimit?: number
  globalActiveLimit?: number
  /** Injected clock keeps expiry/quota tests deterministic. */
  now?: () => number
}

export type CreateAuditExportJobInput = {
  /** Pre-generated by the route so acceptance can be audited before the job exists (F12). */
  jobId?: string
  requestedBy: string
  requestedByUsername: string
  query: AuditQueryFilters
  format: AuditExportFormat
  deleteAfterDownload?: boolean
}

export type AuditExportQuotaResult = { ok: true } | { ok: false; reason: 'per-user' | 'global' }

export type IssueAuditExportDownloadTokenOptions = { ttlMs?: number }

export type AuditExportDownloadToken = { token: string; expiresAt: number }

export type AuditExportDownloadTokenReason = 'invalid' | 'expired' | 'not-ready'

export type AuditExportDownloadTokenVerification =
  | { ok: true }
  | { ok: false; reason: AuditExportDownloadTokenReason }

function hashDownloadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Length mismatch fails without timingSafeEqual throwing on unequal buffers. */
function tokenHashesEqual(offeredHash: string, storedHash: string): boolean {
  const left = Buffer.from(offeredHash)
  const right = Buffer.from(storedHash)
  return left.length === right.length && timingSafeEqual(left, right)
}

function canTransition(from: PersistedAuditExportStatus, to: PersistedAuditExportStatus): boolean {
  if (from === 'queued') {
    return to === 'running' || to === 'failed'
  }
  if (from === 'running') {
    return to === 'succeeded' || to === 'failed'
  }
  return false
}

export class AuditExportJobStore {
  readonly root: string
  readonly ttlMs: number
  readonly perUserActiveLimit: number
  readonly globalActiveLimit: number
  private readonly clock: () => number

  constructor(options: AuditExportJobStoreOptions = {}) {
    this.root = path.resolve(options.root ?? DEFAULT_AUDIT_EXPORT_ROOT)
    this.ttlMs = options.ttlMs ?? DEFAULT_AUDIT_EXPORT_TTL_MS
    this.perUserActiveLimit = options.perUserActiveLimit ?? DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT
    this.globalActiveLimit = options.globalActiveLimit ?? DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT
    this.clock = options.now ?? Date.now
  }

  create(input: CreateAuditExportJobInput): AuditExportJob {
    const createdAt = this.clock()
    const jobId = input.jobId ?? generateAuditExportJobId()
    if (!isValidAuditExportJobId(jobId)) {
      throw new Error('invalid audit export job id')
    }
    // Generated ids are hex-only, so the joined path cannot escape root.
    if (existsSync(path.join(this.root, jobId))) {
      throw new Error('audit export job id collision')
    }
    const job: AuditExportJob = {
      jobId,
      status: 'queued',
      requestedBy: input.requestedBy,
      requestedByUsername: input.requestedByUsername,
      query: input.query,
      format: input.format,
      createdAt,
      startedAt: null,
      finishedAt: null,
      expiresAt: createdAt + this.ttlMs,
      objectKey: AUDIT_EXPORT_OBJECT_KEYS[input.format],
      totalEvents: null,
      bytes: null,
      error: null,
      deleteAfterDownload: input.deleteAfterDownload ?? false,
      downloadedAt: null,
      downloadTokenHash: null,
      downloadTokenExpiresAt: null
    }
    this.write(job)
    return job
  }

  read(jobId: string): AuditExportJob | null {
    const dir = resolveAuditExportJobDir(this.root, jobId)
    if (!dir || !this.isJobDir(dir)) {
      return null
    }
    try {
      const file = path.join(dir, AUDIT_EXPORT_JOB_FILE)
      // lstat rejects a symlink or directory squatted on job.json.
      if (!lstatSync(file).isFile()) {
        return null
      }
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isAuditExportJob(parsed) && parsed.jobId === jobId ? parsed : null
    } catch {
      return null
    }
  }

  isExpired(job: AuditExportJob): boolean {
    return job.expiresAt <= this.clock()
  }

  markRunning(jobId: string): AuditExportJob | null {
    return this.transition(jobId, 'running', () => ({ startedAt: this.clock() }))
  }

  markSucceeded(
    jobId: string,
    result: { totalEvents: number; bytes: number }
  ): AuditExportJob | null {
    return this.transition(jobId, 'succeeded', () => ({ finishedAt: this.clock(), ...result }))
  }

  markFailed(jobId: string, error: AuditExportJobError): AuditExportJob | null {
    return this.transition(jobId, 'failed', () => ({ finishedAt: this.clock(), error }))
  }

  /** Active = queued/running and not yet expired; optional owner scopes it per user. */
  countActive(requestedBy?: string): number {
    let count = 0
    for (const entry of this.readRoot()) {
      if (!entry.isDirectory()) {
        continue
      }
      const job = this.read(entry.name)
      if (!job || (job.status !== 'queued' && job.status !== 'running') || this.isExpired(job)) {
        continue
      }
      if (requestedBy === undefined || job.requestedBy === requestedBy) {
        count += 1
      }
    }
    return count
  }

  checkQuota(requestedBy: string): AuditExportQuotaResult {
    if (this.countActive(requestedBy) >= this.perUserActiveLimit) {
      return { ok: false, reason: 'per-user' }
    }
    if (this.countActive() >= this.globalActiveLimit) {
      return { ok: false, reason: 'global' }
    }
    return { ok: true }
  }

  /**
   * Mints a fresh download token for a succeeded, unexpired job. Issuing
   * overwrites the previous hash, so rotating immediately invalidates the old
   * link (design §4.2: one active token per job). Only the caller sees the
   * plaintext; storage keeps sha256. A `deleteAfterDownload` job whose artifact
   * was already removed cannot be reissued.
   */
  issueDownloadToken(
    jobId: string,
    options: IssueAuditExportDownloadTokenOptions = {}
  ): AuditExportDownloadToken | null {
    const job = this.read(jobId)
    if (!job || job.status !== 'succeeded' || this.isExpired(job)) {
      return null
    }
    if (job.deleteAfterDownload && job.downloadedAt !== null) {
      return null
    }
    const ttlMs = options.ttlMs ?? DEFAULT_AUDIT_EXPORT_DOWNLOAD_TOKEN_TTL_MS
    const token = randomBytes(24).toString('base64url')
    const expiresAt = this.clock() + ttlMs
    this.write({
      ...job,
      downloadTokenHash: hashDownloadToken(token),
      downloadTokenExpiresAt: expiresAt
    })
    return { token, expiresAt }
  }

  /** Non-consuming check; a valid token stays usable until consumed or rotated. */
  verifyDownloadToken(jobId: string, token: string): AuditExportDownloadTokenVerification {
    const job = this.read(jobId)
    return this.checkDownloadToken(job, token)
  }

  /**
   * Single-use redemption: clears the issuer hash, so the redeemed token is
   * permanently invalid while a later status read can mint a new one. Records
   * the first download time only. File deletion is the caller's job.
   */
  consumeDownloadToken(jobId: string, token: string): AuditExportDownloadTokenVerification {
    const job = this.read(jobId)
    const check = this.checkDownloadToken(job, token)
    if (!check.ok || !job) {
      return check
    }
    this.write({
      ...job,
      downloadedAt: job.downloadedAt ?? this.clock(),
      downloadTokenHash: null,
      downloadTokenExpiresAt: null
    })
    return { ok: true }
  }

  remove(jobId: string): boolean {
    const dir = resolveAuditExportJobDir(this.root, jobId)
    if (!dir || !this.isJobDir(dir)) {
      return false
    }
    rmSync(dir, { recursive: true, force: true })
    return true
  }

  /**
   * Work order §E9: a job left queued/running by a crash or restart can never
   * finish, so it is failed with EXPORT_INTERRUPTED. Terminal jobs are left
   * untouched, and expired ones are left to pruneExpired.
   */
  recoverInterrupted(): string[] {
    const recovered: string[] = []
    for (const entry of this.readRoot()) {
      if (!entry.isDirectory() || !isValidAuditExportJobId(entry.name)) {
        continue
      }
      const job = this.read(entry.name)
      if (!job || (job.status !== 'queued' && job.status !== 'running') || this.isExpired(job)) {
        continue
      }
      const updated = this.transition(job.jobId, 'failed', () => ({
        finishedAt: this.clock(),
        error: { code: 'EXPORT_INTERRUPTED', message: '进程重启导致任务中断' }
      }))
      if (updated) {
        // §3.6: an interrupted job must not leave a half-written artifact or tmp.
        this.removeJobArtifacts(job.jobId)
        recovered.push(entry.name)
      }
    }
    return recovered
  }

  /** Keeps job.json (the recovered state) and removes every other entry, best effort. */
  private removeJobArtifacts(jobId: string): void {
    const dir = path.join(this.root, jobId)
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === AUDIT_EXPORT_JOB_FILE) {
          continue
        }
        try {
          rmSync(path.join(dir, entry.name), { recursive: true, force: true })
        } catch (error) {
          // One stuck file must not block recovering the remaining jobs.
          console.warn(`[audit-export] failed to clean ${entry.name} in ${jobId}:`, error)
        }
      }
    } catch (error) {
      console.warn(`[audit-export] failed to list ${jobId} for cleanup:`, error)
    }
  }

  /** Removes expired job dirs and orphan job dirs (no readable job.json); symlinks are skipped. */
  pruneExpired(): string[] {
    const now = this.clock()
    const removed: string[] = []
    for (const entry of this.readRoot()) {
      // Only managed job dirs are candidates; unknown names under root are left alone.
      if (!entry.isDirectory() || !isValidAuditExportJobId(entry.name)) {
        continue
      }
      const dir = path.join(this.root, entry.name)
      if (!this.isJobDir(dir)) {
        continue
      }
      const job = this.read(entry.name)
      if (job && job.expiresAt > now) {
        continue
      }
      rmSync(dir, { recursive: true, force: true })
      removed.push(entry.name)
    }
    return removed
  }

  private checkDownloadToken(
    job: AuditExportJob | null,
    token: string
  ): AuditExportDownloadTokenVerification {
    if (!job || job.status !== 'succeeded') {
      return { ok: false, reason: 'not-ready' }
    }
    if (this.isExpired(job)) {
      return { ok: false, reason: 'expired' }
    }
    // Redeemed or rotated tokens leave no hash, so they are simply unknown.
    if (job.downloadTokenHash === null || job.downloadTokenExpiresAt === null) {
      return { ok: false, reason: 'invalid' }
    }
    if (!tokenHashesEqual(hashDownloadToken(token), job.downloadTokenHash)) {
      return { ok: false, reason: 'invalid' }
    }
    if (job.downloadTokenExpiresAt <= this.clock()) {
      return { ok: false, reason: 'expired' }
    }
    return { ok: true }
  }

  private readRoot() {
    return existsSync(this.root) ? readdirSync(this.root, { withFileTypes: true }) : []
  }

  private isJobDir(dir: string): boolean {
    try {
      return lstatSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  private transition(
    jobId: string,
    next: PersistedAuditExportStatus,
    patch: () => Partial<AuditExportJob>
  ): AuditExportJob | null {
    const job = this.read(jobId)
    if (!job || this.isExpired(job)) {
      return null
    }
    if (!canTransition(job.status, next)) {
      throw Object.assign(new Error(`invalid audit export transition ${job.status} -> ${next}`), {
        code: 'INVALID_TRANSITION'
      })
    }
    const updated: AuditExportJob = { ...job, ...patch(), status: next }
    this.write(updated)
    return updated
  }

  private write(job: AuditExportJob): void {
    const dir = resolveAuditExportJobDir(this.root, job.jobId)
    if (!dir) {
      throw new Error(`invalid audit export job id: ${job.jobId}`)
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    writeAuditExportJobFileAtomic(path.join(dir, AUDIT_EXPORT_JOB_FILE), job)
  }
}
