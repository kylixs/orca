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

describe('平台 dev store 快照：版本兼容与回滚（U233/U249）', () => {
  const digestOf = (token: string): string => createHash('sha256').update(token).digest('hex')
  type MutableSnapshot = {
    version: number
    refreshTokensHashed?: boolean
    refreshTokens: [string, string][]
  }

  test('写出 v1 + 哈希标记，读取端接受 v1/v2，未知版本拒绝', () => {
    const digest = digestOf('v1-token')
    const source = new Store()
    source.refreshTokens.set(digest, 'sess_v1')
    const current = JSON.parse(serializeSnapshot(source)) as Record<string, unknown> & {
      refreshTokens: [string, string][]
    }
    assert.equal(current.version, SNAPSHOT_VERSION)
    assert.equal(SNAPSHOT_VERSION, 1)
    assert.equal(current.refreshTokensHashed, true)

    const fromV1 = { ...current }
    delete fromV1.refreshTokensHashed
    fromV1.refreshTokens = [[digest, 'sess_v1']]
    const legacy = new Store()
    restoreSnapshot(legacy, JSON.stringify(fromV1))
    assert.equal(legacy.refreshTokens.get(digestOf(digest)), 'sess_v1')

    const fromV2 = new Store()
    restoreSnapshot(fromV2, JSON.stringify({ ...current, version: 2 }))
    assert.equal(fromV2.refreshTokens.get(digest), 'sess_v1')

    assert.throws(
      () => restoreSnapshot(new Store(), JSON.stringify({ ...current, version: 3 })),
      /version 3 is not supported/
    )
  })

  test('回滚：v1 旧读取端能加载 users/sessions/projects，只有刷新需要重登', () => {
    const token = 'rollback-refresh-token'
    const source = new Store()
    source.seedUser({
      username: 'rollback',
      displayName: 'Rollback',
      dept: 'eng',
      email: 'rollback@example.test',
      groups: [],
      roles: ['developer'],
      status: 'active'
    })
    source.sessions.set('sess_rollback', {
      id: 'sess_rollback',
      userId: 'user_rollback',
      deviceId: 'device_rollback',
      epoch: 1,
      refreshHash: digestOf(token),
      refreshExpiresAt: 1,
      revokedAt: null
    })
    source.projects.set('proj_rollback', {
      id: 'proj_rollback',
      key: 'rollback',
      name: 'rollback',
      repoUrl: '',
      hostId: 'host_rollback',
      path: '/tmp/rollback',
      defaultBranch: 'main',
      downloadPolicy: 'deny',
      status: 'ready',
      createdAt: 1
    })
    source.refreshTokens.set(digestOf(token), 'sess_rollback')

    const doc = JSON.parse(serializeSnapshot(source)) as {
      version: number
      refreshTokensHashed?: boolean
      users: unknown[]
      sessions: unknown[]
      projects: unknown[]
      refreshTokens: [string, string][]
    }
    // A pre-U233 binary accepted exactly version 1 and kept these arrays verbatim.
    assert.equal(doc.version, 1)
    assert.equal(doc.refreshTokensHashed, true)
    assert.equal(doc.users.length, 1)
    assert.equal(doc.sessions.length, 1)
    assert.equal(doc.projects.length, 1)

    // The key is a digest, never the plaintext token, so the old reader's
    // plaintext lookup misses and the user re-logs in instead of losing state.
    const [[snapshotKey, sessionId]] = doc.refreshTokens
    assert.ok(snapshotKey!.startsWith('sha256:'))
    assert.notEqual(snapshotKey, token)
    assert.equal(sessionId, 'sess_rollback')

    // The new reader strips the marker prefix exactly once (no double hash).
    const restored = new Store()
    restoreSnapshot(restored, JSON.stringify(doc))
    assert.equal(restored.users.size, 1)
    assert.equal(restored.sessions.size, 1)
    assert.equal(restored.projects.size, 1)
    assert.equal(restored.refreshTokens.get(digestOf(token)), 'sess_rollback')
    assert.equal(restored.refreshTokens.has(snapshotKey!), false)
  })

  test('无标记的 sha256: 前缀 key 只剥离一次，有标记语义不变', () => {
    const digest = digestOf('downgrade-token')
    const doc = JSON.parse(serializeSnapshot(new Store())) as MutableSnapshot
    doc.version = 1
    delete doc.refreshTokensHashed
    doc.refreshTokens = [[`sha256:${digest}`, 'sess_a']]
    const unmarked = new Store()
    restoreSnapshot(unmarked, JSON.stringify(doc))
    assert.equal(unmarked.refreshTokens.get(digest), 'sess_a')
    assert.equal(unmarked.refreshTokens.has(digestOf(`sha256:${digest}`)), false)
    doc.refreshTokensHashed = true
    doc.refreshTokens = [[digest, 'sess_a']]
    restoreSnapshot(unmarked, JSON.stringify(doc))
    assert.equal(unmarked.refreshTokens.get(digest), 'sess_a')
  })

  test('降级写回后提交 sha256:<digest> 不命中会话，也不触发撤销', async () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    const post = (base: string, route: string, body: unknown) =>
      fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    try {
      const first = withEnv(file, () => createApp({ port: 0 }))
      const base = `http://127.0.0.1:${await first.listen()}`
      const login = await post(base, '/v1/auth/login', { username: 'admin', password: 'Adm1n!', deviceName: 'u249-p21' })
      assert.equal(login.status, 200)
      const token = String(((await login.json()) as Record<string, unknown>).refreshToken)
      await first.close()
      // A pre-U233 binary flushes the state it restored: no marker, keys verbatim.
      const doc = JSON.parse(readFileSync(file, 'utf8')) as MutableSnapshot
      doc.version = 1
      delete doc.refreshTokensHashed
      const forgedKey = `sha256:${digestOf(token)}`
      const sessionId = doc.refreshTokens.find(([key]) => key === forgedKey)?.[1]
      assert.ok(sessionId, 'the rewritten file must carry the prefixed digest key')
      writeFileSync(file, JSON.stringify(doc), 'utf8')
      const second = withEnv(file, () => createApp({ port: 0 }))
      const secondBase = `http://127.0.0.1:${await second.listen()}`
      try {
        assert.equal((await post(secondBase, '/v1/auth/refresh', { refreshToken: forgedKey })).status, 401)
        assert.equal(second.store.sessions.get(sessionId!)?.revokedAt, null)
        const real = await post(secondBase, '/v1/auth/refresh', { refreshToken: token })
        assert.equal(real.status, 200, 'the real token must still refresh')
      } finally {
        await second.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('已写出的 v2 文件可加载，并在启动时降级写回 v1 + 标记', () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    const token = 'v2-file-token'
    try {
      const source = new Store()
      source.seedUser({
        username: 'v2',
        displayName: 'V2',
        dept: '',
        email: '',
        groups: [],
        roles: [],
        status: 'active'
      })
      source.sessions.set('sess_v2_file', {
        id: 'sess_v2_file',
        userId: 'user_v2',
        deviceId: 'device_v2',
        epoch: 1,
        refreshHash: digestOf(token),
        refreshExpiresAt: 1,
        revokedAt: null
      })
      source.refreshTokens.set(digestOf(token), 'sess_v2_file')
      const v2 = JSON.parse(serializeSnapshot(source)) as Record<string, unknown>
      v2.version = 2
      delete v2.refreshTokensHashed
      writeFileSync(file, JSON.stringify(v2), 'utf8')

      const store = new Store()
      const handle = attachStorePersistence(store, {
        file,
        intervalMs: 60_000,
        log: { warn: () => {} }
      })
      try {
        assert.equal(store.users.size, 1)
        assert.equal(store.sessions.size, 1)
        assert.equal(store.refreshTokens.get(digestOf(token)), 'sess_v2_file')

        const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
          version: number
          refreshTokensHashed?: boolean
        }
        assert.equal(onDisk.version, 1, 'a v2 file must be rewritten as v1')
        assert.equal(onDisk.refreshTokensHashed, true)
      } finally {
        handle.stop()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('平台 dev store 快照：重启与种子幂等', () => {
  test('第二次启动种子不重复建用户，id 不变，host/project/grant 不重复', async () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    try {
      const first = withEnv(file, () => createApp({ port: 0 }))
      const adminId = first.store.usersByName.get('admin')?.id
      const devId = first.store.usersByName.get('zhangsan')?.id
      assert.ok(adminId)
      assert.ok(devId)
      assert.equal(first.store.users.size, 2)
      assert.equal(first.store.hosts.size, 1)
      assert.equal(first.store.projects.size, 1)
      assert.equal(first.store.grants.length, 1)
      await first.close()

      const second = withEnv(file, () => createApp({ port: 0 }))
      try {
        assert.equal(second.store.usersByName.get('admin')?.id, adminId)
        assert.equal(second.store.usersByName.get('zhangsan')?.id, devId)
        assert.equal(second.store.users.size, 2)
        assert.equal(second.store.hosts.size, 1)
        assert.equal(second.store.projects.size, 1)
        assert.equal(second.store.grants.length, 1)
      } finally {
        await second.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('快照不落盘 currentRefreshToken（U197 仅内存明文）', () => {
    const store = new Store()
    store.sessions.set('sess_u197', {
      id: 'sess_u197',
      userId: 'user_u197',
      deviceId: 'device_u197',
      epoch: 1,
      refreshHash: 'hash-current',
      refreshExpiresAt: 1,
      currentRefreshToken: 'plaintext-current',
      revokedAt: null
    })
    const snapshot = JSON.parse(serializeSnapshot(store)) as {
      sessions: [string, Record<string, unknown>][]
    }
    assert.equal('currentRefreshToken' in snapshot.sessions[0]![1], false)

    const restored = new Store()
    restoreSnapshot(restored, serializeSnapshot(store))
    assert.equal(restored.sessions.get('sess_u197')?.refreshHash, 'hash-current')
    assert.equal(restored.sessions.get('sess_u197')?.currentRefreshToken, undefined)
  })
})
