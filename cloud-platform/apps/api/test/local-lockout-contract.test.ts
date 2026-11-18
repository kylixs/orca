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
})
