import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { saveEvidence } from './harness.ts'

/**
 * M89 (AC-13): an auditor asks for one user's last seven days and must get the
 * whole window — and be able to follow a single request by its traceId into the
 * audit chain. The platform's clock is injected so the seven-day boundary is
 * crossed by moving time, not by waiting.
 */

const EVIDENCE = 'm89-audit-trace-window'
const DAY = 24 * 60 * 60_000
const T0 = 1_800_000_000_000
const WINDOW_DAYS = 7

let clock = T0
let app: ApiHandle
let url = ''

type Page = {
  events: { seq: number; ts: number; eventType: string; actor: string; traceId: string | null }[]
  nextCursor: number | null
}

async function startApp(): Promise<void> {
  clock = T0
  app = createApp({ port: 0, now: () => clock })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

type Session = { token: string; deviceId: string; pubKey: string }

async function login(username: string, password: string, device: string): Promise<Session> {
  // The ticket binds this key; the connect call must present the same one.
  const pubKey = Buffer.from(`m89-${device}`).toString('base64')
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: device, devicePubKey: pubKey })
  })
  assert.equal(res.status, 200, await res.clone().text())
  const body = (await res.json()) as { accessToken?: string; device?: { id?: string } }
  return { token: body.accessToken ?? '', deviceId: body.device?.id ?? '', pubKey }
}

