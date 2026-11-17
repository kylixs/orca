import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AuditExportJobStore,
  DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT,
  DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT,
  DEFAULT_AUDIT_EXPORT_ROOT,
  DEFAULT_AUDIT_EXPORT_TTL_MS
} from '../src/audit-export-jobs.ts'
import {
  DEFAULT_AUDIT_EXPORT_CLEANUP_INTERVAL_MS,
  createAuditExportStore,
  startAuditExportCleanup,
  type AuditExportCleanupHandle
} from '../src/audit-export-runtime.ts'
import type { CreateAuditExportJobInput } from '../src/audit-export-jobs.ts'

/**
 * U201 E9: the runtime builds the process-wide export store from env and sweeps
 * expired job dirs at startup and on an unref'd interval, without ever throwing
 * out of cleanup.
 */

const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'orca-audit-export-runtime-'))
const jobInput = (): CreateAuditExportJobInput => ({
  requestedBy: 'user_1',
  requestedByUsername: 'alice',
  query: { limit: 200 },
  format: 'csv'
})

function clock(start = 1_000) {
  let value = start
  return {
    now: () => value,
    set: (next: number) => {
      value = next
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), 'condition not met before timeout')
}

describe('createAuditExportStore', () => {
  test('env 覆盖 root/TTL/配额', () => {
    const root = tempRoot()
    try {
      const store = createAuditExportStore({
        ORCA_AUDIT_EXPORT_ROOT: ` ${root} `,
        ORCA_AUDIT_EXPORT_TTL_MS: '5000',
        ORCA_AUDIT_EXPORT_PER_USER_LIMIT: '3',
        ORCA_AUDIT_EXPORT_GLOBAL_LIMIT: '9'
      })
      assert.equal(store.root, path.resolve(root))
      assert.equal(store.ttlMs, 5_000)
      assert.equal(store.perUserActiveLimit, 3)
      assert.equal(store.globalActiveLimit, 9)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('空 env 回落默认 root/TTL/配额', () => {
    const store = createAuditExportStore({})
    assert.equal(store.root, path.resolve(DEFAULT_AUDIT_EXPORT_ROOT))
    assert.equal(store.ttlMs, DEFAULT_AUDIT_EXPORT_TTL_MS)
    assert.equal(store.perUserActiveLimit, DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT)
    assert.equal(store.globalActiveLimit, DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT)
    assert.equal(DEFAULT_AUDIT_EXPORT_CLEANUP_INTERVAL_MS, 5 * 60_000)
  })

  test('非法 env 值回落默认', () => {
    const store = createAuditExportStore({
      ORCA_AUDIT_EXPORT_TTL_MS: 'abc',
      ORCA_AUDIT_EXPORT_PER_USER_LIMIT: '0',
      ORCA_AUDIT_EXPORT_GLOBAL_LIMIT: '-2'
    })
    assert.equal(store.ttlMs, DEFAULT_AUDIT_EXPORT_TTL_MS)
    assert.equal(store.perUserActiveLimit, DEFAULT_AUDIT_EXPORT_PER_USER_LIMIT)
    assert.equal(store.globalActiveLimit, DEFAULT_AUDIT_EXPORT_GLOBAL_LIMIT)
  })
})

describe('startAuditExportCleanup', () => {
  test('启动时立即清理过期任务目录', () => {
    const root = tempRoot()
    try {
      const time = clock(1_000)
      const store = new AuditExportJobStore({ root, ttlMs: 1_000, now: time.now })
      const job = store.create(jobInput())
      time.set(2_000)
      assert.equal(existsSync(path.join(root, job.jobId)), true)

      const cleanup = startAuditExportCleanup({ store, intervalMs: 60_000 })
      try {
        assert.equal(existsSync(path.join(root, job.jobId)), false)
      } finally {
        cleanup.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('按 interval 再次清理后来过期的任务', async () => {
    const root = tempRoot()
    try {
      const time = clock(1_000)
      const store = new AuditExportJobStore({ root, ttlMs: 1_000, now: time.now })
      const job = store.create(jobInput())
      const jobDir = path.join(root, job.jobId)

      const cleanup = startAuditExportCleanup({ store, intervalMs: 25 })
      try {
        assert.equal(existsSync(jobDir), true)
        time.set(2_000)
        await waitFor(() => !existsSync(jobDir))
      } finally {
        cleanup.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('stop() 后不再清理，且可重复调用', async () => {
    const root = tempRoot()
    try {
      const time = clock(1_000)
      const store = new AuditExportJobStore({ root, ttlMs: 1_000, now: time.now })
      const job = store.create(jobInput())
      const jobDir = path.join(root, job.jobId)

      const cleanup = startAuditExportCleanup({ store, intervalMs: 20 })
      cleanup.stop()
      cleanup.stop()

      time.set(5_000)
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(existsSync(jobDir), true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('onError 捕获清理异常且不抛出', async () => {
    const errors: Error[] = []
    let calls = 0
    const failingStore = {
      pruneExpired: (): string[] => {
        calls += 1
        throw new Error('boom')
      }
    }

    let cleanup: AuditExportCleanupHandle | undefined
    assert.doesNotThrow(() => {
      cleanup = startAuditExportCleanup({
        store: failingStore,
        intervalMs: 20,
        onError: (error) => {
          if (error instanceof Error) {
            errors.push(error)
          }
        }
      })
    })
    try {
      await waitFor(() => calls >= 2)
      assert.ok(errors.length >= 2)
      assert.equal(errors[0]?.message, 'boom')
    } finally {
      cleanup?.stop()
    }
  })

  test('未提供 onError 时记录 console.error', () => {
    const original = console.error
    let logged = 0
    console.error = () => {
      logged += 1
    }
    let cleanup: AuditExportCleanupHandle | undefined
    try {
      assert.doesNotThrow(() => {
        cleanup = startAuditExportCleanup({
          store: {
            pruneExpired: (): string[] => {
              throw new Error('boom')
            }
          },
          intervalMs: 60_000
        })
      })
      assert.equal(logged, 1)
    } finally {
      cleanup?.stop()
      console.error = original
    }
  })
})
