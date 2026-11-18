import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  login,
  makeDeviceKey,
  registerHost,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U67 role-based authorization model, platform + UI, against a real process.
 *
 * Stored host rows keep the three bits; the levels are derived (never stored):
 *   查看 = view                       → 全部非归档项目可见, ticket capped open+file:read
 *   控制 = view+provision             → 全部项目可见, six ops, download only inherited
 *   管理 = provision+maintain         → no visibility derivation, create + maintain
 * Project grants never widen the host level, and admin keeps the project row
 * only (U40 self-grant still requires open).
 *
 * - P1 查看: visibility derivation + read-only cap beats a wide project grant
 * - P2 控制: six ops + inheritance-only download + creation via provision
 * - P3 管理: no derivation, create + maintenance still work
 * - P4 项目授权不扩大: a project row stays project-scoped
 * - P5 admin bypass: project bits only, no hostAccess
 * - P6 UI: card add → stored row → ticket perms, end to end
 */

const EVIDENCE = 'u67-role-authz'
const DEVICE_PUB_KEY = makeDeviceKey()

let service: Service
let adminToken = ''
let zhangsanToken = ''
let lisiToken = ''
let zhangsanDeviceId = ''
let lisiDeviceId = ''
let hostA = ''
let hostB = ''
let p1 = '' // hostA, wide team-payment grant (cap probe)
let p2 = '' // hostB, no grants (full derivation probe)
let p3 = '' // hostB, download-carrying grant (inheritance probe)

type ProjectRow = {
  id: string
  hostId: string
  permissions: string[]
  hostAccess?: 'full' | 'read-only'
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

async function loginAs(
  username: string,
  password: string
): Promise<{ token: string; deviceId: string }> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, devicePubKey: DEVICE_PUB_KEY, deviceName: 'u67' })
  })
  const body = (await res.json()) as {
    accessToken?: string
    device?: { id: string }
    error?: { code: string }
  }
  assert.equal(res.status, 200, `login ${username}: ${body.error?.code}`)
  return { token: body.accessToken!, deviceId: body.device!.id }
}

async function putHostGrant(
  hostId: string,
  subjectType: 'user' | 'group',
  subjectId: string,
  permissions: string[],
  token = adminToken
): Promise<{ status: number; code?: string }> {
  const res = await api(`/v1/hosts/${hostId}/grants`, {
    method: 'PUT',
    token,
    body: JSON.stringify({ subjectType, subjectId, permissions })
  })
  return { status: res.status, code: res.body.error?.code }
}