/** A user action with an explicit traceId, the way a client would send one. */
async function openProject(
  session: Session,
  projectId: string,
  traceId: string,
  clientVersion = '1.5.0'
): Promise<{ status: number; traceId: string | null }> {
  const res = await fetch(`${url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...auth(session.token),
      'x-trace-id': traceId
    },
    body: JSON.stringify({
      deviceId: session.deviceId,
      devicePubKey: session.pubKey,
      clientVersion
    })
  })
  const text = await res.text()
  const body = text === '' ? {} : (JSON.parse(text) as { error?: { traceId?: string } })
  return { status: res.status, traceId: body.error?.traceId ?? null }
}

async function auditPage(token: string, params: Record<string, string>): Promise<Page> {
  const query = new URLSearchParams(params)
  const res = await fetch(`${url}/v1/audit/events?${query.toString()}`, { headers: auth(token) })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as Page
}

async function verifyChain(token: string): Promise<{ ok: boolean; checked: number }> {
  const res = await fetch(`${url}/v1/audit/verify`, { headers: auth(token) })
  assert.equal(res.status, 200, await res.clone().text())
  return (await res.json()) as { ok: boolean; checked: number }
}

before(startApp, { timeout: 30_000 })
after(async () => {
  await app?.close()
})

test('AC-13 审计员查用户近 7 天：窗口边界、分页完整、traceId 可关联', { timeout: 60_000 }, async () => {
  const admin = await login('admin', 'Adm1n!', 'm89-admin')
  assert.notEqual(admin.token, '')

  // A real host on a real project, so `project_connect` really is recorded.
  const tokenRes = await fetch(`${url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(admin.token)
  })
  const hostToken = ((await tokenRes.json()) as { token?: string }).token ?? ''
  const registered = await fetch(`${url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${hostToken}` },
    body: JSON.stringify({
      name: 'm89-host',
      fingerprint: 'sha256:m89',
      e2eePublicKeyB64: 'm89-e2ee',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: [],
      relayTarget: '127.0.0.1:9',
      relayRoute: 'm89-route',
      runtimeCapabilities: ['pty', 'files']
    })
  })
  const registerText = await registered.text()
  assert.equal(registered.status, 201, registerText)
  const host = JSON.parse(registerText) as { hostId?: string; credential?: string }
  assert.ok(host.hostId && host.credential, registerText)

  const created = await fetch(`${url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(admin.token) },
    body: JSON.stringify({
      key: 'm89-project',
      name: 'm89-project',
      hostId: host.hostId,
      path: '/srv/work/m89-project'
    })
  })
  assert.equal(created.status, 201, await created.clone().text())
  const project = (await created.json()) as { id: string }
  const granted = await fetch(`${url}/v1/projects/${project.id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...auth(admin.token) },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })
  assert.equal(granted.status, 200)

  /** The host must keep beating or every connect is refused as HOST_OFFLINE. */
  const heartbeat = async (): Promise<void> => {
    const res = await fetch(`${url}/v1/hosts/${host.hostId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
      body: JSON.stringify({ status: 'online' })
    })
    assert.equal(res.status, 200, await res.clone().text())
  }

  await heartbeat()

  // ---- day 0: a refused request with a traceId ----
  const dev = await login('zhangsan', 'Passw0rd!', 'm89-dev')
  const oldTrace = 'm89-trace-old-7d'
  const denied = await openProject(dev, project.id, oldTrace, '1.0.0')
  assert.equal(denied.status, 426, 'an old client version is refused')
  assert.equal(denied.traceId, oldTrace, 'the response echoes the request traceId')

  // ---- day 6: still inside the seven-day window ----
  clock = T0 + 6 * DAY
  await heartbeat()
  const devLater = await login('zhangsan', 'Passw0rd!', 'm89-dev-later')
  const insideTrace = 'm89-trace-inside-7d'
  const inside = await openProject(devLater, project.id, insideTrace)
  assert.equal(inside.status, 200, JSON.stringify(inside))

  // ---- day 10: day-0 events are now outside the window ----
  clock = T0 + 10 * DAY
  await heartbeat()
  const adminLater = await login('admin', 'Adm1n!', 'm89-admin-later')
  const devAt10 = await login('zhangsan', 'Passw0rd!', 'm89-dev-10')
  const recentTrace = 'm89-trace-recent'
  const recent = await openProject(devAt10, project.id, recentTrace)
  assert.equal(recent.status, 200, JSON.stringify(recent))

  // The API takes an ISO date, not epoch milliseconds (Date.parse of the latter is NaN).
  const since = new Date(clock - WINDOW_DAYS * DAY).toISOString()
  // ---- window boundary: day 0 excluded, day 6 and day 10 included ----
  const window = await auditPage(adminLater.token, {
    actor: 'zhangsan',
    eventType: 'project_connect',
    since,
    limit: '200'
  })
  const windowTraces = window.events.map((event) => event.traceId)
  assert.ok(
    window.events.every((event) => event.ts >= Date.parse(since)),
    'no event predates the window'
  )
  assert.ok(windowTraces.includes(insideTrace), 'day 6 is inside the window')
  assert.ok(windowTraces.includes(recentTrace), 'day 10 is inside the window')
  assert.ok(!windowTraces.includes(oldTrace), 'day 0 is outside the window')

  // ---- paging: walking the window returns every in-window event exactly once ----
  const collected: number[] = []
  let cursor: number | null = null
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await auditPage(adminLater.token, {
      actor: 'zhangsan',
      eventType: 'project_connect',
      since,
      limit: '1',
      ...(cursor === null ? {} : { cursor: String(cursor) })
    })
    collected.push(...page.events.map((event) => event.seq))
    if (page.nextCursor === null) break
    cursor = page.nextCursor
  }
  assert.deepEqual(
    [...collected].sort((a, b) => a - b),
    window.events.map((event) => event.seq).sort((a, b) => a - b),
    'paging must cover the window completely, without duplicates'
  )

  // ---- traceId correlation: the event and the response point at each other ----
  const byTrace = await auditPage(adminLater.token, { traceId: insideTrace, limit: '50' })
  assert.equal(byTrace.events.length, 1, JSON.stringify(byTrace))
  const correlated = byTrace.events[0]
  assert.equal(correlated?.eventType, 'project_connect')
  assert.equal(correlated.actor, 'zhangsan')
  const unavailable = await auditPage(adminLater.token, {
    traceId: 'm89-trace-never-used',
    limit: '50'
  })
  assert.equal(unavailable.events.length, 0)

  // ---- the window is verifiable, not just filtered ----
  const verified = await verifyChain(adminLater.token)
  assert.equal(verified.ok, true, JSON.stringify(verified))

  saveEvidence(EVIDENCE, 'audit-trace-window.json', {
    windowDays: WINDOW_DAYS,
    windowEventCount: window.events.length,
    day0Excluded: !windowTraces.includes(oldTrace),
    day6Included: windowTraces.includes(insideTrace),
    day10Included: windowTraces.includes(recentTrace),
    pagedSeqs: collected,
    traceLookup: {
      traceId: insideTrace,
      matches: byTrace.events.length,
      eventType: correlated?.eventType,
      actor: correlated?.actor
    },
    chain: verified
  })
})
