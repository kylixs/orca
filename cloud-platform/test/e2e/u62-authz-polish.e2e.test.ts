import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, makeDeviceKey, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * U62 authorization batch P3×6, against a real platform process (real API
 * requests only — no mocks):
 *   B11  a refused host-grant READ is a `host_grant_read/denied` event, not the
 *        write type the caller never reached
 *   B12  `subjectType` outside user|group is a 400 on both grant families,
 *        never a silent rewrite into a user row (omission still means user)
 *   C10  self-service auto-selection counts only hosts the caller may
 *        provision on, so "no usable host" answers NO_PROVISIONABLE_HOST and
 *        never offers hosts that would 403 anyway
 *   G4   denied grant/policy events carry the endpoint's field family
 *        (hostId+subject vs hostId+mode) instead of the generic pair only
 * Item 5 (register-dialog host switch residue) is already fixed upstream; the
 * replay evidence lives in cloud-platform/evidence/authz-replay-verify.
 */

const EVIDENCE = 'u62-authz-polish'
const DEVICE_PUB_KEY = makeDeviceKey()

let service: Service
let adminToken = ''
let lisiToken = ''
let zhangsanToken = ''
let hostA = ''
let hostB = ''
let p1 = ''

type AuditEvent = {
  eventType: string
  actor: string | null
  targetType: string
  targetId: string | null
  result: string
  metadata?: Record<string, unknown>
}

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- assert-driven shape
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${init.token ?? adminToken}`,
      ...init.headers
    },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function loginAs(username: string, password: string): Promise<string> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, devicePubKey: DEVICE_PUB_KEY, deviceName: 'u62' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username}: ${body.error?.code}`)
  return body.accessToken!
}

async function deniedEvents(eventType: string, hostId?: string): Promise<AuditEvent[]> {
  const query = new URLSearchParams({ result: 'denied', eventTypes: eventType, limit: '200' })
  if (hostId) query.set('hostId', hostId)
  const res = await api(`/v1/audit/events?${query}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.events as AuditEvent[]
}

async function heartbeat(hostId: string, credential: string): Promise<void> {
  const res = await fetch(`${service.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ status: 'online', directAddrs: ['127.0.0.1:9'] })
  })
  assert.equal(res.status, 200, await res.text())
}

async function hostGrantRows(hostId: string): Promise<{ subjectType: string; subjectId: string; permissions: string[] }[]> {
  const res = await api(`/v1/hosts/${hostId}/grants`)
  assert.equal(res.status, 200)
  return res.body.grants
}

async function putHostGrant(
  hostId: string,
  body: Record<string, unknown>,
  token = adminToken
): Promise<{ status: number; code?: string }> {
  const res = await api(`/v1/hosts/${hostId}/grants`, { method: 'PUT', token, body: JSON.stringify(body) })
  return { status: res.status, code: res.body.error?.code }
}

async function selfService(
  body: Record<string, unknown>,
  token: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await api('/v1/projects/self', { method: 'POST', token, body: JSON.stringify(body) })
  return { status: res.status, body: res.body }
}

function errorCode(body: unknown): string | null {
  return (body as { error?: { code?: string } }).error?.code ?? null
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u62-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u62-authz-polish'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  zhangsanToken = await loginAs('zhangsan', 'Passw0rd!')
  lisiToken = await loginAs('lisi', 'Passw0rd!')

  const a = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-u62-a',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/u62-a'
  })
  hostA = a.hostId
  const b = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-u62-b',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/u62-b'
  })
  hostB = b.hostId
  await heartbeat(hostA, a.credential)
  await heartbeat(hostB, b.credential)

  // zhangsan: view+provision on hostA only (visibility + one allowed host);
  // developers keeps a group row so the group form stays covered. lisi: none.
  assert.equal(
    (await putHostGrant(hostA, { subjectType: 'user', subjectId: 'zhangsan', permissions: ['view', 'provision'] }))
      .status,
    200
  )
  assert.equal(
    (await putHostGrant(hostB, { subjectType: 'group', subjectId: 'developers', permissions: ['view'] })).status,
    200
  )

  const created = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key: 'u62-proj', hostId: hostA, path: '/srv/u62-a/u62-proj' })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  p1 = created.body.id
}, 120_000)

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'u62-summary.json', {
    hosts: { a: hostA, b: hostB },
    project: p1,
    items: {
      B11: 'host-grant read refusal lands host_grant_read/denied + hostId, zero write-type events',
      B12: 'subjectType role → 400 on both grant families, row untouched; omission still means user',
      C10: 'no provision-allowed host → 409 NO_PROVISIONABLE_HOST; single allowed host auto-picked',
      G4: 'denied events carry hostId+subject / hostId+mode field families',
      popupSwitch: 'already fixed upstream (U61); replay evidence authz-replay-verify/popup-switch-replay.json pass'
    }
  })
})

