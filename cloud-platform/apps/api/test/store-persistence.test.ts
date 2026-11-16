import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import {
  attachStorePersistence,
  restoreSnapshot,
  serializeSnapshot
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
      writeFileSync(wrongVersion, JSON.stringify({ version: 2 }), 'utf8')
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
})
