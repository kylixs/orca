import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  test('损坏 JSON 与版本不符都被忽略，起空 store 并 warn', () => {
    const root = tempRoot()
    try {
      const broken = path.join(root, 'broken.json')
      writeFileSync(broken, '{not-json', 'utf8')
      const store = new Store()
      const warnings: string[] = []
      attachStorePersistence(store, {
        file: broken,
        intervalMs: 60_000,
        log: { warn: (message?: unknown) => warnings.push(String(message)) }
      }).stop()
      assert.equal(store.users.size, 0)
      assert.equal(store.hosts.size, 0)
      assert.equal(warnings.length, 1)

      const wrongVersion = path.join(root, 'wrong-version.json')
      writeFileSync(wrongVersion, JSON.stringify({ version: 99 }), 'utf8')
      const store2 = new Store()
      const warnings2: string[] = []
      attachStorePersistence(store2, {
        file: wrongVersion,
        intervalMs: 60_000,
        log: { warn: (message?: unknown) => warnings2.push(String(message)) }
      }).stop()
      assert.equal(store2.users.size, 0)
      assert.equal(warnings2.length, 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
      refreshTokens: [string, string][]
    }
    // Pre-U233 format: version 1 and the map key was the plaintext token itself.
    snapshot.version = 1
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
      refreshTokens: [string, string][]
    }
    snapshot.version = 1
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

describe('平台 dev store 快照：版本兼容（U233 读端）', () => {
  test('写出 v2，读取端接受 v1 与 v2，未知版本拒绝', () => {
    const digest = createHash('sha256').update('v1-token').digest('hex')
    const source = new Store()
    source.refreshTokens.set(digest, 'sess_v1')
    const current = JSON.parse(serializeSnapshot(source)) as Record<string, unknown> & {
      refreshTokens: [string, string][]
    }
    assert.equal(current.version, SNAPSHOT_VERSION)
    assert.equal(SNAPSHOT_VERSION, 2)

    const v1 = { ...current, version: 1 }
    const fromV1 = new Store()
    restoreSnapshot(fromV1, JSON.stringify(v1))
    assert.equal(fromV1.refreshTokens.get(digest), 'sess_v1')

    const fromV2 = new Store()
    restoreSnapshot(fromV2, JSON.stringify(current))
    assert.equal(fromV2.refreshTokens.get(digest), 'sess_v1')

    assert.throws(
      () => restoreSnapshot(new Store(), JSON.stringify({ ...current, version: 3 })),
      /version 3 is not supported/
    )
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