test('U62-B12：subjectType:"role" 在主机与项目授权两侧都是 400，不落行；缺省仍按 user', async () => {
  const roleHost = await putHostGrant(hostA, {
    subjectType: 'role',
    subjectId: 'lisi',
    permissions: ['maintain']
  })
  assert.equal(roleHost.status, 400)
  assert.equal(roleHost.code, 'HOST_GRANT_SUBJECT_TYPE_INVALID')

  const roleProject = await api(`/v1/projects/${p1}/grants`, {
    method: 'PUT',
    body: JSON.stringify({ subjectType: 'role', subjectId: 'zhangsan', permissions: ['open'] })
  })
  assert.equal(roleProject.status, 400)
  assert.equal(roleProject.body.error.code, 'GRANT_SUBJECT_TYPE_INVALID')

  // The refused values must not have been rewritten into user rows.
  const hostRows = await hostGrantRows(hostA)
  assert.equal(
    hostRows.some((row) => row.subjectId === 'lisi' && row.permissions.includes('maintain')),
    false,
    'no host row for the refused subjectType'
  )
  const projectRows = (
    await api(`/v1/projects/${p1}/grants`)
  ).body.grants as { subjectType: string; subjectId: string }[]
  assert.equal(
    projectRows.some((row) => row.subjectType !== 'user' && row.subjectType !== 'group'),
    false,
    'no project row outside the user|group contract'
  )

  // Omission stays backward compatible: no subjectType means user.
  assert.equal(
    (await putHostGrant(hostA, { subjectId: 'lisi', permissions: ['view'] })).status,
    200
  )
  assert.ok(
    (await hostGrantRows(hostA)).some(
      // oxlint-disable-next-line typescript/no-explicit-any -- harness-enriched row
      (row) => row.subjectType === 'user' && (row as any).username === 'lisi'
    ),
    'omitted subjectType still stores a user row'
  )
  saveEvidence(EVIDENCE, 'b12-subject-type.json', {
    hostRows: await hostGrantRows(hostA),
    projectRows
  })
})

test('U62-B11：非 admin 读主机授权 403 落 host_grant_read/denied（含 hostId），零写事件类型', async () => {
  const writeDeniedBefore = (await deniedEvents('host_grant_update', hostB)).length
  const readDenied = await api(`/v1/hosts/${hostB}/grants`, { token: lisiToken })
  assert.equal(readDenied.status, 403)
  assert.equal(readDenied.body.error.code, 'PERMISSION_DENIED')

  const writeDeniedAfter = await deniedEvents('host_grant_update', hostB)
  assert.equal(
    writeDeniedAfter.length,
    writeDeniedBefore,
    'a refused read must not land the write event type'
  )
  const readEvents = await deniedEvents('host_grant_read', hostB)
  const event = readEvents[0]
  assert.ok(event, 'the read refusal lands host_grant_read/denied')
  assert.equal(event.actor, 'lisi')
  assert.equal(event.targetType, 'host')
  assert.equal(event.targetId, hostB)
  assert.equal(event.metadata?.hostId, hostB)
  assert.equal(event.metadata?.reason, 'PERMISSION_DENIED')
  assert.equal(event.metadata?.requiredPermission, 'platform:admin')
  saveEvidence(EVIDENCE, 'b11-read-denied.json', { event, writeDeniedAfter })
})

