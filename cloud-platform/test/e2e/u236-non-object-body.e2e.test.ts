import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U236: `JSON.parse` can return `null` or a scalar, and every route that reads a
 * field off the parsed body used to throw a TypeError (500). A non-object body
 * is now normalized to `{}` at the read boundary, so each endpoint answers with
 * its own "empty body" verdict instead. Arrays stay as parsed.
 */

const NON_OBJECT_BODIES = ['null', '42', '"x"', '[]'] as const

const apps: ApiHandle[] = []
let base = ''

async function start(): Promise<void> {
  const app = createApp({
    port: 0,
    internalToken: 'u236',
    cookieMode: 'never',
    // Empty string pins "unconfigured" even if the developer shell exports one.
    publicOrigin: ''
  })
  apps.push(app)
  base = `http://127.0.0.1:${await app.listen()}`
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

function call(method: string, path: string, body?: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  return fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body })
  })
}

async function login(username: string, password: string): Promise<string> {
  const res = await call(
    'POST',
    '/v1/auth/login',
    JSON.stringify({ username, password, deviceName: 'u236' })
  )
  assert.equal(res.status, 200, `login failed for ${username}`)
  const body = (await res.json()) as { accessToken?: string }
  assert.ok(body.accessToken)
  return body.accessToken
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

let adminToken = ''
let developerToken = ''

describe('U236 非对象 body 归一为空 body（真实 createApp + HTTP）', () => {
  before(async () => {
    await start()
    adminToken = await login('admin', 'Adm1n!')
    developerToken = await login('zhangsan', 'Passw0rd!')
  })

  test('login：null / 标量 / 数组均 401 INVALID_CREDENTIALS', async () => {
    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('POST', '/v1/auth/login', raw)
      assert.equal(res.status, 401, `body=${raw}`)
      assert.equal(await errorCode(res), 'INVALID_CREDENTIALS', `body=${raw}`)
    }
  })

  test('项目创建：400 HOST_NOT_FOUND', async () => {
    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('POST', '/v1/projects', raw, adminToken)
      assert.equal(res.status, 400, `body=${raw}`)
      assert.equal(await errorCode(res), 'HOST_NOT_FOUND', `body=${raw}`)
    }
  })

  test('项目授权（管理员路径）：400 GRANT_PERMISSION_INVALID', async () => {
    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('PUT', '/v1/projects/proj_payment/grants', raw, adminToken)
      assert.equal(res.status, 400, `body=${raw}`)
      assert.equal(await errorCode(res), 'GRANT_PERMISSION_INVALID', `body=${raw}`)
    }
  })

  test('项目授权（拒绝路径）：非法 subject 元数据读取不抛 500，仍 403', async () => {
    // The denial path builds its audit metadata from the body before anything
    // else; a null body used to throw here instead of returning 403.
    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('PUT', '/v1/projects/proj_payment/grants', raw, developerToken)
      assert.equal(res.status, 403, `body=${raw}`)
      assert.equal(await errorCode(res), 'PERMISSION_DENIED', `body=${raw}`)
    }
  })

  test('角色修改：400 ROLE_INVALID；有效对象回归 200', async () => {
    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('PUT', '/v1/users/u236-nobody/roles', raw, adminToken)
      assert.equal(res.status, 400, `body=${raw}`)
      assert.equal(await errorCode(res), 'ROLE_INVALID', `body=${raw}`)
    }

    const developerId = apps[0]?.store.usersByName.get('zhangsan')?.id
    assert.ok(developerId)
    const valid = await call(
      'PUT',
      `/v1/users/${developerId}/roles`,
      JSON.stringify({ role: 'developer' }),
      adminToken
    )
    assert.equal(valid.status, 200)
  })

  test('主机注册：400 HOST_NAME_REQUIRED；有效对象回归 201', async () => {
    const tokenRes = await call('POST', '/v1/hosts/tokens', undefined, adminToken)
    assert.equal(tokenRes.status, 201)
    const { token } = (await tokenRes.json()) as { token: string }

    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('POST', '/v1/hosts/register', raw, token)
      assert.equal(res.status, 400, `body=${raw}`)
      assert.equal(await errorCode(res), 'HOST_NAME_REQUIRED', `body=${raw}`)
    }

    const valid = await call(
      'POST',
      '/v1/hosts/register',
      JSON.stringify({ name: 'u236-registered-host' }),
      token
    )
    assert.equal(valid.status, 201)
  })

  test('审计导出：400 EXPORT_CONFIRM_REQUIRED；有效对象走到字段校验', async () => {
    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('POST', '/v1/audit/export', raw, adminToken)
      assert.equal(res.status, 400, `body=${raw}`)
      assert.equal(await errorCode(res), 'EXPORT_CONFIRM_REQUIRED', `body=${raw}`)
    }

    const valid = await call(
      'POST',
      '/v1/audit/export',
      JSON.stringify({ confirm: true, format: 'bogus' }),
      adminToken
    )
    assert.equal(valid.status, 400)
    assert.equal(await errorCode(valid), 'INVALID_QUERY')
  })

  test('connect：426 VERSION_UNSUPPORTED；有效对象回归 401 DEVICE_NOT_REGISTERED', async () => {
    // zhangsan holds the seeded team-payment grant, so the route reaches the
    // body-derived version gate instead of stopping at 403.
    for (const raw of NON_OBJECT_BODIES) {
      const res = await call('POST', '/v1/projects/proj_payment/connect', raw, developerToken)
      assert.equal(res.status, 426, `body=${raw}`)
      assert.equal(await errorCode(res), 'VERSION_UNSUPPORTED', `body=${raw}`)
    }

    const valid = await call(
      'POST',
      '/v1/projects/proj_payment/connect',
      JSON.stringify({ clientVersion: '1.5.0' }),
      developerToken
    )
    assert.equal(valid.status, 401)
    assert.equal(await errorCode(valid), 'DEVICE_NOT_REGISTERED')
  })

  test('有效对象回归：项目创建 201，授权 200', async () => {
    const created = await call(
      'POST',
      '/v1/projects',
      JSON.stringify({
        hostId: 'host_dev001',
        key: 'u236-project',
        name: 'u236-project',
        path: '/srv/work/u236-project'
      }),
      adminToken
    )
    assert.equal(created.status, 201)

    const granted = await call(
      'PUT',
      '/v1/projects/proj_payment/grants',
      JSON.stringify({ subjectType: 'user', subjectId: 'zhangsan', permissions: ['open'] }),
      adminToken
    )
    assert.equal(granted.status, 200)
  })
})
