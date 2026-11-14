import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * FR-3.10 (M122, W7a): the platform mints a one-time, 60-second handoff code and
 * points the browser at the host's web-index entry; the code is traded once for
 * a real session. No access token ever travels in a URL, and every direction of
 * the exchange is audited with a code fingerprint, never the code itself.
 */

const EVIDENCE = 'w7a-handoff-api'
/** Short enough to expire while the test waits, long enough to redeem across the happy path. */
const SHORT_TTL_MS = 150

let api: Service
let shortTtl: Service
let adminToken = ''
let devToken = ''
let shortTtlDevToken = ''
let noDirectHostId = ''
/** Every code the suite mints, so the audit test can prove none of them is logged. */
const issuedCodes: string[] = []

type HandoffIssue = { status: number; url: string; expiresIn: number; code?: string }

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? ''
}

function errorReason(body: unknown): string {
  return (body as { error?: { details?: { reason?: string } } }).error?.details?.reason ?? ''
}

async function login(
  service: Service,
  username: string,
  password: string
): Promise<{ token: string; deviceId: string }> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'w7a-handoff' })
  })
  const body = (await res.json()) as {
    accessToken?: string
    device?: { id: string }
    error?: { code: string }
  }
  assert.equal(res.status, 200, `login ${username} failed: ${body.error?.code}`)
  assert.ok(body.accessToken && body.device?.id)
  return { token: body.accessToken, deviceId: body.device.id }
}

/** Issues a handoff code and returns it split out of the entry URL's hash. */
async function issueHandoff(token: string, projectId: string): Promise<HandoffIssue> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/web-handoff`, {
    method: 'POST',
    headers: auth(token)
  })
  const body = (await res.json()) as { url?: string; expiresIn?: number; error?: { code: string } }
  const hash = body.url
    ? (new URL(body.url).hash.match(/^#handoff=([^&]+)&project=([\w-]+)$/) ?? [])
    : []
  if (hash[1]) issuedCodes.push(hash[1])
  return {
    status: res.status,
    url: body.url ?? '',
    expiresIn: body.expiresIn ?? 0,
    code: hash[1]
  }
}

async function redeem(
  service: Service,
  code: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${service.url}/v1/web/handoff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

type AuditEvent = {
  eventType: string
  actor: string | null
  targetType: string | null
  targetId: string | null
  result: string
  metadata: Record<string, unknown> | null
}

async function auditEvents(query: string): Promise<AuditEvent[]> {
  const res = await fetch(`${api.url}/v1/audit/events?${query}`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: AuditEvent[] }).events
}

/** Registers a host that advertises no direct address, so no web entry can be built. */
async function registerNoDirectHost(name: string): Promise<string> {
  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  assert.equal(tokenRes.status, 201)
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      name,
      fingerprint: `sha256:${name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      runtimeCapabilities: ['pty', 'files']
    })
  })
  const body = (await res.json()) as { hostId?: string; credential?: string }
  assert.equal(res.status, 201, JSON.stringify(body))
  noDirectHostId = body.hostId ?? ''
  return body.credential ?? ''
}

async function heartbeatOnline(
  hostId: string,
  credential: string,
  directAddrs?: string[]
): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ status: 'online', ...(directAddrs ? { directAddrs } : {}) })
  })
  assert.equal(res.status, 200)
}

/** Issuance demands `open` even from admin/auditor, so host-gate probes grant it first. */
async function grantAdminOpen(projectId: string): Promise<void> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: auth(adminToken),
    body: JSON.stringify({
      subjectType: 'user',
      subjectId: 'admin',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  assert.equal(res.status, 200)
}

/** Creates an admin-owned project on a host and grants admin the `open` it now needs. */
async function createProjectOnHost(key: string, hostId: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({ key, name: key, hostId, path: `/srv/work/${key}` })
  })
  const body = (await res.json()) as { id?: string; error?: { code: string } }
  assert.equal(res.status, 201, JSON.stringify(body))
  const projectId = body.id ?? ''
  await grantAdminOpen(projectId)
  return projectId
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-handoff'
  )
  shortTtl = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_CLOUD_HANDOFF_TTL_MS: String(SHORT_TTL_MS) },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-handoff-short-ttl'
  )
  adminToken = (await login(api, 'admin', 'Adm1n!')).token
  devToken = (await login(api, 'zhangsan', 'Passw0rd!')).token
  shortTtlDevToken = (await login(shortTtl, 'zhangsan', 'Passw0rd!')).token
  const noDirectCredential = await registerNoDirectHost('w7a-no-direct')
  await heartbeatOnline(noDirectHostId, noDirectCredential)
}, 120_000)

