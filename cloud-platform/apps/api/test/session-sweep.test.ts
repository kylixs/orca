import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, type Revocation, type Session } from '../src/store.ts'
import {
  DEFAULT_SESSION_SWEEP_INTERVAL_MS,
  SESSION_RETENTION_MS,
  resolveSessionSweepIntervalMs,
  startSessionSweep,
  sweepSessionsOnce
} from '../src/session-sweep.ts'
import { createApp } from '../src/server.ts'

/**
 * D18 / U233 F6: the sweep only removes credentials that can no longer
 * authenticate, revokes an expired live session before deleting it, and never
 * touches `revocations`.
 */

const NOW = 1_800_000_000_000

function makeSession(
  id: string,
  input: { refreshExpiresAt: number; revokedAt?: number | null }
): Session {
  return {
    id,
    userId: `user_${id}`,
    deviceId: `dev_${id}`,
    epoch: 1,
    refreshHash: `hash_${id}`,
    refreshExpiresAt: input.refreshExpiresAt,
    revokedAt: input.revokedAt ?? null
  }
}

function addSession(store: Store, session: Session): Session {
  const user = {
    id: session.userId,
    username: `u_${session.id}`,
    displayName: session.id,
    dept: 'test',
    email: `${session.id}@example.test`,
    groups: [],
    roles: ['developer'],
    status: 'active' as const
  }
  store.users.set(user.id, user)
  store.usersByName.set(user.username, user)
  store.sessions.set(session.id, session)
  return session
}

function addAccessToken(store: Store, token: string, session: Session, expiresAt: number): void {
  store.accessTokens.set(token, {
    sessionId: session.id,
    userId: session.userId,
    epoch: session.epoch,
    expiresAt
  })
}

