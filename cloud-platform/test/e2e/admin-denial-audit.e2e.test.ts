import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M94 (AC-18): a developer reaching for the admin console is refused by 403 *and*
 * leaves a denied event in the audit chain. Before this, only two of the twelve
 * privileged endpoints recorded their own refusal, so "who tried to open the
 * console" was unanswerable for the rest.
 *
 * Real platform process, real logins, real Ed25519 tokens, real audit chain.
 */

const EVIDENCE = 'm94-admin-denial-audit'

type AuditEvent = {
  seq: number
  eventType: string
  actor: string
  targetType: string
  targetId: string | null
  result: string
  traceId: string | null
  metadata?: Record<string, unknown>
}

let service: Service
let adminToken = ''
let devToken = ''
let projectId = ''

async function call(
  token: string,
  path: string,
  method = 'GET',
  body?: unknown
): Promise<number> {
  const res = await fetch(`${service.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return res.status
}

async function deniedEvents(): Promise<AuditEvent[]> {
  const res = await fetch(`${service.url}/v1/audit/events?result=denied&limit=200`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { events: AuditEvent[] }
  return body.events
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'm94-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-admin-denial'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
  const projects = await fetch(`${service.url}/v1/projects`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const body = (await projects.json()) as { projects: { id: string }[] }
  projectId = body.projects[0]?.id ?? ''
  assert.notEqual(projectId, '')
}, 120_000)

after(async () => {
  await service?.stop()
})

test('AC-18 每个管理接口的拒绝都写 denied 审计，且链仍可校验', async () => {
  // ---- every privileged endpoint a developer can reach ----
  const attempts: { label: string; status: number; eventType: string }[] = []
  const attempt = async (
    label: string,
    eventType: string,
    run: () => Promise<number>
  ): Promise<void> => {
    const status = await run()
    assert.equal(status, 403, `${label} must be refused`)
    attempts.push({ label, status, eventType })
  }

  await attempt('GET /v1/hosts', 'host_list', () => call(devToken, '/v1/hosts'))
  await attempt('POST /v1/hosts/tokens', 'host_token_create', () =>
    call(devToken, '/v1/hosts/tokens', 'POST')
  )
  await attempt('POST /v1/hosts/:id/maintenance', 'host_maintenance', () =>
    call(devToken, '/v1/hosts/host_dev001/maintenance', 'POST', { enabled: true })
  )
  await attempt('DELETE /v1/hosts/:id', 'host_revoke', () =>
    call(devToken, '/v1/hosts/host_dev001', 'DELETE')
  )
  await attempt('PUT /v1/policies/download', 'policy_update', () =>
    call(devToken, '/v1/policies/download', 'PUT', { downloadDefault: 'allow' })
  )
  await attempt('PUT /v1/projects/:id/policy', 'policy_update', () =>
    call(devToken, `/v1/projects/${projectId}/policy`, 'PUT', { downloadPolicy: 'allow' })
  )
  await attempt('GET /v1/audit/events', 'audit_query', () =>
    call(devToken, '/v1/audit/events')
  )
  await attempt('GET /v1/audit/status', 'audit_query', () =>
    call(devToken, '/v1/audit/status')
  )
  await attempt('GET /v1/audit/verify', 'audit_verify', () =>
    call(devToken, '/v1/audit/verify')
  )
  await attempt('POST /v1/admin/signing-keys/rotate', 'signing_key_rotate', () =>
    call(devToken, '/v1/admin/signing-keys/rotate', 'POST')
  )
  await attempt('POST /v1/projects', 'project_create', () =>
    call(devToken, '/v1/projects', 'POST', {
      key: 'm94-denied',
      name: 'm94-denied',
      hostId: 'host_dev001',
      path: '/srv/work/m94-denied'
    })
  )
  await attempt('PUT /v1/projects/:id', 'project_update', () =>
    call(devToken, `/v1/projects/${projectId}`, 'PUT', { name: 'renamed' })
  )

  // ---- each refusal is in the chain, attributed and complete ----
  const denied = await deniedEvents()
  const byActor = denied.filter((event) => event.actor === 'zhangsan')
  const seen = attempts.map((entry) => entry.eventType)
  const missing = seen.filter(
    (eventType) => !byActor.some((event) => event.eventType === eventType && event.result === 'denied')
  )
  assert.deepEqual(missing, [], `no denied event for: ${missing.join(', ')}`)

  for (const event of byActor) {
    assert.equal(event.result, 'denied')
    assert.equal(typeof event.targetType, 'string')
    assert.ok(event.metadata, `event ${event.eventType} must carry metadata`)
    // The two project-creation paths pass their own permission vocabulary.
    const required = event.metadata.requiredPermission
    if (required !== undefined) {
      assert.ok(
        required === 'platform:admin' || required === 'platform:auditor',
        `unexpected requiredPermission ${String(required)}`
      )
    }
  }

  // The admin's own successful console read is not a denial: the filter is real.
  assert.equal(await call(adminToken, '/v1/hosts'), 200)
  const afterAdmin = await deniedEvents()
  assert.equal(
    afterAdmin.filter((event) => event.actor === 'admin' && event.result === 'denied').length,
    0
  )

  // ---- the chain that now contains twelve more events still verifies ----
  const verify = await fetch(`${service.url}/v1/audit/verify`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(verify.status, 200)
  const verdict = (await verify.json()) as { ok: boolean; checked: number }
  assert.equal(verdict.ok, true, JSON.stringify(verdict))

  saveEvidence(EVIDENCE, 'admin-denial-audit.json', {
    attempts,
    deniedEventsForDeveloper: byActor.map((event) => ({
      eventType: event.eventType,
      targetType: event.targetType,
      targetId: event.targetId,
      requiredPermission: event.metadata?.requiredPermission ?? null
    })),
    missingEventTypes: missing,
    chain: verdict
  })
}, 120_000)
