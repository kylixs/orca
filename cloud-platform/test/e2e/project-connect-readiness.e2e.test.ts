import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * W120 U20: `POST /v1/projects/:id/connect` used to ignore `project.status`, so
 * a `failed` or still-`provisioning` project got a credential and the failure
 * only surfaced at the host's provision RPC. The host's provision reports are
 * trustworthy since W12b-2, so the platform now refuses both states up front.
 * The admin fast path (a registered checkout is ready at creation) and the
 * archived 404 stay untouched.
 */

const EVIDENCE = 'w120-fix-u20'
const REPO_URL = 'https://git.example.com/pay/u20-clone-fail.git'
const DEVICE_PUB_KEY = Buffer.from('u20-device-key').toString('base64')

type Reply = { status: number; body: Record<string, unknown> }
type LoginBody = { accessToken?: string; device?: { id: string } }
type AuditEvent = {
  eventType: string
  targetId: string | null
  result: string
  metadata?: Record<string, unknown>
}

let api: Service
let adminToken = ''
let dev: LoginBody = {}
let host = { id: '', credential: '' }
const observations: Record<string, unknown> = {}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function beat(body: Record<string, unknown> = { status: 'online' }): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${host.id}/heartbeat`, {
    method: 'POST',
    headers: auth(host.credential),
    body: JSON.stringify(body)
  })
  assert.equal(res.status, 200, 'heartbeat must succeed while the host is live')
}

async function adminCreate(key: string, repoUrl?: string): Promise<Reply> {
  const res = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key,
      name: `U20 ${key}`,
      hostId: host.id,
      path: `/srv/work/${key}`,
      ...(repoUrl ? { repoUrl } : {})
    })
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function projectStatus(projectId: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}`, { headers: auth(devToken()) })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { status: string; provisioningError?: string }
  return body.provisioningError ? `${body.status}:${body.provisioningError}` : body.status
}

function devToken(): string {
  return dev.accessToken ?? ''
}

async function connect(projectId: string): Promise<Reply> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: auth(devToken()),
    body: JSON.stringify({
      deviceId: dev.device?.id,
      devicePubKey: DEVICE_PUB_KEY,
      clientVersion: '1.5.0'
    })
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function errorOf(reply: Reply): {
  code: string
  message: string
  details: Record<string, unknown>
} {
  const err = (reply.body as { error?: { code?: string; message?: string; details?: unknown } })
    .error
  return {
    code: err?.code ?? '',
    message: err?.message ?? '',
    details: (err?.details as Record<string, unknown>) ?? {}
  }
}

async function grantToDev(projectId: string): Promise<void> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  assert.equal(res.status, 200)
}

async function deniedConnectAudits(projectId: string): Promise<AuditEvent[]> {
  const res = await fetch(`${api.url}/v1/audit/events?result=denied&limit=200`, {
    headers: auth(adminToken)
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { events: AuditEvent[] }
  return body.events.filter(
    (e) => e.eventType === 'project_connect' && e.targetId === projectId
  )
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-connect-readiness'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey: DEVICE_PUB_KEY,
      deviceName: 'u20-dev'
    })
  })
  dev = (await res.json()) as LoginBody
  assert.ok(dev.accessToken && dev.device?.id, 'developer login must yield token and device')
  const registered = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u20-ready-host',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/u20'
  })
  host = { id: registered.hostId, credential: registered.credential }
  await beat()
})

after(async () => {
  await api?.stop()
  saveEvidence(EVIDENCE, 'connect-readiness.json', { observations })
})

describe('W120 U20 connect 按项目就绪状态门禁（真实平台进程）', () => {
  test('failed 项目：409 PROJECT_NOT_PREPARED + provisioningError + denied 审计', async () => {
    const created = await adminCreate('u20-failed', REPO_URL)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal((created.body as { status: string }).status, 'provisioning')
    const projectId = (created.body as { id: string }).id
    await grantToDev(projectId)

    // The host reports the clone failure over its heartbeat, as in production.
    await beat({
      status: 'online',
      provisioned: [{ projectId, ok: false, error: 'git clone failed: authentication required' }]
    })
    const status = await projectStatus(projectId)
    assert.match(status, /^failed:git clone failed/, JSON.stringify({ projectId, status }))

    const reply = await connect(projectId)
    const err = errorOf(reply)
    assert.equal(reply.status, 409, JSON.stringify(reply.body))
    assert.equal(err.code, 'PROJECT_NOT_PREPARED')
    assert.match(err.message, /准备失败/)
    assert.equal(err.details.status, 'failed')
    assert.equal(err.details.provisioningError, 'git clone failed: authentication required')

    const audits = await deniedConnectAudits(projectId)
    assert.equal(audits.length, 1, 'exactly one denied connect audit')
    assert.equal(audits[0]?.metadata?.reason, 'PROJECT_NOT_PREPARED')
    assert.equal(audits[0]?.metadata?.error, 'git clone failed: authentication required')
    observations['failed-connect'] = { status: reply.status, error: err, audits }
  })

  test('provisioning 项目：409 PROJECT_PROVISIONING，提示稍后重试', async () => {
    const created = await adminCreate('u20-provisioning', REPO_URL)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const projectId = (created.body as { id: string }).id
    await grantToDev(projectId)
    assert.equal(await projectStatus(projectId), 'provisioning')

    const reply = await connect(projectId)
    const err = errorOf(reply)
    assert.equal(reply.status, 409, JSON.stringify(reply.body))
    assert.equal(err.code, 'PROJECT_PROVISIONING')
    assert.match(err.message, /稍后重试/)
    assert.equal(err.details.status, 'provisioning')
    observations['provisioning-connect'] = { status: reply.status, error: err }
  })

  test('ready 项目：管理员快路径 200 发票照旧', async () => {
    const created = await adminCreate('u20-ready')
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal((created.body as { status: string }).status, 'ready')
    const projectId = (created.body as { id: string }).id
    await grantToDev(projectId)

    const reply = await connect(projectId)
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.ok(typeof (reply.body as { credential?: string }).credential === 'string')
    observations['ready-connect'] = { status: reply.status, credentialIssued: true }
  })

  test('归档项目：connect 仍 404，语义零变化', async () => {
    const created = await adminCreate('u20-archived')
    assert.equal(created.status, 201)
    const projectId = (created.body as { id: string }).id
    await grantToDev(projectId)
    const archive = await fetch(`${api.url}/v1/projects/${projectId}/archive`, {
      method: 'POST',
      headers: auth(adminToken)
    })
    assert.equal(archive.status, 200)

    const reply = await connect(projectId)
    assert.equal(reply.status, 404, JSON.stringify(reply.body))
    assert.equal(errorOf(reply).code, 'PROJECT_NOT_FOUND')
    observations['archived-connect'] = { status: reply.status, code: errorOf(reply).code }
  })
})
