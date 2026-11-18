import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * Design §13.2: when the audit log cannot be written, sensitive operations are
 * refused (fail-closed). Availability of login and reads is deliberate: an
 * operator has to be able to reach the platform to diagnose it.
 *
 * These cases break the sink for real — a read-only log file and a rewritten
 * chain on disk — and check that the mutation did not happen, not merely that an
 * error was returned.
 */

const EVIDENCE = 'm32-audit-fail-closed'

type Json = Record<string, unknown>

async function startWithLog(path: string): Promise<Service> {
  return await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', AUDIT_LOG_PATH: path },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )
}

async function login(service: Service, username = 'admin', password = 'Adm1n!'): Promise<string> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: `fc-${username}` })
  })
  assert.equal(res.status, 200, `login must stay available, got ${res.status}`)
  return ((await res.json()) as { accessToken: string }).accessToken
}

async function createProject(
  service: Service,
  token: string,
  key: string
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${service.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ key, name: key, hostId: 'host_dev001', path: `/srv/work/${key}` })
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function projectKeys(service: Service, token: string): Promise<string[]> {
  const res = await fetch(`${service.url}/v1/projects`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200, 'reads must stay available')
  const body = (await res.json()) as { projects: { key: string }[] }
  return body.projects.map((project) => project.key)
}

async function auditStatus(service: Service, token: string): Promise<Json> {
  const res = await fetch(`${service.url}/v1/audit/status`, {
    headers: { authorization: `Bearer ${token}` }
  })
  return (await res.json()) as Json
}

async function auditVerify(
  service: Service,
  token: string
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${service.url}/v1/audit/verify`, {
    headers: { authorization: `Bearer ${token}` }
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function auditEvents(service: Service, token: string, query: string): Promise<Json[]> {
  const res = await fetch(`${service.url}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { events: Json[] }
  return body.events
}

function errorCode(body: Json): unknown {
  const error = body.error
  return error !== null && typeof error === 'object' ? (error as Json).code : undefined
}

describe('审计不可写时敏感操作 fail-closed（真实平台进程）', () => {
  test('M32-1 日志文件只读：建项目被拒 503 且确实没建，读取与登录仍可用；恢复后重新可用', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'orca-audit-fc-')), 'audit.jsonl')
    let service = await startWithLog(logPath)
    try {
      const token = await login(service)

      const before = await createProject(service, token, 'fc-before')
      assert.equal(before.status, 201, 'sanity: writable audit allows the mutation')
      const verifyBefore = await auditVerify(service, token)
      assert.equal(verifyBefore.status, 200)
      const checkedBefore = verifyBefore.body.checked as number

      chmodSync(logPath, 0o400)
      const blocked = await createProject(service, token, 'fc-blocked')
      assert.equal(blocked.status, 503)
      assert.equal(errorCode(blocked.body), 'AUDIT_UNAVAILABLE')

      // The point of fail-closed: nothing was created, not just "an error was returned".
      const keys = await projectKeys(service, token)
      assert.ok(!keys.includes('fc-blocked'), 'a refused mutation must not take effect')
      assert.ok(keys.includes('fc-before'))

      // U246: a failed persist must not become a phantom event. The first verify
      // appended one audit_verify event; the refused project must add none.
      const verifyAfterFailure = await auditVerify(service, token)
      assert.equal(verifyAfterFailure.status, 200, '验证本身仍可读')
      assert.equal(verifyAfterFailure.body.checked, checkedBefore + 1, '失败条目不得被 verify 计入')
      const projectEvents = await auditEvents(service, token, 'eventType=project_create&limit=50')
      const keysAudited = projectEvents.map((event) => (event.metadata as Json | undefined)?.key)
      assert.ok(!keysAudited.includes('fc-blocked'), '被拒项目不得留下 phantom success')
      assert.ok(keysAudited.includes('fc-before'))

      // Reads and the liveness probe stay available for diagnosis.
      const health = await fetch(`${service.url}/health`)
      assert.equal(health.status, 200)
      const jwks = await fetch(`${service.url}/v1/jwks`)
      assert.equal(jwks.status, 200)

      const status = await auditStatus(service, token)
      assert.equal(status.ok, false)
      assert.equal(status.reason, 'write_failed')
      assert.equal(status.persisted, true)
      const statusChain = status.chain as { lastSeq: number }
      assert.equal(statusChain.lastSeq, checkedBefore + 1, 'seq 不得为失败条目前移')

      chmodSync(logPath, 0o600)
      // Why a fresh request: the refusal is recorded per-request, so recovery is
      // observed by a new attempt rather than by a retry of the refused one.
      const recovered = await createProject(service, token, 'fc-after')
      assert.equal(recovered.status, 201)

      // U246: the log is a valid chain again — previously the phantom tail left a
      // seq gap and every restart failed verify with 409.
      await service.stop()
      service = await startWithLog(logPath)
      const restartToken = await login(service)
      const verifyAfterRestart = await auditVerify(service, restartToken)
      assert.equal(verifyAfterRestart.status, 200, '重启后链必须连续')
      assert.equal(verifyAfterRestart.body.ok, true)

      saveEvidence(EVIDENCE, 'm32-1-readonly-log.json', {
        blocked: blocked.body,
        status,
        recovered: recovered.status,
        checkedBefore,
        checkedAfterFailure: verifyAfterFailure.body.checked,
        verifyAfterRestart: verifyAfterRestart.body
      })
    } finally {
      chmodSync(logPath, 0o600)
      await service.stop()
    }
  }, 40000)

  test('M32-2 审计链被改写后重启：敏感操作 503 AUDIT_CHAIN_BROKEN，登录与读取不受影响', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'orca-audit-fc-chain-')), 'audit.jsonl')
    const first = await startWithLog(logPath)
    const firstToken = await login(first)
    assert.equal((await createProject(first, firstToken, 'chain-before')).status, 201)
    await first.stop()

    const originalText = readFileSync(logPath, 'utf8')
    const lines = originalText.split('\n').filter(Boolean)
    assert.ok(lines.length >= 2)
    const tampered = JSON.parse(lines[1]!) as { actor: string }
    tampered.actor = 'ghost'
    lines[1] = JSON.stringify(tampered)
    writeFileSync(logPath, `${lines.join('\n')}\n`)

    const second = await startWithLog(logPath)
    try {
      const token = await login(second)
      const blocked = await createProject(second, token, 'chain-blocked')
      assert.equal(blocked.status, 503)
      assert.equal(errorCode(blocked.body), 'AUDIT_CHAIN_BROKEN')

      const keys = await projectKeys(second, token)
      assert.ok(!keys.includes('chain-blocked'))

      const status = await auditStatus(second, token)
      assert.equal(status.reason, 'chain_broken')

      const verifyRes = await fetch(`${second.url}/v1/audit/verify`, {
        headers: { authorization: `Bearer ${token}` }
      })
      assert.equal(verifyRes.status, 409)

      saveEvidence(EVIDENCE, 'm32-2-chain-broken.json', { blocked: blocked.body, status })
    } finally {
      await second.stop()
    }

    // Repairing the log restores service: the block is about the chain, not a latched process state.
    writeFileSync(logPath, originalText)
    const third = await startWithLog(logPath)
    try {
      const token = await login(third)
      const allowed = await createProject(third, token, 'chain-after')
      assert.equal(allowed.status, 201)
    } finally {
      await third.stop()
    }
  }, 60000)
})

