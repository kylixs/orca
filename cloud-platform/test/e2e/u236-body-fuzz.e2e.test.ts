import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U236 follow-up: every `readJson(req)` call site in apps/api/src/server.ts is
 * probed with the six non-object JSON shapes. `null`/scalars are normalised to
 * `{}` and arrays pass through, so no route may answer 5xx. Each endpoint is
 * reached with real prerequisites (login, project, registered host credential)
 * — none of the cases below is skipped.
 */

const BODY_FORMS: readonly (readonly [label: string, raw: string])[] = [
  ['null', 'null'],
  ['number', '42'],
  ['string', '"x"'],
  ['array', '[]'],
  ['boolean', 'true'],
  ['empty-object', '{}']
]

const INTERNAL_TOKEN = 'u236-body-fuzz'
const NEW_COOKIE_ORIGIN = 'http://127.0.0.1:4711'

type ProbeResult = {
  endpoint: string
  form: string
  status: number
  code: string
  json: boolean
}

const results: ProbeResult[] = []
const apps: ApiHandle[] = []

let base = ''
let adminToken = ''
let developerToken = ''
let heartbeatHostId = ''
let heartbeatCredential = ''
let maintenanceHostId = ''
let registerToken = ''

function call(
  origin: string,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const all: Record<string, string> = { ...headers }
  if (body !== undefined) {
    all['content-type'] = 'application/json'
  }
  return fetch(`${origin}${path}`, {
    method,
    headers: all,
    ...(body === undefined ? {} : { body })
  })
}

async function login(origin: string, username: string, password: string): Promise<string> {
  const res = await call(origin, 'POST', '/v1/auth/login', JSON.stringify({
    username,
    password,
    deviceName: 'u236-body-fuzz'
  }))
  assert.equal(res.status, 200, `login failed for ${username}`)
  const body = (await res.json()) as { accessToken?: string }
  assert.ok(body.accessToken)
  return body.accessToken
}

async function registerHost(name: string): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await call(
    base,
    'POST',
    '/v1/hosts/tokens',
    '{}',
    { authorization: `Bearer ${adminToken}` }
  )
  assert.equal(tokenRes.status, 201)
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await call(base, 'POST', '/v1/hosts/register', JSON.stringify({ name }), {
    authorization: `Bearer ${token}`
  })
  assert.equal(res.status, 201)
  const body = (await res.json()) as { hostId: string; credential: string }
  assert.ok(body.hostId && body.credential)
  return body
}

async function probe(
  endpoint: string,
  form: string,
  method: string,
  path: string,
  raw: string,
  headers: Record<string, string>
): Promise<ProbeResult> {
  const res = await call(base, method, path, raw, headers)
  const text = await res.text()
  let json = false
  let code = ''
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string } }
    json = true
    code = parsed.error?.code ?? ''
  } catch {
    json = false
  }
  const result: ProbeResult = { endpoint, form, status: res.status, code, json }
  results.push(result)
  return result
}

type Endpoint = {
  name: string
  method: string
  path: () => string
  headers: () => Record<string, string>
}

const bearer = (token: () => string): Record<string, string> => ({
  authorization: `Bearer ${token()}`
})

