import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * AA1 (admin-authorization design §3.1): the project grant matrix gets a
 * server-derived subject directory, and grant writes stop accepting subjects and
 * permission bits that can never fire.
 *
 * - GET /v1/directory is admin-only, derived from logged-in users plus groups a
 *   grant already references (no LDAP search exists)
 * - a refused directory read is a 403 *and* a `directory_read/denied` event
 * - PUT /grants refuses an unknown group and an out-of-contract bit with a 400,
 *   leaving the stored ACL untouched
 * - PUT /grants now records `grant_update/denied` on the 403 path (AC-18)
 */

const EVIDENCE = 'aa1-directory'
const PROJECT = 'proj_payment'
const GRANTS_PATH = `/v1/projects/${PROJECT}/grants`
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

type GrantRow = { subjectType: string; subjectId: string; username?: string; permissions: string[] }

type Directory = {
  users: { id: string; username: string; displayName: string; dept: string }[]
  groups: string[]
}

let service: Service
let adminToken = ''
let devToken = ''

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- same assert-driven shape as web-permission-matrix.e2e.test.ts
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

async function putGrant(
  token: string,
  subjectType: string,
  subjectId: string,
  permissions: string[]
): Promise<{ status: number; code?: string }> {
  const res = await api(GRANTS_PATH, {
    method: 'PUT',
    token,
    body: JSON.stringify({ subjectType, subjectId, permissions })
  })
  return { status: res.status, code: (res.body.error as { code?: string } | undefined)?.code }
}

async function grants(): Promise<GrantRow[]> {
  const res = await api(GRANTS_PATH)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.grants as GrantRow[]
}

async function deniedEvents(eventType: string): Promise<AuditEvent[]> {
  const res = await api(`/v1/audit/events?eventType=${eventType}&result=denied&limit=200`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.events as AuditEvent[]
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'aa1-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-authorization-directory'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  // zhangsan's groups (`developers`, `team-payment`) are the known group set.
  devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
}, 120_000)

after(async () => {
  await service?.stop()
})

test('AA1 admin 目录端点：用户清单与已知组清单从 store 派生', async () => {
  const res = await api('/v1/directory')
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const directory = res.body as Directory

  for (const username of ['admin', 'zhangsan']) {
    const user = directory.users.find((entry) => entry.username === username)
    assert.ok(user, `${username} must be listed`)
    assert.match(user.id, /^user_/, 'a directory user carries the stable account id')
    assert.equal(typeof user.displayName, 'string')
    assert.equal(typeof user.dept, 'string')
  }

  // Sorted and de-duplicated: users' LDAP groups plus the seeded group grant.
  assert.deepEqual(directory.groups, [...new Set(directory.groups)].sort())
  assert.ok(directory.groups.includes('developers'))
  assert.ok(directory.groups.includes('platform-admins'))
  assert.ok(directory.groups.includes('team-payment'))
  assert.equal(directory.groups.includes('team-typo'), false)

  saveEvidence(EVIDENCE, 'directory.json', {
    users: directory.users.map((user) => user.username),
    groups: directory.groups
  })
}, 120_000)

test('AA1 非 admin 读目录：403 且落 directory_read/denied 审计', async () => {
  const res = await api('/v1/directory', { token: devToken })
  assert.equal(res.status, 403)
  assert.equal((res.body.error as { code: string }).code, 'PERMISSION_DENIED')

  const denied = (await deniedEvents('directory_read')).filter((event) => event.actor === 'zhangsan')
  assert.equal(denied.length, 1, 'exactly one denied directory read is recorded')
  const [event] = denied
  assert.equal(event.targetType, 'directory')
  assert.equal(event.metadata?.reason, 'PERMISSION_DENIED')
  assert.equal(event.metadata?.requiredPermission, 'platform:admin')

  saveEvidence(EVIDENCE, 'directory-denied.json', event)
}, 120_000)

test('AA1 组名校验：未知组 400 且不落死行，已知组 200', async () => {
  const before = await grants()

  const typo = await putGrant(adminToken, 'group', 'team-typo', BASE)
  assert.equal(typo.status, 400)
  assert.equal(typo.code, 'GROUP_NOT_FOUND')

  const afterTypo = await grants()
  assert.deepEqual(afterTypo, before, 'a refused group must leave the ACL untouched')
  assert.equal(
    afterTypo.some((row) => row.subjectId === 'team-typo'),
    false,
    'no dead grant row may be stored'
  )

  const known = await putGrant(adminToken, 'group', 'team-payment', BASE)
  assert.equal(known.status, 200)

  saveEvidence(EVIDENCE, 'group-validation.json', {
    unknownGroup: typo,
    knownGroup: known,
    storedAfterRefusal: afterTypo
  })
}, 120_000)

test('AA1 权限位校验：越界位 400 且存量授权行不变', async () => {
  await putGrant(adminToken, 'group', 'team-payment', BASE)
  const before = await grants()

  const invalid = await putGrant(adminToken, 'group', 'team-payment', ['open', 'bogus'])
  assert.equal(invalid.status, 400)
  assert.equal(invalid.code, 'GRANT_PERMISSION_INVALID')

  const after = await grants()
  assert.deepEqual(after, before, 'the whole row is refused, not partially stored')

  // Every contract bit is still accepted.
  const allBits = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'browser', 'download']
  assert.equal((await putGrant(adminToken, 'group', 'team-payment', allBits)).status, 200)

  saveEvidence(EVIDENCE, 'permission-validation.json', { invalid, storedAfterRefusal: after })
}, 120_000)

test('AA1 AC-18：非 admin 写授权 403 现在落 grant_update/denied 审计', async () => {
  const before = await grants()

  const refused = await putGrant(devToken, 'group', 'team-payment', ['open', 'browser'])
  assert.equal(refused.status, 403)
  assert.equal(refused.code, 'PERMISSION_DENIED')
  assert.deepEqual(await grants(), before, 'the refused write stored nothing')

  const denied = (await deniedEvents('grant_update')).filter((event) => event.actor === 'zhangsan')
  assert.equal(denied.length, 1, 'the 403 path now writes an audit event')
  const [event] = denied
  assert.equal(event.targetType, 'project')
  assert.equal(event.targetId, PROJECT)
  assert.equal(event.metadata?.reason, 'PERMISSION_DENIED')
  assert.equal(event.metadata?.requiredPermission, 'platform:admin')

  saveEvidence(EVIDENCE, 'grant-denied-audit.json', event)
}, 120_000)
