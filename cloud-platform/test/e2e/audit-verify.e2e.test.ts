import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnService, saveEvidence, type Service } from './harness.ts'

/**
 * Audit chain verification over the wire. The log is a hash chain, but until now
 * an operator could read events and never learn whether they were altered.
 * These cases drive the real endpoint against a real platform process.
 */

const EVIDENCE = 'm31-audit-verify'
let api: Service
let adminToken = ''
let userToken = ''

type VerifyBody = {
  ok?: boolean
  checked?: number
  tip?: string
  brokenAtSeq?: number
  error?: { code?: string }
}

async function login(username: string, password: string, deviceName: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName })
  })
  const body = (await res.json()) as { accessToken?: string }
  assert.equal(res.status, 200, `login failed for ${username}`)
  return body.accessToken ?? ''
}

async function verify(token: string): Promise<{ status: number; body: VerifyBody }> {
  const res = await fetch(`${api.url}/v1/audit/verify`, {
    headers: { authorization: `Bearer ${token}` }
  })
  return { status: res.status, body: (await res.json()) as VerifyBody }
}

async function auditEvents(
  token: string,
  params: Record<string, string> = {}
): Promise<{ events: { seq: number; eventType: string; result: string; actor: string }[] }> {
  const query = new URLSearchParams({ limit: '50', ...params })
  const res = await fetch(`${api.url}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  return (await res.json()) as {
    events: { seq: number; eventType: string; result: string; actor: string }[]
  }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )
  adminToken = await login('admin', 'Adm1n!', 'verify-admin')
  userToken = await login('zhangsan', 'Passw0rd!', 'verify-user')
})

after(async () => {
  await api?.stop()
})

describe('审计链完整性校验（真实平台进程）', () => {
  test('M31-1 管理员校验通过，报告已校验条数与链尾；校验动作本身入链', async () => {
    // Generate real events first so `checked` is not trivially zero.
    await fetch(`${api.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'zhangsan', password: 'wrong-password', deviceName: 'x' })
    })

    const first = await verify(adminToken)
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)
    assert.ok((first.body.checked ?? 0) > 0, 'chain must contain real events')
    assert.match(first.body.tip ?? '', /^[0-9a-f]{64}$/)

    const second = await verify(adminToken)
    assert.equal(second.body.ok, true)
    // The recorded attempt extends the chain, so the next check covers more events.
    assert.equal(second.body.checked, (first.body.checked ?? 0) + 1)
    assert.notEqual(second.body.tip, first.body.tip)

    const log = await auditEvents(adminToken, { eventType: 'audit_verify' })
    assert.ok(
      log.events.some((event) => event.result === 'success' && event.actor === 'admin'),
      'verification must be auditable'
    )
    saveEvidence(EVIDENCE, 'm31-1-verify.json', { first, second })
  })

  test('M31-2 普通用户被拒，且拒绝本身被写入审计', async () => {
    const denied = await verify(userToken)
    assert.equal(denied.status, 403)
    assert.equal(denied.body.error?.code, 'PERMISSION_DENIED')

    const log = await auditEvents(adminToken, { eventType: 'audit_verify', result: 'denied' })
    assert.ok(
      log.events.some((event) => event.actor === 'zhangsan'),
      'a refused verification is a security event and must be recorded'
    )
    saveEvidence(EVIDENCE, 'm31-2-denied.json', denied)
  })

  test('M31-3 校验不改变链的连续性：翻页拿到的 seq 严格递减且无重复', async () => {
    for (let index = 0; index < 5; index += 1) {
      await verify(adminToken)
    }
    const page = await auditEvents(adminToken, { eventType: 'audit_verify' })
    const seqs = page.events.map((event) => event.seq)
    assert.equal(new Set(seqs).size, seqs.length)
    for (let index = 1; index < seqs.length; index += 1) {
      assert.ok(seqs[index]! < seqs[index - 1]!, 'events are listed newest first')
    }
    const after = await verify(adminToken)
    assert.equal(after.body.ok, true)
    saveEvidence(EVIDENCE, 'm31-3-continuity.json', { seqs: seqs.slice(0, 10) })
  })

  test('M31-4 未携带令牌时拒绝，且不泄露链状态', async () => {
    const res = await fetch(`${api.url}/v1/audit/verify`)
    assert.equal(res.status, 401)
    const body = (await res.json()) as VerifyBody
    assert.equal(body.ok, undefined)
    assert.equal(body.checked, undefined)
  })
})

