import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * AA2 (admin-authorization design §3.2): host grants are a platform-only
 * delegation layer — nothing here travels to the host on the wire.
 *
 * - GET/PUT /v1/hosts/{id}/grants and PUT /v1/hosts/{id}/provision-policy are
 *   admin-only; refusals land as audit events
 * - a `restricted` host refuses self-service to ungranted subjects with
 *   HOST_PROVISION_FORBIDDEN, while an absent policy keeps the old open behaviour
 * - /v1/hosts/available gains the additive `provisionAllowed` field
 * - a granted `maintain` subject may toggle maintenance; admin keeps full power
 */

const EVIDENCE = 'aa2-host-grants'
const BASE = ['open', 'terminal', 'agent', 'file:read', 'file:write']

type AuditEvent = {
  seq: number
  eventType: string
  actor: string
  targetType: string
  targetId: string | null
  result: string
  metadata?: Record<string, unknown>
}

type HostGrantRow = {
  hostId: string
  subjectType: string
  subjectId: string
  username?: string
  permissions: string[]
}

type AvailableHost = {
  id: string
  name: string
  online: boolean
  provisionable: boolean
  projectDirs: string[]
  provisionAllowed: boolean
}

let service: Service
let adminToken = ''
let devToken = ''
let otherToken = ''
let restrictedHostId = ''
let openHostId = ''

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- assert-driven shape like AA1
): Promise<{ status: number; body: Record<string, any> }> {
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

function errorCode(body: unknown): string | null {
  return (body as { error?: { code?: string } }).error?.code ?? null
}

async function hostGrants(hostId: string): Promise<HostGrantRow[]> {
  const res = await api(`/v1/hosts/${hostId}/grants`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.grants as HostGrantRow[]
}

async function putHostGrant(
  token: string,
  hostId: string,
  subjectType: string,
  subjectId: string,
  permissions: string[]
): Promise<{ status: number; code?: string }> {
  const res = await api(`/v1/hosts/${hostId}/grants`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ subjectType, subjectId, permissions })
  })
  return { status: res.status, code: errorCode(res.body) ?? undefined }
}

async function setPolicy(
  token: string,
  hostId: string,
  mode: unknown
): Promise<{ status: number; code?: string }> {
  const res = await api(`/v1/hosts/${hostId}/provision-policy`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ mode })
  })
  return { status: res.status, code: errorCode(res.body) ?? undefined }
}

async function selfService(
  token: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, any> }> {
  return api('/v1/projects/self', { method: 'POST', token, body: JSON.stringify(body) })
}

async function available(token: string): Promise<AvailableHost[]> {
  const res = await api('/v1/hosts/available', { token })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.hosts as AvailableHost[]
}

async function deniedEvents(eventType: string): Promise<AuditEvent[]> {
  const res = await api(`/v1/audit/events?eventType=${eventType}&result=denied&limit=200`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.events as AuditEvent[]
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'aa2-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-host-authorization'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
  // lisi's LDAP groups (`developers`) do not include team-payment.
  otherToken = await login(service.url, 'lisi', 'Passw0rd!')

  const restricted = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-aa2-restricted',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/projects'
  })
  restrictedHostId = restricted.hostId
  const open = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-aa2-open',
    directAddr: '127.0.0.1:8',
    relayTarget: '127.0.0.1:8',
    projectsRoot: '/srv/open'
  })
  openHostId = open.hostId
}, 120_000)

after(async () => {
  await service?.stop()
})

test('AA2 三端点门禁：admin 可用，developer 403 且落 denied 审计', async () => {
  const adminGet = await api(`/v1/hosts/${restrictedHostId}/grants`)
  assert.equal(adminGet.status, 200, JSON.stringify(adminGet.body))
  assert.deepEqual(adminGet.body.grants, [])

  const devGet = await api(`/v1/hosts/${restrictedHostId}/grants`, { token: devToken })
  assert.equal(devGet.status, 403)
  assert.equal(errorCode(devGet.body), 'PERMISSION_DENIED')

  const devPut = await putHostGrant(devToken, restrictedHostId, 'group', 'developers', [
    'provision'
  ])
  assert.equal(devPut.status, 403)
  assert.equal(devPut.code, 'PERMISSION_DENIED')

  const devPolicy = await setPolicy(devToken, restrictedHostId, 'restricted')
  assert.equal(devPolicy.status, 403)
  assert.equal(devPolicy.code, 'PERMISSION_DENIED')

  const grantDenied = (await deniedEvents('host_grant_update')).filter(
    (event) => event.actor === 'zhangsan'
  )
  assert.equal(grantDenied.length, 2, 'GET and PUT refusals are both recorded')
  for (const event of grantDenied) {
    assert.equal(event.targetType, 'host')
    assert.equal(event.targetId, restrictedHostId)
    assert.equal(event.metadata?.reason, 'PERMISSION_DENIED')
    assert.equal(event.metadata?.requiredPermission, 'platform:admin')
  }

  const policyDenied = (await deniedEvents('host_provision_policy_update')).filter(
    (event) => event.actor === 'zhangsan'
  )
  assert.equal(policyDenied.length, 1)

  saveEvidence(EVIDENCE, 'endpoint-gating.json', { grantDenied, policyDenied })
}, 120_000)

