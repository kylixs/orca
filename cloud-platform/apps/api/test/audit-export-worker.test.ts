import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AuditQuery, AuditQueryResult } from '../src/audit.ts'
import {
  AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE,
  AUDIT_EXPORT_ERROR_TOO_LARGE,
  AUDIT_EXPORT_ERROR_WRITE_FAILED,
  AuditExportWorker
} from '../src/audit-export-worker.ts'
import { AUDIT_EXPORT_CSV_HEADER } from '../src/audit-export-format.ts'
import {
  AuditExportJobStore,
  resolveAuditExportObjectPath
} from '../src/audit-export-jobs.ts'
import type { AuditExportFormat } from '../src/audit-export-jobs.ts'
import type { AuditEvent } from '../src/store.ts'

/**
 * U201 E6: the worker must page a newest-first chain into a chronological file,
 * refuse oversized exports, and never leave an artifact behind on failure.
 */

const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'orca-audit-export-worker-'))

function clock(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    set: (next: number) => {
      value = next
    }
  }
}

const event = (seq: number, over: Partial<AuditEvent> = {}): AuditEvent => ({
  seq,
  ts: 1_700_000_000_000 + seq * 1_000,
  eventType: 'file_download',
  actor: 'user:alice',
  targetType: 'host',
  targetId: 'host_1',
  result: 'success',
  traceId: `trace_${seq}`,
  metadata: { fileName: `report-${seq}.csv` },
  prevHash: seq === 1 ? 'GENESIS' : `h${seq - 1}`,
  hash: `h${seq}`,
  ...over
})

/** Mirrors AuditChain.query: newest-first, cursor = seq of the last event in the page. */
function fakeChain(events: AuditEvent[]) {
  const calls: AuditQuery[] = []
  const query = (filter: AuditQuery): AuditQueryResult => {
    calls.push(filter)
    const page = events
      .filter((entry) => filter.cursor === undefined || entry.seq < filter.cursor)
      .filter((entry) => (filter.since === undefined ? true : entry.ts >= filter.since))
      .filter((entry) => (filter.until === undefined ? true : entry.ts <= filter.until))
      .filter(
        (entry) =>
          !filter.eventTypes || filter.eventTypes.length === 0
            ? true
            : filter.eventTypes.includes(entry.eventType)
      )
      .sort((a, b) => b.seq - a.seq)
      .slice(0, filter.limit)
    const oldest = page.at(-1)
    return {
      events: page,
      nextCursor: page.length === filter.limit && oldest ? oldest.seq : null
    }
  }
  return { query, calls }
}

type WorkerOverrides = {
  now?: () => number
  maxEvents?: number
  maxBytes?: number
  pageSize?: number
  ttlMs?: number
}

function makeWorker(root: string, chain: ReturnType<typeof fakeChain>, over: WorkerOverrides = {}) {
  const { ttlMs, ...workerOptions } = over
  const store = new AuditExportJobStore({ root, now: over.now, ttlMs })
  const worker = new AuditExportWorker({ store, query: chain.query, ...workerOptions })
  return { store, worker }
}

const objectPathFor = (root: string, jobId: string, format: AuditExportFormat) => {
  const file = resolveAuditExportObjectPath(root, jobId, format)
  assert.ok(file, 'object path resolves')
  return file
}

const csvDataRows = (content: string) => content.split('\r\n').filter((line) => line !== '')

function parseJsonRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line)
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  // SAFETY: the assertion above proves a non-null non-array object, and JSON.parse
  // only yields plain objects for a single JSONL event line.
  return value as Record<string, unknown>
}