describe('审计链落盘：重启续链与篡改检测（真实进程）', () => {
  async function startWithLog(path: string): Promise<Service> {
    return await spawnService(
      'apps/api/src/server.ts',
      { PORT: '0', AUDIT_LOG_PATH: path },
      /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'api'
    )
  }

  async function tokenFor(service: Service, username: string, password: string): Promise<string> {
    const res = await fetch(`${service.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, deviceName: `chain-${username}` })
    })
    const body = (await res.json()) as { accessToken?: string }
    assert.equal(res.status, 200)
    return body.accessToken ?? ''
  }

  async function verifyOn(service: Service, token: string): Promise<{ status: number; body: VerifyBody }> {
    const res = await fetch(`${service.url}/v1/audit/verify`, {
      headers: { authorization: `Bearer ${token}` }
    })
    return { status: res.status, body: (await res.json()) as VerifyBody }
  }

  test('M31-5 重启后从落盘日志续链：seq 继续递增，verify 通过', { timeout: 30000 }, async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'orca-audit-chain-')), 'audit.jsonl')
    const first = await startWithLog(logPath)
    const firstToken = await tokenFor(first, 'admin', 'Adm1n!')
    const before = await verifyOn(first, firstToken)
    assert.equal(before.body.ok, true)
    const checkedBefore = before.body.checked ?? 0
    await first.stop()

    const second = await startWithLog(logPath)
    try {
      const secondToken = await tokenFor(second, 'admin', 'Adm1n!')
      const after = await verifyOn(second, secondToken)
      assert.equal(after.body.ok, true)
      // The restored chain is re-verified and the new attempt extends it.
      assert.ok(
        (after.body.checked ?? 0) > checkedBefore,
        `chain must continue, got ${after.body.checked} vs ${checkedBefore}`
      )
      saveEvidence(EVIDENCE, 'm31-5-restart.json', { checkedBefore, after })
    } finally {
      await second.stop()
    }
  })

  test('M31-6 日志被改写后重启：verify 明确报告断链位置，而不是静默通过', { timeout: 30000 }, async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'orca-audit-tamper-')), 'audit.jsonl')
    const first = await startWithLog(logPath)
    const token = await tokenFor(first, 'admin', 'Adm1n!')
    await verifyOn(first, token)
    await first.stop()

    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    assert.ok(lines.length >= 2, 'need at least two events to tamper with one')
    const target = JSON.parse(lines[1]!) as { actor: string; seq: number }
    target.actor = 'ghost'
    lines[1] = JSON.stringify(target)
    writeFileSync(logPath, `${lines.join('\n')}\n`)

    const second = await startWithLog(logPath)
    try {
      const secondToken = await tokenFor(second, 'admin', 'Adm1n!')
      const verdict = await verifyOn(second, secondToken)
      assert.equal(verdict.status, 409)
      assert.equal(verdict.body.ok, false)
      assert.equal(verdict.body.brokenAtSeq, target.seq)
      saveEvidence(EVIDENCE, 'm31-6-tampered.json', { brokenAtSeq: verdict.body.brokenAtSeq })
    } finally {
      await second.stop()
    }
  })

  test('M31-7 日志行不可解析时平台拒绝启动，而不是丢掉一部分链', { timeout: 30000 }, async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'orca-audit-corrupt-')), 'audit.jsonl')
    const first = await startWithLog(logPath)
    await tokenFor(first, 'admin', 'Adm1n!')
    await first.stop()

    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}not-json\n`)
    await assert.rejects(async () => {
      const second = await startWithLog(logPath)
      // If it did start, that is the bug this case exists to catch.
      await second.stop()
    })
  })
})
