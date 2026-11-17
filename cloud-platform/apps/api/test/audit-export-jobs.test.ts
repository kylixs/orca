import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AUDIT_EXPORT_JOB_ID_PATTERN,
  DEFAULT_AUDIT_EXPORT_DOWNLOAD_TOKEN_TTL_MS,
  DEFAULT_AUDIT_EXPORT_TTL_MS,
  AuditExportJobStore,
  generateAuditExportJobId,
  isValidAuditExportJobId,
  resolveAuditExportJobDir,
  resolveAuditExportObjectPath,
  writeAuditExportJobFileAtomic
} from '../src/audit-export-jobs.ts'
import type { CreateAuditExportJobInput } from '../src/audit-export-jobs.ts'

/**
 * U201 E3: job records are file-backed. These cases pin path safety, the
 * tmp+rename atomicity, permission bits, derived expiry, cleanup, and quota
 * counting without dragging in HTTP or the audit chain.
 */

const tempRoot = () => mkdtempSync(path.join(tmpdir(), 'orca-audit-export-'))
const jobInput = (over: Partial<CreateAuditExportJobInput> = {}): CreateAuditExportJobInput => ({
  requestedBy: 'user_1',
  requestedByUsername: 'alice',
  query: { limit: 200 },
  format: 'csv',
  ...over
})
const fileMode = (file: string) => statSync(file).mode & 0o777

function clock(start = 1_000_000) {
  let value = start
  return {
    now: () => value,
    set: (next: number) => {
      value = next
    }
  }
}

describe('jobId 校验与路径安全', () => {
  const root = path.join(tmpdir(), 'orca-audit-export-root')
  const invalidIds = [
    '',
    '..',
    '../x',
    'exp_../x',
    '/etc/passwd',
    String.raw`C:\windows`,
    'exp_ABCDEF0123456789ABCDEF01',
    'exp_0123',
    `exp_${'a'.repeat(23)}`,
    `exp_${'a'.repeat(25)}`
  ]

  test('拒绝穿越、绝对路径与非 hex jobId', () => {
    for (const jobId of invalidIds) {
      assert.equal(isValidAuditExportJobId(jobId), false, jobId)
      assert.equal(resolveAuditExportJobDir(root, jobId), null, jobId)
      assert.equal(resolveAuditExportObjectPath(root, jobId, 'csv'), null, jobId)
    }
  })

  test('合法 jobId 解析到 root 下的任务目录', () => {
    const jobId = generateAuditExportJobId()
    assert.match(jobId, AUDIT_EXPORT_JOB_ID_PATTERN)
    const resolvedRoot = path.resolve(root)
    assert.equal(resolveAuditExportJobDir(root, jobId), path.join(resolvedRoot, jobId))
    assert.equal(
      resolveAuditExportObjectPath(root, jobId, 'jsonl'),
      path.join(resolvedRoot, jobId, 'events.jsonl')
    )
  })

  test('store 对非法 jobId 读取/删除均不触碰文件系统', () => {
    const store = new AuditExportJobStore({ root: tempRoot() })
    for (const jobId of ['../x', '/etc/passwd', 'exp_zzzz']) {
      assert.equal(store.read(jobId), null)
      assert.equal(store.remove(jobId), false)
    }
  })
})

