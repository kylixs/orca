import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * U57 (R3): three inputs used to be trusted far enough to write bad state or
 * silently widen a response.
 *  - heartbeat `directAddrs: [123]` was stored and every later project view
 *    threw on `addr.match`, so one beat took down the admin list (P1).
 *  - PUT grants with a non-array `permissions` read as [] and deleted the
 *    existing row (P2).
 *  - audit `limit=0/-1/abc` reached slice() as 0/-1/NaN and returned the whole
 *    chain instead of a page (P2).
 *
 * Real platform process, real host registration and credential, real grants.
 */

const EVIDENCE = 'r3-api-hardening'

type Json = Record<string, unknown>

let api: Service
let adminToken = ''

function auth(token = adminToken): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function call(
  path: string,
  method = 'GET',
  body?: unknown
): Promise<{ status: number; body: Json; text: string }> {
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers: auth(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {}, text }
}

async function registerHost(name: string): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await call('/v1/hosts/tokens', 'POST')
  assert.equal(tokenRes.status, 201, tokenRes.text)
  const { token } = tokenRes.body as { token: string }
  const res = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name,
      fingerprint: `sha256:${name}`,
      e2eePublicKeyB64: 'r3-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: ['127.0.0.1:19101'],
      relayTarget: '127.0.0.1:19101',
      runtimeCapabilities: ['pty', 'files']
    })
  })
  const body = (await res.json()) as { hostId?: string; credential?: string }
  assert.equal(res.status, 201, JSON.stringify(body))
  assert.ok(body.hostId && body.credential)
  return { hostId: body.hostId, credential: body.credential }
}

async function heartbeat(
  hostId: string,
  credential: string,
  body: Json
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function hostRow(hostId: string): Promise<{ directAddrs: string[] }> {
  const res = await call('/v1/hosts')
  assert.equal(res.status, 200, res.text)
  const row = (res.body.hosts as { id: string; directAddrs: string[] }[]).find(
    (host) => host.id === hostId
  )
  assert.ok(row, `host ${hostId} missing`)
  return row
}

async function projectList(): Promise<{ status: number; count: number; text: string }> {
  const res = await call('/v1/projects')
  const projects = (res.body.projects as unknown[] | undefined) ?? []
  return { status: res.status, count: projects.length, text: res.text }
}

type GrantRow = {
  subjectType: string
  subjectId: string
  username?: string
  permissions: string[]
}

/** The write resolves a username to a user id, so match either form. */
function userRow(grants: GrantRow[], username: string): GrantRow | undefined {
  return grants.find(
    (g) => g.subjectType === 'user' && (g.username === username || g.subjectId === username)
  )
}

async function projectGrants(projectId: string): Promise<{
  status: number
  grants: GrantRow[]
}> {
  const res = await call(`/v1/projects/${projectId}/grants`)
  return { status: res.status, grants: (res.body.grants as GrantRow[]) ?? [] }
}

async function hostGrants(hostId: string): Promise<{
  status: number
  grants: GrantRow[]
}> {
  const res = await call(`/v1/hosts/${hostId}/grants`)
  return { status: res.status, grants: (res.body.grants as GrantRow[]) ?? [] }
}

async function auditPage(
  query: string
): Promise<{ status: number; length: number; code?: string }> {
  const res = await call(`/v1/audit/events?${query}`)
  const events = (res.body.events as unknown[] | undefined) ?? []
  return {
    status: res.status,
    length: events.length,
    ...(res.body.error ? { code: (res.body.error as { code: string }).code } : {})
  }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'r3-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-r3-hardening'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
}, { timeout: 120_000 })

after(async () => {
  await api?.stop()
})

test('U57-H14 心跳 directAddrs 非字符串 → 400 不落库，管理台列表不受影响', async () => {
  const { hostId, credential } = await registerHost('r3-heartbeat-host')
  const beforeList = await projectList()
  assert.equal(beforeList.status, 200, beforeList.text)

  // The exact exploratory payload: an element that is not a string.
  const bad = await heartbeat(hostId, credential, { directAddrs: [123] })
  assert.equal(bad.status, 400, JSON.stringify(bad.body))
  assert.equal((bad.body.error as { code: string }).code, 'HOST_DIRECTADDRS_INVALID')

  // The bad beat must not have overwritten the last good addresses.
  const stored = await hostRow(hostId)
  assert.deepEqual(stored.directAddrs, ['127.0.0.1:19101'])

  // And the failure the probe saw — GET /v1/projects 500 for everyone — is gone.
  const afterList = await projectList()
  assert.equal(afterList.status, 200, afterList.text)
  assert.equal(afterList.count, beforeList.count)

  // Other malformed shapes are refused the same way.
  for (const directAddrs of [['http://evil.example'], [123, 456], 'not-an-array', [null]]) {
    const refused = await heartbeat(hostId, credential, { directAddrs })
    assert.equal(refused.status, 400, `directAddrs=${JSON.stringify(directAddrs)}`)
    assert.equal((refused.body.error as { code: string }).code, 'HOST_DIRECTADDRS_INVALID')
  }

  // Positive case: a valid address still updates and lands.
  const good = await heartbeat(hostId, credential, { directAddrs: ['127.0.0.1:19102'] })
  assert.equal(good.status, 200, JSON.stringify(good.body))
  assert.deepEqual((await hostRow(hostId)).directAddrs, ['127.0.0.1:19102'])

  saveEvidence(EVIDENCE, 'heartbeat-directaddrs.json', {
    endpoint: `POST /v1/hosts/${hostId}/heartbeat`,
    requestBody: { directAddrs: [123] },
    response: { status: bad.status, body: bad.body },
    storedAfterBadBeat: ['127.0.0.1:19101'],
    projectListStatuses: [beforeList.status, afterList.status],
    validBeat: { status: good.status, stored: ['127.0.0.1:19102'] }
  })
})

