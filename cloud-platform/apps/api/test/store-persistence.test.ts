import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { attachStorePersistence } from '../src/store-persistence.ts'
import { restoreSnapshot } from '../src/snapshot-restore-codec.ts'
import { serializeSnapshot } from '../src/snapshot-serialize.ts'
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
