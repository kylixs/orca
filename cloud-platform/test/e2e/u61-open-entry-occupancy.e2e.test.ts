import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { login, registerHost, saveEvidence } from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U61 (authz combination batch):
 * - D8: /connect and /web-handoff must share one open predicate. Admin access
 *   only widens visibility; `open` stays an explicit grant bit.
 * - F2: a project path occupies (hostId, path), not path alone, so the same
 *   absolute path on two hosts can coexist while one host still refuses it twice.
 * - The registration dialog must not carry a path across a host switch.
 */

const EVIDENCE = 'u61-fix'
const INTERNAL_TOKEN = 'u61-internal-token'
const DEVICE_PUB_KEY = Buffer.from('u61-device-key').toString('base64')

type LoginBody = { accessToken: string; device: { id: string } }
type ErrorBody = { error?: { code?: string; details?: { reason?: string } } }

let app: ApiHandle
let url = ''
let adminToken = ''
let adminDeviceId = ''

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function adminLogin(): Promise<LoginBody> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'u61-admin',
      devicePubKey: DEVICE_PUB_KEY
    })
  })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as LoginBody
}

async function connect(projectId: string): Promise<{ status: number; body: ErrorBody }> {
  const res = await fetch(`${url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      deviceId: adminDeviceId,
      devicePubKey: DEVICE_PUB_KEY,
      clientVersion: '1.5.0'
    })
  })
  return { status: res.status, body: (await res.json()) as ErrorBody }
}

async function handoff(projectId: string): Promise<{ status: number; body: ErrorBody }> {
  const res = await fetch(`${url}/v1/projects/${projectId}/web-handoff`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  return { status: res.status, body: (await res.json()) as ErrorBody }
}

async function createProject(input: {
  key: string
  hostId: string
  path: string
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key: input.key,
      name: input.key,
      hostId: input.hostId,
      path: input.path
    })
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

before(async () => {
  // The hosts must stay online for the whole file; no heartbeat loop needed.
  app = createApp({ port: 0, internalToken: INTERNAL_TOKEN, hostOfflineMs: 120_000 })
  url = `http://127.0.0.1:${await app.listen()}`
  const admin = await adminLogin()
  adminToken = admin.accessToken
  adminDeviceId = admin.device.id
})

after(async () => {
  await app?.close()
})