describe('任务往返、权限与状态迁移', () => {
  test('create 接受预生成 jobId，仍校验格式与碰撞', () => {
    const root = tempRoot()
    const store = new AuditExportJobStore({ root })
    const jobId = generateAuditExportJobId()
    const job = store.create(jobInput({ jobId }))
    assert.equal(job.jobId, jobId)
    assert.equal(job.status, 'queued')

    assert.throws(() => store.create(jobInput({ jobId: '../escape' })), /invalid audit export job id/)
    assert.throws(() => store.create(jobInput({ jobId })), /collision/)
  })

  test('create/read/update/remove 往返并落 0700/0600', () => {
    const root = tempRoot()
    const store = new AuditExportJobStore({ root })
    const job = store.create(jobInput())
    assert.equal(job.status, 'queued')
    assert.equal(job.objectKey, 'events.csv')
    assert.equal(job.expiresAt, job.createdAt + DEFAULT_AUDIT_EXPORT_TTL_MS)
    assert.equal(fileMode(path.join(root, job.jobId)), 0o700)
    assert.equal(fileMode(path.join(root, job.jobId, 'job.json')), 0o600)
    assert.deepEqual(store.read(job.jobId), job)

    const running = store.markRunning(job.jobId)
    assert.equal(running?.status, 'running')
    assert.notEqual(running?.startedAt, null)

    const done = store.markSucceeded(job.jobId, { totalEvents: 12, bytes: 345 })
    assert.equal(done?.status, 'succeeded')
    assert.equal(done?.totalEvents, 12)
    assert.equal(done?.bytes, 345)
    assert.deepEqual(store.read(job.jobId), done)

    assert.equal(store.remove(job.jobId), true)
    assert.equal(store.read(job.jobId), null)
    assert.equal(existsSync(path.join(root, job.jobId)), false)
  })

  test('失败任务保留原因；非法迁移抛错', () => {
    const store = new AuditExportJobStore({ root: tempRoot() })
    const job = store.create(jobInput())
    assert.throws(
      () => store.markSucceeded(job.jobId, { totalEvents: 0, bytes: 0 }),
      /invalid audit export transition/
    )
    const failed = store.markFailed(job.jobId, { code: 'EXPORT_WRITE_FAILED', message: 'disk' })
    assert.equal(failed?.status, 'failed')
    assert.deepEqual(failed?.error, { code: 'EXPORT_WRITE_FAILED', message: 'disk' })
    assert.throws(() => store.markRunning(job.jobId), /invalid audit export transition/)
  })
})

describe('过期判定与清理', () => {
  test('expiresAt 由注入时钟派生', () => {
    const time = clock(1_000)
    const store = new AuditExportJobStore({ root: tempRoot(), ttlMs: 500, now: time.now })
    const job = store.create(jobInput())
    time.set(1_499)
    assert.equal(store.isExpired(job), false)
    assert.notEqual(store.read(job.jobId), null)
    time.set(1_500)
    assert.equal(store.isExpired(job), true)
    assert.equal(store.markRunning(job.jobId), null)
  })

  test('只删过期与孤儿目录，跳过符号链接和非目录文件', () => {
    const root = tempRoot()
    const time = clock(1_000)
    const store = new AuditExportJobStore({ root, ttlMs: 1_000, now: time.now })
    const expired = store.create(jobInput())
    time.set(2_500)
    const live = store.create(jobInput())

    const orphan = `exp_${'b'.repeat(24)}`
    mkdirSync(path.join(root, orphan))
    const junk = 'not-a-job'
    mkdirSync(path.join(root, junk))
    const stray = path.join(root, 'stray.txt')
    writeFileSync(stray, 'x')
    const linkTarget = path.join(root, 'link-target')
    mkdirSync(linkTarget)
    const link = `exp_${'c'.repeat(24)}`
    symlinkSync(linkTarget, path.join(root, link))

    assert.deepEqual(store.pruneExpired().sort(), [expired.jobId, orphan].sort())
    assert.equal(existsSync(path.join(root, expired.jobId)), false)
    assert.equal(existsSync(path.join(root, live.jobId)), true)
    assert.equal(existsSync(path.join(root, orphan)), false)
    assert.equal(existsSync(path.join(root, junk)), true)
    assert.equal(existsSync(path.join(root, link)), true)
    assert.equal(existsSync(linkTarget), true)
    assert.equal(existsSync(stray), true)
  })

  test('损坏的 job.json 视为孤儿并在清理时删除', () => {
    const store = new AuditExportJobStore({ root: tempRoot(), now: () => 1_000 })
    const job = store.create(jobInput())
    writeFileSync(path.join(store.root, job.jobId, 'job.json'), '{not json')
    assert.equal(store.read(job.jobId), null)
    assert.deepEqual(store.pruneExpired(), [job.jobId])
  })
})