after(async () => {
  await api?.stop()
  await shortTtl?.stop()
})

describe('W7a web handoff：一次性 code 签发与换发', () => {
  test('签发→换发：60s code 换出正式会话，URL 不携带任何令牌', async () => {
    const issued = await issueHandoff(devToken, 'proj_payment')
    assert.equal(issued.status, 201, issued.url)
    assert.equal(issued.expiresIn, 60)
    assert.ok(issued.code, 'the entry URL must carry the handoff code in its hash')
    // W7b: the page is served by the host, so ?api= is how it finds the platform
    // to trade the code on (same channel as the admin session page).
    const entryPrefix = `https://127.0.0.1:16768/web-index.html?api=${encodeURIComponent(api.url)}#handoff=`
    assert.ok(issued.url.startsWith(entryPrefix), issued.url)
    assert.ok(issued.url.endsWith('&project=proj_payment'), issued.url)
    assert.match(
      issued.url.slice(entryPrefix.length, -'&project=proj_payment'.length),
      /^[A-Za-z0-9_-]+$/,
      'the hash code stays base64url'
    )

    const exchanged = await redeem(api, issued.code ?? '')
    assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body))
    assert.equal(errorCode(exchanged.body), '')
    const session = exchanged.body as unknown as {
      accessToken: string
      refreshToken: string
      expiresIn: number
      user: { username: string }
      device: { id: string; name: string }
    }
    assert.equal(session.user.username, 'zhangsan', 'the session is the code owner, not the caller')
    assert.ok(session.accessToken && session.refreshToken)
    assert.ok(session.device.id)
    assert.equal(issued.url.includes(session.accessToken), false, 'no token may ride in the URL')

    // The minted session is a real one: it reads /v1/me and renews itself.
    const me = await fetch(`${api.url}/v1/me`, { headers: auth(session.accessToken) })
    assert.equal(me.status, 200)
    assert.equal(((await me.json()) as { user: { username: string } }).user.username, 'zhangsan')
    const renewed = await fetch(`${api.url}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken })
    })
    assert.equal(renewed.status, 200, JSON.stringify(await renewed.json()))

    saveEvidence(EVIDENCE, 'issue-then-exchange.json', {
      issuedUrl: issued.url,
      expiresIn: issued.expiresIn,
      codeInUrlHash: true,
      accessTokenInUrl: issued.url.includes(session.accessToken),
      exchangeStatus: exchanged.status,
      exchangedUser: session.user.username,
      meStatus: me.status,
      refreshStatus: renewed.status
    })
  })

  test('重放与未知码一律 410，消费即失效', async () => {
    const issued = await issueHandoff(devToken, 'proj_payment')
    assert.equal(issued.status, 201)
    const first = await redeem(api, issued.code ?? '')
    assert.equal(first.status, 200)

    const replay = await redeem(api, issued.code ?? '')
    assert.equal(replay.status, 410)
    assert.equal(errorCode(replay.body), 'HANDOFF_GONE')
    assert.equal(errorReason(replay.body), 'code_invalid')

    const unknown = await redeem(api, randomBytes(32).toString('base64url'))
    assert.equal(unknown.status, 410)
    assert.equal(errorCode(unknown.body), 'HANDOFF_GONE')
    const blank = await redeem(api, '')
    assert.equal(blank.status, 410)

    saveEvidence(EVIDENCE, 'replay-and-unknown-410.json', {
      replay: {
        status: replay.status,
        code: errorCode(replay.body),
        reason: errorReason(replay.body)
      },
      unknown: { status: unknown.status, code: errorCode(unknown.body) },
      blank: { status: blank.status }
    })
  })

  test('短 TTL 注入：过期换发 410 code_expired', async () => {
    const res = await fetch(`${shortTtl.url}/v1/projects/proj_payment/web-handoff`, {
      method: 'POST',
      headers: auth(shortTtlDevToken)
    })
    const body = (await res.json()) as { url?: string; expiresIn?: number }
    assert.equal(res.status, 201, JSON.stringify(body))
    assert.equal(body.expiresIn, 1, 'the injected TTL is rounded up to whole seconds')
    const code = new URL(body.url ?? '').hash.match(/^#handoff=([^&]+)&/)?.[1] ?? ''
    assert.ok(code)
    issuedCodes.push(code)

    await new Promise((resolve) => setTimeout(resolve, SHORT_TTL_MS + 200))
    const exchanged = await redeem(shortTtl, code)
    assert.equal(exchanged.status, 410)
    assert.equal(errorCode(exchanged.body), 'HANDOFF_GONE')
    assert.equal(errorReason(exchanged.body), 'code_expired')

    saveEvidence(EVIDENCE, 'expired-410.json', {
      injectedTtlMs: SHORT_TTL_MS,
      responseExpiresIn: body.expiresIn,
      exchange: { status: exchanged.status, reason: errorReason(exchanged.body) }
    })
  })

  test('无直连地址 400 HOST_UNAVAILABLE；维护与吊销宿主 409 拒签', async () => {
    const projectId = await createProjectOnHost('handoff-no-direct', noDirectHostId)

    const noDirect = await issueHandoff(adminToken, projectId)
    assert.equal(noDirect.status, 400)

    const maintained = await fetch(`${api.url}/v1/hosts/${noDirectHostId}/maintenance`, {
      method: 'POST',
      headers: auth(adminToken),
      body: JSON.stringify({ enabled: true, reason: 'w7a window' })
    })
    assert.equal(maintained.status, 200)
    const maintenance = await issueHandoff(adminToken, projectId)
    assert.equal(maintenance.status, 409)

    const revokedHost = await fetch(`${api.url}/v1/hosts/${noDirectHostId}`, {
      method: 'DELETE',
      headers: auth(adminToken)
    })
    assert.equal(revokedHost.status, 200)
    const revoked = await issueHandoff(adminToken, projectId)
    assert.equal(revoked.status, 409)

    saveEvidence(EVIDENCE, 'host-entry-gates.json', {
      noDirect: { status: noDirect.status },
      maintenance: { status: maintenance.status },
      revoked: { status: revoked.status }
    })
  })

  test('直连地址形态非法：400 HOST_UNAVAILABLE，不产出错位入口 URL', async () => {
    const credential = await registerNoDirectHost('w7a-malformed-addr')
    const projectId = await createProjectOnHost('handoff-bad-addr', noDirectHostId)

    // A host-supplied string is spliced verbatim into `https://<addr>/...`, so a
    // scheme, path, bad port, or unbracketed IPv6 must be refused, not pointed at.
    const malformed = [
      'https://attacker.example/web-index.html',
      'dev-001.example/web-index.html',
      '127.0.0.1:0',
      '127.0.0.1:99999',
      '::1',
      'dev-001 example'
    ]
    for (const addr of malformed) {
      await heartbeatOnline(noDirectHostId, credential, [addr])
      const issued = await issueHandoff(adminToken, projectId)
      assert.equal(issued.status, 400, addr)
      assert.equal(issued.url, '', `no entry URL may be built from ${addr}`)
    }

    // The same host recovers the moment it reports a well-formed address.
    await heartbeatOnline(noDirectHostId, credential, ['[::1]:16768'])
    const recovered = await issueHandoff(adminToken, projectId)
    assert.equal(recovered.status, 201, recovered.url)
    assert.match(
      recovered.url,
      /^https:\/\/\[::1\]:16768\/web-index\.html\?api=[^#]+#handoff=/,
      'the recovered direct entry still carries the platform api param'
    )

    saveEvidence(EVIDENCE, 'malformed-direct-addr-400.json', {
      rejected: malformed,
      accepted: '[::1]:16768',
      recoveredStatus: recovered.status
    })
  })

  test('无 grant 的 admin 签发 403 permission_lost，不再签出死 code', async () => {
    // adminAccess lets the admin see proj_payment but grants no `open`, so the
    // code could only ever redeem 403 — it must be refused at mint time.
    const res = await fetch(`${api.url}/v1/projects/proj_payment/web-handoff`, {
      method: 'POST',
      headers: auth(adminToken)
    })
    const body = (await res.json()) as { url?: string; error?: { code?: string } }
    assert.equal(res.status, 403)
    assert.equal(body.error?.code, 'PROJECT_FORBIDDEN')
    assert.equal(body.url, undefined, 'a refused issuance must not carry an entry URL')

    const denied = await auditEvents('eventType=web_handoff&result=denied&limit=200')
    const refusal = denied.find(
      (event) => event.actor === 'admin' && event.targetId === 'proj_payment'
    )
    assert.equal(refusal?.metadata?.reason, 'permission_lost', 'the refusal must be audited')

    const issued = await auditEvents('eventType=web_handoff&result=success&limit=200')
    assert.equal(
      issued.filter((event) => event.actor === 'admin' && event.targetId === 'proj_payment').length,
      0,
      'no dead code may be minted for a project the issuer cannot open'
    )

    saveEvidence(EVIDENCE, 'admin-no-grant-issue-403.json', {
      status: res.status,
      code: body.error?.code,
      auditedReason: refusal?.metadata?.reason,
      deadCodeIssued: false
    })
  })

  test('无 open 权限的开发者签发 404（不泄露项目存在）', async () => {
    const lisi = await login(api, 'lisi', 'Passw0rd!')
    const res = await fetch(`${api.url}/v1/projects/proj_payment/web-handoff`, {
      method: 'POST',
      headers: auth(lisi.token)
    })
    assert.equal(res.status, 404)
    assert.equal(errorCode(await res.json()), 'PROJECT_NOT_FOUND')

    const denied = await auditEvents('eventType=project_access&result=denied&limit=50')
    assert.ok(
      denied.some((event) => event.actor === 'lisi' && event.targetId === 'proj_payment'),
      'the refusal must be audited'
    )
    saveEvidence(EVIDENCE, 'no-grant-issue-404.json', { status: res.status, auditedDenied: true })
  })

  test('签发后授权被撤：换发 403 permission_lost', async () => {
    const issued = await issueHandoff(devToken, 'proj_payment')
    assert.equal(issued.status, 201)
    const removed = await fetch(`${api.url}/v1/projects/proj_payment/grants`, {
      method: 'PUT',
      headers: auth(adminToken),
      body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
    })
    assert.equal(removed.status, 200)

    const exchanged = await redeem(api, issued.code ?? '')
    assert.equal(exchanged.status, 403)
    assert.equal(errorCode(exchanged.body), 'PROJECT_FORBIDDEN')
    assert.equal(errorReason(exchanged.body), 'permission_lost')

    // Put the workspace back for any later reader of this suite's fixtures.
    const restored = await fetch(`${api.url}/v1/projects/proj_payment/grants`, {
      method: 'PUT',
      headers: auth(adminToken),
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
      })
    })
    assert.equal(restored.status, 200)

    saveEvidence(EVIDENCE, 'permission-lost-403.json', {
      exchange: {
        status: exchanged.status,
        code: errorCode(exchanged.body),
        reason: errorReason(exchanged.body)
      },
      grantRestored: restored.status
    })
  })

  test('审计 web_handoff 两向齐全，且不含 code 明文', async () => {
    const events = await auditEvents('eventType=web_handoff&limit=200')
    const shortTtlAdmin = await login(shortTtl, 'admin', 'Adm1n!')
    const shortTtlRes = await fetch(`${shortTtl.url}/v1/audit/events?eventType=web_handoff`, {
      headers: auth(shortTtlAdmin.token)
    })
    assert.equal(shortTtlRes.status, 200)
    const shortTtlEvents = ((await shortTtlRes.json()) as { events: AuditEvent[] }).events
    const all = [...events, ...shortTtlEvents]
    const issued = all.filter(
      (event) => event.result === 'success' && event.targetType === 'project'
    )
    const exchanged = all.filter(
      (event) => event.result === 'success' && event.targetType === 'session'
    )
    const denied = all.filter((event) => event.result === 'denied')
    assert.ok(issued.length >= 3, `issuance must be audited: ${JSON.stringify(events)}`)
    assert.ok(exchanged.length >= 1, 'the exchange must be audited like a login')
    assert.ok(
      issued.every((event) => typeof event.metadata?.codeFingerprint === 'string'),
      'each issuance carries a code fingerprint'
    )
    assert.match(issued[0].metadata?.codeFingerprint as string, /^sha256:[0-9a-f]{16}$/)
    assert.ok(
      denied.some((event) => event.metadata?.reason === 'code_invalid') &&
        denied.some((event) => event.metadata?.reason === 'code_expired') &&
        denied.some((event) => event.metadata?.reason === 'permission_lost') &&
        denied.some((event) => event.metadata?.reason === 'host_unavailable'),
      `denials must be audited: ${JSON.stringify(denied)}`
    )
    // Every code this suite minted must be absent from either audit trail.
    const serialized = JSON.stringify(all)
    for (const code of issuedCodes) {
      assert.equal(serialized.includes(code), false, 'a plaintext code leaked into the audit')
    }

    saveEvidence(EVIDENCE, 'audit-both-directions.json', {
      issued: issued.length,
      exchanged: exchanged.length,
      deniedReasons: denied.map((event) => event.metadata?.reason),
      fingerprintSample: issued[0].metadata?.codeFingerprint,
      codesCheckedAgainstLog: issuedCodes.length,
      plaintextLeak: false
    })
  })
})