test('U62-C10：无 provision 可用主机时自助选择 409 NO_PROVISIONABLE_HOST；唯一可用主机自动选中', async () => {
  // lisi holds no provision bit anywhere; two online hosts would pre-fix have
  // answered HOST_REQUIRED listing both as candidates.
  const lisi = await selfService({ name: 'U62 Lisi Self', dir: 'u62-lisi' }, lisiToken)
  assert.equal(lisi.status, 409)
  assert.equal(errorCode(lisi.body), 'NO_PROVISIONABLE_HOST')
  assert.equal(
    (lisi.body as { error?: { details?: unknown } }).error?.details,
    undefined,
    'unavailable hosts must not be offered as candidates'
  )

  // zhangsan may provision exactly one of the two online hosts: no ambiguity,
  // the single allowed host is picked without hostId.
  const zhangsan = await selfService({ name: 'U62 Zhangsan Self', dir: 'u62-app' }, zhangsanToken)
  assert.equal(zhangsan.status, 201, JSON.stringify(zhangsan.body))
  assert.equal((zhangsan.body as { hostId?: string }).hostId, hostA)

  // Explicit-host refusals keep their authorization-aware 403 (unchanged path).
  const explicit = await selfService(
    { name: 'U62 Explicit B', dir: 'u62-b', hostId: hostB },
    zhangsanToken
  )
  assert.equal(explicit.status, 403)
  assert.equal(errorCode(explicit.body), 'HOST_PROVISION_FORBIDDEN')
  saveEvidence(EVIDENCE, 'c10-self-selection.json', { lisi, zhangsan: zhangsan.body, explicit: explicit.body })
})

test('U62-G4：denied 授权/策略事件带 hostId+subject / hostId+mode 字段族', async () => {
  const grantRefused = await putHostGrant(
    hostB,
    { subjectType: 'user', subjectId: 'lisi', permissions: ['maintain'] },
    lisiToken
  )
  assert.equal(grantRefused.status, 403)

  const grantEvents = await deniedEvents('host_grant_update', hostB)
  const grantEvent = grantEvents.find(
    (event) => event.actor === 'lisi' && event.metadata?.subjectId === 'lisi'
  )
  assert.ok(grantEvent, 'the refused host grant write is recorded with the subject')
  assert.equal(grantEvent!.metadata?.hostId, hostB)
  assert.equal(grantEvent!.metadata?.subjectType, 'user')
  assert.deepEqual(grantEvent!.metadata?.permissions, ['maintain'])
  assert.equal(grantEvent!.metadata?.reason, 'PERMISSION_DENIED')

  const policyRefused = await api(`/v1/hosts/${hostB}/provision-policy`, {
    method: 'PUT',
    token: lisiToken,
    body: JSON.stringify({ mode: 'open' })
  })
  assert.equal(policyRefused.status, 403)
  const policyEvents = await deniedEvents('host_provision_policy_update', hostB)
  const policyEvent = policyEvents.find((event) => event.actor === 'lisi')
  assert.ok(policyEvent, 'the refused policy write is recorded')
  assert.equal(policyEvent!.metadata?.hostId, hostB)
  assert.equal(policyEvent!.metadata?.mode, 'open')

  // Project grant refusal (zhangsan sees p1 via host view but is no owner).
  const projectRefused = await api(`/v1/projects/${p1}/grants`, {
    method: 'PUT',
    token: zhangsanToken,
    body: JSON.stringify({ subjectType: 'user', subjectId: 'lisi', permissions: ['open'] })
  })
  assert.equal(projectRefused.status, 403)
  const projectEvents = (await deniedEvents('grant_update')).filter(
    (event) => event.actor === 'zhangsan' && event.targetId === p1
  )
  const projectEvent = projectEvents[projectEvents.length - 1]
  assert.ok(projectEvent, 'the refused project grant write is recorded')
  assert.equal(projectEvent!.metadata?.subjectType, 'user')
  assert.equal(projectEvent!.metadata?.subjectId, 'lisi')
  assert.deepEqual(projectEvent!.metadata?.permissions, ['open'])
  saveEvidence(EVIDENCE, 'g4-denied-metadata.json', {
    grantEvent,
    policyEvent,
    projectEvent
  })
})