test('U57-G9 项目授权 permissions 非数组 → 400，既有授权保留', async () => {
  const projectId = 'proj_payment'
  const subjectId = 'zhangsan'
  const before = await projectGrants(projectId)
  assert.equal(before.status, 200)
  assert.equal(userRow(before.grants, subjectId), undefined)

  const seeded = await call(`/v1/projects/${projectId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId,
    permissions: ['open']
  })
  assert.equal(seeded.status, 200, seeded.text)

  const malformed = await call(`/v1/projects/${projectId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId,
    permissions: 'open'
  })
  assert.equal(malformed.status, 400, malformed.text)
  assert.equal((malformed.body.error as { code: string }).code, 'GRANT_PERMISSION_INVALID')

  const after = await projectGrants(projectId)
  const row = userRow(after.grants, subjectId)
  assert.ok(row, 'the malformed PUT must not delete the existing row')
  assert.deepEqual(row.permissions, ['open'])

  // Omitted permissions is the same non-array contract, not a silent delete.
  const omitted = await call(`/v1/projects/${projectId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId
  })
  assert.equal(omitted.status, 400, omitted.text)
  assert.deepEqual(userRow((await projectGrants(projectId)).grants, subjectId)?.permissions, [
    'open'
  ])

  // Existing element validation still rejects a bad bit (zero regression).
  const badBit = await call(`/v1/projects/${projectId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId,
    permissions: ['open', 'banana']
  })
  assert.equal(badBit.status, 400, badBit.text)
  assert.equal((badBit.body.error as { code: string }).code, 'GRANT_PERMISSION_INVALID')

  // An explicit empty array is the supported way to remove a row.
  const cleared = await call(`/v1/projects/${projectId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId,
    permissions: []
  })
  assert.equal(cleared.status, 200, cleared.text)
  assert.equal(userRow((await projectGrants(projectId)).grants, subjectId), undefined)

  saveEvidence(EVIDENCE, 'project-grants.json', {
    endpoint: `PUT /v1/projects/${projectId}/grants`,
    requestBody: { subjectType: 'user', subjectId, permissions: 'open' },
    response: { status: malformed.status, body: malformed.body },
    grantPreservedAfterMalformedPut: row.permissions,
    omittedPermissionsStatus: omitted.status,
    badBitStatus: badBit.status,
    emptyArrayClearsRow: true
  })
})

test('U57-G9 主机授权 permissions 非数组 → 400，既有授权保留', async () => {
  const hostId = 'host_dev001'
  const subjectId = 'zhangsan'

  const seeded = await call(`/v1/hosts/${hostId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId,
    permissions: ['view']
  })
  assert.equal(seeded.status, 200, seeded.text)

  const malformed = await call(`/v1/hosts/${hostId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId,
    permissions: 'view'
  })
  assert.equal(malformed.status, 400, malformed.text)
  assert.equal((malformed.body.error as { code: string }).code, 'HOST_GRANT_PERMISSION_INVALID')

  const after = await hostGrants(hostId)
  const row = userRow(after.grants, subjectId)
  assert.ok(row, 'the malformed PUT must not delete the existing host row')
  assert.deepEqual(row.permissions, ['view'])

  const cleared = await call(`/v1/hosts/${hostId}/grants`, 'PUT', {
    subjectType: 'user',
    subjectId,
    permissions: []
  })
  assert.equal(cleared.status, 200, cleared.text)

  saveEvidence(EVIDENCE, 'host-grants.json', {
    endpoint: `PUT /v1/hosts/${hostId}/grants`,
    requestBody: { subjectType: 'user', subjectId, permissions: 'view' },
    response: { status: malformed.status, body: malformed.body },
    grantPreservedAfterMalformedPut: row.permissions,
    emptyArrayClearsRow: true
  })
})

test('U57-U8 审计 limit 0/负/非数字 → 默认 50 页，合法值不回归', async () => {
  // Grow the chain past the default page so a widened limit is observable.
  for (let i = 0; i < 60; i += 1) {
    const verify = await call('/v1/audit/verify')
    assert.equal(verify.status, 200, verify.text)
  }

  const zero = await auditPage('limit=0')
  const negative = await auditPage('limit=-1')
  const nonNumeric = await auditPage('limit=abc')
  const empty = await auditPage('limit=')
  const one = await auditPage('limit=1')
  const capped = await auditPage('limit=500')
  const page200 = await auditPage('limit=200')

  for (const [label, page] of [
    ['limit=0', zero],
    ['limit=-1', negative],
    ['limit=abc', nonNumeric],
    ['limit=', empty]
  ] as const) {
    assert.equal(page.status, 200, label)
    assert.equal(
      page.length,
      50,
      `${label} must fall back to the default page, not the whole chain`
    )
  }
  assert.equal(one.status, 200)
  assert.equal(one.length, 1, 'a valid positive limit is unchanged')
  assert.equal(capped.status, 200)
  assert.equal(capped.length, Math.min(page200.length, 200), 'the 200 cap still holds')

  saveEvidence(EVIDENCE, 'audit-limit.json', {
    endpoint: 'GET /v1/audit/events',
    totalEventsProbed: page200.length,
    results: {
      limit0: zero,
      limitNegative: negative,
      limitAbc: nonNumeric,
      limitEmpty: empty,
      limitOne: one,
      limit500: capped,
      limit200: page200
    }
  })
})