function deps(store: Store, clock: { at: number }, events: string[]) {
  return {
    store,
    now: () => clock.at,
    revokeSessionOnce: (session: Session): boolean => {
      if (session.revokedAt !== null) return false
      session.revokedAt = clock.at
      session.epoch += 1
      return true
    },
    recordExpired: (session: Session): void => {
      events.push(session.id)
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('D18 会话清扫：配置', () => {
  test('默认 60s、显式 0 关闭、非法值回退', () => {
    assert.equal(DEFAULT_SESSION_SWEEP_INTERVAL_MS, 60_000)
    assert.equal(resolveSessionSweepIntervalMs({}), 60_000)
    assert.equal(resolveSessionSweepIntervalMs({ ORCA_CLOUD_SESSION_SWEEP_MS: '0' }), 0)
    assert.equal(resolveSessionSweepIntervalMs({ ORCA_CLOUD_SESSION_SWEEP_MS: '250' }), 250)
    assert.equal(resolveSessionSweepIntervalMs({ ORCA_CLOUD_SESSION_SWEEP_MS: 'nope' }), 60_000)
    assert.equal(resolveSessionSweepIntervalMs({ ORCA_CLOUD_SESSION_SWEEP_MS: ' ' }), 60_000)
  })
})

describe('D18 会话清扫：删除集合与保留集合', () => {
  test('预置过期/撤销/在线 session 与孤儿 token：一轮后精确匹配', () => {
    const store = new Store()
    const clock = { at: NOW }
    const events: string[] = []
    const revocations: Revocation[] = [
      { targetType: 'user', targetId: 'user_x', reason: 'disabled', at: NOW - 5_000 }
    ]
    store.revocations = revocations

    const live = addSession(
      store,
      makeSession('sess_live', { refreshExpiresAt: NOW + SESSION_RETENTION_MS * 10 })
    )
    const expired = addSession(store, makeSession('sess_expired', { refreshExpiresAt: NOW - 1 }))
    const oldRevoked = addSession(
      store,
      makeSession('sess_old', {
        refreshExpiresAt: NOW + 60_000,
        revokedAt: NOW - SESSION_RETENTION_MS
      })
    )
    const recentRevoked = addSession(
      store,
      makeSession('sess_recent', {
        refreshExpiresAt: NOW + 60_000,
        revokedAt: NOW - SESSION_RETENTION_MS + 1
      })
    )

    addAccessToken(store, 'tok_live', live, NOW + SESSION_RETENTION_MS * 10)
    addAccessToken(store, 'tok_stale', live, NOW - 1)
    addAccessToken(store, 'tok_expired_session', expired, NOW + 60_000)
    addAccessToken(store, 'tok_old', oldRevoked, NOW + 60_000)
    addAccessToken(store, 'tok_recent', recentRevoked, NOW + 60_000)
    store.refreshTokens.set('ref_live', live.id)
    store.refreshTokens.set('ref_expired', expired.id)
    store.refreshTokens.set('ref_old', oldRevoked.id)
    store.refreshTokens.set('ref_recent', recentRevoked.id)
    store.refreshTokens.set('ref_orphan', 'sess_missing')

    // Snapshot the revocation ledger by value: `store.revocations` aliases the
    // fixture array, so deepEqual against it would pass even if sweep mutated
    // entries in place. Compare serialized copies instead.
    const revocationsBefore = JSON.stringify(store.revocations)

    sweepSessionsOnce(deps(store, clock, events))

    assert.deepEqual([...store.sessions.keys()].sort(), [
      'sess_expired',
      'sess_live',
      'sess_recent'
    ])
    assert.deepEqual([...store.refreshTokens.keys()].sort(), [
      'ref_expired',
      'ref_live',
      'ref_recent'
    ])
    assert.deepEqual([...store.accessTokens.keys()], ['tok_live'])
    assert.deepEqual(events, ['sess_expired'], 'one event for the one expiry transition')
    assert.equal(expired.revokedAt, NOW)
    assert.equal(expired.epoch, 2)
    assert.equal(
      JSON.stringify(store.revocations),
      revocationsBefore,
      'revocations are never swept'
    )

    // Past retention the expired/recently revoked sessions and their refresh
    // digests go too; the live session and the event survive.
    clock.at = NOW + SESSION_RETENTION_MS + 1
    sweepSessionsOnce(deps(store, clock, events))

    assert.deepEqual([...store.sessions.keys()], ['sess_live'])
    assert.deepEqual([...store.refreshTokens.keys()], ['ref_live'])
    assert.deepEqual([...store.accessTokens.keys()], ['tok_live'])
    assert.deepEqual(events, ['sess_expired'], 'deletion must not write another event')
    assert.equal(JSON.stringify(store.revocations), revocationsBefore)
  })

  test('retention 边界：恰好到期删除，早 1ms 保留', () => {
    const store = new Store()
    const clock = { at: NOW }
    const events: string[] = []
    addSession(
      store,
      makeSession('sess_boundary', {
        refreshExpiresAt: NOW + 60_000,
        revokedAt: NOW - SESSION_RETENTION_MS
      })
    )
    addSession(
      store,
      makeSession('sess_inside', {
        refreshExpiresAt: NOW + 60_000,
        revokedAt: NOW - SESSION_RETENTION_MS + 1
      })
    )

    sweepSessionsOnce(deps(store, clock, events))

    assert.deepEqual([...store.sessions.keys()], ['sess_inside'])
  })

  test('live session 与有效 access token 不被删除', () => {
    const store = new Store()
    const clock = { at: NOW }
    const events: string[] = []
    const live = addSession(store, makeSession('sess_live', { refreshExpiresAt: NOW + 60_000 }))
    addAccessToken(store, 'tok_live', live, NOW + 60_000)
    store.refreshTokens.set('ref_live', live.id)

    sweepSessionsOnce(deps(store, clock, events))

    assert.equal(store.sessions.get('sess_live'), live)
    assert.equal(store.accessTokens.has('tok_live'), true)
    assert.equal(store.refreshTokens.get('ref_live'), 'sess_live')
    assert.deepEqual(events, [])
  })

  test('过期未撤销 session：先撤销并只记 1 条事件，连续清扫不重复', () => {
    const store = new Store()
    const clock = { at: NOW }
    const events: string[] = []
    addSession(store, makeSession('sess_expired', { refreshExpiresAt: NOW - 1 }))

    sweepSessionsOnce(deps(store, clock, events))
    sweepSessionsOnce(deps(store, clock, events))
    clock.at = NOW + 1_000
    sweepSessionsOnce(deps(store, clock, events))

    assert.deepEqual(events, ['sess_expired'])
  })
})

describe('D18 会话清扫：定时器', () => {
  test('启动时立即 prune 一次，不等首个 interval', () => {
    const store = new Store()
    const clock = { at: NOW }
    const events: string[] = []
    const expired = addSession(
      store,
      makeSession('sess_boot_immediate', { refreshExpiresAt: NOW - 1 })
    )

    const sweep = startSessionSweep({
      ...deps(store, clock, events),
      intervalMs: DEFAULT_SESSION_SWEEP_INTERVAL_MS
    })
    try {
      assert.equal(expired.revokedAt, NOW, 'startup prune runs synchronously')
      assert.deepEqual(events, ['sess_boot_immediate'])
    } finally {
      sweep.stop()
    }
  })

  test('intervalMs=0 完全关闭：连启动 prune 也不执行', () => {
    const store = new Store()
    const clock = { at: NOW }
    const events: string[] = []
    const expired = addSession(
      store,
      makeSession('sess_disabled', { refreshExpiresAt: NOW - 1 })
    )

    const sweep = startSessionSweep({ ...deps(store, clock, events), intervalMs: 0 })
    try {
      assert.equal(expired.revokedAt, null)
      assert.deepEqual(events, [])
    } finally {
      sweep.stop()
    }
  })

  test('stop 后不再有残留 interval 执行', async () => {
    const store = new Store()
    const clock = { at: NOW }
    const events: string[] = []
    const sweep = startSessionSweep({ ...deps(store, clock, events), intervalMs: 10 })
    try {
      addSession(store, makeSession('sess_first', { refreshExpiresAt: NOW - 1 }))
      await waitFor(() => events.length === 1)

      sweep.stop()
      addSession(store, makeSession('sess_after_stop', { refreshExpiresAt: NOW - 1 }))
      await new Promise((resolve) => setTimeout(resolve, 50))

      assert.deepEqual(events, ['sess_first'])
      assert.equal(store.sessions.get('sess_after_stop')?.revokedAt, null)
    } finally {
      sweep.stop()
    }
  })

  test('撤销 session 的 accessToken 在 sweep 后从存储消失且请求 401', async () => {
    const clock = { at: NOW }
    const app = createApp({
      port: 0,
      accessTtlMs: 600_000,
      refreshTtlMs: 600_000,
      cookieMode: 'never',
      sessionSweepMs: 10,
      now: () => clock.at
    })
    const port = await app.listen()
    const base = `http://127.0.0.1:${port}`
    try {
      const loginRes = await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'd18-sweep' })
      })
      assert.equal(loginRes.status, 200)
      const { accessToken } = (await loginRes.json()) as { accessToken: string }
      assert.equal(app.store.accessTokens.has(accessToken), true)

      const session = [...app.store.sessions.values()][0]
      assert.ok(session)
      session.revokedAt = clock.at
      await waitFor(() => !app.store.accessTokens.has(accessToken))

      const me = await fetch(`${base}/v1/me`, {
        headers: { authorization: `Bearer ${accessToken}` }
      })
      assert.equal(me.status, 401, 'a swept token can no longer authenticate')
    } finally {
      await app.close()
    }
  })

  test('server 接线：启动清扫、close 后停止', async () => {
    const app = createApp({
      port: 0,
      accessTtlMs: 60_000,
      refreshTtlMs: 60_000,
      cookieMode: 'never',
      sessionSweepMs: 10,
      now: () => NOW
    })
    await app.listen()
    try {
      const expired = addSession(app.store, makeSession('sess_boot', { refreshExpiresAt: NOW - 1 }))
      await waitFor(() => expired.revokedAt !== null)
      const events = app.store.audit.filter((event) => event.eventType === 'session.expired')
      assert.equal(events.length, 1)
      assert.equal(events[0]?.metadata.source, 'sweep')
      assert.equal(events[0]?.targetId, expired.id)

      await app.close()
      const late = addSession(app.store, makeSession('sess_late', { refreshExpiresAt: NOW - 1 }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(late.revokedAt, null, 'close must clear the sweep interval')
    } finally {
      await app.close().catch(() => {})
    }
  })
})