test('AA2 授权写入：组/用户行、位校验、组名校验，全量替换且不改既有行', async () => {
  const invalid = await putHostGrant(adminToken, restrictedHostId, 'group', 'team-payment', [
    'provision',
    'bogus'
  ])
  assert.equal(invalid.status, 400)
  assert.equal(invalid.code, 'HOST_GRANT_PERMISSION_INVALID')
  assert.deepEqual(await hostGrants(restrictedHostId), [], 'a bad bit stores nothing')

  const typo = await putHostGrant(adminToken, restrictedHostId, 'group', 'team-typo', [
    'provision'
  ])
  assert.equal(typo.status, 400)
  assert.equal(typo.code, 'GROUP_NOT_FOUND')
  assert.deepEqual(await hostGrants(restrictedHostId), [])

  const groupRow = await putHostGrant(adminToken, restrictedHostId, 'group', 'team-payment', [
    'provision',
    'view'
  ])
  assert.equal(groupRow.status, 200, JSON.stringify(groupRow))

  const userRow = await putHostGrant(adminToken, restrictedHostId, 'user', 'lisi', ['maintain'])
  assert.equal(userRow.status, 200, JSON.stringify(userRow))

  const rows = await hostGrants(restrictedHostId)
  const group = rows.find((row) => row.subjectId === 'team-payment')
  assert.deepEqual(group?.permissions.sort(), ['provision', 'view'])
  const user = rows.find((row) => row.username === 'lisi')
  assert.ok(user, 'a user row is named by username')
  assert.deepEqual(user.permissions, ['maintain'])
  assert.match(user.subjectId, /^user_/)

  // Whole-row replacement: an empty array deletes exactly that subject's row.
  const cleared = await putHostGrant(adminToken, restrictedHostId, 'group', 'team-payment', [])
  assert.equal(cleared.status, 200)
  assert.equal((await hostGrants(restrictedHostId)).some((row) => row.username === 'lisi'), true)
  // Re-grant team-payment provision so the group path stays covered below.
  assert.equal(
    (await putHostGrant(adminToken, restrictedHostId, 'group', 'team-payment', ['provision']))
      .status,
    200
  )

  saveEvidence(EVIDENCE, 'grant-rows.json', await hostGrants(restrictedHostId))
}, 120_000)

test('AA2 restricted 门禁：非授权主体 403 HOST_PROVISION_FORBIDDEN，授权组与管理員放行', async () => {
  const policy = await setPolicy(adminToken, restrictedHostId, 'restricted')
  assert.equal(policy.status, 200, JSON.stringify(policy))

  const listed = await api('/v1/hosts')
  const hostView = (listed.body.hosts as { id: string; provisionPolicy?: string }[]).find(
    (host) => host.id === restrictedHostId
  )
  assert.equal(hostView?.provisionPolicy, 'restricted')

  const refused = await selfService(otherToken, {
    name: 'Lisi Grant Demo',
    dir: 'lisi-grant-demo',
    hostId: restrictedHostId
  })
  assert.equal(refused.status, 403, JSON.stringify(refused.body))
  assert.equal(errorCode(refused.body), 'HOST_PROVISION_FORBIDDEN')

  const denied = (await deniedEvents('project_create')).filter(
    (event) => event.actor === 'lisi' && event.metadata?.reason === 'HOST_PROVISION_FORBIDDEN'
  )
  assert.equal(denied.length, 1)
  assert.equal(denied[0].metadata?.hostId, restrictedHostId)

  // zhangsan is in team-payment, which holds `provision` on this host.
  const granted = await selfService(devToken, {
    name: 'Granted Self Demo',
    dir: 'granted-self-demo',
    hostId: restrictedHostId
  })
  assert.equal(granted.status, 201, JSON.stringify(granted.body))
  assert.equal(granted.body.hostId, restrictedHostId)
  for (const permission of BASE) {
    assert.ok(granted.body.permissions.includes(permission), `missing ${permission}`)
  }

  // Admin keeps full power regardless of grants.
  const byAdmin = await selfService(adminToken, {
    name: 'Admin Self Demo',
    dir: 'admin-self-demo',
    hostId: restrictedHostId
  })
  assert.equal(byAdmin.status, 201, JSON.stringify(byAdmin.body))

  saveEvidence(EVIDENCE, 'restricted-provision.json', { refused, denied, granted: granted.body })
}, 120_000)