async function putProjectGrant(
  projectId: string,
  subjectType: 'user' | 'group',
  subjectId: string,
  permissions: string[]
): Promise<void> {
  const res = await api(`/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    body: JSON.stringify({ subjectType, subjectId, permissions })
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

async function visibleProjects(token: string): Promise<ProjectRow[]> {
  const res = await api('/v1/projects', { token })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.projects
}

async function connect(
  projectId: string,
  token: string,
  deviceId: string
): Promise<{ status: number; perms?: string[]; code?: string }> {
  const res = await api(`/v1/projects/${projectId}/connect`, {
    method: 'POST',
    token,
    body: JSON.stringify({ deviceId, devicePubKey: DEVICE_PUB_KEY, clientVersion: '1.5.0' })
  })
  if (res.status !== 200) {
    return { status: res.status, code: res.body.error?.code }
  }
  const credential = res.body.credential as string
  const payload = JSON.parse(
    Buffer.from(credential.split('.')[1], 'base64url').toString('utf8')
  ) as { perms: string[] }
  return { status: res.status, perms: payload.perms }
}

function errorCode(body: unknown): string | null {
  return (body as { error?: { code?: string } }).error?.code ?? null
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u67-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u67-role-authz'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  const zhangsan = await loginAs('zhangsan', 'Passw0rd!')
  zhangsanToken = zhangsan.token
  zhangsanDeviceId = zhangsan.deviceId
  const lisi = await loginAs('lisi', 'Passw0rd!')
  lisiToken = lisi.token
  lisiDeviceId = lisi.deviceId

  const a = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-u67-a',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/u67-a'
  })
  hostA = a.hostId
  const b = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'dev-u67-b',
    directAddr: '127.0.0.1:8',
    relayTarget: '127.0.0.1:8',
    projectsRoot: '/srv/u67-b'
  })
  hostB = b.hostId

  const created1 = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key: 'u67-wide', hostId: hostA, path: '/srv/u67-a/wide' })
  })
  assert.equal(created1.status, 201, JSON.stringify(created1.body))
  p1 = created1.body.id
  // A deliberately wider-than-readonly project row: the cap must beat it.
  await putProjectGrant(p1, 'group', 'team-payment', [
    'open',
    'terminal',
    'agent',
    'file:read',
    'file:write',
    'download'
  ])

  const created2 = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key: 'u67-bare', hostId: hostB, path: '/srv/u67-b/bare' })
  })
  assert.equal(created2.status, 201, JSON.stringify(created2.body))
  p2 = created2.body.id

  const created3 = await api('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key: 'u67-dl', hostId: hostB, path: '/srv/u67-b/dl' })
  })
  assert.equal(created3.status, 201, JSON.stringify(created3.body))
  p3 = created3.body.id
  await putProjectGrant(p3, 'group', 'team-payment', ['open', 'download'])
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
  saveEvidence(EVIDENCE, 'u67-summary.json', {
    model: 'U67 role → bit mapping (查看=view, 控制=view+provision, 管理=provision+maintain)',
    hosts: { a: hostA, b: hostB },
    projects: { p1, p2, p3 }
  })
})

test('U67-P1 查看（view）：推导全部项目可见，票据上限 open+file:read 压过更宽的项目行', { timeout: 120_000 }, async () => {
  // lisi starts with nothing: the seeded project must be invisible.
  assert.equal(
    (await visibleProjects(lisiToken)).some((row) => row.id === p1),
    false,
    'precondition: lisi cannot see hostA projects before the host grant'
  )

  assert.equal((await putHostGrant(hostA, 'user', 'lisi', ['view'])).status, 200)

  const lisiRows = await visibleProjects(lisiToken)
  const seen = lisiRows.find((row) => row.id === p1)
  assert.ok(seen, 'view derives visibility of every non-archived host project')
  assert.deepEqual([...seen.permissions].sort(), ['file:read', 'open'], 'the read-only ceiling')
  assert.equal(seen.hostAccess, 'read-only', 'the payload explains the cap')
  assert.equal(
    lisiRows.some((row) => row.hostId === hostB),
    false,
    'the derivation is host-scoped: hostB projects stay invisible'
  )
  const opened = await api(`/v1/projects/${p1}`, { token: lisiToken })
  assert.equal(opened.status, 200, 'a derived project opens')
  const hidden = await api(`/v1/projects/${p2}`, { token: lisiToken })
  assert.equal(hidden.status, 404, 'a project on another host stays 404')

  // The cap must beat a wide project row: before any host grant, zhangsan's
  // ticket carries his whole project row; a 查看 row on the host clips it.
  const beforeCap = await connect(p1, zhangsanToken, zhangsanDeviceId)
  assert.equal(beforeCap.status, 200)
  assert.ok(beforeCap.perms!.includes('download'), 'precondition: uncapped ticket')
  assert.equal((await putHostGrant(hostA, 'user', 'zhangsan', ['view'])).status, 200)
  const capped = await connect(p1, zhangsanToken, zhangsanDeviceId)
  assert.equal(capped.status, 200, JSON.stringify(capped))
  assert.deepEqual(
    [...capped.perms!].sort(),
    ['file:read', 'open'],
    'view caps the ticket at open+file:read, download stripped'
  )
  const lisiTicket = await connect(p1, lisiToken, lisiDeviceId)
  assert.deepEqual([...lisiTicket.perms!].sort(), ['file:read', 'open'])

  saveEvidence(EVIDENCE, 'p1-view-cap.json', {
    lisiRow: seen,
    zhangsanTicketPerms: capped.perms,
    lisiTicketPerms: lisiTicket.perms
  })
})

test('U67-P2 控制（view+provision）：全部项目可见、六操作位、download 仅继承，可自助创建', { timeout: 120_000 }, async () => {
  assert.equal((await putHostGrant(hostB, 'user', 'zhangsan', ['view', 'provision'])).status, 200)

  const rows = await visibleProjects(zhangsanToken)
  const bare = rows.find((row) => row.id === p2)
  assert.ok(bare, 'full derives visibility without any project grant')
  assert.deepEqual(
    [...bare.permissions].sort(),
    ['agent', 'browser', 'file:read', 'file:write', 'open', 'terminal'],
    'six operation bits, download never derived'
  )
  assert.equal(bare.hostAccess, 'full')
  const inheriting = rows.find((row) => row.id === p3)
  assert.deepEqual(
    [...inheriting.permissions].sort(),
    ['agent', 'browser', 'download', 'file:read', 'file:write', 'open', 'terminal'],
    'an explicit project download bit is inherited, not derived'
  )

  const bareTicket = await connect(p2, zhangsanToken, zhangsanDeviceId)
  assert.deepEqual([...bareTicket.perms!].sort(), [
    'agent',
    'browser',
    'file:read',
    'file:write',
    'open',
    'terminal'
  ])
  const inheritingTicket = await connect(p3, zhangsanToken, zhangsanDeviceId)
  assert.ok(inheritingTicket.perms!.includes('download'), 'the inherited bit rides the ticket')

  // provision on hostB enables self-service there — and only there.
  const selfOnB = await api('/v1/projects/self', {
    method: 'POST',
    token: zhangsanToken,
    body: JSON.stringify({ name: 'U67 Full Self', dir: 'u67-full-self', hostId: hostB })
  })
  assert.equal(selfOnB.status, 201, JSON.stringify(selfOnB.body))
  const selfOnA = await api('/v1/projects/self', {
    method: 'POST',
    token: zhangsanToken,
    body: JSON.stringify({ name: 'U67 Denied Self', dir: 'u67-denied-self', hostId: hostA })
  })
  assert.equal(selfOnA.status, 403, JSON.stringify(selfOnA.body))
  assert.equal(errorCode(selfOnA.body), 'HOST_PROVISION_FORBIDDEN', 'view alone never creates')

  saveEvidence(EVIDENCE, 'p2-full.json', {
    bare,
    inheriting,
    bareTicketPerms: bareTicket.perms,
    inheritingTicketPerms: inheritingTicket.perms,
    selfOnB: selfOnB.status,
    selfOnA: selfOnA.body
  })
})

test('U67-P4 项目授权不扩大：项目行只影响本项目，主机与兄弟项目均不衍生', { timeout: 120_000 }, async () => {
  // lisi has hostA view only; a project row on hostB must stay project-scoped.
  await putProjectGrant(p2, 'user', 'lisi', ['open', 'terminal'])
  const rows = await visibleProjects(lisiToken)
  const granted = rows.find((row) => row.id === p2)
  assert.ok(granted, 'the explicit project row is visible')
  assert.deepEqual(
    [...granted.permissions].sort(),
    ['open', 'terminal'],
    'no view on the host means the project bits are the whole story'
  )
  assert.equal(granted.hostAccess, undefined, 'no host level may be reported for project-only rows')
  assert.equal(
    rows.some((row) => row.id === p3),
    false,
    'a sibling project on the same host gains nothing'
  )
  const ticket = await connect(p2, lisiToken, lisiDeviceId)
  assert.deepEqual([...ticket.perms!].sort(), ['open', 'terminal'])
})

test('U67-P5 admin 旁路：项目内仍按项目行，payload 无 hostAccess', { timeout: 120_000 }, async () => {
  const res = await api('/v1/projects')
  const row = (res.body.projects as ProjectRow[]).find((candidate) => candidate.id === p2)
  assert.ok(row, 'the admin sees every project')
  assert.deepEqual(row.permissions, [], 'admin carries no grant row (U40 self-grant unchanged)')
  assert.equal('hostAccess' in row, false, 'the cap field is meaningless for the admin bypass')

  // U40: opening still needs an explicit grant for the admin themself.
  const denied = await connect(p2, adminToken, (await loginAs('admin', 'Adm1n!')).deviceId)
  assert.equal(denied.status, 403, JSON.stringify(denied))
  assert.equal(denied.code, 'PROJECT_FORBIDDEN')
})

test('U67-P6 管理（provision+maintain）：不推导可见性，创建与维护仍有效', { timeout: 120_000 }, async () => {
  assert.equal((await putHostGrant(hostA, 'user', 'lisi', ['provision', 'maintain'])).status, 200)

  // lisi already saw p1 via the hostA view grant… wait — this row ADDS bits to
  // the same subject row? No: user:lisi on hostA already holds view, so the PUT
  // above REPLACED it with provision+maintain. The visibility must disappear.
  const rows = await visibleProjects(lisiToken)
  assert.equal(
    rows.some((row) => row.hostId === hostA),
    false,
    'without view the derivation disappears entirely (put is row-wide replacement)'
  )
  assert.equal(
    rows.some((row) => row.id === p2),
    true,
    'the explicit hostB project row from U67-P4 survives'
  )

  // provision still works and maintenance is still delegable.
  const selfOnA = await api('/v1/projects/self', {
    method: 'POST',
    token: lisiToken,
    body: JSON.stringify({ name: 'U67 Manage Self', dir: 'u67-manage-self', hostId: hostA })
  })
  assert.equal(selfOnA.status, 201, JSON.stringify(selfOnA.body))

  const maintainer = await api(`/v1/hosts/${hostA}/maintenance`, {
    method: 'POST',
    token: lisiToken,
    body: JSON.stringify({ enabled: true, reason: 'u67 manage card' })
  })
  assert.equal(maintainer.status, 200, JSON.stringify(maintainer.body))
  const events = (await api('/v1/audit/events?eventType=host_maintenance&result=success&limit=50'))
    .body.events as { actor: string; targetId: string; metadata?: Record<string, unknown> }[]
  const delegated = events.find((event) => event.actor === 'lisi' && event.targetId === hostA)
  assert.equal(delegated?.metadata?.via, 'host_grant', 'the delegation is recorded')
  const restored = await api(`/v1/hosts/${hostA}/maintenance`, {
    method: 'POST',
    body: JSON.stringify({ enabled: false })
  })
  assert.equal(restored.status, 200)

  saveEvidence(EVIDENCE, 'p6-manage.json', {
    rowsAfterReplacement: rows.map((row) => ({ id: row.id, permissions: row.permissions })),
    selfOnA: selfOnA.status,
    maintenanceVia: delegated?.metadata?.via
  })
})

test('U67-P7 UI 三卡片→票据端到端：查看卡添加 lisi@hostB，票据按上限签发', { timeout: 120_000 }, async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('hosts')
  const button = [...page.window.document.querySelectorAll<HTMLButtonElement>('[data-host]')].find(
    (candidate) => candidate.dataset.host === hostB
  )
  assert.ok(button, 'the hosts page must list hostB')
  button.click()
  await page.settle()
  const tab = page.window.document.querySelector<HTMLButtonElement>('[data-auth-tab="perms"]')
  assert.ok(tab, 'the drawer must offer the 权限 tab')
  tab.click()
  await page.settle()

  const card = page.window.document.querySelector<HTMLElement>(
    `[data-perm-cards] > [data-card="view"]`
  )
  assert.ok(card, 'the 查看 card must render')
  card.querySelector<HTMLInputElement>('[data-perm-subject]')!.value = 'lisi'
  const select = card.querySelector<HTMLSelectElement>('[data-perm-type]')!
  select.value = 'user'
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  card.querySelector<HTMLButtonElement>('[data-perm-add]')!.click()
  await page.settle()
  assert.match(
    [...page.window.document.querySelectorAll('.toast')].at(-1)?.textContent ?? '',
    /已保存「查看」授权：只读/
  )

  const row = (
    (await api(`/v1/hosts/${hostB}/grants`)).body.grants as {
      subjectType: string
      username?: string
      permissions: string[]
    }[]
  ).find((candidate) => candidate.username === 'lisi')
  assert.deepEqual(row?.permissions, ['view'], 'the card wrote exactly the 查看 bits')

  // The stored row mints capped tickets without any project-level grant.
  const lisi = await loginAs('lisi', 'Passw0rd!')
  const seen = (await visibleProjects(lisi.token)).find((candidate) => candidate.id === p2)
  assert.ok(seen, 'the 查看 card derivation reaches the project list')
  assert.deepEqual([...seen.permissions].sort(), ['file:read', 'open'])
  const ticket = await connect(p2, lisi.token, lisi.deviceId)
  assert.deepEqual([...ticket.perms!].sort(), ['file:read', 'open'])

  saveEvidence(EVIDENCE, 'p7-card-to-ticket.json', {
    storedRow: row,
    derivedRow: seen,
    ticketPerms: ticket.perms
  })
})

test('U45 被授权开发者管理项目被拒：PUT grants/策略/更新 403，读路径与既有授权不受影响', { timeout: 120_000 }, async () => {
  // zhangsan holds the wide team-payment row on p1: authorized to work, not to manage.
  assert.equal((await api(`/v1/projects/${p1}`, { token: zhangsanToken })).status, 200)
  assert.equal((await api(`/v1/projects/${p1}/grants`, { token: zhangsanToken })).status, 200)

  const grantWrite = await api(`/v1/projects/${p1}/grants`, {
    method: 'PUT',
    token: zhangsanToken,
    body: JSON.stringify({ subjectType: 'user', subjectId: 'lisi', permissions: ['open'] })
  })
  assert.equal(grantWrite.status, 403, JSON.stringify(grantWrite.body))
  assert.equal(errorCode(grantWrite.body), 'PERMISSION_DENIED')

  const policyWrite = await api(`/v1/projects/${p1}/policy`, {
    method: 'PUT',
    token: zhangsanToken,
    body: JSON.stringify({ downloadPolicy: 'deny' })
  })
  assert.equal(policyWrite.status, 403, JSON.stringify(policyWrite.body))
  assert.equal(errorCode(policyWrite.body), 'PERMISSION_DENIED')

  const update = await api(`/v1/projects/${p1}`, {
    method: 'PUT',
    token: zhangsanToken,
    body: JSON.stringify({ name: 'renamed by developer' })
  })
  assert.equal(update.status, 403, JSON.stringify(update.body))
  assert.equal(errorCode(update.body), 'PERMISSION_DENIED')

  // AC-18: every refusal is audited, so the attempts are visible after the fact.
  const denied = (
    (await api('/v1/audit/events?result=denied&limit=200')).body.events as {
      eventType: string
      actor: string | null
      targetId: string | null
      metadata?: Record<string, unknown> | null
    }[]
  ).filter((event) => event.actor === 'zhangsan' && event.targetId === p1)
  for (const eventType of ['grant_update', 'policy_update', 'project_update']) {
    const refusal = denied.find((event) => event.eventType === eventType)
    assert.ok(refusal, `${eventType} denial must be audited`)
    assert.equal(refusal.metadata?.requiredPermission, 'platform:admin')
  }

  // The refused grant write must not have stored the lisi row it asked for.
  const grantsAfter = (await api(`/v1/projects/${p1}/grants`)).body.grants as {
    subjectType: string
    subjectId: string
  }[]
  assert.equal(
    grantsAfter.some((grant) => grant.subjectType === 'user' && grant.subjectId === 'lisi'),
    false,
    'a refused grant write stores nothing'
  )

  saveEvidence(EVIDENCE, 'u45-dev-manage-denied.json', {
    developer: 'zhangsan (wide team-payment project row)',
    denied: {
      grantWrite: grantWrite.status,
      policyWrite: policyWrite.status,
      update: update.status
    },
    auditedEventTypes: denied.map((event) => event.eventType)
  })
})