test('D8 无 open 的 admin：connect 与 handoff 同为 403 PROJECT_FORBIDDEN/permission_lost', async () => {
  // proj_payment is granted to team-payment only; admin is not a member.
  const deniedConnect = await connect('proj_payment')
  const deniedHandoff = await handoff('proj_payment')
  assert.equal(deniedConnect.status, 403, JSON.stringify(deniedConnect.body))
  assert.equal(deniedConnect.body.error?.code, 'PROJECT_FORBIDDEN')
  assert.equal(deniedConnect.body.error?.details?.reason, 'permission_lost')
  assert.equal(deniedHandoff.status, 403, JSON.stringify(deniedHandoff.body))
  assert.equal(deniedHandoff.body.error?.code, 'PROJECT_FORBIDDEN')
  assert.equal(deniedHandoff.body.error?.details?.reason, 'permission_lost')

  const audits = await fetch(
    `${url}/v1/audit/events?eventType=project_connect&result=denied&limit=50`,
    { headers: auth(adminToken) }
  )
  const events = ((await audits.json()) as { events: { metadata?: { reason?: string } }[] }).events
  assert.ok(
    events.some((event) => event.metadata?.reason === 'permission_lost'),
    'the refused connect must be audited as permission_lost'
  )

  // AA5: the admin self-grant is the sanctioned way to open an unshared project.
  const granted = await fetch(`${url}/v1/projects/proj_payment/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({ subjectType: 'user', subjectId: 'admin', permissions: ['open'] })
  })
  assert.equal(granted.status, 200, await granted.text())

  const openedConnect = await connect('proj_payment')
  const openedHandoff = await handoff('proj_payment')
  assert.equal(openedConnect.status, 200, JSON.stringify(openedConnect.body))
  assert.equal(openedHandoff.status, 201, JSON.stringify(openedHandoff.body))

  saveEvidence(EVIDENCE, 'd8-open-entry.json', {
    deniedConnect: { status: deniedConnect.status, ...deniedConnect.body },
    deniedHandoff: { status: deniedHandoff.status, ...deniedHandoff.body },
    deniedAudit: 'permission_lost',
    afterSelfGrant: { connect: openedConnect.status, handoff: openedHandoff.status }
  })
})

test('F2 管理员登记：跨主机同绝对路径 201 共存，同主机重复仍 409', async () => {
  const hostA = await registerHost({
    apiUrl: url,
    adminToken,
    name: 'u61-host-a',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9'
  })
  const hostB = await registerHost({
    apiUrl: url,
    adminToken,
    name: 'u61-host-b',
    directAddr: '127.0.0.1:10',
    relayTarget: '127.0.0.1:10'
  })
  const sharedPath = '/srv/u61/shared/repo'

  const onA = await createProject({ key: 'u61-shared-a', hostId: hostA.hostId, path: sharedPath })
  const onB = await createProject({ key: 'u61-shared-b', hostId: hostB.hostId, path: sharedPath })
  assert.equal(onA.status, 201, JSON.stringify(onA.body))
  assert.equal(onB.status, 201, JSON.stringify(onB.body))

  const duplicate = await createProject({
    key: 'u61-shared-a-again',
    hostId: hostA.hostId,
    path: sharedPath
  })
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body))
  assert.equal((duplicate.body as { error?: { code?: string } }).error?.code, 'PROJECT_PATH_TAKEN')

  saveEvidence(EVIDENCE, 'f2-admin-path-occupancy.json', {
    sharedPath,
    hostA: { status: onA.status, id: onA.body.id },
    hostB: { status: onB.status, id: onB.body.id },
    sameHostAgain: { status: duplicate.status, code: duplicate.body.error?.code }
  })
})

test('F2 自助登记：跨主机同名目录 201，同主机重复 409', async () => {
  const devToken = await login(url, 'zhangsan', 'Passw0rd!')
  const root = '/srv/u61root'
  const hostA = await registerHost({
    apiUrl: url,
    adminToken,
    name: 'u61-self-a',
    directAddr: '127.0.0.1:11',
    relayTarget: '127.0.0.1:11',
    projectsRoot: root
  })
  const hostB = await registerHost({
    apiUrl: url,
    adminToken,
    name: 'u61-self-b',
    directAddr: '127.0.0.1:12',
    relayTarget: '127.0.0.1:12',
    projectsRoot: root
  })

  const createSelf = async (name: string, hostId: string) => {
    const res = await fetch(`${url}/v1/projects/self`, {
      method: 'POST',
      headers: auth(devToken),
      body: JSON.stringify({ name, dir: 'shared-dir', hostId })
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  const onA = await createSelf('U61 Self A', hostA.hostId)
  const onB = await createSelf('U61 Self B', hostB.hostId)
  assert.equal(onA.status, 201, JSON.stringify(onA.body))
  assert.equal(onB.status, 201, JSON.stringify(onB.body))
  assert.equal(onA.body.path, `${root}/shared-dir`)
  assert.equal(onB.body.path, `${root}/shared-dir`)

  const duplicate = await createSelf('U61 Self C', hostA.hostId)
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body))
  assert.equal((duplicate.body as { error?: { code?: string } }).error?.code, 'PROJECT_PATH_TAKEN')

  saveEvidence(EVIDENCE, 'f2-self-service-path-occupancy.json', {
    path: `${root}/shared-dir`,
    hostA: onA.status,
    hostB: onB.status,
    sameHostAgain: {
      status: duplicate.status,
      code: (duplicate.body as { error?: { code?: string } }).error?.code
    }
  })
})

test('登记弹层切换主机：清空上一主机的路径、错误与无效态，并更新根提示', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('projects')

  page.fail('GET', '/v1/hosts', {
    status: 200,
    body: {
      hosts: [
        { id: 'host_u61_a', name: 'u61-a', online: true, status: 'online', revokedAt: null, projectsRoot: '/srv/root-a' },
        { id: 'host_u61_b', name: 'u61-b', online: true, status: 'online', revokedAt: null, projectsRoot: '/srv/root-b' }
      ]
    }
  })
  const doc = page.window.document
  doc.querySelector<HTMLElement>('#registerProjectBtn')?.click()
  await page.settle()

  const select = doc.querySelector<HTMLSelectElement>('#regHost')
  const path = doc.querySelector<HTMLInputElement>('#regPath')
  const pathError = doc.querySelector<HTMLElement>('#regPathError')
  const hint = doc.querySelector<HTMLElement>('#regRootHint')
  assert.ok(select && path && pathError && hint, 'the dialog must render the host and path fields')

  select.value = 'host_u61_a'
  select.dispatchEvent(new page.window.Event('change'))
  path.value = '/srv/root-a/child'
  pathError.hidden = false
  pathError.textContent = '上一主机的路径错误'
  path.classList.add('invalid')
  assert.equal(hint.textContent, '主机项目根：/srv/root-a')

  select.value = 'host_u61_b'
  select.dispatchEvent(new page.window.Event('change'))
  assert.equal(path.value, '', 'a switched host must not inherit the previous path')
  assert.equal(pathError.hidden, true, 'the previous path error must be cleared')
  assert.equal(path.classList.contains('invalid'), false)
  assert.equal(hint.textContent, '主机项目根：/srv/root-b')

  saveEvidence(EVIDENCE, 'registration-host-switch.json', {
    switchedPath: path.value,
    hint: hint.textContent,
    errorHidden: pathError.hidden
  })
})