test('AA2 available 加性字段：restricted 按授权区分，缺省 open 恒 true 且其余字段不变', async () => {
  const forOther = (await available(otherToken)).find((host) => host.id === restrictedHostId)
  assert.ok(forOther)
  assert.equal(forOther.provisionAllowed, false)
  assert.equal(forOther.provisionable, true)

  const forDev = (await available(devToken)).find((host) => host.id === restrictedHostId)
  assert.equal(forDev?.provisionAllowed, true)

  const forAdmin = (await available(adminToken)).find((host) => host.id === restrictedHostId)
  assert.equal(forAdmin?.provisionAllowed, true)

  // Host with no policy: pre-grant behaviour, so every logged-in user may self-serve.
  const openForOther = (await available(otherToken)).find((host) => host.id === openHostId)
  assert.ok(openForOther)
  assert.equal(openForOther.provisionAllowed, true)
  assert.deepEqual(Object.keys(openForOther).sort(), [
    'id',
    'name',
    'online',
    'projectDirs',
    'provisionAllowed',
    'provisionable'
  ])

  const created = await selfService(otherToken, {
    name: 'Open Self Demo',
    dir: 'open-self-demo',
    hostId: openHostId
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))

  saveEvidence(EVIDENCE, 'available.json', {
    restricted: forOther,
    open: openForOther
  })
}, 120_000)

test('AA2 维护委派：maintain 位可进出维护并记 via，未授权者与吊销仍 admin-only', async () => {
  const delegated = await api(`/v1/hosts/${restrictedHostId}/maintenance`, {
    method: 'POST',
    token: otherToken,
    body: JSON.stringify({ enabled: true, reason: 'granted maintenance' })
  })
  assert.equal(delegated.status, 200, JSON.stringify(delegated.body))
  assert.equal(delegated.body.status, 'maintenance')

  const events = await deniedEvents('host_maintenance')
  assert.equal(events.length, 0, 'a granted maintainer is never denied')

  const success = (
    await api('/v1/audit/events?eventType=host_maintenance&result=success&limit=200')
  ).body.events as AuditEvent[]
  const delegatedEvent = success.find(
    (event) => event.actor === 'lisi' && event.targetId === restrictedHostId
  )
  assert.ok(delegatedEvent, 'the delegated toggle is recorded')
  assert.equal(delegatedEvent.metadata?.via, 'host_grant')

  const ungranted = await api(`/v1/hosts/${openHostId}/maintenance`, {
    method: 'POST',
    token: devToken,
    body: JSON.stringify({ enabled: true })
  })
  assert.equal(ungranted.status, 403)
  assert.equal(errorCode(ungranted.body), 'PERMISSION_DENIED')

  // Admin is still unrestricted, and its path carries no delegation marker.
  const byAdmin = await api(`/v1/hosts/${openHostId}/maintenance`, {
    method: 'POST',
    token: adminToken,
    body: JSON.stringify({ enabled: true, reason: 'admin maintenance' })
  })
  assert.equal(byAdmin.status, 200)
  const adminEvent = (
    (
      await api('/v1/audit/events?eventType=host_maintenance&result=success&limit=200')
    ).body.events as AuditEvent[]
  ).find((event) => event.actor === 'admin' && event.targetId === openHostId)
  assert.equal(adminEvent?.metadata?.via, undefined)

  // Revocation is never delegated, even to a maintainer.
  const revoke = await api(`/v1/hosts/${restrictedHostId}`, { method: 'DELETE', token: otherToken })
  assert.equal(revoke.status, 403)
  assert.equal(errorCode(revoke.body), 'PERMISSION_DENIED')
  const revokeDenied = (await deniedEvents('host_revoke')).filter(
    (event) => event.actor === 'lisi'
  )
  assert.equal(revokeDenied.length, 1)

  saveEvidence(EVIDENCE, 'maintenance-delegation.json', {
    delegatedEvent,
    ungranted,
    adminEvent,
    revokeDenied
  })
}, 120_000)
