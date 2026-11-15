import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * W120 U18/U19: the platform no longer trusts the admin console's client-side
 * pre-validation. POST /v1/projects and POST /v1/projects/self enforce the same
 * contract server-side — project key grammar (U18), name bounds (U18) and a live
 * target host (U19, FR-3.2). The offline window is shortened so a host can be
 * walked from online to offline inside the test; every must-succeed call beats
 * first, so no case depends on how fast the file runs.
 */

const EVIDENCE = 'w120-fix-u18u19'
const OFFLINE_WINDOW_MS = 400

type Reply = { status: number; body: Record<string, unknown> }

let api: Service
let adminToken = ''
let devToken = ''
let onlineHost = { id: '', credential: '' }
let idleHost = { id: '', credential: '' }
const observations: Record<string, unknown> = {}

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'w120-reg-validation' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  return body.accessToken!
}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

/** U65/U67: self-service creation needs the host provision bit. */
async function grantProvision(hostId: string): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'developers',
      permissions: ['provision']
    })
  })
  assert.equal(res.status, 200, await res.text())
}

async function beat(host: { id: string; credential: string }): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${host.id}/heartbeat`, {
    method: 'POST',
    headers: auth(host.credential),
    body: JSON.stringify({ status: 'online' })
  })
  assert.equal(res.status, 200, 'heartbeat before a must-succeed registration')
}

async function adminCreate(
  body: Record<string, unknown>,
  options: { beatFirst?: boolean } = {}
): Promise<Reply> {
  if (options.beatFirst !== false) await beat(onlineHost)
  const res = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function selfCreate(
  body: Record<string, unknown>,
  options: { beatFirst?: boolean } = {}
): Promise<Reply> {
  if (options.beatFirst !== false) await beat(onlineHost)
  const res = await fetch(`${api.url}/v1/projects/self`, {
    method: 'POST',
    headers: auth(devToken),
    body: JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function errorOf(reply: Reply): { code: string; message: string } {
  const error = (reply.body as { error?: { code?: string; message?: string } }).error
  return { code: error?.code ?? '', message: error?.message ?? '' }
}

async function expectRejected(
  label: string,
  reply: Promise<Reply>,
  status: number,
  code: string
): Promise<void> {
  const got = await reply
  const error = errorOf(got)
  assert.equal(got.status, status, `${label}: ${JSON.stringify(got.body)}`)
  assert.equal(error.code, code, label)
  observations[label] = { status: got.status, error }
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_CLOUD_HOST_OFFLINE_MS: String(OFFLINE_WINDOW_MS) },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-registration-validation'
  )
  adminToken = await login('admin', 'Adm1n!')
  devToken = await login('zhangsan', 'Passw0rd!')
  const online = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-regval-online',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/regval-online'
  })
  onlineHost = { id: online.hostId, credential: online.credential }
  await grantProvision(online.hostId)
  const idle = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-regval-idle',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/regval-idle'
  })
  idleHost = { id: idle.hostId, credential: idle.credential }
  await grantProvision(idle.hostId)
  // The idle host never beats again: past the window it is offline for good.
  await new Promise((resolve) => setTimeout(resolve, OFFLINE_WINDOW_MS + 300))
  await beat(onlineHost)
})

after(async () => {
  await api?.stop()
  saveEvidence(EVIDENCE, 'registration-validation.json', {
    offlineWindowMs: OFFLINE_WINDOW_MS,
    observations
  })
})

describe('W120 U18/U19 平台登记输入校验（真实平台进程）', () => {
  test('U18 管理员创建：非法 key 一律 400 PROJECT_KEY_INVALID，不再只查重', async () => {
    const illegalKeys = [
      'Bad-Key',
      'has space',
      'x'.repeat(65),
      'trailing.',
      '.hidden',
      '..',
      '',
      123
    ]
    for (const [index, key] of illegalKeys.entries()) {
      await expectRejected(
        `admin-illegal-key-${index}`,
        adminCreate({
          key,
          name: `Reg Val Bad Key ${index}`,
          hostId: onlineHost.id,
          path: `/srv/work/regval-bad-key-${index}`
        }),
        400,
        'PROJECT_KEY_INVALID'
      )
    }
    // 缺 key 与空串同罪：语法校验在查重之前。
    await expectRejected(
      'admin-missing-key',
      adminCreate({ name: 'No Key', hostId: onlineHost.id, path: '/srv/work/regval-no-key' }),
      400,
      'PROJECT_KEY_INVALID'
    )
  })

  test('U18 管理员创建：非法 name 400 PROJECT_NAME_INVALID，缺省回落 key', async () => {
    for (const [index, name] of ['', '   ', 'x'.repeat(201)].entries()) {
      await expectRejected(
        `admin-illegal-name-${index}`,
        adminCreate({
          key: `regval-bad-name-${index}`,
          name,
          hostId: onlineHost.id,
          path: `/srv/work/regval-bad-name-${index}`
        }),
        400,
        'PROJECT_NAME_INVALID'
      )
    }
    // 既有行为保留：未提供 name 时以 key 作为展示名。
    const omitted = await adminCreate({
      key: 'regval-name-fallback',
      hostId: onlineHost.id,
      path: '/srv/work/regval-name-fallback'
    })
    assert.equal(omitted.status, 201, JSON.stringify(omitted.body))
    assert.equal((omitted.body as { name: string }).name, 'regval-name-fallback')
    observations['admin-name-fallback'] = { status: 201, name: 'regval-name-fallback' }
  })

  test('U18 自助创建：key 语法与 name 边界同规则 400', async () => {
    const illegalKeys = ['Bad-Key', 'x'.repeat(65), 'trailing.', 'has space']
    for (const [index, key] of illegalKeys.entries()) {
      await expectRejected(
        `self-illegal-key-${index}`,
        selfCreate({
          name: `Self Bad Key ${index}`,
          dir: `self-bad-key-${index}`,
          key,
          repoUrl: 'https://git.example.com/pay/self-bad-key.git'
        }),
        400,
        'PROJECT_KEY_INVALID'
      )
    }
    for (const [index, name] of ['', '   ', 'x'.repeat(201)].entries()) {
      await expectRejected(
        `self-illegal-name-${index}`,
        selfCreate({
          name,
          dir: `self-bad-name-${index}`,
          repoUrl: 'https://git.example.com/pay/self-bad-name.git'
        }),
        400,
        'PROJECT_NAME_INVALID'
      )
    }
  })

  test('U19 管理员创建：离线主机 409 HOST_OFFLINE，未知主机 400 HOST_NOT_FOUND', async () => {
    await expectRejected(
      'admin-offline-host',
      adminCreate(
        {
          key: 'regval-offline-host',
          name: 'Offline Host',
          hostId: idleHost.id,
          path: '/srv/work/regval-offline-host'
        },
        { beatFirst: false }
      ),
      409,
      'HOST_OFFLINE'
    )
    await expectRejected(
      'admin-unknown-host',
      adminCreate({
        key: 'regval-unknown-host',
        name: 'Unknown Host',
        hostId: 'host_missing_regval',
        path: '/srv/work/regval-unknown-host'
      }),
      400,
      'HOST_NOT_FOUND'
    )
  })

  test('U19 自助创建：显式指定离线/未知主机同样拒绝', async () => {
    await expectRejected(
      'self-offline-host',
      selfCreate(
        {
          name: 'Self Offline Host',
          dir: 'self-offline-host',
          repoUrl: 'https://git.example.com/pay/self-offline-host.git',
          hostId: idleHost.id
        },
        { beatFirst: false }
      ),
      409,
      'HOST_OFFLINE'
    )
    await expectRejected(
      'self-unknown-host',
      selfCreate({
        name: 'Self Unknown Host',
        dir: 'self-unknown-host',
        repoUrl: 'https://git.example.com/pay/self-unknown-host.git',
        hostId: 'host_missing_regval'
      }),
      400,
      'HOST_NOT_FOUND'
    )
  })

  test('合法输入两条路径仍 201（零回归）', async () => {
    const admin = await adminCreate({
      key: 'regval-ok-admin',
      name: 'Registration Validation OK',
      hostId: onlineHost.id,
      path: '/srv/work/regval-ok-admin',
      defaultBranch: 'main'
    })
    assert.equal(admin.status, 201, JSON.stringify(admin.body))
    const adminView = admin.body as { key: string; name: string; hostId: string }
    assert.equal(adminView.key, 'regval-ok-admin')
    assert.equal(adminView.name, 'Registration Validation OK')
    assert.equal(adminView.hostId, onlineHost.id)

    const self = await selfCreate({
      name: 'Registration Validation Self',
      dir: 'regval-ok-self',
      repoUrl: 'https://git.example.com/pay/regval-ok-self.git',
      hostId: onlineHost.id
    })
    assert.equal(self.status, 201, JSON.stringify(self.body))
    const selfView = self.body as { path: string; hostId: string }
    assert.equal(selfView.path, '/srv/regval-online/regval-ok-self')
    assert.equal(selfView.hostId, onlineHost.id)
    observations['happy-path'] = { admin: 201, self: 201 }
  })
})
