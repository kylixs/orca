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
  AuditExportWorker,
  type AuditExportAuditSink,
  type AuditExportTerminalAuditEvent
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
  audit?: AuditExportAuditSink
}

function makeWorker(root: string, chain: ReturnType<typeof fakeChain>, over: WorkerOverrides = {}) {
  const { ttlMs, ...workerOptions } = over
  const store = new AuditExportJobStore({ root, now: over.now, ttlMs })
  const worker = new AuditExportWorker({ store, query: chain.query, ...workerOptions })
  return { store, worker }
}

/** Sync recorder; `append` still returns a promise like the real sink. */
function recordingAudit() {
  const events: AuditExportTerminalAuditEvent[] = []
  const audit: AuditExportAuditSink = {
    append: (event) => {
      events.push(event)
      return Promise.resolve()
    }
  }
  return { audit, events }
}

const objectPathFor = (root: string, jobId: string, format: AuditExportFormat) => {
  const file = resolveAuditExportObjectPath(root, jobId, format)
  assert.ok(file, 'object path resolves')
  return file
}

const csvDataRows = (content: string) =>
  content.replace(/^﻿/, '').split('\r\n').filter((line) => line !== '')

/** Chunk scratch files live beside the object; none may survive a terminal run. */
const partFiles = (dir: string) => readdirSync(dir).filter((name) => name.includes('.part-'))

function parseJsonRecord(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line)
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value))
  // SAFETY: the assertion above proves a non-null non-array object, and JSON.parse
  // only yields plain objects for a single JSONL event line.
  return value as Record<string, unknown>
}

/**
 * U206 F16: `job.error.message` is polled by admins/auditors, so it must be a
 * fixed code-based sentence — never exception text or an absolute path.
 */
function assertSanitizedMessage(message: string | undefined, leaked?: string) {
  assert.equal(typeof message, 'string')
  assert.ok(message && message.length > 0)
  assert.equal(message.includes('/'), false)
  assert.equal(message.includes('\\'), false)
  if (leaked) {
    assert.equal(message.includes(leaked), false)
  }
}

