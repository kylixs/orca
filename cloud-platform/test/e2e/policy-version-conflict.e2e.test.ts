import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnService, type Service } from './harness.ts'

/**
 * U136④a: download-policy writes are optimistic-concurrency controlled, not
 * last-write-wins. An optional `expectedVersion` refuses a stale admin instead
 * of silently overwriting a newer policy; omitting it keeps the old contract.
 */

const INTERNAL_TOKEN = 'u136d-internal-token'
const PROJECT_ID = 'proj_payment'

type PolicyView = {
  downloadDefault: string
  readRatePerHour: { calls: number; bytes: number }
  version: number
}

type ProjectPolicyView = {
  downloadPolicy: string
  readRatePerHour: { calls: number; bytes: number }
  version: number
}

type AuditEvent = {
  seq: number
  eventType: string
  actor: string
  targetType: string
  targetId: string | null
  result: string
  metadata?: Record<string, unknown>
}

type ErrorBody = {
  error?: { code?: string; details?: Record<string, unknown> }
}

let service: Service
let adminToken = ''

async function callJson(
  path: string,
  method: string,
  body?: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${service.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: res.status, json: await res.json() }
}

async function getPolicy(): Promise<PolicyView> {
  const res = await callJson('/v1/policies/download', 'GET')
  assert.equal(res.status, 200)
  return res.json as PolicyView
}

async function projectPolicyAuditEvents(result: 'success' | 'failure'): Promise<AuditEvent[]> {
  const res = await fetch(
    `${service.url}/v1/audit/events?eventType=policy_update&result=${result}&limit=200`,
    { headers: { authorization: `Bearer ${adminToken}` } }
  )
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: AuditEvent[] }).events
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'u136d-policy-version'
  )
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u136d-policy' })
  })
  const body = (await res.json()) as { accessToken?: string }
  assert.equal(res.status, 200, 'admin login failed')
  adminToken = body.accessToken!
})

after(async () => {
  await service?.stop()
})

describe('U136④a 下载策略乐观并发控制（真实平台进程）', () => {
  test('两管理员并发：陈旧 expectedVersion 409 且不覆盖新策略', async () => {
    const seen = await getPolicy() // admin A reads version N
    const staleVersion = seen.version

    // admin B writes first, without expectedVersion (old client) -> N+1.
    const winner = await callJson('/v1/policies/download', 'PUT', { downloadDefault: 'allow' })
    assert.equal(winner.status, 200)
    assert.equal((winner.json as PolicyView).version, staleVersion + 1)
    assert.equal((winner.json as PolicyView).downloadDefault, 'allow')

    // admin A now writes with the version it read -> stale, refused.
    const loser = await callJson('/v1/policies/download', 'PUT', {
      downloadDefault: 'deny',
      expectedVersion: staleVersion
    })
    assert.equal(loser.status, 409)
    const errorBody = loser.json as ErrorBody
    assert.equal(errorBody.error?.code, 'POLICY_VERSION_CONFLICT')
    const details = errorBody.error?.details ?? {}
    assert.equal(details.version, staleVersion + 1, '409 reports the server version')
    assert.equal(details.downloadDefault, 'allow', '409 reports the server policy')

    const after = await getPolicy()
    assert.equal(after.version, staleVersion + 1, 'the refused write must not bump the version')
    assert.equal(after.downloadDefault, 'allow', 'the refused write must not overwrite the policy')

    const failures = await projectPolicyAuditEvents('failure')
    const conflict = failures.filter(
      (event) =>
        event.targetType === 'policy' &&
        event.targetId === 'download' &&
        event.metadata?.reason === 'POLICY_VERSION_CONFLICT'
    )
    assert.ok(conflict.length >= 1, 'the conflict must be audited')
    const event = conflict[0]!
    assert.equal(event.metadata?.expectedVersion, staleVersion)
    assert.equal(event.metadata?.resultVersion, staleVersion + 1)
  })

  test('匹配的 expectedVersion 正常写入并将版本加一', async () => {
    const seen = await getPolicy()
    const put = await callJson('/v1/policies/download', 'PUT', {
      downloadDefault: 'deny',
      expectedVersion: seen.version
    })
    assert.equal(put.status, 200)
    const body = put.json as PolicyView
    assert.equal(body.downloadDefault, 'deny')
    assert.equal(body.version, seen.version + 1)

    const successes = await projectPolicyAuditEvents('success')
    // The audit query is newest-first, so the head is this write's event.
    const last = successes.find(
      (event) => event.targetType === 'policy' && event.targetId === 'download'
    )
    assert.ok(last, 'a successful versioned write must be audited')
    assert.equal(last.metadata?.expectedVersion, seen.version)
    assert.equal(last.metadata?.resultVersion, seen.version + 1)
  })

  test('缺省 expectedVersion 保持旧的 last-write-wins 行为', async () => {
    const seen = await getPolicy()
    const put = await callJson('/v1/policies/download', 'PUT', { downloadDefault: 'allow' })
    assert.equal(put.status, 200)
    assert.equal((put.json as PolicyView).version, seen.version + 1)

    const successes = await projectPolicyAuditEvents('success')
    // The audit query is newest-first, so the head is this write's event.
    const last = successes.find(
      (event) => event.targetType === 'policy' && event.targetId === 'download'
    )
    assert.ok(last)
    assert.equal(
      Object.hasOwn(last.metadata ?? {}, 'expectedVersion'),
      false,
      'old clients keep the exact pre-U136 audit metadata'
    )
  })

  test('非法 expectedVersion 400 POLICY_INVALID 且不写入', async () => {
    const seen = await getPolicy()
    for (const expectedVersion of ['1', -1, 1.5, null]) {
      const put = await callJson('/v1/policies/download', 'PUT', {
        downloadDefault: 'deny',
        expectedVersion
      })
      assert.equal(put.status, 400, `expectedVersion=${String(expectedVersion)} must be refused`)
      assert.equal((put.json as ErrorBody).error?.code, 'POLICY_INVALID')
    }
    const after = await getPolicy()
    assert.equal(after.version, seen.version)
    assert.equal(after.downloadDefault, seen.downloadDefault)
  })

  test('项目级下载策略同样支持 expectedVersion 冲突保护', async () => {
    const path = `/v1/projects/${PROJECT_ID}/policy`
    const seen = await callJson(path, 'GET')
    assert.equal(seen.status, 200)
    const staleVersion = (seen.json as ProjectPolicyView).version

    const winner = await callJson(path, 'PUT', { downloadPolicy: 'allow' })
    assert.equal(winner.status, 200)
    assert.equal((winner.json as ProjectPolicyView).version, staleVersion + 1)

    const loser = await callJson(path, 'PUT', {
      downloadPolicy: 'deny',
      expectedVersion: staleVersion
    })
    assert.equal(loser.status, 409)
    assert.equal((loser.json as ErrorBody).error?.code, 'POLICY_VERSION_CONFLICT')
    const details = (loser.json as ErrorBody).error?.details ?? {}
    assert.equal(details.version, staleVersion + 1)
    assert.equal(details.downloadPolicy, 'allow')

    const after = await callJson(path, 'GET')
    assert.equal((after.json as ProjectPolicyView).version, staleVersion + 1)
    assert.equal((after.json as ProjectPolicyView).downloadPolicy, 'allow')

    const retry = await callJson(path, 'PUT', {
      downloadPolicy: 'deny',
      expectedVersion: staleVersion + 1
    })
    assert.equal(retry.status, 200, 'refreshing the version lets the retry land')
    assert.equal((retry.json as ProjectPolicyView).version, staleVersion + 2)
  })
})