describe('fail-closed 覆盖全部敏感写（真实平台进程）', () => {
  test('M32-3 授权变更、设备吊销、主机令牌、维护、策略在审计不可写时全部拒绝，且状态未变', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'orca-audit-fc-all-')), 'audit.jsonl')
    const service = await startWithLog(logPath)
    try {
      const token = await login(service)
      const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const mine = (await (
        await fetch(`${service.url}/v1/me/devices`, { headers: auth })
      ).json()) as { devices?: { id: string; revokedAt: number | null }[] }
      const deviceId = mine.devices?.find((device) => device.revokedAt === null)?.id ?? ''
      assert.ok(deviceId !== '', 'need a registered device for the revoke case')
      const grantsBefore = (await (
        await fetch(`${service.url}/v1/projects/proj_payment/grants`, { headers: auth })
      ).json()) as { grants: unknown[] }

      chmodSync(logPath, 0o400)

      const attempts: { name: string; call: () => Promise<Response> }[] = [
        {
          name: 'grant_update',
          call: () =>
            fetch(`${service.url}/v1/projects/proj_payment/grants`, {
              method: 'PUT',
              headers: auth,
              body: JSON.stringify({
                subjectType: 'group',
                subjectId: 'team-payment',
                permissions: []
              })
            })
        },
        {
          name: 'host_token',
          call: () => fetch(`${service.url}/v1/hosts/tokens`, { method: 'POST', headers: auth })
        },
        {
          name: 'maintenance',
          call: () =>
            fetch(`${service.url}/v1/hosts/host_dev001/maintenance`, {
              method: 'POST',
              headers: auth,
              body: JSON.stringify({ enabled: true })
            })
        },
        {
          name: 'policy',
          call: () =>
            fetch(`${service.url}/v1/policies/download`, {
              method: 'PUT',
              headers: auth,
              body: JSON.stringify({ downloadDefault: 'allow' })
            })
        },
        {
          name: 'device_revoke',
          call: () =>
            fetch(`${service.url}/v1/me/devices/${deviceId}`, { method: 'DELETE', headers: auth })
        }
      ]
      const results: Record<string, number> = {}
      for (const attempt of attempts) {
        const res = await attempt.call()
        results[attempt.name] = res.status
        assert.equal(res.status, 503, `${attempt.name} must be refused when audit is unwritable`)
      }

      // None of them took effect.
      const grantsAfter = (await (
        await fetch(`${service.url}/v1/projects/proj_payment/grants`, { headers: auth })
      ).json()) as { grants: unknown[] }
      assert.equal(grantsAfter.grants.length, grantsBefore.grants.length)
      const policy = (await (
        await fetch(`${service.url}/v1/policies/download`, { headers: auth })
      ).json()) as { downloadDefault: string }
      assert.equal(policy.downloadDefault, 'deny')
      const hosts = (await (await fetch(`${service.url}/v1/hosts`, { headers: auth })).json()) as {
        hosts: { id: string; status: string }[]
      }
      assert.equal(hosts.hosts.find((host) => host.id === 'host_dev001')?.status, 'online')
      // The device still works: a revoked device would fail its next login.
      await login(service)
      const devices = (await (
        await fetch(`${service.url}/v1/me/devices`, { headers: auth })
      ).json()) as { devices: { id: string; revokedAt: number | null }[] }
      assert.equal(devices.devices.find((device) => device.id === deviceId)?.revokedAt, null)

      saveEvidence(EVIDENCE, 'm32-3-all-sensitive.json', { results })
    } finally {
      chmodSync(logPath, 0o600)
      await service.stop()
    }
  }, 40000)
})