describe('分页、排序与产物', () => {
  test('450 条按 200/页 翻 3 页，游标正确，导出为 seq 升序', async () => {
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
    const result = await worker.runAuditExportJob(job.jobId)

    assert.equal(result.status, 'succeeded')
    if (result.status !== 'succeeded') {
      return
    }
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

  test('1200 条按 200/页 翻 6 页，分块拼接后无残留、表头与行数正确', async () => {
    const root = tempRoot()
    const time = clock()
    const events = Array.from({ length: 1200 }, (_, index) => event(index + 1))
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

    assert.equal((await worker.runAuditExportJob(csvJob.jobId)).status, 'succeeded')
    // Six full data pages, plus the empty probe the chain asks for after a full last page.
    assert.equal(chain.calls.length, 7)
    assert.deepEqual(
      chain.calls.map((call) => call.cursor),
      [undefined, 1001, 801, 601, 401, 201, 1]
    )
    chain.calls.length = 0
    assert.equal((await worker.runAuditExportJob(jsonlJob.jobId)).status, 'succeeded')
    assert.equal(chain.calls.length, 7)

    const csvFile = objectPathFor(root, csvJob.jobId, 'csv')
    const csv = readFileSync(csvFile, 'utf8')
    const rows = csvDataRows(csv)
    assert.equal(rows.length, 1201)
    assert.equal(rows[0], AUDIT_EXPORT_CSV_HEADER)
    assert.equal(rows.filter((line) => line === AUDIT_EXPORT_CSV_HEADER).length, 1)
    assert.equal(rows[1]?.split(',')[0], '1')
    assert.equal(rows.at(-1)?.split(',')[0], '1200')
    assert.deepEqual(partFiles(path.dirname(csvFile)), [])

    const jsonlFile = objectPathFor(root, jsonlJob.jobId, 'jsonl')
    const jsonl = readFileSync(jsonlFile, 'utf8')
    const lines = jsonl.trimEnd().split('\n')
    assert.equal(lines.length, 1200)
    assert.deepEqual(
      lines.map((line) => parseJsonRecord(line).seq),
      events.map((entry) => entry.seq)
    )
    assert.deepEqual(partFiles(path.dirname(jsonlFile)), [])

    const savedCsv = store.read(csvJob.jobId)
    assert.equal(savedCsv?.totalEvents, 1200)
    assert.equal(savedCsv?.bytes, Buffer.byteLength(csv))
    const savedJsonl = store.read(jsonlJob.jobId)
    assert.equal(savedJsonl?.totalEvents, 1200)
    assert.equal(savedJsonl?.bytes, Buffer.byteLength(jsonl))
  })

  test('CSV 与 JSONL 两种格式都可读回', async () => {
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

    assert.equal((await worker.runAuditExportJob(csvJob.jobId)).status, 'succeeded')
    assert.equal((await worker.runAuditExportJob(jsonlJob.jobId)).status, 'succeeded')

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

describe('过滤字段完整转发', () => {
  test('job.query 的字段全部进入 audit.query，仅 limit/游标由 worker 决定', async () => {
    const root = tempRoot()
    const time = clock()
    const chain = fakeChain([])
    const { store, worker } = makeWorker(root, chain, { now: time.now })
    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: {
        limit: 50,
        actor: 'user:alice',
        eventType: 'file_copy',
        eventTypes: ['file_copy'],
        result: 'success',
        traceId: 'trace_1',
        fileName: 'report.csv',
        keyword: 'report',
        since: 1_699_000_000_000,
        until: 1_800_000_000_000,
        username: 'alice',
        projectId: 'proj_1',
        hostId: 'host_1'
      },
      format: 'jsonl'
    })

    const result = await worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'succeeded')
    assert.equal(chain.calls.length, 1)
    const call = chain.calls[0]
    assert.ok(call)
    assert.deepEqual(
      {
        actor: call.actor,
        eventType: call.eventType,
        eventTypes: call.eventTypes,
        result: call.result,
        traceId: call.traceId,
        fileName: call.fileName,
        keyword: call.keyword,
        since: call.since,
        until: call.until,
        username: call.username,
        projectId: call.projectId,
        hostId: call.hostId
      },
      {
        actor: 'user:alice',
        eventType: 'file_copy',
        eventTypes: ['file_copy'],
        result: 'success',
        traceId: 'trace_1',
        fileName: 'report.csv',
        keyword: 'report',
        since: 1_699_000_000_000,
        until: 1_800_000_000_000,
        username: 'alice',
        projectId: 'proj_1',
        hostId: 'host_1'
      }
    )
    assert.equal(call.limit, 200)
    assert.equal(call.cursor, undefined)
  })
})

describe('失败终态不留产物', () => {
  test('超过 maxEvents 或 maxBytes 记为 EXPORT_TOO_LARGE 且无对象文件', async () => {
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
    const eventsResult = await byEvents.worker.runAuditExportJob(eventsJob.jobId)
    assert.equal(eventsResult.status, 'failed')
    if (eventsResult.status === 'failed') {
      assert.equal(eventsResult.error.code, AUDIT_EXPORT_ERROR_TOO_LARGE)
      assert.equal(eventsResult.error.message, '导出数据超过上限。')
      assertSanitizedMessage(eventsResult.error.message)
    }
    assert.equal(existsSync(objectPathFor(root, eventsJob.jobId, 'csv')), false)
    assert.deepEqual(
      partFiles(path.dirname(objectPathFor(root, eventsJob.jobId, 'csv'))),
      []
    )
    const failed = byEvents.store.read(eventsJob.jobId)
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.error?.code, AUDIT_EXPORT_ERROR_TOO_LARGE)
    assert.equal(failed?.error?.message, '导出数据超过上限。')
    assertSanitizedMessage(failed?.error?.message)

    const rootBytes = tempRoot()
    const byBytes = makeWorker(rootBytes, chain, { now: time.now, maxBytes: 128 })
    const bytesJob = byBytes.store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'jsonl'
    })
    const bytesResult = await byBytes.worker.runAuditExportJob(bytesJob.jobId)
    assert.equal(bytesResult.status, 'failed')
    if (bytesResult.status === 'failed') {
      assert.equal(bytesResult.error.code, AUDIT_EXPORT_ERROR_TOO_LARGE)
      assert.equal(bytesResult.error.message, '导出数据超过上限。')
    }
    assert.equal(existsSync(objectPathFor(rootBytes, bytesJob.jobId, 'jsonl')), false)
    assert.deepEqual(
      partFiles(path.dirname(objectPathFor(rootBytes, bytesJob.jobId, 'jsonl'))),
      []
    )
  })

  test('对象写入失败记为 EXPORT_WRITE_FAILED，无半截文件', async () => {
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

    const result = await worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.error.code, AUDIT_EXPORT_ERROR_WRITE_FAILED)
      assert.equal(result.error.message, '导出产物写入失败。')
      assertSanitizedMessage(result.error.message, objectPath)
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
    assert.equal(failed?.error?.message, '导出产物写入失败。')
  })

  test('查询抛错记为 EXPORT_AUDIT_UNAVAILABLE 且无对象文件', async () => {
    const root = tempRoot()
    const time = clock()
    const store = new AuditExportJobStore({ root, now: time.now })
    // The exception carries an absolute path; none of it may reach job.error.message.
    const leakedPath = '/Users/alice/private/audit-chain.json'
    const leakyError = new Error(`ENOENT: open ${leakedPath} failed`)
    const worker = new AuditExportWorker({
      store,
      now: time.now,
      query: () => {
        throw leakyError
      }
    })
    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })

    const result = await worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.error.code, AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE)
      assert.equal(result.error.message, '审计查询不可用。')
      assertSanitizedMessage(result.error.message, leakedPath)
      assert.equal(result.error.message.includes('ENOENT'), false)
    }
    assert.equal(existsSync(objectPathFor(root, job.jobId, 'csv')), false)
    assert.equal(store.read(job.jobId)?.status, 'failed')
    assert.equal(store.read(job.jobId)?.error?.message, '审计查询不可用。')
  })
})