describe('分页、排序与产物', () => {
  test('450 条按 200/页 翻 3 页，游标正确，导出为 seq 升序', () => {
    const root = tempRoot()
    const time = clock()
    const events = Array.from({ length: 450 }, (_, index) => event(index + 1))
    const chain = fakeChain(events)
    const { store, worker } = makeWorker(root, chain, { now: time.now })

    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 50, since: 1_699_000_000_000, until: 1_800_000_000_000 },
      format: 'csv'
    })
    const result = worker.runAuditExportJob(job.jobId)

    assert.equal(result.status, 'succeeded')
    if (result.status !== 'succeeded') return
    assert.equal(result.totalEvents, 450)

    assert.equal(chain.calls.length, 3)
    assert.deepEqual(
      chain.calls.map((call) => call.limit),
      [200, 200, 200]
    )
    assert.deepEqual(
      chain.calls.map((call) => call.cursor),
      [undefined, 251, 51]
    )
    // The job's own filter snapshot is forwarded, only `limit` is overridden.
    for (const call of chain.calls) {
      assert.equal(call.since, 1_699_000_000_000)
      assert.equal(call.until, 1_800_000_000_000)
    }

    const file = objectPathFor(root, job.jobId, 'csv')
    const lines = csvDataRows(readFileSync(file, 'utf8'))
    assert.equal(lines[0], AUDIT_EXPORT_CSV_HEADER)
    assert.equal(lines.length, 451)
    assert.equal(lines[1]?.split(',')[0], '1')
    assert.equal(lines.at(-1)?.split(',')[0], '450')

    const saved = store.read(job.jobId)
    assert.equal(saved?.status, 'succeeded')
    assert.equal(saved?.totalEvents, 450)
    assert.equal(saved?.bytes, Buffer.byteLength(readFileSync(file, 'utf8')))
  })

  test('CSV 与 JSONL 两种格式都可读回', () => {
    const root = tempRoot()
    const time = clock()
    const events = Array.from({ length: 5 }, (_, index) => event(index + 1))
    const chain = fakeChain(events)
    const { store, worker } = makeWorker(root, chain, { now: time.now })

    const csvJob = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })
    const jsonlJob = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'jsonl'
    })

    assert.equal(worker.runAuditExportJob(csvJob.jobId).status, 'succeeded')
    assert.equal(worker.runAuditExportJob(jsonlJob.jobId).status, 'succeeded')

    const csvRows = csvDataRows(readFileSync(objectPathFor(root, csvJob.jobId, 'csv'), 'utf8'))
    assert.equal(csvRows.length, 6)
    assert.equal(csvRows[0], AUDIT_EXPORT_CSV_HEADER)

    const jsonlLines = readFileSync(objectPathFor(root, jsonlJob.jobId, 'jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
    assert.equal(jsonlLines.length, 5)
    const parsed = jsonlLines.map(parseJsonRecord)
    assert.deepEqual(
      parsed.map((entry) => entry.seq),
      [1, 2, 3, 4, 5]
    )
    assert.equal(parsed[0]?.prevHash, 'GENESIS')
    assert.deepEqual(parsed[0]?.metadata, { fileName: 'report-1.csv' })
  })
})

