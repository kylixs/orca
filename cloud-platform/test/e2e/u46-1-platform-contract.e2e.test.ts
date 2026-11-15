import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { saveEvidence } from './harness.ts'

/**
 * U46-1 (FR-3.11 R3): the platform-side wire contract behind the three project
 * actions. Two additive fields, verified against the compatibility matrix:
 * `web-handoff`'s optional `surface`, and `projectView.createdBy` for
 * admin/auditor only. Old peers must keep their exact pre-U46 bytes.
 */

const EVIDENCE = 'u46-1-contract'
const INTERNAL_TOKEN = 'u46-internal-token'
const DIRECT_ENTRY = 'https://127.0.0.1:16768/web-index.html'
const ADMIN_ENTRY = 'https://127.0.0.1:16768/cloud-admin.html'

let app: ApiHandle
let url = ''
let adminToken = ''
let devToken = ''
const matrix: Record<string, unknown> = {}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'u46-contract' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  return body.accessToken ?? ''
}

/** Issues a handoff with the raw request body; returns status, headers-free text. */
async function issue(
  token: string,
  projectId: string,
  body?: Record<string, unknown>
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${url}/v1/projects/${projectId}/web-handoff`, {
    method: 'POST',
    headers: auth(token),
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  const text = await res.text()
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> }
}

function errorCode(body: Record<string, unknown>): string {
  return (body as { error?: { code?: string } }).error?.code ?? ''
}

function errorDetails(body: Record<string, unknown>): Record<string, unknown> {
  return (body as { error?: { details?: Record<string, unknown> } }).error?.details ?? {}
}

function entryUrl(body: Record<string, unknown>): URL {
  return new URL(String(body.url))
}

async function announceBrowserEdge(): Promise<void> {
  const res = await fetch(`${url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify({
      id: 'relay-u46',
      host: '127.0.0.1',
      port: 18021,
      browserHost: 'edge.u46.test:8443'
    })
  })
  assert.equal(res.status, 200, await res.text())
}

async function auditEvents(
  query: string
): Promise<
  { eventType: string; actor: string | null; result: string; metadata: Record<string, unknown> }[]