describe('启动恢复', () => {
  test('queued/running → failed/EXPORT_INTERRUPTED，终态不动', () => {
    const time = clock(1_000)
    const store = new AuditExportJobStore({ root: tempRoot(), ttlMs: 60_000, now: time.now })
    const queued = store.create(jobInput())
    const running = store.create(jobInput())
    store.markRunning(running.jobId)
    const succeeded = store.create(jobInput())
    store.markRunning(succeeded.jobId)
    const done = store.markSucceeded(succeeded.jobId, { totalEvents: 2, bytes: 3 })
    const failed = store.create(jobInput())
    const failedJob = store.markFailed(failed.jobId, { code: 'X', message: 'x' })

    time.set(2_000)
    assert.deepEqual(
      store.recoverInterrupted().sort(),
      [queued.jobId, running.jobId].sort()
    )

    for (const jobId of [queued.jobId, running.jobId]) {
      const job = store.read(jobId)
      assert.equal(job?.status, 'failed')
      assert.equal(job?.finishedAt, 2_000)
      assert.deepEqual(job?.error, {
        code: 'EXPORT_INTERRUPTED',
        message: '进程重启导致任务中断'
      })
    }
    // startedAt is evidence of how far the interrupted job got, so it stays.
    assert.equal(store.read(running.jobId)?.startedAt, 1_000)
    assert.deepEqual(store.read(succeeded.jobId), done)
    assert.deepEqual(store.read(failed.jobId), failedJob)
    // A second pass has nothing left to recover.
    assert.deepEqual(store.recoverInterrupted(), [])
  })

  test('恢复清理半成品：删除 events.* 与 *.tmp，保留 job.json；终态不清理', () => {
    const store = new AuditExportJobStore({ root: tempRoot(), ttlMs: 60_000, now: () => 1_000 })
    const running = store.create(jobInput({ format: 'csv' }))
    store.markRunning(running.jobId)
    const dir = path.join(store.root, running.jobId)
    writeFileSync(path.join(dir, 'events.csv'), 'seq,ts\r\n')
    writeFileSync(path.join(dir, 'events.jsonl'), '{"seq":1}\n')
    writeFileSync(path.join(dir, `events.csv.${process.pid}.abc.tmp`), 'partial')

    const succeeded = store.create(jobInput())
    store.markRunning(succeeded.jobId)
    store.markSucceeded(succeeded.jobId, { totalEvents: 1, bytes: 2 })
    const succeededDir = path.join(store.root, succeeded.jobId)
    writeFileSync(path.join(succeededDir, 'events.csv'), 'kept')
    writeFileSync(path.join(succeededDir, 'orphan.tmp'), 'kept')

    assert.deepEqual(store.recoverInterrupted(), [running.jobId])
    assert.equal(store.read(running.jobId)?.status, 'failed')
    assert.deepEqual(readdirSync(dir), ['job.json'])
    assert.deepEqual(readdirSync(succeededDir).sort(), ['events.csv', 'job.json', 'orphan.tmp'])
  })

  test('过期任务不恢复，交由 prune 处理', () => {
    const time = clock(1_000)
    const store = new AuditExportJobStore({ root: tempRoot(), ttlMs: 500, now: time.now })
    const expired = store.create(jobInput())
    time.set(1_500)
    const live = store.create(jobInput())

    assert.deepEqual(store.recoverInterrupted(), [live.jobId])
    assert.equal(store.read(expired.jobId)?.status, 'queued')
    assert.deepEqual(store.pruneExpired(), [expired.jobId])
  })

  test('忽略孤儿任务目录与符号链接', () => {
    const root = tempRoot()
    const store = new AuditExportJobStore({ root, now: () => 1_000 })
    const orphan = `exp_${'d'.repeat(24)}`
    mkdirSync(path.join(root, orphan))
    const target = path.join(root, 'link-target')
    mkdirSync(target)
    const link = `exp_${'e'.repeat(24)}`
    symlinkSync(target, path.join(root, link))

    assert.deepEqual(store.recoverInterrupted(), [])
    assert.equal(existsSync(path.join(root, orphan)), true)
  })
})