describe('终态审计（best-effort）', () => {
  test('成功写一条 phase=finished 事件，含 totalEvents/bytes', async () => {
    const root = tempRoot()
    const chain = fakeChain([event(1), event(2)])
    const { audit, events } = recordingAudit()
    const { store, worker } = makeWorker(root, chain, { audit })

    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })
    const result = await worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'succeeded')
    await Promise.resolve()

    assert.equal(events.length, 1)
    const [audited] = events
    assert.equal(audited.eventType, 'audit_export')
    assert.equal(audited.actor, 'alice')
    assert.equal(audited.targetId, job.jobId)
    assert.equal(audited.result, 'success')
    assert.deepEqual(audited.metadata, {
      jobId: job.jobId,
      phase: 'finished',
      format: 'csv',
      totalEvents: 2,
      bytes: result.status === 'succeeded' ? result.bytes : -1
    })
  })

  test('失败写一条 phase=finished 事件，含 errorCode', async () => {
    const root = tempRoot()
    const chain = fakeChain([event(1), event(2), event(3)])
    const { audit, events } = recordingAudit()
    const { store, worker } = makeWorker(root, chain, { audit, maxEvents: 1 })

    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'jsonl'
    })
    assert.equal((await worker.runAuditExportJob(job.jobId)).status, 'failed')
    await Promise.resolve()

    assert.equal(events.length, 1)
    assert.equal(events[0]?.result, 'failure')
    assert.deepEqual(events[0]?.metadata, {
      jobId: job.jobId,
      phase: 'finished',
      format: 'jsonl',
      errorCode: AUDIT_EXPORT_ERROR_TOO_LARGE
    })
  })

  test('审计抛错或拒绝不影响任务终态', async () => {
    const root = tempRoot()
    const chain = fakeChain([event(1)])
    const throwing: AuditExportAuditSink = {
      append: () => {
        throw new Error('audit down')
      }
    }
    const { store, worker } = makeWorker(root, chain, { audit: throwing })
    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })

    const result = await worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'succeeded')
    assert.equal(store.read(job.jobId)?.status, 'succeeded')
    assert.ok(existsSync(objectPathFor(root, job.jobId, 'csv')))

    const rejecting: AuditExportAuditSink = { append: () => Promise.reject(new Error('down')) }
    const { store: store2, worker: worker2 } = makeWorker(tempRoot(), fakeChain([event(1)]), {
      audit: rejecting
    })
    const job2 = store2.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })
    assert.equal((await worker2.runAuditExportJob(job2.jobId)).status, 'succeeded')
    await Promise.resolve()
    assert.equal(store2.read(job2.jobId)?.status, 'succeeded')
  })
})