const endpoints: Endpoint[] = [
  {
    name: 'POST /v1/auth/login (server.ts:3473)',
    method: 'POST',
    path: () => '/v1/auth/login',
    headers: () => ({})
  },
  {
    name: 'POST /v1/auth/refresh body fallback (server.ts:3761)',
    method: 'POST',
    path: () => '/v1/auth/refresh',
    headers: () => ({})
  },
  {
    name: 'POST /v1/web/handoff (server.ts:3858)',
    method: 'POST',
    path: () => '/v1/web/handoff',
    headers: () => ({})
  },
  {
    name: 'POST /v1/projects admin (server.ts:4300)',
    method: 'POST',
    path: () => '/v1/projects',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'POST /v1/projects/self (server.ts:4437)',
    method: 'POST',
    path: () => '/v1/projects/self',
    headers: () => bearer(() => developerToken)
  },
  {
    name: 'POST /v1/projects/proj_payment/connect (server.ts:6758)',
    method: 'POST',
    path: () => '/v1/projects/proj_payment/connect',
    headers: () => bearer(() => developerToken)
  },
  {
    name: 'POST /v1/projects/proj_payment/web-handoff (server.ts:6640)',
    method: 'POST',
    path: () => '/v1/projects/proj_payment/web-handoff',
    headers: () => bearer(() => developerToken)
  },
  {
    name: 'PUT /v1/projects/proj_payment/grants admin path (server.ts:4738)',
    method: 'PUT',
    path: () => '/v1/projects/proj_payment/grants',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'PUT /v1/projects/proj_payment/grants deny path (server.ts:4728)',
    method: 'PUT',
    path: () => '/v1/projects/proj_payment/grants',
    headers: () => bearer(() => developerToken)
  },
  {
    name: 'PUT /v1/projects/proj_payment/policy (server.ts:4936)',
    method: 'PUT',
    path: () => '/v1/projects/proj_payment/policy',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'PUT /v1/projects/proj_payment (server.ts:4636)',
    method: 'PUT',
    path: () => '/v1/projects/proj_payment',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'PUT /v1/users/u236-nobody/roles (server.ts:5107)',
    method: 'PUT',
    path: () => '/v1/users/u236-nobody/roles',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'POST /v1/hosts/tokens (server.ts:5293)',
    method: 'POST',
    path: () => '/v1/hosts/tokens',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'POST /v1/hosts/register (server.ts:5333)',
    method: 'POST',
    path: () => '/v1/hosts/register',
    headers: () => bearer(() => registerToken)
  },
  {
    name: 'POST /v1/hosts/:id/heartbeat (server.ts:5445)',
    method: 'POST',
    path: () => `/v1/hosts/${heartbeatHostId}/heartbeat`,
    headers: () => bearer(() => heartbeatCredential)
  },
  {
    name: 'POST /v1/hosts/:id/maintenance (server.ts:5647)',
    method: 'POST',
    path: () => `/v1/hosts/${maintenanceHostId}/maintenance`,
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'PUT /v1/hosts/:id/grants admin path (server.ts:5731)',
    method: 'PUT',
    path: () => `/v1/hosts/${heartbeatHostId}/grants`,
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'PUT /v1/hosts/:id/grants deny path (server.ts:5718)',
    method: 'PUT',
    path: () => `/v1/hosts/${heartbeatHostId}/grants`,
    headers: () => bearer(() => developerToken)
  },
  {
    name: 'PUT /v1/hosts/:id/provision-policy admin path (server.ts:5862)',
    method: 'PUT',
    path: () => `/v1/hosts/${heartbeatHostId}/provision-policy`,
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'PUT /v1/hosts/:id/provision-policy deny path (server.ts:5849)',
    method: 'PUT',
    path: () => `/v1/hosts/${heartbeatHostId}/provision-policy`,
    headers: () => bearer(() => developerToken)
  },
  {
    name: 'POST /v1/internal/audit/file-events (server.ts:5932)',
    method: 'POST',
    path: () => '/v1/internal/audit/file-events',
    headers: () => ({ 'x-internal-token': INTERNAL_TOKEN })
  },
  {
    name: 'POST /v1/audit/export (server.ts:6004)',
    method: 'POST',
    path: () => '/v1/audit/export',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'PUT /v1/policies/download (server.ts:6418)',
    method: 'PUT',
    path: () => '/v1/policies/download',
    headers: () => bearer(() => adminToken)
  },
  {
    name: 'POST /v1/internal/relay-endpoint (server.ts:6521)',
    method: 'POST',
    path: () => '/v1/internal/relay-endpoint',
    headers: () => ({ 'x-internal-token': INTERNAL_TOKEN })
  }
]

function assertMatrix(endpoint: string, rows: ProbeResult[]): void {
  const failures = rows.map((row) => {
    if (row.status >= 500) {
      return `${row.form}: HTTP ${row.status} (${row.code || 'no code'})`
    }
    if (!row.json) {
      return `${row.form}: non-JSON response`
    }
    return null
  })
  const present = failures.filter((failure): failure is string => failure !== null)
  assert.deepEqual(present, [], `${endpoint} must never answer 5xx/non-JSON for non-object bodies`)
}