describe('并发计数与配额', () => {
  test('只统计 queued/running，并在过期后释放名额', () => {
    const time = clock(1_000)
    const store = new AuditExportJobStore({
      root: tempRoot(),
      ttlMs: 10_000,
      perUserActiveLimit: 2,
      globalActiveLimit: 3,
      now: time.now
    })
    const a = store.create(jobInput({ requestedBy: 'u1' }))
    const b = store.create(jobInput({ requestedBy: 'u1' }))
    const c = store.create(jobInput({ requestedBy: 'u2' }))
    assert.equal(store.countActive(), 3)
    assert.equal(store.countActive('u1'), 2)
    assert.deepEqual(store.checkQuota('u1'), { ok: false, reason: 'per-user' })
    assert.deepEqual(store.checkQuota('u3'), { ok: false, reason: 'global' })

    store.markRunning(a.jobId)
    store.markRunning(b.jobId)
    store.markSucceeded(b.jobId, { totalEvents: 0, bytes: 0 })
    store.markFailed(c.jobId, { code: 'X', message: 'x' })
    assert.equal(store.countActive(), 1)
    assert.equal(store.countActive('u1'), 1)
    assert.deepEqual(store.checkQuota('u3'), { ok: true })

    time.set(20_000)
    assert.equal(store.countActive(), 0)
    assert.deepEqual(store.checkQuota('u1'), { ok: true })
  })
})

describe('下载 token 生命周期', () => {
  const succeeded = (store: AuditExportJobStore): string => {
    const job = store.create(jobInput())
    store.markRunning(job.jobId)
    store.markSucceeded(job.jobId, { totalEvents: 3, bytes: 42 })
    return job.jobId
  }

  test('签发→验证→消费→重复消费返回 consumed', () => {
    const time = clock(1_000)
    const store = new AuditExportJobStore({ root: tempRoot(), now: time.now })
    const jobId = succeeded(store)

    const issued = store.issueDownloadToken(jobId)
    assert.ok(issued)
    assert.equal(issued.expiresAt, 1_000 + DEFAULT_AUDIT_EXPORT_DOWNLOAD_TOKEN_TTL_MS)
    assert.deepEqual(store.verifyDownloadToken(jobId, issued.token), { ok: true })

    assert.deepEqual(store.consumeDownloadToken(jobId, issued.token), { ok: true })
    assert.equal(store.read(jobId)?.downloadedAt, 1_000)
    assert.deepEqual(store.consumeDownloadToken(jobId, issued.token), {
      ok: false,
      reason: 'consumed'
    })
    assert.deepEqual(store.verifyDownloadToken(jobId, issued.token), {
      ok: false,
      reason: 'consumed'
    })
  })

  test('再次签发轮换 token，旧 token 立即 invalid', () => {
    const store = new AuditExportJobStore({ root: tempRoot(), now: () => 1_000 })
    const jobId = succeeded(store)

    const first = store.issueDownloadToken(jobId)
    const second = store.issueDownloadToken(jobId)
    assert.ok(first && second)
    assert.notEqual(first.token, second.token)
    assert.deepEqual(store.verifyDownloadToken(jobId, first.token), {
      ok: false,
      reason: 'invalid'
    })
    assert.deepEqual(store.verifyDownloadToken(jobId, second.token), { ok: true })
  })

  test('注入时钟越过 TTL 后 verify/consume 返回 expired', () => {
    const time = clock(1_000)
    const store = new AuditExportJobStore({ root: tempRoot(), now: time.now })
    const jobId = succeeded(store)
    const issued = store.issueDownloadToken(jobId, { ttlMs: 1_000 })
    assert.ok(issued)

    time.set(1_999)
    assert.deepEqual(store.verifyDownloadToken(jobId, issued.token), { ok: true })
    time.set(2_000)
    assert.deepEqual(store.verifyDownloadToken(jobId, issued.token), {
      ok: false,
      reason: 'expired'
    })
    assert.deepEqual(store.consumeDownloadToken(jobId, issued.token), {
      ok: false,
      reason: 'expired'
    })
    assert.equal(store.read(jobId)?.downloadedAt, null)
  })

  test('非 succeeded 任务不可签发，verify 返回 not-ready', () => {
    const store = new AuditExportJobStore({ root: tempRoot(), now: () => 1_000 })
    const queued = store.create(jobInput())
    assert.equal(store.issueDownloadToken(queued.jobId), null)
    assert.deepEqual(store.verifyDownloadToken(queued.jobId, 'any-token'), {
      ok: false,
      reason: 'not-ready'
    })

    store.markFailed(queued.jobId, { code: 'X', message: 'x' })
    assert.equal(store.issueDownloadToken(queued.jobId), null)

    const running = store.create(jobInput())
    store.markRunning(running.jobId)
    assert.equal(store.issueDownloadToken(running.jobId), null)
    assert.deepEqual(store.consumeDownloadToken(running.jobId, 'any-token'), {
      ok: false,
      reason: 'not-ready'
    })
  })

  test('过期任务不可签发', () => {
    const time = clock(1_000)
    const store = new AuditExportJobStore({ root: tempRoot(), ttlMs: 500, now: time.now })
    const jobId = succeeded(store)
    time.set(1_500)
    assert.equal(store.issueDownloadToken(jobId), null)

    // A token minted while live dies with the job, not only with its own TTL.
    time.set(1_400)
    const issued = store.issueDownloadToken(jobId)
    assert.ok(issued)
    time.set(1_501)
    assert.deepEqual(store.verifyDownloadToken(jobId, issued.token), {
      ok: false,
      reason: 'expired'
    })
  })

  test('落盘只存 sha256，明文 token 不出现；异长 token 不抛异常', () => {
    const store = new AuditExportJobStore({ root: tempRoot(), now: () => 1_000 })
    const jobId = succeeded(store)
    const issued = store.issueDownloadToken(jobId)
    assert.ok(issued)

    const raw = readFileSync(path.join(store.root, jobId, 'job.json'), 'utf8')
    assert.equal(raw.includes(issued.token), false)
    const job = store.read(jobId)
    assert.ok(job)
    assert.equal(job.downloadTokenHash, createHash('sha256').update(issued.token).digest('hex'))
    assert.match(job.downloadTokenHash ?? '', /^[0-9a-f]{64}$/)

    for (const token of ['', 'x', 'a'.repeat(1_000)]) {
      assert.doesNotThrow(() => store.verifyDownloadToken(jobId, token))
      assert.deepEqual(store.verifyDownloadToken(jobId, token), {
        ok: false,
        reason: 'invalid'
      })
    }
  })
})