> {
  const res = await fetch(`${url}/v1/audit/events?${query}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: [] }).events
}

before(async () => {
  app = createApp({ port: 0, internalToken: INTERNAL_TOKEN })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')
})

after(async () => {
  saveEvidence(EVIDENCE, 'contract-matrix.json', matrix)
  await app?.close()
})

test('旧控制台（无 surface）：回复字段与 URL 形态逐字节保持 U46 之前', async () => {
  const issued = await issue(devToken, 'proj_payment')
  assert.equal(issued.status, 201, issued.text)
  // Byte-level shape: exactly the two pre-U46 fields, in the pre-U46 order.
  assert.match(
    issued.text,
    /^\{"url":"https:\/\/127\.0\.0\.1:16768\/web-index\.html\?api=https?%3A[^"]+#handoff=[A-Za-z0-9_-]+&project=proj_payment","expiresIn":60\}$/,
    issued.text
  )
  assert.equal(issued.text.includes('"surface"'), false, 'old reply must not gain a field')
  const page = entryUrl(issued.json)
  assert.equal(`${page.origin}${page.pathname}`, DIRECT_ENTRY)
  assert.deepEqual([...page.searchParams.keys()], ['api'])
  assert.equal(page.hash.startsWith('#handoff='), true)
  assert.equal(page.hash.endsWith('&project=proj_payment'), true)

  matrix.oldConsole = { status: issued.status, urlPath: page.pathname, rawShape: 'url,expiresIn' }
})

test('新控制台 surface=web：显式回显 surface，入口仍是 web-index.html', async () => {
  const issued = await issue(devToken, 'proj_payment', { surface: 'web' })
  assert.equal(issued.status, 201, issued.text)
  assert.equal(issued.json.surface, 'web')
  const page = entryUrl(issued.json)
  assert.equal(page.pathname, '/web-index.html')
  assert.equal(page.searchParams.has('embed'), false)
  assert.equal(page.searchParams.has('project'), false)
  assert.equal(page.hash.startsWith('#handoff='), true)

  matrix.newConsoleWeb = {
    status: issued.status,
    surface: issued.json.surface,
    urlPath: page.pathname
  }
})

test('新控制台 surface=admin：同源换页 cloud-admin.html + embed/project 查询与既有 handoff hash', async () => {
  const issued = await issue(devToken, 'proj_payment', { surface: 'admin' })
  assert.equal(issued.status, 201, issued.text)
  assert.equal(issued.json.surface, 'admin')
  const page = entryUrl(issued.json)
  assert.equal(page.pathname, '/cloud-admin.html')
  assert.equal(page.searchParams.get('embed'), '1')
  assert.equal(page.searchParams.get('project'), 'proj_payment')
  assert.ok(page.searchParams.get('api'))
  assert.match(page.hash, /^#handoff=[A-Za-z0-9_-]+&project=proj_payment$/)
  assert.equal(String(issued.json.url).startsWith(`${ADMIN_ENTRY}?`), true)

  matrix.newConsoleAdmin = {
    status: issued.status,
    surface: issued.json.surface,
    urlPath: page.pathname,
    query: Object.fromEntries(page.searchParams)
  }
})

test('中继边缘入口同样只换页面名：/h/<route>/cloud-admin.html，直连回退形态不变', async () => {
  await announceBrowserEdge()
  const web = await issue(devToken, 'proj_payment', { surface: 'web' })
  const admin = await issue(devToken, 'proj_payment', { surface: 'admin' })
  assert.equal(web.status, 201, web.text)
  assert.equal(admin.status, 201, admin.text)
  const webPage = entryUrl(web.json)
  const adminPage = entryUrl(admin.json)
  assert.equal(webPage.origin, 'https://edge.u46.test:8443')
  assert.equal(webPage.pathname, '/h/dev-001/web-index.html')
  assert.equal(adminPage.pathname, '/h/dev-001/cloud-admin.html')
  assert.equal(adminPage.searchParams.get('embed'), '1')
  assert.equal(adminPage.hash, new URL(String(admin.json.url)).hash)

  matrix.relayEdge = {
    webPath: webPage.pathname,
    adminPath: adminPage.pathname,
    sameOrigin: webPage.origin === adminPage.origin
  }
})

test('admin surface 独享 provisioning/failed 前置门禁；旧请求行为不变', async () => {
  const project = app.store.projects.get('proj_payment')
  assert.ok(project)
  const original = { status: project.status, provisioningError: project.provisioningError }

  project.status = 'provisioning'
  const provisioningAdmin = await issue(devToken, 'proj_payment', { surface: 'admin' })
  assert.equal(provisioningAdmin.status, 409, provisioningAdmin.text)
  assert.equal(errorCode(provisioningAdmin.json), 'PROJECT_PROVISIONING')
  assert.equal(errorDetails(provisioningAdmin.json).status, 'provisioning')
  const provisioningOld = await issue(devToken, 'proj_payment')
  assert.equal(provisioningOld.status, 201, 'old console keeps the pre-U46 issuance')

  project.status = 'failed'
  project.provisioningError = 'PROVISION_FAILED'
  const failedAdmin = await issue(devToken, 'proj_payment', { surface: 'admin' })
  assert.equal(failedAdmin.status, 409, failedAdmin.text)
  assert.equal(errorCode(failedAdmin.json), 'PROJECT_NOT_PREPARED')
  assert.deepEqual(errorDetails(failedAdmin.json), {
    status: 'failed',
    provisioningError: 'PROVISION_FAILED'
  })
  const failedOld = await issue(devToken, 'proj_payment')
  assert.equal(failedOld.status, 201, 'old console never sees the new refusals')

  project.status = original.status
  if (original.provisioningError === undefined) {
    delete project.provisioningError
  } else {
    project.provisioningError = original.provisioningError
  }

  matrix.statusGates = {
    adminProvisioning: {
      status: provisioningAdmin.status,
      code: errorCode(provisioningAdmin.json)
    },
    adminFailed: { status: failedAdmin.status, code: errorCode(failedAdmin.json) },
    oldProvisioningStatus: provisioningOld.status,
    oldFailedStatus: failedOld.status
  }
})

test('审计 web_handoff 区分 surface：admin 与 web 各留痕', async () => {
  const success = await auditEvents('eventType=web_handoff&result=success&limit=200')
  assert.ok(
    success.some((event) => event.metadata?.surface === 'admin'),
    'embedded admin entry must audit surface=admin'
  )
  assert.ok(
    success.some((event) => event.metadata?.surface === 'web'),
    'orca web entry must audit surface=web'
  )

  matrix.audit = {
    adminEvents: success.filter((event) => event.metadata?.surface === 'admin').length,
    webEvents: success.filter((event) => event.metadata?.surface === 'web').length
  }
})

test('createdBy：admin/auditor 下发（null 允许），developer payload 无此字段', async () => {
  // Seed projects predate creator tracking: admin sees the key with null.
  const adminSingle = await fetch(`${url}/v1/projects/proj_payment`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(adminSingle.status, 200)
  const adminProject = (await adminSingle.json()) as Record<string, unknown>
  assert.equal('createdBy' in adminProject, true)
  assert.equal(adminProject.createdBy, null)

  const created = await fetch(`${url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key: 'u46-created',
      name: 'U46 created',
      hostId: 'host_dev001',
      path: '/srv/work/u46-created'
    })
  })
  const createdBody = await created.text()
  assert.equal(created.status, 201, createdBody)
  const createdProject = JSON.parse(createdBody) as Record<string, unknown>
  assert.equal(createdProject.createdBy, 'admin', 'a new project records its creator')

  // Developer: neither the single-project read nor the list carries the field.
  const devSingle = await fetch(`${url}/v1/projects/proj_payment`, {
    headers: { authorization: `Bearer ${devToken}` }
  })
  assert.equal(devSingle.status, 200)
  const devProject = (await devSingle.json()) as Record<string, unknown>
  assert.equal('createdBy' in devProject, false, 'developer payload must stay unchanged')
  const devList = await fetch(`${url}/v1/projects`, {
    headers: { authorization: `Bearer ${devToken}` }
  })
  const devProjects = ((await devList.json()) as { projects: Record<string, unknown>[] }).projects
  assert.equal(
    devProjects.every((project) => !('createdBy' in project)),
    true
  )

  // Auditor sees the same field admin does (no admin role required).
  const dev = [...app.store.users.values()].find((user) => user.username === 'zhangsan')
  assert.ok(dev)
  const roles = [...dev.roles]
  dev.roles.push('platform:auditor')
  try {
    const auditorSingle = await fetch(`${url}/v1/projects/proj_payment`, {
      headers: { authorization: `Bearer ${devToken}` }
    })
    assert.equal(auditorSingle.status, 200)
    const auditorProject = (await auditorSingle.json()) as Record<string, unknown>
    assert.equal('createdBy' in auditorProject, true)
    assert.equal(auditorProject.createdBy, null)
  } finally {
    dev.roles.length = 0
    dev.roles.push(...roles)
  }

  matrix.createdBy = {
    admin: { present: true, value: adminProject.createdBy },
    adminCreated: createdProject.createdBy,
    developer: { present: false },
    auditor: { present: true }
  }
})
