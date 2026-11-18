import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { attachStorePersistence } from '../src/store-persistence.ts'
import { restoreSnapshot } from '../src/snapshot-restore-codec.ts'
import { SNAPSHOT_VERSION, serializeSnapshot } from '../src/snapshot-serialize.ts'
import { createApp } from '../src/server.ts'

const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'orca-store-persistence-'))

function withEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.ORCA_PLATFORM_STORE_FILE
  if (value === undefined) {
    delete process.env.ORCA_PLATFORM_STORE_FILE
  } else {
    process.env.ORCA_PLATFORM_STORE_FILE = value
  }
  try {
    return run()
  } finally {
    if (previous === undefined) {
      delete process.env.ORCA_PLATFORM_STORE_FILE
    } else {
      process.env.ORCA_PLATFORM_STORE_FILE = previous
    }
  }
}

describe('平台 dev store 快照：refresh token 明文剥离（U233 F6）', () => {
  const digestOf = (token: string): string => createHash('sha256').update(token).digest('hex')

  test('快照文本不含明文 refresh token，重启后仍可用它刷新', async () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    try {
      const first = withEnv(file, () => createApp({ port: 0 }))
      const firstBase = `http://127.0.0.1:${await first.listen()}`
      const loginRes = await fetch(`${firstBase}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u233-snapshot' })
      })
      assert.equal(loginRes.status, 200)
      const loginBody = (await loginRes.json()) as Record<string, unknown>
      const refreshToken = String(loginBody.refreshToken)
      assert.ok(refreshToken.length > 0)
      await first.close()

      const text = readFileSync(file, 'utf8')
      assert.equal(text.includes(refreshToken), false, 'snapshot text must not carry the token')
      const decoded = JSON.parse(text) as { refreshTokens: [string, string][] }
      for (const [key] of decoded.refreshTokens) {
        assert.equal(key.includes(refreshToken), false, 'no snapshot key may be a plaintext token')
      }

      // Restore: the digest lookup must still map the original token to its session.
      const second = withEnv(file, () => createApp({ port: 0 }))
      const secondBase = `http://127.0.0.1:${await second.listen()}`
      try {
        assert.equal(second.store.refreshTokens.has(refreshToken), false)
        const refreshed = await fetch(`${secondBase}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken })
        })
        assert.equal(refreshed.status, 200)
        const refreshedBody = (await refreshed.json()) as Record<string, unknown>
        assert.equal(typeof refreshedBody.accessToken, 'string')
      } finally {
        await second.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('旧快照的明文 key 可加载，并在内存中重建为摘要', () => {
    const token = 'legacy-plaintext-refresh-token'
    const source = new Store()
    source.sessions.set('sess_legacy', {
      id: 'sess_legacy',
      userId: 'user_legacy',
      deviceId: 'device_legacy',
      epoch: 1,
      refreshHash: digestOf(token),
      refreshExpiresAt: 1,
      revokedAt: null
    })
    const snapshot = JSON.parse(serializeSnapshot(source)) as {
      version: number
      refreshTokensHashed?: boolean
      refreshTokens: [string, string][]
    }
    // Pre-U233 format: version 1, no digest marker, the map key was the plaintext token.
    snapshot.version = 1
    delete snapshot.refreshTokensHashed
    snapshot.refreshTokens = [[token, 'sess_legacy']]

    const restored = new Store()
    restoreSnapshot(restored, JSON.stringify(snapshot))

    assert.equal(restored.refreshTokens.has(token), false)
    assert.equal(restored.refreshTokens.get(digestOf(token)), 'sess_legacy')
  })

  function writeLegacySnapshot(file: string, token: string): void {
    const source = new Store()
    source.sessions.set('sess_legacy_disk', {
      id: 'sess_legacy_disk',
      userId: 'user_legacy',
      deviceId: 'device_legacy',
      epoch: 1,
      refreshHash: digestOf(token),
      refreshExpiresAt: 1,
      revokedAt: null
    })
    const snapshot = JSON.parse(serializeSnapshot(source)) as {
      version: number
      refreshTokensHashed?: boolean
      refreshTokens: [string, string][]
    }
    snapshot.version = 1
    delete snapshot.refreshTokensHashed
    snapshot.refreshTokens = [[token, 'sess_legacy_disk']]
    writeFileSync(file, JSON.stringify(snapshot), 'utf8')
  }

  test('旧明文快照加载后磁盘立即被清洗，无需等待状态变更', () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    const token = 'legacy-plaintext-token-on-disk'
    try {
      writeLegacySnapshot(file, token)

      const store = new Store()
      const handle = attachStorePersistence(store, {
        file,
        intervalMs: 60_000,
        log: { warn: () => {} }
      })
      try {
        assert.equal(store.refreshTokens.get(digestOf(token)), 'sess_legacy_disk')
        const onDisk = readFileSync(file, 'utf8')
        assert.equal(onDisk.includes(token), false, 'disk must be cleaned on load')
        const decoded = JSON.parse(onDisk) as {
          version: number
          refreshTokens: [string, string][]
        }
        assert.equal(decoded.version, SNAPSHOT_VERSION)
        for (const [key] of decoded.refreshTokens) {
          assert.ok(key.startsWith('sha256:'), 'every key must be a digest')
        }
      } finally {
        handle.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('清洗后 flush（close/SIGTERM 走同一路径）仍保持摘要形态', () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    const token = 'legacy-plaintext-flush-token'
    try {
      writeLegacySnapshot(file, token)

      const store = new Store()
      const handle = attachStorePersistence(store, {
        file,
        intervalMs: 60_000,
        log: { warn: () => {} }
      })
      try {
        handle.flushNow()
        const onDisk = readFileSync(file, 'utf8')
        assert.equal(onDisk.includes(token), false)
        assert.equal(onDisk, serializeSnapshot(store))
      } finally {
        handle.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('清洗后立即 flush 不产生第二次写（no-op）', () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    try {
      writeLegacySnapshot(file, 'legacy-plaintext-noop-token')

      const store = new Store()
      let writes = 0
      const handle = attachStorePersistence(store, {
        file,
        intervalMs: 60_000,
        log: { warn: () => {} },
        writeFile: (target, text) => {
          writes += 1
          writeFileSync(target, text, { encoding: 'utf8', mode: 0o600 })
        }
      })
      try {
        assert.equal(writes, 1, 'legacy snapshot is cleaned on load')
        handle.flushNow()
        assert.equal(writes, 1, 'flush without a state change must not write again')
        handle.flushNow()
        assert.equal(writes, 1)
      } finally {
        handle.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('立即写回失败不阻断启动，内存可用且下一次 flush 重试成功', () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    const token = 'legacy-plaintext-retry-token'
    try {
      writeLegacySnapshot(file, token)

      const store = new Store()
      const warnings: unknown[] = []
      let attempts = 0
      const handle = attachStorePersistence(store, {
        file,
        intervalMs: 60_000,
        log: { warn: (...args: unknown[]) => warnings.push(args) },
        writeFile: (target, text) => {
          attempts += 1
          if (attempts === 1) {
            throw new Error('injected write failure')
          }
          writeFileSync(target, text, { encoding: 'utf8', mode: 0o600 })
        }
      })
      try {
        assert.equal(attempts, 1)
        assert.equal(warnings.length, 1, 'write failure must be logged')
        assert.equal(store.refreshTokens.get(digestOf(token)), 'sess_legacy_disk')
        assert.equal(readFileSync(file, 'utf8').includes(token), true, 'file unchanged on failure')

        handle.flushNow()
        assert.equal(attempts, 2)
        assert.equal(readFileSync(file, 'utf8').includes(token), false)
      } finally {
        handle.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
