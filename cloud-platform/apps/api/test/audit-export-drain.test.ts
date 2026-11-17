import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAuditExportDrain } from '../src/server.ts'

/**
 * U205 P2: accepted-export triggers coalesce into one in-flight worker pass per
 * process, and the slot clears on success or failure so the next job can run.
 */

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve))

test('并发触发串行化：任一时刻只有一次 pass，且每个触发都得到一次跟进', async () => {
  let calls = 0
  let active = 0
  let maxActive = 0
  const releases: (() => void)[] = []
  const drain = createAuditExportDrain(
    () => {
      calls += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      return new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1
          resolve()
        })
      })
    },
    (callback) => callback()
  )

  drain()
  drain()
  drain()
  await flushMicrotasks()
  assert.equal(calls, 1, 'concurrent triggers must not start parallel passes')
  assert.equal(maxActive, 1)

  releases.shift()?.()
  await flushMicrotasks()
  assert.equal(calls, 2, 'a trigger during a pass must queue a sequential follow-up')
  releases.shift()?.()
  await flushMicrotasks()
  assert.equal(calls, 3, 'every dropped trigger must get a follow-up pass')
  releases.shift()?.()
  await flushMicrotasks()
  assert.equal(maxActive, 1, 'passes must never overlap')
})

test('drain 结束后再次触发会启动新的 pass', async () => {
  let calls = 0
  const drain = createAuditExportDrain(
    async () => {
      calls += 1
    },
    (callback) => callback()
  )

  drain()
  await flushMicrotasks()
  drain()
  await flushMicrotasks()
  assert.equal(calls, 2)
})

test('worker 异常只记录日志，且清空 in-flight 槽位', async () => {
  let calls = 0
  const originalError = console.error
  const logged: unknown[][] = []
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    const drain = createAuditExportDrain(
      async () => {
        calls += 1
        throw new Error('worker exploded')
      },
      (callback) => callback()
    )

    drain()
    await flushMicrotasks()
    assert.equal(calls, 1)
    assert.equal(logged.length, 1)

    drain()
    await flushMicrotasks()
    assert.equal(calls, 2)
  } finally {
    console.error = originalError
  }
})