describe('U236 非对象 body 全端点模糊验证（真实 createApp + HTTP）', () => {
  before(async () => {
    const app = createApp({
      port: 0,
      internalToken: INTERNAL_TOKEN,
      cookieMode: 'never',
      // Empty string pins "unconfigured" even if the developer shell exports one.
      publicOrigin: ''
    })
    apps.push(app)
    base = `http://127.0.0.1:${await app.listen()}`

    adminToken = await login(base, 'admin', 'Adm1n!')
    developerToken = await login(base, 'zhangsan', 'Passw0rd!')

    const heartbeatHost = await registerHost('u236-fuzz-heartbeat')
    heartbeatHostId = heartbeatHost.hostId
    heartbeatCredential = heartbeatHost.credential

    const maintenanceHost = await registerHost('u236-fuzz-maintenance')
    maintenanceHostId = maintenanceHost.hostId

    // A fresh single-use token: nameless bodies are refused before it is spent.
    const tokenRes = await call(base, 'POST', '/v1/hosts/tokens', '{}', bearer(() => adminToken))
    assert.equal(tokenRes.status, 201)
    registerToken = ((await tokenRes.json()) as { token: string }).token
  })

  for (const endpoint of endpoints) {
    test(endpoint.name, async () => {
      const rows: ProbeResult[] = []
      for (const [form, raw] of BODY_FORMS) {
        rows.push(
          await probe(endpoint.name, form, endpoint.method, endpoint.path(), raw, endpoint.headers())
        )
      }
      assertMatrix(endpoint.name, rows)
    })
  }

  test('POST /v1/auth/refresh cookie branch (server.ts:3618)', async () => {
    const app = createApp({
      port: 0,
      internalToken: INTERNAL_TOKEN,
      cookieMode: 'always',
      publicOrigin: NEW_COOKIE_ORIGIN
    })
    apps.push(app)
    const cookieBase = `http://127.0.0.1:${await app.listen()}`

    const loginRes = await call(
      cookieBase,
      'POST',
      '/v1/auth/login',
      JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u236-fuzz-cookie' }),
      { origin: NEW_COOKIE_ORIGIN }
    )
    assert.equal(loginRes.status, 200)
    const setCookie = loginRes.headers.get('set-cookie') ?? ''
    const match = /orca_refresh=([^;]+)/.exec(setCookie)
    assert.ok(match, 'login must issue the refresh cookie')

    const rows: ProbeResult[] = []
    for (const [form, raw] of BODY_FORMS) {
      const res = await call(cookieBase, 'POST', '/v1/auth/refresh', raw, {
        origin: NEW_COOKIE_ORIGIN,
        cookie: `orca_refresh=${match[1]}`
      })
      const text = await res.text()
      let json = false
      let code = ''
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string } }
        json = true
        code = parsed.error?.code ?? ''
      } catch {
        json = false
      }
      rows.push({ endpoint: 'cookie refresh', form, status: res.status, code, json })
      const last = rows.at(-1)
      if (last) {
        results.push(last)
      }
    }
    assertMatrix('POST /v1/auth/refresh cookie branch', rows)
  })

  test('汇总矩阵（endpoint × body shape → status）', () => {
    const header = ['endpoint', ...BODY_FORMS.map(([form]) => form)]
    const byEndpoint = new Map<string, Map<string, ProbeResult>>()
    for (const row of results) {
      const inner = byEndpoint.get(row.endpoint) ?? new Map<string, ProbeResult>()
      inner.set(row.form, row)
      byEndpoint.set(row.endpoint, inner)
    }
    const lines = [header.join('\t')]
    for (const [endpoint, inner] of byEndpoint) {
      lines.push(
        [
          endpoint,
          ...BODY_FORMS.map(([form]) => {
            const row = inner.get(form)
            return row ? String(row.status) : 'MISSING'
          })
        ].join('\t')
      )
    }
    // eslint-disable-next-line no-console -- test evidence
    console.log(`\nU236 body-fuzz matrix\n${lines.join('\n')}\n`)

    const bad = results.filter((row) => row.status >= 500 || !row.json)
    assert.deepEqual(bad, [], 'no 5xx or non-JSON response anywhere in the matrix')
  })
})

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})