describe('审计健康升级（真实 writer 进程）', () => {
  const LEASE_TTL_MS = 300
  const WRITER_TOKEN = 'u249-health-escalation'

  async function startLeaseWriter(logPath: string, leasePath: string): Promise<Service> {
    return spawnService(
      'apps/audit-writer/src/writer.ts',
      {
        PORT: '0',
        INTERNAL_TOKEN: WRITER_TOKEN,
        AUDIT_LOG_PATH: logPath,
        AUDIT_LEASE_PATH: leasePath,
        AUDIT_LEASE_TTL_MS: String(LEASE_TTL_MS),
        WRITER_ID: 'u249-writer'
      },
      /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'audit-writer-u249'
    )
  }

  async function writerJson(url: string, path: string): Promise<Json> {
    const res = await fetch(`${url}${path}`, { headers: { 'x-internal-token': WRITER_TOKEN } })
    assert.equal(res.status, 200)
    return (await res.json()) as Json
  }

  /** Poll a writer endpoint until the predicate holds; returns the last body either way. */
  async function writerUntil(
    url: string,
    path: string,
    predicate: (body: Json) => boolean,
    timeoutMs = 8000
  ): Promise<Json> {
    const started = Date.now()
    let last: Json = {}
    while (Date.now() - started < timeoutMs) {
      last = await writerJson(url, path)
      if (predicate(last)) return last
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return last
  }

  test('M32-4 write_failed 后发生真实断链：/v1/status 升级为 chain_broken 并保留 first/lastFailure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-u249-health-'))
    const logPath = join(dir, 'audit.jsonl')
    const leasePath = join(dir, 'writer.lease')
    const writer = await startLeaseWriter(logPath, leasePath)
    try {
      const append = (targetId: string) =>
        fetch(`${writer.url}/v1/append`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-token': WRITER_TOKEN },
          body: JSON.stringify({
            events: [
              {
                eventType: 'project_connect',
                actor: 'admin',
                targetType: 'project',
                targetId,
                result: 'success',
                traceId: null
              }
            ]
          })
        })
      assert.equal((await append('one')).status, 200)

      // First cause: a transient persist failure (retryable, not a break).
      chmodSync(logPath, 0o400)
      const refused = await append('two')
      assert.equal(refused.status, 503)
      assert.equal(errorCode((await refused.json()) as Json), 'AUDIT_WRITE_FAILED')
      chmodSync(logPath, 0o600)

      const failed = (await writerJson(writer.url, '/v1/status')) as Json
      assert.equal(failed.ok, false)
      assert.equal(failed.reason, 'write_failed')
      assert.equal(failed.firstFailure, 'write_failed')
      assert.equal(failed.lastFailure, 'write_failed')

      // Second cause: rewrite the durable line, then make the writer re-read the
      // log by losing and re-acquiring its lease. restore() now verifies a broken
      // chain — strictly more severe than the earlier write failure.
      const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
      const tampered = JSON.parse(lines[0]!) as { actor: string }
      tampered.actor = 'ghost'
      lines[0] = JSON.stringify(tampered)
      writeFileSync(logPath, `${lines.join('\n')}\n`)
      writeFileSync(leasePath, JSON.stringify({ holderId: 'intruder', since: Date.now() }))

      const demoted = await writerUntil(writer.url, '/health', (body) => body.role === 'standby')
      assert.equal(demoted.role, 'standby', 'lease takeover must demote this writer')
      const promoted = await writerUntil(writer.url, '/health', (body) => body.role === 'leader')
      assert.equal(promoted.role, 'leader', 'the writer must re-acquire its lease')

      const escalated = (await writerJson(writer.url, '/v1/status')) as Json
      assert.equal(escalated.ok, false)
      assert.equal(escalated.reason, 'chain_broken', 'chain_broken must supersede write_failed')
      assert.equal(escalated.firstFailure, 'write_failed', 'the earlier cause stays readable')
      assert.equal(escalated.lastFailure, 'chain_broken')

      saveEvidence(EVIDENCE, 'm32-4-health-escalation.json', { failed, escalated })
    } finally {
      chmodSync(logPath, 0o600)
      await writer.stop()
    }
  }, 40000)
})
