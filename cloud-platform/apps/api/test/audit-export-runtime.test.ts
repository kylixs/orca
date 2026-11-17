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
  DEFAULT_AUDIT_EXPORT_SWEEP_INTERVAL_MS,
  createAuditExportStore,
  resolveAuditExportSweepIntervalMs,
  startAuditExportCleanup,
  startAuditExportSweep,
  type AuditExportCleanupHandle,
  type AuditExportSweepHandle
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
  test('ORCA_AUDIT_EXPORT_DIR 优先于兼容别名 ORCA_AUDIT_EXPORT_ROOT', () => {
    const dir = tempRoot()
    const legacy = tempRoot()
    try {
      const store = createAuditExportStore({
        ORCA_AUDIT_EXPORT_DIR: ` ${dir} `,
        ORCA_AUDIT_EXPORT_ROOT: legacy
      })
      assert.equal(store.root, path.resolve(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(legacy, { recursive: true, force: true })
    }
  })

  test('仅 ORCA_AUDIT_EXPORT_DIR 时生效', () => {
    const dir = tempRoot()
    try {
      assert.equal(createAuditExportStore({ ORCA_AUDIT_EXPORT_DIR: dir }).root, path.resolve(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('DIR 为空串时回落到 ROOT 别名', () => {
    const legacy = tempRoot()
    try {
      const store = createAuditExportStore({
        ORCA_AUDIT_EXPORT_DIR: '   ',
        ORCA_AUDIT_EXPORT_ROOT: legacy
      })
      assert.equal(store.root, path.resolve(legacy))
    } finally {
      rmSync(legacy, { recursive: true, force: true })
    }
  })

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
  test('首次清理前先恢复中断任务，且只恢复一次', () => {
    const calls: string[] = []
    const cleanup = startAuditExportCleanup({
      store: {
        recoverInterrupted: (): string[] => {
          calls.push('recover')
          return []
        },
        pruneExpired: (): string[] => {
          calls.push('prune')
          return []
        }
      },
      intervalMs: 60_000
    })
    try {
      assert.deepEqual(calls, ['recover', 'prune'])
      cleanup.runNow()
      assert.deepEqual(calls, ['recover', 'prune', 'prune'])
    } finally {
      cleanup.stop()
    }
  })

  test('启动时把 queued/running 任务恢复为 failed', () => {
    const root = tempRoot()
    try {
      const store = new AuditExportJobStore({ root, ttlMs: 60_000 })
      const queued = store.create(jobInput())
      const running = store.create(jobInput())
      store.markRunning(running.jobId)

      const cleanup = startAuditExportCleanup({ store, intervalMs: 60_000 })
      try {
        for (const jobId of [queued.jobId, running.jobId]) {
          const job = store.read(jobId)
          assert.equal(job?.status, 'failed')
          assert.deepEqual(job?.error, {
            code: 'EXPORT_INTERRUPTED',
            message: '进程重启导致任务中断'
          })
        }
      } finally {
        cleanup.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('恢复失败走 onError，仍继续清理', async () => {
    const errors: Error[] = []
    const calls: string[] = []
    const cleanup = startAuditExportCleanup({
      store: {
        recoverInterrupted: (): string[] => {
          calls.push('recover')
          throw new Error('recover-boom')
        },
        pruneExpired: (): string[] => {
          calls.push('prune')
          return []
        }
      },
      intervalMs: 20,
      onError: (error) => {
        if (error instanceof Error) {
          errors.push(error)
        }
      }
    })
    try {
      await waitFor(() => calls.filter((call) => call === 'prune').length >= 2)
      assert.equal(errors[0]?.message, 'recover-boom')
      assert.equal(calls.filter((call) => call === 'recover').length, 1)
    } finally {
      cleanup.stop()
    }
  })

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
      recoverInterrupted: (): string[] => [],
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
            recoverInterrupted: (): string[] => [],
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

describe('startAuditExportSweep', () => {
  test('存在 queued 任务时每个 tick 触发 drain', async () => {
    let triggers = 0
    const sweep = startAuditExportSweep({
      store: { listQueuedIds: () => ['exp_000000000000000000000000'] },
      trigger: () => {
        triggers += 1
      },
      intervalMs: 10
    })
    try {
      await waitFor(() => triggers >= 2)
    } finally {
      sweep.stop()
    }
  })

  test('没有 queued 任务时不触发', async () => {
    let listCalls = 0
    let triggers = 0
    const sweep = startAuditExportSweep({
      store: {
        listQueuedIds: () => {
          listCalls += 1
          return []
        }
      },
      trigger: () => {
        triggers += 1
      },
      intervalMs: 5
    })
    try {
      await waitFor(() => listCalls >= 2)
      assert.equal(triggers, 0)
    } finally {
      sweep.stop()
    }
  })

  test('stop() 幂等且此后不再触发', async () => {
    let triggers = 0
    const sweep = startAuditExportSweep({
      store: { listQueuedIds: () => ['exp_000000000000000000000000'] },
      trigger: () => {
        triggers += 1
      },
      intervalMs: 5
    })
    await waitFor(() => triggers >= 1)
    sweep.stop()
    sweep.stop()
    const seen = triggers
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(triggers, seen)
  })

  test('trigger 抛错走 onError，后续 tick 继续', async () => {
    const errors: Error[] = []
    let calls = 0
    const sweep = startAuditExportSweep({
      store: { listQueuedIds: () => ['exp_000000000000000000000000'] },
      trigger: () => {
        calls += 1
        throw new Error('boom')
      },
      intervalMs: 10,
      onError: (error) => {
        if (error instanceof Error) {
          errors.push(error)
        }
      }
    })
    try {
      await waitFor(() => calls >= 3)
      assert.equal(errors[0]?.message, 'boom')
      assert.ok(errors.length >= 3)
    } finally {
      sweep.stop()
    }
  })

  test('listQueuedIds 抛错也走 onError 且不中断', async () => {
    const errors: Error[] = []
    let calls = 0
    let sweep: AuditExportSweepHandle | undefined
    assert.doesNotThrow(() => {
      sweep = startAuditExportSweep({
        store: {
          listQueuedIds: () => {
            calls += 1
            throw new Error('list-boom')
          }
        },
        trigger: () => {},
        intervalMs: 10,
        onError: (error) => {
          if (error instanceof Error) {
            errors.push(error)
          }
        }
      })
    })
    try {
      await waitFor(() => calls >= 2)
      assert.equal(errors[0]?.message, 'list-boom')
    } finally {
      sweep?.stop()
    }
  })

  test('ORCA_AUDIT_EXPORT_SWEEP_MS 覆盖且非法值回落默认', () => {
    assert.equal(DEFAULT_AUDIT_EXPORT_SWEEP_INTERVAL_MS, 15_000)
    assert.equal(resolveAuditExportSweepIntervalMs({ ORCA_AUDIT_EXPORT_SWEEP_MS: '100' }), 100)
    assert.equal(resolveAuditExportSweepIntervalMs({ ORCA_AUDIT_EXPORT_SWEEP_MS: ' 250 ' }), 250)
    for (const bad of [undefined, '', '   ', '0', '-1', 'abc', '1.5']) {
      assert.equal(
        resolveAuditExportSweepIntervalMs({ ORCA_AUDIT_EXPORT_SWEEP_MS: bad }),
        DEFAULT_AUDIT_EXPORT_SWEEP_INTERVAL_MS
      )
    }
  })
})
