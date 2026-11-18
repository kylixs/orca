import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import {
  attachStorePersistence,
  restoreSnapshot,
  serializeSnapshot,
  SNAPSHOT_VERSION
} from '../src/store-persistence.ts'
import { createApp } from '../src/server.ts'

/**
 * U131: the dev platform used to lose every host/project on restart. These cases
 * pin the snapshot format, the restart round-trip, and seed idempotency so a
 * restored store is not re-seeded with fresh ids.
 */

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

describe('平台 dev store 快照：序列化与恢复', () => {
  test('往返恢复 hosts/projects/grants/hostTokens/policies/auditSeq', () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    try {
      const first = new Store()
      first.seedUser({
        username: 'alice',
        displayName: 'Alice',
        dept: 'eng',
        email: 'alice@example.test',
        groups: ['developers'],
        roles: ['developer'],
        status: 'active'
      })
      first.hosts.set('host_a', {
        id: 'host_a',
        name: 'dev-a',
        fingerprint: 'fp',
        tlsFingerprint: null,
        e2eePublicKey: 'pk',
        orcaVersion: '1.0.0',
        protocolVersion: 3,
        zone: 'intranet',
        directAddrs: ['127.0.0.1:1'],
        relayRoute: null,
        capabilities: ['pty'],
        projectsRoot: null,
        projectDirs: [],
        status: 'online',
        maintenanceReason: null,
        lastHeartbeatAt: 1,
        credentialHash: 'hash',
        revokedAt: null
      })
      first.projects.set('proj_a', {
        id: 'proj_a',
        key: 'demo',
        name: 'demo',
        repoUrl: 'git@example.test:demo.git',
        hostId: 'host_a',
        path: '/tmp/demo',
        defaultBranch: 'main',
        downloadPolicy: 'allow',
        status: 'ready',
        createdAt: 2
      })
      first.grants.push({
        projectId: 'proj_a',
        subjectType: 'user',
        subjectId: 'user_alice',
        permissions: ['open', 'terminal']
      })
      first.hostTokens.push({ tokenHash: 'token-hash', expiresAt: 3, usedAt: null })
      first.policies.downloadDefault = 'allow'
      first.auditSeq = 7
      first.auditTip = 'tip-7'

      const handle = attachStorePersistence(first, {
        file,
        intervalMs: 60_000,
        log: { warn: () => {} }
      })
      try {
        ;(handle as { flushNow: () => void }).flushNow()
      } finally {
        handle.stop()
      }

      const restored = new Store()
      let warned = 0
      attachStorePersistence(restored, {
        file,
        intervalMs: 60_000,
        log: { warn: () => (warned += 1) }
      }).stop()

      assert.equal(warned, 0)
      assert.deepEqual(restored.hosts.get('host_a'), first.hosts.get('host_a'))
      assert.deepEqual(restored.projects.get('proj_a'), first.projects.get('proj_a'))
      assert.deepEqual(restored.grants, first.grants)
      assert.deepEqual(restored.hostTokens, first.hostTokens)
      assert.equal(restored.policies.downloadDefault, 'allow')
      assert.equal(restored.auditSeq, 7)
      assert.equal(restored.auditTip, 'tip-7')
      assert.equal(restored.users.size, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('恢复时重建 usersByName/hostsByName/projectsByKey 索引', () => {
    const source = new Store()
    source.seedUser({
      username: 'bob',
      displayName: 'Bob',
      dept: 'eng',
      email: 'bob@example.test',
      groups: [],
      roles: ['developer'],
      status: 'active'
    })
    source.hosts.set('host_b', {
      id: 'host_b',
      name: 'dev-b',
      fingerprint: 'fp',
      tlsFingerprint: null,
      e2eePublicKey: 'pk',
      orcaVersion: '1.0.0',
      protocolVersion: 3,
      zone: 'intranet',
      directAddrs: [],
      relayRoute: null,
      capabilities: [],
      projectsRoot: null,
      projectDirs: [],
      status: 'online',
      maintenanceReason: null,
      lastHeartbeatAt: 1,
      credentialHash: null,
      revokedAt: null
    })
    source.projects.set('proj_b', {
      id: 'proj_b',
      key: 'key-b',
      name: 'key-b',
      repoUrl: '',
      hostId: 'host_b',
      path: '/tmp/b',
      defaultBranch: 'main',
      downloadPolicy: 'deny',
      status: 'ready',
      createdAt: 1
    })

    const restored = new Store()
    restoreSnapshot(restored, serializeSnapshot(source))

    assert.equal(restored.usersByName.get('bob')?.username, 'bob')
    assert.equal(
      restored.users.get(restored.usersByName.get('bob')?.id ?? ''),
      restored.usersByName.get('bob')
    )
    assert.equal(restored.hostsByName.get('dev-b')?.id, 'host_b')
    assert.equal(restored.projectsByKey.get('key-b')?.id, 'proj_b')
  })

  test('审计只保留最后 10000 条', () => {
    const source = new Store()
    for (let index = 1; index <= 10_005; index += 1) {
      source.audit.push({
        eventType: 'probe',
        actor: null,
        targetType: null,
        targetId: null,
        result: 'success',
        traceId: null,
        seq: index,
        ts: index,
        prevHash: `prev-${index}`,
        hash: `hash-${index}`
      })
    }
    source.auditSeq = 10_005
    source.auditTip = 'hash-10005'

    const decoded = JSON.parse(serializeSnapshot(source)) as { audit: { seq: number }[] }
    assert.equal(decoded.audit.length, 10_000)
    assert.equal(decoded.audit[0]?.seq, 6)
    assert.equal(decoded.audit.at(-1)?.seq, 10_005)

    const restored = new Store()
    restoreSnapshot(restored, serializeSnapshot(source))
    assert.equal(restored.audit.length, 10_000)
    assert.equal(restored.auditSeq, 10_005)
    assert.equal(restored.auditTip, 'hash-10005')
  })
})

describe('平台 dev store 快照：损坏与默认关闭', () => {
  /** U249 P2-2/P3: unreadable files are renamed, old backups pruned, the store stays empty. */
  async function assertUnreadableSnapshotPreserved(
    name: string,
    original: Buffer
  ): Promise<void> {
    const root = tempRoot()
    try {
      const file = path.join(root, name)
      const seeded = [1000, 2000, 4000].map((ts) => `${name}.corrupt-${ts}`)
      writeFileSync(file, original)
      for (const entry of seeded) {
        writeFileSync(path.join(root, entry), 'old', 'utf8')
      }
      const store = new Store()
      const warnings: string[] = []
      const handle = attachStorePersistence(store, {
        file,
        intervalMs: 50,
        log: { warn: (message?: unknown) => warnings.push(String(message)) }
      })
      try {
        assert.equal(existsSync(file), false, 'an unreadable snapshot must be renamed away')
        const backups = readdirSync(root).filter((entry) =>
          entry.startsWith(`${name}.corrupt-`)
        )
        assert.equal(backups.length, 3, 'only the newest 3 backups are kept')
        assert.equal(backups.includes(seeded[0]!), false, 'older backups are pruned')
        const preserved = backups.filter((entry) => !seeded.includes(entry))
        assert.equal(preserved.length, 1)
        assert.ok(readFileSync(path.join(root, preserved[0]!)).equals(original))

        // Let at least one 50ms flush tick run: it must not touch the backup.
        await new Promise((resolve) => setTimeout(resolve, 150))
        assert.equal(warnings.length, 1)
        assert.equal(existsSync(file), true, 'the first tick must write a fresh snapshot')
        assert.equal(store.users.size, 0)
        assert.equal(store.sessions.size, 0)
        assert.equal(store.hosts.size, 0)
        assert.equal(store.policies.version, 1)
        assert.equal(store.auditSeq, 0)
      } finally {
        handle.stop()
      }
      // A second startup reads the fresh empty snapshot: no warning, no new backup.
      const second = new Store()
      const secondWarnings: unknown[] = []
      attachStorePersistence(second, {
        file,
        intervalMs: 50,
        log: { warn: (...args: unknown[]) => secondWarnings.push(args[0]) }
      }).stop()
      assert.equal(secondWarnings.length, 0)
      assert.equal(second.users.size, 0)
      assert.equal(
        readdirSync(root).filter((entry) => entry.startsWith(`${name}.corrupt-`)).length,
        3
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test('损坏 JSON 快照：改名保留原字节，首个 tick 写入合法空快照', async () => {
    // Invalid UTF-8 plus non-JSON bytes: any rewrite would change these bytes.
    await assertUnreadableSnapshotPreserved(
      'broken.json',
      Buffer.from([0x7b, 0x6e, 0x6f, 0x74, 0x2d, 0x6a, 0x73, 0x6f, 0x6e, 0xff, 0x00])
    )
  })

  test('不支持的快照版本：改名保留原字节，首个 tick 写入合法空快照', async () => {
    await assertUnreadableSnapshotPreserved(
      'wrong-version.json',
      Buffer.from(JSON.stringify({ version: 99, marker: 'keep-me' }), 'utf8')
    )
  })

  test('policies 校验失败时不部分应用：users/sessions/policies 保持为空/默认', () => {
    const source = new Store()
    source.seedUser({
      username: 'partial',
      displayName: 'Partial',
      dept: 'eng',
      email: 'partial@example.test',
      groups: [],
      roles: ['developer'],
      status: 'active'
    })
    source.sessions.set('sess_partial', {
      id: 'sess_partial',
      userId: 'user_partial',
      deviceId: 'device_partial',
      epoch: 1,
      refreshHash: 'hash-partial',
      refreshExpiresAt: 1,
      revokedAt: null
    })
    const snapshot = JSON.parse(serializeSnapshot(source)) as {
      policies: Record<string, unknown>
    }
    delete snapshot.policies.version

    const restored = new Store()
    assert.throws(
      () => restoreSnapshot(restored, JSON.stringify(snapshot)),
      /policies\.version/
    )
    // U249 P2-3: nothing may be committed when validation fails.
    assert.equal(restored.users.size, 0)
    assert.equal(restored.usersByName.size, 0)
    assert.equal(restored.sessions.size, 0)
    assert.equal(restored.policies.version, 1)
    assert.deepEqual(restored.policies.readRatePerHour, {
      calls: 600,
      bytes: 64 * 1024 * 1024
    })
  })

  test('毒化 entry 值：整体不提交，快照按不可读流程改名并自愈', async () => {
    const doc = JSON.parse(serializeSnapshot(new Store())) as { users: unknown[] }
    doc.users = [['user_poison', null]]
    await assertUnreadableSnapshotPreserved('poisoned.json', Buffer.from(JSON.stringify(doc)))
  })

  test('env 未设置时不加载也不创建快照文件', async () => {
    const root = tempRoot()
    const file = path.join(root, 'platform-store.json')
    try {
      const snapshot = new Store()
      snapshot.seedUser({
        username: 'admin',
        displayName: 'snapshot-admin',
        dept: '',
        email: '',
        groups: [],
        roles: [],
        status: 'active'
      })
      writeFileSync(file, serializeSnapshot(snapshot), 'utf8')
      const before = readFileSync(file, 'utf8')

      const app = withEnv(undefined, () => createApp({ port: 0 }))
      assert.equal(
        app.store.users.get(app.store.usersByName.get('admin')?.id ?? '')?.displayName,
        '李静'
      )
      assert.equal(app.store.users.size, 2)
      await app.close()

      assert.equal(readFileSync(file, 'utf8'), before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

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
