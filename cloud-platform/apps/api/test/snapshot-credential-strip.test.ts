import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.ts'
import { restoreSnapshot } from '../src/snapshot-restore-codec.ts'
import { serializeSnapshot } from '../src/snapshot-serialize.ts'

/**
 * D18: transient credentials never reach the dev-store snapshot. The arrays
 * stay in the schema so an older reader still loads a newer file.
 */

test('快照丢弃 accessTokens/webHandoffs 与 session 明文 refresh，schema 保持', () => {
  const store = new Store()
  const accessToken = 'access-token-plaintext-secret'
  const refreshToken = 'refresh-token-plaintext-secret'
  const handoffCode = 'handoff-code-plaintext-secret'
  store.sessions.set('sess_strip', {
    id: 'sess_strip',
    userId: 'user_strip',
    deviceId: 'dev_strip',
    epoch: 1,
    refreshHash: 'sha256-digest-of-refresh',
    refreshExpiresAt: 1_800_000_000_000,
    currentRefreshToken: refreshToken,
    revokedAt: null
  })
  store.accessTokens.set(accessToken, {
    sessionId: 'sess_strip',
    userId: 'user_strip',
    epoch: 1,
    expiresAt: 1_800_000_000_000
  })
  store.webHandoffs.set(handoffCode, {
    userId: 'user_strip',
    projectId: 'proj_strip',
    expiresAt: 1_800_000_000_000
  })

  const text = serializeSnapshot(store)
  const parsed = JSON.parse(text) as {
    accessTokens: unknown[]
    webHandoffs: unknown[]
    sessions: [string, Record<string, unknown>][]
  }

  assert.deepEqual(parsed.accessTokens, [])
  assert.deepEqual(parsed.webHandoffs, [])
  assert.equal(parsed.sessions.length, 1)
  assert.equal('currentRefreshToken' in (parsed.sessions[0]?.[1] ?? {}), false)
  for (const secret of [accessToken, refreshToken, handoffCode]) {
    assert.equal(text.includes(secret), false, `snapshot must not carry ${secret}`)
  }

  const restored = new Store()
  restoreSnapshot(restored, text)
  assert.equal(restored.accessTokens.size, 0)
  assert.equal(restored.webHandoffs.size, 0)
  assert.ok(restored.sessions.get('sess_strip'))
})
