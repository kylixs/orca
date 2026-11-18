import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.ts'
import {
  createLockoutStore,
  LOCK_MS,
  MAX_FAILURES,
  type LockoutState
} from '../../login-lockout/src/lockout.ts'

/**
 * U289: the API replica and the shared counter must answer with one contract, so
 * a future caller can read `lockedUntil` without knowing which mode served it.
 */

const NOW = 1_800_000_000_000

describe('本地与共享登录锁定契约同构（U289）', () => {
  test('无锁态与锁定态的字段集合一致', () => {
    const local = new Store()
    const shared = createLockoutStore()
    const username = 'u289-contract'

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const localResult = local.recordLoginFailure(username, NOW)
      const sharedResult = shared.recordFailure(username, NOW)
      assert.deepEqual(
        Object.keys(localResult).sort(),
        Object.keys(sharedResult).sort(),
        `第 ${attempt + 1} 次失败的字段集合`
      )
      assert.deepEqual(Object.keys(localResult).sort(), ['locked', 'lockedUntil', 'remaining'])
    }
  })

  test('无锁态 lockedUntil 均为 0，锁定态均为真实截止时间', () => {
    const local = new Store()
    const shared = createLockoutStore()
    const username = 'u289-states'

    for (let attempt = 0; attempt < MAX_FAILURES - 1; attempt += 1) {
      const localResult = local.recordLoginFailure(username, NOW)
      const sharedResult = shared.recordFailure(username, NOW)
      assert.deepEqual(localResult, sharedResult)
      assert.equal(localResult.lockedUntil, 0)
      assert.equal(sharedResult.lockedUntil, 0)
    }

    const lockedLocal = local.recordLoginFailure(username, NOW)
    const lockedShared = shared.recordFailure(username, NOW)
    assert.deepEqual(lockedLocal, lockedShared)
    assert.equal(lockedLocal.locked, true)
    assert.equal(lockedLocal.lockedUntil, NOW + LOCK_MS)
    assert.equal(lockedShared.lockedUntil, NOW + LOCK_MS)
  })

  test('锁定到期后的新失败回到无锁表示（lockedUntil 0）', () => {
    const local = new Store()
    const shared = createLockoutStore()
    const username = 'u289-expiry'

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      local.recordLoginFailure(username, NOW)
      shared.recordFailure(username, NOW)
    }

    const afterExpiry = NOW + LOCK_MS + 1
    const localResult = local.recordLoginFailure(username, afterExpiry)
    const sharedResult = shared.recordFailure(username, afterExpiry)
    assert.deepEqual(localResult, sharedResult)
    assert.equal(localResult.locked, false)
    assert.equal(localResult.lockedUntil, 0)
  })

  test('本地只读锁定查询返回记录中的真实截止时间', () => {
    const local = new Store()
    const username = 'u289-readonly'

    assert.deepEqual(local.loginLockState(username, NOW), {
      locked: false,
      remaining: MAX_FAILURES,
      lockedUntil: 0
    })

    let recorded: LockoutState = { locked: false, remaining: MAX_FAILURES, lockedUntil: 0 }
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      recorded = local.recordLoginFailure(username, NOW)
    }

    assert.deepEqual(local.loginLockState(username, NOW), {
      locked: true,
      remaining: 0,
      lockedUntil: recorded.lockedUntil
    })
    assert.equal(recorded.lockedUntil, NOW + LOCK_MS)
  })

  test('锁定期间继续失败：逐次与共享完全一致，且不延长截止时间', () => {
    const local = new Store()
    const shared = createLockoutStore()
    const username = 'u292-locked-failures'

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const localResult = local.recordLoginFailure(username, NOW)
      const sharedResult = shared.recordFailure(username, NOW)
      assert.deepEqual(localResult, sharedResult, `锁定前第 ${attempt + 1} 次失败`)
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const later = NOW + 1_000 * (attempt + 1)
      const localResult = local.recordLoginFailure(username, later)
      const sharedResult = shared.recordFailure(username, later)
      assert.deepEqual(localResult, sharedResult, `锁定期间第 ${attempt + 1} 次失败`)
      assert.equal(localResult.locked, true)
      assert.equal(localResult.remaining, 0)
      assert.equal(localResult.lockedUntil, NOW + LOCK_MS, '锁定截止时间不得被后续失败延长')
      assert.deepEqual(
        local.loginLockState(username, later),
        shared.isLocked(username, later),
        `锁定期间第 ${attempt + 1} 次失败的只读态`
      )
    }
  })

  test('两个失败同时通过预检后落锁：不延长且与共享同序语义一致（U293）', async () => {
    const local = new Store()
    const shared = createLockoutStore()
    const username = 'u293-concurrent'

    // MAX-1 次失败：下一次失败触发锁定，另一个并发请求落在锁定窗口内。
    for (let attempt = 0; attempt < MAX_FAILURES - 1; attempt += 1) {
      assert.deepEqual(local.recordLoginFailure(username, NOW), shared.recordFailure(username, NOW))
    }

    // 两个请求都在任一写入前通过预检（模拟登录接口的异步鉴权窗口），再按到达顺序记录失败。
    const runConcurrentRequests = async (
      precheck: (now: number) => LockoutState,
      record: (now: number) => LockoutState
    ): Promise<LockoutState[]> => {
      let prechecked = 0
      let openGate!: () => void
      const bothPrechecked = new Promise<void>((resolve) => {
        openGate = resolve
      })
      const attempt = async (recordAt: number): Promise<LockoutState> => {
        const state = precheck(NOW)
        assert.equal(state.locked, false, '预检必须发生在锁定之前')
        assert.equal(state.remaining, 1)
        prechecked += 1
        if (prechecked === 2) {
          openGate()
        }
        await bothPrechecked
        return record(recordAt)
      }
      return Promise.all([attempt(NOW), attempt(NOW + 1_000)])
    }

    const localResults = await runConcurrentRequests(
      (now) => local.loginLockState(username, now),
      (now) => local.recordLoginFailure(username, now)
    )
    const sharedResults = await runConcurrentRequests(
      (now) => shared.isLocked(username, now),
      (now) => shared.recordFailure(username, now)
    )

    assert.deepEqual(localResults, sharedResults)
    assert.deepEqual(localResults, [
      { locked: true, remaining: 0, lockedUntil: NOW + LOCK_MS },
      { locked: true, remaining: 0, lockedUntil: NOW + LOCK_MS }
    ])
    assert.deepEqual(
      local.loginLockState(username, NOW + 1_000),
      shared.isLocked(username, NOW + 1_000)
    )
  })

  test('三次失败后本地只读 remaining 与共享 isLocked 一致（=2）', () => {
    const local = new Store()
    const shared = createLockoutStore()
    const username = 'u292-remaining'

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.deepEqual(local.recordLoginFailure(username, NOW), shared.recordFailure(username, NOW))
    }

    const localState = local.loginLockState(username, NOW)
    const sharedState = shared.isLocked(username, NOW)
    assert.deepEqual(localState, sharedState)
    assert.equal(localState.remaining, 2)
    assert.equal(localState.locked, false)
    assert.equal(localState.lockedUntil, 0)
  })

  test('锁过期后本地只读态与共享一致，且新失败重新从满额计数', () => {
    const local = new Store()
    const shared = createLockoutStore()
    const username = 'u292-readonly-expiry'

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      local.recordLoginFailure(username, NOW)
      shared.recordFailure(username, NOW)
    }

    const afterExpiry = NOW + LOCK_MS + 1
    const localState = local.loginLockState(username, afterExpiry)
    const sharedState = shared.isLocked(username, afterExpiry)
    assert.deepEqual(localState, sharedState)
    assert.equal(localState.locked, false)
    assert.equal(localState.remaining, MAX_FAILURES)
    assert.equal(localState.lockedUntil, 0)

    assert.deepEqual(
      local.recordLoginFailure(username, afterExpiry),
      shared.recordFailure(username, afterExpiry)
    )
    assert.equal(local.loginLockState(username, afterExpiry).remaining, MAX_FAILURES - 1)
  })
})
