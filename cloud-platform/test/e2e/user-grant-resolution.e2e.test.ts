import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M116-QA-001 (P0): a user-level grant used to store the submitted username as
 * `subjectId`, while the ACL matches on the account id — the console reported a
 * grant that never fired, and because the revoke branch could not resolve that
 * "user", it dropped every live credential on the project instead of the target
 * user's. The platform now resolves the name to the account, refuses unknown
 * ones, and a user grant change revokes only that user's credentials.
 */

const EVIDENCE = 'w116-fixes'
const BASIC_PERMISSIONS = ['open', 'terminal', 'agent', 'file:read', 'file:write']

let service: Service
let adminToken: string
let probeHostId = ''
let probeHostCredential = ''

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'w116-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-user-grant'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  // A host with a real credential: its heartbeat is where the platform publishes
  // the revocation lists a host acts on, so it is the observable scope of a grant
  // change.
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'grant-probe',
    directAddr: '127.0.0.1:16998',
    relayTarget: '127.0.0.1:16998'
  })
  probeHostId = host.hostId
  probeHostCredential = host.credential
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
})

async function putGrant(input: {
  subjectType: 'user' | 'group'
  subjectId: string
  permissions: string[]
}): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${service.url}/v1/projects/proj_payment/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(input)
  })
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } }
  return { status: res.status, code: body.error?.code }
}

type ProjectView = { name: string; permissions: string[] }

async function listProjects(token: string): Promise<ProjectView[]> {
  const res = await fetch(`${service.url}/v1/projects`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { projects: ProjectView[] }).projects
}

type Revoked = {
  users: { id: string; since: number }[]
  projects: { id: string; since: number }[]
}

/** The revocation lists exactly as a host receives them on its next beat. */
async function hostRevocations(): Promise<Revoked> {
  const res = await fetch(`${service.url}/v1/hosts/${probeHostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${probeHostCredential}` },
    body: JSON.stringify({ status: 'online' })
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { revoked: Revoked }).revoked
}

type GrantRow = { subjectType: string; subjectId: string; username?: string; permissions: string[] }

async function listGrants(): Promise<GrantRow[]> {
  const res = await fetch(`${service.url}/v1/projects/proj_payment/grants`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { grants: GrantRow[] }).grants
}

test('M116-QA-001 用户级授权按用户名解析为账号：授权真实生效，未知用户被拒', { timeout: 120_000 }, async () => {
  const lisi = await login(service.url, 'lisi', 'Passw0rd!')

  // Before: lisi holds no grant on the seeded project (his groups are developers
  // only), so the project must be invisible.
  assert.equal(
    (await listProjects(lisi)).some((p) => p.name === 'payment-service'),
    false,
    'precondition: lisi cannot see the project before the user grant'
  )

  const granted = await putGrant({
    subjectType: 'user',
    subjectId: 'lisi',
    permissions: BASIC_PERMISSIONS
  })
  assert.equal(granted.status, 200, JSON.stringify(granted))

  // The stored subject is the account, not the submitted name.
  const row = (await listGrants()).find((g) => g.subjectType === 'user' && g.username === 'lisi')
  assert.ok(row, 'the grant row must carry the resolved user')
  assert.match(row.subjectId, /^user_/, 'subjectId must be the user id')
  assert.notEqual(row.subjectId, 'lisi', 'the username must not be stored as the subject id')
  assert.deepEqual(row.permissions, BASIC_PERMISSIONS)

  // The grant fires: the same session now sees the project with those permissions.
  const visible = (await listProjects(lisi)).find((p) => p.name === 'payment-service')
  assert.ok(visible, 'the granted user must see the project')
  assert.deepEqual(visible.permissions, BASIC_PERMISSIONS)

  // An unknown name is refused instead of being stored as a grant that never fires.
  const unknown = await putGrant({
    subjectType: 'user',
    subjectId: 'nosuchuser',
    permissions: BASIC_PERMISSIONS
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.code, 'USER_NOT_FOUND')
  assert.equal(
    (await listGrants()).some((g) => g.subjectId === 'nosuchuser'),
    false,
    'a refused subject must not leave a dead grant row'
  )

  saveEvidence(EVIDENCE, 'f1-user-grant-row.json', {
    qa: 'M116-QA-001',
    storedRow: row,
    grantedUserSeesProject: Boolean(visible),
    grantedPermissions: visible?.permissions ?? [],
    unknownUser: unknown
  })
})

test('M116-QA-001 授权变更只撤销该用户的凭证：项目级撤销不得发生', { timeout: 120_000 }, async () => {
  // zhangsan works on the project through his group grant; his session must be
  // untouched by lisi's grant change.
  const zhangsan = await login(service.url, 'zhangsan', 'Passw0rd!')
  const zhangsanBefore = await listProjects(zhangsan)
  assert.ok(zhangsanBefore.some((p) => p.name === 'payment-service'))

  const granted = await putGrant({
    subjectType: 'user',
    subjectId: 'lisi',
    permissions: BASIC_PERMISSIONS
  })
  assert.equal(granted.status, 200)

  const revoked = await hostRevocations()
  assert.ok(
    revoked.users.some((u) => u.id === 'lisi'),
    `the target user's credentials must be revoked: ${JSON.stringify(revoked.users)}`
  )
  assert.equal(
    revoked.users.some((u) => u.id === 'zhangsan'),
    false,
    'other users must keep their credentials'
  )
  assert.equal(
    revoked.projects.some((p) => p.id === 'proj_payment'),
    false,
    `a user grant change must not revoke the whole project: ${JSON.stringify(revoked.projects)}`
  )

  const zhangsanAfter = await listProjects(zhangsan)
  assert.deepEqual(
    zhangsanAfter.find((p) => p.name === 'payment-service')?.permissions,
    zhangsanBefore.find((p) => p.name === 'payment-service')?.permissions,
    'the other user’s project access must be unchanged'
  )

  // Removing the grant narrows only lisi again — and must not fall back to a
  // project-wide revocation either.
  const removed = await putGrant({ subjectType: 'user', subjectId: 'lisi', permissions: [] })
  assert.equal(removed.status, 200)
  assert.equal(
    (await listProjects(await login(service.url, 'lisi', 'Passw0rd!'))).some(
      (p) => p.name === 'payment-service'
    ),
    false,
    'the revoked user must no longer see the project'
  )
  const afterRemoval = await hostRevocations()
  assert.equal(
    afterRemoval.projects.some((p) => p.id === 'proj_payment'),
    false,
    'removal must stay user-scoped'
  )
  assert.ok(
    (await listProjects(zhangsan)).some((p) => p.name === 'payment-service'),
    'the other user keeps the project'
  )

  saveEvidence(EVIDENCE, 'f1-user-grant-scope.json', {
    qa: 'M116-QA-001',
    revokedUsersAfterGrantChange: revoked.users.map((u) => u.id),
    revokedProjects: revoked.projects.map((p) => p.id),
    zhangsanPermissionsUnchanged: true
  })
})