describe('失败终态不留产物', () => {
  test('超过 maxEvents 或 maxBytes 记为 EXPORT_TOO_LARGE 且无对象文件', () => {
    const root = tempRoot()
    const time = clock()
    const chain = fakeChain(Array.from({ length: 50 }, (_, index) => event(index + 1)))

    const byEvents = makeWorker(root, chain, { now: time.now, maxEvents: 10 })
    const eventsJob = byEvents.store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })
    const eventsResult = byEvents.worker.runAuditExportJob(eventsJob.jobId)
    assert.equal(eventsResult.status, 'failed')
    if (eventsResult.status === 'failed') {
      assert.equal(eventsResult.error.code, AUDIT_EXPORT_ERROR_TOO_LARGE)
    }
    assert.equal(existsSync(objectPathFor(root, eventsJob.jobId, 'csv')), false)
    const failed = byEvents.store.read(eventsJob.jobId)
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.error?.code, AUDIT_EXPORT_ERROR_TOO_LARGE)

    const rootBytes = tempRoot()
    const byBytes = makeWorker(rootBytes, chain, { now: time.now, maxBytes: 128 })
    const bytesJob = byBytes.store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'jsonl'
    })
    const bytesResult = byBytes.worker.runAuditExportJob(bytesJob.jobId)
    assert.equal(bytesResult.status, 'failed')
    if (bytesResult.status === 'failed') {
      assert.equal(bytesResult.error.code, AUDIT_EXPORT_ERROR_TOO_LARGE)
    }
    assert.equal(existsSync(objectPathFor(rootBytes, bytesJob.jobId, 'jsonl')), false)
  })

  test('对象写入失败记为 EXPORT_WRITE_FAILED，无半截文件', () => {
    const root = tempRoot()
    const time = clock()
    const chain = fakeChain(Array.from({ length: 3 }, (_, index) => event(index + 1)))
    const { store, worker } = makeWorker(root, chain, { now: time.now })
    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })

    // A directory squatting on the object key makes tmp+rename fail even as root.
    const objectPath = objectPathFor(root, job.jobId, 'csv')
    mkdirSync(objectPath)

    const result = worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.error.code, AUDIT_EXPORT_ERROR_WRITE_FAILED)
    }
    assert.equal(existsSync(objectPath), false)
    const jobDir = path.dirname(objectPath)
    assert.deepEqual(
      readdirSync(jobDir).filter((name) => name.endsWith('.tmp')),
      []
    )
    const failed = store.read(job.jobId)
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.error?.code, AUDIT_EXPORT_ERROR_WRITE_FAILED)
  })

  test('查询抛错记为 EXPORT_AUDIT_UNAVAILABLE 且无对象文件', () => {
    const root = tempRoot()
    const time = clock()
    const store = new AuditExportJobStore({ root, now: time.now })
    const worker = new AuditExportWorker({
      store,
      now: time.now,
      query: () => {
        throw new Error('remote writer unreachable')
      }
    })
    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })

    const result = worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.error.code, AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE)
    }
    assert.equal(existsSync(objectPathFor(root, job.jobId, 'csv')), false)
    assert.equal(store.read(job.jobId)?.status, 'failed')
  })
})

describe('只处理 queued', () => {
  test('非 queued 与已过期任务被跳过；processQueuedAuditExports 只挑 queued', () => {
    const root = tempRoot()
    const time = clock()
    const chain = fakeChain(Array.from({ length: 4 }, (_, index) => event(index + 1)))
    const { store, worker } = makeWorker(root, chain, { now: time.now, ttlMs: 1_000 })

    const first = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })
    time.set(time.now() + 1)
    const second = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'jsonl'
    })
    time.set(time.now() + 1)
    const terminal = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })
    store.markRunning(terminal.jobId)
    store.markSucceeded(terminal.jobId, { totalEvents: 0, bytes: 0 })

    // limit=1 takes the oldest queued job only.
    const printed = worker.processQueuedAuditExports(1)
    assert.equal(printed.length, 1)
    assert.equal(printed[0]?.jobId, first.jobId)
    assert.equal(store.read(second.jobId)?.status, 'queued')

    const rest = worker.processQueuedAuditExports()
    assert.deepEqual(
      rest.map((entry) => entry.jobId),
      [second.jobId]
    )
    assert.equal(store.read(terminal.jobId)?.status, 'succeeded')
    assert.equal(worker.runAuditExportJob(terminal.jobId).status, 'skipped')

    // Expired queued job is left queued (derived expiry), not failed.
    const expiring = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'bob',
      query: { limit: 200 },
      format: 'csv'
    })
    time.set(expiring.expiresAt + 1)
    assert.deepEqual(worker.runAuditExportJob(expiring.jobId), {
      jobId: expiring.jobId,
      status: 'skipped',
      reason: 'expired'
    })
    assert.equal(store.read(expiring.jobId)?.status, 'queued')
    assert.equal(worker.processQueuedAuditExports().length, 0)
  })

  test('不存在的 jobId 返回 skipped/not-found', () => {
    const root = tempRoot()
    const chain = fakeChain([])
    const { worker } = makeWorker(root, chain)
    assert.deepEqual(worker.runAuditExportJob('exp_0123456789abcdef01234567'), {
      jobId: 'exp_0123456789abcdef01234567',
      status: 'skipped',
      reason: 'not-found'
    })
  })
})