describe('原子写与符号链接防护', () => {
  test('rename 目标为目录时失败且不留半截 job.json', () => {
    const store = new AuditExportJobStore({ root: tempRoot() })
    const job = store.create(jobInput())
    const targetRoot = tempRoot()
    const target = path.join(targetRoot, 'job.json')
    mkdirSync(target)

    assert.throws(() => writeAuditExportJobFileAtomic(target, job))
    assert.equal(statSync(target).isDirectory(), true)
    assert.deepEqual(
      readdirSync(targetRoot).filter((name) => name.endsWith('.tmp')),
      []
    )
  })

  test('拒绝符号链接的 job.json', () => {
    const store = new AuditExportJobStore({ root: tempRoot() })
    const job = store.create(jobInput())
    const jobFile = path.join(store.root, job.jobId, 'job.json')
    const outside = path.join(tempRoot(), 'outside.json')
    writeFileSync(outside, JSON.stringify(job))
    rmSync(jobFile)
    symlinkSync(outside, jobFile)
    assert.equal(store.read(job.jobId), null)
  })

  test('拒绝符号链接的任务目录', () => {
    const source = new AuditExportJobStore({ root: tempRoot() })
    const job = source.create(jobInput())
    const root = tempRoot()
    symlinkSync(path.join(source.root, job.jobId), path.join(root, job.jobId))
    const store = new AuditExportJobStore({ root })
    assert.equal(store.read(job.jobId), null)
    assert.equal(store.remove(job.jobId), false)
  })
})