describe('远端异步审计查询（auditWriterUrls 拓扑）', () => {
  /** Mirrors `createRemoteAudit`: every page resolves on a later microtask. */
  function asyncChain(events: AuditEvent[]) {
    const sync = fakeChain(events)
    const query = async (filter: AuditQuery): Promise<AuditQueryResult> => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return sync.query(filter)
    }
    return { query, calls: sync.calls }
  }

  test('Promise 查询多页（450 条 > 200/页）仍正确分页、升序导出并 succeeded', async () => {
    const root = tempRoot()
    const time = clock()
    const events = Array.from({ length: 450 }, (_, index) => event(index + 1))
    const chain = asyncChain(events)
    const store = new AuditExportJobStore({ root, now: time.now })
    const worker = new AuditExportWorker({ store, query: chain.query, now: time.now })

    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 50 },
      format: 'jsonl'
    })
    const result = await worker.runAuditExportJob(job.jobId)

    assert.equal(result.status, 'succeeded')
    if (result.status !== 'succeeded') {
      return
    }
    assert.equal(result.totalEvents, 450)
    assert.equal(chain.calls.length, 3)
    assert.deepEqual(
      chain.calls.map((call) => call.cursor),
      [undefined, 251, 51]
    )

    const lines = readFileSync(objectPathFor(root, job.jobId, 'jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
    assert.deepEqual(
      lines.map((line) => parseJsonRecord(line).seq),
      events.map((entry) => entry.seq)
    )
    assert.equal(store.read(job.jobId)?.status, 'succeeded')
  })

  test('某页 Promise reject 记为 EXPORT_AUDIT_UNAVAILABLE 且无对象文件', async () => {
    const root = tempRoot()
    const time = clock()
    const store = new AuditExportJobStore({ root, now: time.now })
    const worker = new AuditExportWorker({
      store,
      now: time.now,
      query: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        throw new Error('remote writer unreachable')
      }
    })
    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })

    const result = await worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.error.code, AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE)
      assert.equal(result.error.message, '审计查询不可用。')
      assertSanitizedMessage(result.error.message, 'remote writer unreachable')
    }
    assert.equal(existsSync(objectPathFor(root, job.jobId, 'csv')), false)
    assert.equal(store.read(job.jobId)?.status, 'failed')
    assert.equal(store.read(job.jobId)?.error?.code, AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE)
    assert.equal(store.read(job.jobId)?.error?.message, '审计查询不可用。')
  })

  test('第 2 页 reject 时清理已写分块并记为 EXPORT_AUDIT_UNAVAILABLE', async () => {
    const root = tempRoot()
    const time = clock()
    const events = Array.from({ length: 450 }, (_, index) => event(index + 1))
    const chain = fakeChain(events)
    const store = new AuditExportJobStore({ root, now: time.now })
    let calls = 0
    const worker = new AuditExportWorker({
      store,
      now: time.now,
      query: async (filter) => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (calls === 2) {
          throw new Error('remote writer unreachable')
        }
        return chain.query(filter)
      }
    })
    const job = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })

    const result = await worker.runAuditExportJob(job.jobId)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') {
      assert.equal(result.error.code, AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE)
    }
    const objectPath = objectPathFor(root, job.jobId, 'csv')
    assert.equal(existsSync(objectPath), false)
    assert.deepEqual(partFiles(path.dirname(objectPath)), [])
    assert.equal(store.read(job.jobId)?.status, 'failed')
    assert.equal(store.read(job.jobId)?.error?.code, AUDIT_EXPORT_ERROR_AUDIT_UNAVAILABLE)
  })

  test('processQueuedAuditExports 串行 await Promise 查询并返回结果数组', async () => {
    const root = tempRoot()
    const time = clock()
    const chain = asyncChain(Array.from({ length: 4 }, (_, index) => event(index + 1)))
    const store = new AuditExportJobStore({ root, now: time.now })
    const worker = new AuditExportWorker({ store, query: chain.query, now: time.now })
    const first = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'csv'
    })
    const second = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'alice',
      query: { limit: 200 },
      format: 'jsonl'
    })

    const results = await worker.processQueuedAuditExports()
    // Same-millisecond creates are ordered by jobId (deterministic pass order).
    const pairs = results.map((entry) => `${entry.jobId}:${entry.status}`)
    const want = [first.jobId, second.jobId].map((jobId) => `${jobId}:succeeded`)
    assert.deepEqual(pairs.sort(), want.sort())
    assert.equal(store.read(first.jobId)?.status, 'succeeded')
    assert.equal(store.read(second.jobId)?.status, 'succeeded')
  })
})

describe('只处理 queued', () => {
  test('非 queued 与已过期任务被跳过；processQueuedAuditExports 只挑 queued', async () => {
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
    const printed = await worker.processQueuedAuditExports(1)
    assert.equal(printed.length, 1)
    assert.equal(printed[0]?.jobId, first.jobId)
    assert.equal(store.read(second.jobId)?.status, 'queued')

    const rest = await worker.processQueuedAuditExports()
    assert.deepEqual(
      rest.map((entry) => entry.jobId),
      [second.jobId]
    )
    assert.equal(store.read(terminal.jobId)?.status, 'succeeded')
    assert.equal((await worker.runAuditExportJob(terminal.jobId)).status, 'skipped')

    // Expired queued job is left queued (derived expiry), not failed.
    const expiring = store.create({
      requestedBy: 'user_1',
      requestedByUsername: 'bob',
      query: { limit: 200 },
      format: 'csv'
    })
    time.set(expiring.expiresAt + 1)
    assert.deepEqual(await worker.runAuditExportJob(expiring.jobId), {
      jobId: expiring.jobId,
      status: 'skipped',
      reason: 'expired'
    })
    assert.equal(store.read(expiring.jobId)?.status, 'queued')
    assert.equal((await worker.processQueuedAuditExports()).length, 0)
  })

  test('不存在的 jobId 返回 skipped/not-found', async () => {
    const root = tempRoot()
    const chain = fakeChain([])
    const { worker } = makeWorker(root, chain)
    assert.deepEqual(await worker.runAuditExportJob('exp_0123456789abcdef01234567'), {
      jobId: 'exp_0123456789abcdef01234567',
      status: 'skipped',
      reason: 'not-found'
    })
  })
})
