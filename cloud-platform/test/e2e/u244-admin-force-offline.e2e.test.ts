import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'

/**
 * U244 / FR-1.6: an administrator force-offline revokes every platform session
 * of one user (epoch bump kills issued access tokens, refresh dies and clears
 * the Cookie) and drops the host ticket through the user revocation set —
 * without revoking the user's devices.
 */

const ORIGIN = 'https://console.u244.example'
const apps: ApiHandle[] = []

type LoginBody = {
  accessToken?: string
  refreshToken?: string
  error?: { code?: string; message?: string }
  user?: { id: string }
  device?: { id: string }
}

type RevokeBody = { ok?: boolean; revokedSessions?: number; error?: { code?: string } }

type AuditEvent = {
  eventType: string
  actor: string | null
  targetType: string | null
  targetId: string | null
  result: string
  metadata: Record<string, unknown>
}

async function start(
  options: {
    cookieMode?: string
    publicOrigin?: string
    auditLogPath?: string
    beforeUserSessionRevoke?: () => void | Promise<void>
    now?: () => number
  } = {}
): Promise<{ app: ApiHandle; base: string }> {
  const app = createApp({
    port: 0,
    accessTtlMs: 60_000,
    refreshTtlMs: 60_000,
    now: options.now,
    internalToken: 'u244-token',
    cookieMode: options.cookieMode,
    beforeUserSessionRevoke: options.beforeUserSessionRevoke,
    auditLogPath: options.auditLogPath,
    // Empty string pins "unconfigured" even if the developer shell exports one.
    publicOrigin: options.publicOrigin ?? ''
  })
  apps.push(app)
  const port = await app.listen()
  return { app, base: `http://127.0.0.1:${port}` }
}

async function login(
  base: string,
  username: string,
  password: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; res: Response; body: LoginBody }> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username, password, deviceName: `u244-${username}-${Date.now()}` })
  })
  return { status: res.status, res, body: (await res.json()) as LoginBody }
}

function cookieValueOf(res: Response): string {
  const match = /^orca_refresh=([A-Za-z0-9_-]+);/.exec(res.headers.getSetCookie()[0] ?? '')
  assert.ok(match, 'expected a refresh cookie')
  return match[1] ?? ''
}

function refreshCookie(base: string, cookie: string): Promise<Response> {
  return fetch(`${base}/v1/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      cookie: `orca_refresh=${cookie}`
    },
    body: JSON.stringify({})
  })
}

function revoke(
  base: string,
  token: string,
  userId: string,
  body: Record<string, unknown> = {}
): Promise<Response> {
  return fetch(`${base}/v1/users/${userId}/sessions/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
}

function revokeRaw(base: string, token: string, userId: string, body: string): Promise<Response> {
  return fetch(`${base}/v1/users/${userId}/sessions/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body
  })
}

function logout(base: string, token: string): Promise<Response> {
  return fetch(`${base}/v1/auth/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({})
  })
}

async function updateUserGrant(
  base: string,
  token: string,
  projectId: string,
  subjectId: string,
  permissions: string[]
): Promise<Response> {
  return fetch(`${base}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ subjectType: 'user', subjectId, permissions })
  })
}

async function connectProject(
  base: string,
  token: string,
  projectId: string,
  deviceId: string
): Promise<Response> {
  return fetch(`${base}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ deviceId, clientVersion: '1.5.0' })
  })
}

function credentialPayload(credential: string): { iat: number; iatMs?: number } {
  const segment = credential.split('.')[1]
  assert.ok(segment, 'credential must carry a payload segment')
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
    iat: number
    iatMs?: number
  }
}

function sessionsOf(app: ApiHandle, userId: string) {
  return [...app.store.sessions.values()].filter((session) => session.userId === userId)
}

async function auditEvents(base: string, token: string, query: string): Promise<AuditEvent[]> {
  const res = await fetch(`${base}/v1/audit/events?${query}&limit=50`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: AuditEvent[] }).events
}

/** Pairwise barrier that re-arms, so one test can gate several concurrent rounds. */
function recurringRendezvous(): () => Promise<void> {
  let arrivals = 0
  let releaseCurrent: () => void = () => {}
  let current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  // U245④: a partner that never arrives must fail fast, not hang the runner.
  const awaitGate = (gate: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('barrier partner did not arrive')), 2_000)
      timer.unref()
    })
    return Promise.race([gate, timeout]).finally(() => clearTimeout(timer))
  }
  return async () => {
    const gate = current
    arrivals += 1
    if (arrivals % 2 === 0) {
      const release = releaseCurrent
      current = new Promise<void>((resolve) => {
        releaseCurrent = resolve
      })
      release()
    }
    await awaitGate(gate)
  }
}

function rendezvous(timeoutMs = 2_000): () => Promise<void> {
  let arrivals = 0
  let release: () => void = () => {}
  let fail: (error: Error) => void = () => {}
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const timer = setTimeout(
    () => fail(new Error(`the second revoke did not reach the barrier within ${timeoutMs}ms`)),
    timeoutMs
  )
  timer.unref()
  gate.catch(() => {})
  return async () => {
    arrivals += 1
    if (arrivals === 2) {
      clearTimeout(timer)
      release()
    }
    await gate
  }
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

describe('U244 管理员强制下线（真实 createApp + HTTP）', () => {
  test('撤销多设备用户：全部会话失效、epoch +1、旧 access 401、refresh 401 并清 Cookie', async () => {
    const { app, base } = await start({ cookieMode: 'auto', publicOrigin: ORIGIN })
    const phone = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })
    const laptop = await login(base, 'zhangsan', 'Passw0rd!', { origin: ORIGIN })
    assert.equal(phone.status, 200)
    assert.equal(laptop.status, 200)
    const admin = await login(base, 'admin', 'Adm1n!', { origin: ORIGIN })
    assert.equal(admin.status, 200)
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const sessions = sessionsOf(app, zhang.id)
    assert.equal(sessions.length, 2, 'two logins make two devices and sessions')
    const devices = [...app.store.devices.values()].filter((device) => device.userId === zhang.id)
    assert.equal(devices.length, 2)

    const revoked = await revoke(base, admin.body.accessToken ?? '', zhang.id, { reason: '离职交接' })

    assert.equal(revoked.status, 200)
    assert.deepEqual((await revoked.json()) as RevokeBody, { ok: true, revokedSessions: 2 })
    for (const session of sessions) {
      assert.ok(session.revokedAt !== null, 'every session must be revoked')
      assert.equal(session.epoch, 2, 'the epoch bump must invalidate issued access tokens')
    }
    for (const access of [phone.body.accessToken, laptop.body.accessToken]) {
      const me = await fetch(`${base}/v1/me`, {
        headers: { authorization: `Bearer ${access ?? ''}` }
      })
      assert.equal(me.status, 401, 'old access tokens must be dead immediately')
    }
    const refused = await refreshCookie(base, cookieValueOf(phone.res))
    assert.equal(refused.status, 401)
    assert.equal(((await refused.json()) as LoginBody).error?.code, 'SESSION_EXPIRED')
    assert.match(
      refused.headers.getSetCookie().join(';'),
      /Max-Age=0/,
      'the refresh Cookie must be cleared'
    )
    for (const device of devices) {
      assert.equal(device.revokedAt, null, 'force-offline is not a device loss')
    }
  })

  test('授权变更后强制下线仍刷新撤销标记并留痕，不把合法动作误判为 no-op', async () => {
    const baseClock = 1_700_000_000_000
    let clock = baseClock
    const { app, base } = await start({ now: () => clock })
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const admin = await login(base, 'admin', 'Adm1n!')
    assert.equal(admin.status, 200)
    const token = admin.body.accessToken ?? ''

    // T1: an ordinary grant edit writes a user revocation marker of its own.
    clock = baseClock + 1_000
    const granted = await updateUserGrant(base, token, 'proj_payment', zhang.id, ['open'])
    assert.equal(granted.status, 200)
    const marker = app.store.revocations.find(
      (entry) => entry.targetType === 'user' && entry.targetId === zhang.username
    )
    assert.ok(marker, 'the grant edit must seed the user marker')
    assert.equal(marker.at, clock)
    assert.equal(marker.reason, 'grant_changed')

    // Login after the grant edit, mint a host ticket issued after T1, then go idle.
    clock = baseClock + 2_000
    const zhangLogin = await login(base, 'zhangsan', 'Passw0rd!')
    assert.equal(zhangLogin.status, 200)
    const deviceId = zhangLogin.body.device?.id
    assert.ok(deviceId, 'login must report the device it created')
    const zhangToken = zhangLogin.body.accessToken ?? ''
    const ticket = await connectProject(base, zhangToken, 'proj_payment', deviceId)
    assert.equal(ticket.status, 200)
    const payload = credentialPayload(((await ticket.json()) as { credential: string }).credential)
    assert.equal(payload.iatMs, clock, 'the host ticket is newer than the grant marker')
    assert.equal((await logout(base, zhangToken)).status, 200)
    assert.equal(
      sessionsOf(app, zhang.id).filter((session) => session.revokedAt === null).length,
      0,
      'logout leaves no live session behind'
    )

    // T2: force-offline must move the marker past the ticket minted at Tm.
    clock = baseClock + 3_000
    const forced = await revoke(base, token, zhang.id)
    assert.equal(forced.status, 200)
    assert.deepEqual((await forced.json()) as RevokeBody, { ok: true, revokedSessions: 0 })

    const markers = app.store.revocations.filter(
      (entry) => entry.targetType === 'user' && entry.targetId === zhang.username
    )
    assert.equal(markers.length, 1, 'a refresh must not grow the revocation list')
    assert.equal(markers[0]?.at, clock, '`since` must advance past the grant marker')
    assert.equal(markers[0]?.reason, 'admin_force_offline')
    assert.ok((payload.iatMs ?? 0) < (markers[0]?.at ?? 0), 'the host ticket is now covered')

    const successEvents = app.store.audit.filter(
      (entry) =>
        entry.eventType === 'session_revoke' &&
        entry.result === 'success' &&
        entry.targetId === zhang.id
    )
    assert.equal(successEvents.length, 1, 'the admin action must be audited exactly once')
    assert.equal(successEvents[0]?.metadata.revokedSessions, 0)
  })

  test('宿主撤销集合写入 user:<username>，内部端点可查', async () => {
    const { app, base } = await start()
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)

    const revoked = await revoke(base, admin.body.accessToken ?? '', zhang.id)
    assert.equal(revoked.status, 200)
    assert.equal(((await revoked.json()) as RevokeBody).revokedSessions, 1)

    const res = await fetch(`${base}/v1/internal/revocations`, {
      headers: { 'x-internal-token': 'u244-token' }
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { users: { id: string }[]; devices: { id: string }[] }
    assert.ok(
      body.users.some((entry) => entry.id === zhang.username),
      'the host ticket must be revoked by username, not user id'
    )
    assert.equal(body.devices.length, 0, 'no device revocation may be written')
  })

  test('非管理员 403 PERMISSION_DENIED + denied 审计，会话无变化', async () => {
    const { app, base } = await start()
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const lisi = await login(base, 'lisi', 'Passw0rd!')
    assert.equal(lisi.status, 200)
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)

    const denied = await revoke(base, lisi.body.accessToken ?? '', zhang.id)

    assert.equal(denied.status, 403)
    assert.equal(((await denied.json()) as RevokeBody).error?.code, 'PERMISSION_DENIED')
    assert.equal(session.revokedAt, null)
    assert.equal(session.epoch, 1)
    const event = app.store.audit.find(
      (entry) => entry.eventType === 'session_revoke' && entry.result === 'denied'
    )
    assert.ok(event, 'the refusal must be audited')
    assert.equal(event.actor, 'lisi')
    assert.equal(event.targetId, zhang.id)
    assert.equal(event.metadata.reason, 'PERMISSION_DENIED')
    assert.equal(event.metadata.requiredPermission, 'platform:admin')
  })

  test('审计不可写 → 503 且会话未变（fail-closed）', async () => {
    const logPath = join(mkdtempSync(join(tmpdir(), 'u244-audit-')), 'audit.jsonl')
    const { app, base } = await start({ auditLogPath: logPath })
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)
    const quiet = app.store.seedUser({
      username: 'quiet',
      displayName: 'Quiet',
      dept: 'ops',
      email: 'quiet@example.com',
      groups: [],
      roles: ['developer'],
      status: 'active'
    })

    chmodSync(logPath, 0o400)
    try {
      const refused = await revoke(base, admin.body.accessToken ?? '', zhang.id)
      assert.equal(refused.status, 503)
      assert.equal(session.revokedAt, null, 'no revocation may happen without an audit record')
      assert.equal(session.epoch, 1)
      assert.equal(
        app.store.revocations.some((entry) => entry.targetType === 'user'),
        false,
        'the host ticket must survive a refused audit write'
      )
      // A user with no sessions still mutates the host revocation set, so it must also fail closed.
      const emptyRefused = await revoke(base, admin.body.accessToken ?? '', quiet.id)
      assert.equal(emptyRefused.status, 503)
      assert.equal(
        app.store.revocations.some(
          (entry) => entry.targetType === 'user' && entry.targetId === 'quiet'
        ),
        false
      )
    } finally {
      chmodSync(logPath, 0o600)
    }
  })

  test('并发撤销只生效一次、只写一条审计；重复请求返回 0 但仍留痕', async () => {
    const { app, base } = await start({ beforeUserSessionRevoke: rendezvous() })
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)
    const token = admin.body.accessToken ?? ''

    const [first, second] = await Promise.all([
      revoke(base, token, zhang.id),
      revoke(base, token, zhang.id)
    ])

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const counts = [
      ((await first.json()) as RevokeBody).revokedSessions,
      ((await second.json()) as RevokeBody).revokedSessions
    ].sort()
    assert.deepEqual(counts, [0, 1], 'exactly one request performs the revocation')
    assert.ok(session.revokedAt !== null)
    assert.equal(session.epoch, 2, 'the epoch may only be bumped once')
    const successEvents = app.store.audit.filter(
      (entry) => entry.eventType === 'session_revoke' && entry.result === 'success'
    )
    assert.equal(successEvents.length, 1, 'concurrent requests must not duplicate the audit')
    assert.equal(successEvents[0]?.metadata.revokedSessions, 1)

    const repeat = await revoke(base, token, zhang.id)
    assert.equal(repeat.status, 200)
    assert.equal(((await repeat.json()) as RevokeBody).revokedSessions, 0)
    const afterRepeat = app.store.audit.filter(
      (entry) => entry.eventType === 'session_revoke' && entry.result === 'success'
    )
    assert.equal(afterRepeat.length, 2, 'a non-concurrent repeat is still an admin action')
    assert.equal(afterRepeat[1]?.metadata.revokedSessions, 0)
  })

  test('leader 审计失败时 follower 重试而非虚假 200；审计恢复后仍只写一条', async () => {
    const { app, base } = await start({ beforeUserSessionRevoke: recurringRendezvous() })
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)
    const token = admin.body.accessToken ?? ''
    const originalAppend = app.audit.append.bind(app.audit)
    let auditDown = true
    app.audit.append = (input) => {
      if (auditDown) {
        throw new Error('audit unavailable')
      }
      return originalAppend(input)
    }
    try {
      const failed = await Promise.all([
        revoke(base, token, zhang.id),
        revoke(base, token, zhang.id)
      ])
      const failedBodies = await Promise.all(
        failed.map(async (res) => ({ status: res.status, body: (await res.json()) as RevokeBody }))
      )
      assert.equal(
        failedBodies.some((entry) => entry.status === 200 && entry.body.revokedSessions === 0),
        false,
        'a follower must not report a false success when the leader audit failed'
      )
      assert.deepEqual(
        failedBodies.map((entry) => entry.status),
        [503, 503],
        'both requests fail closed while audit is down'
      )
      assert.equal(session.revokedAt, null, 'no revocation may happen without an audit record')
      assert.equal(session.epoch, 1)
      assert.equal(
        app.store.revocations.some((entry) => entry.targetType === 'user'),
        false,
        'the host ticket must survive a refused audit write'
      )
      assert.equal(app.store.audit.filter((entry) => entry.eventType === 'session_revoke').length, 0)

      auditDown = false
      app.audit.append = originalAppend
      const recovered = await Promise.all([
        revoke(base, token, zhang.id),
        revoke(base, token, zhang.id)
      ])
      assert.deepEqual(recovered.map((res) => res.status), [200, 200])
      const counts = await Promise.all(recovered.map(async (res) => (await res.json()) as RevokeBody))
      assert.deepEqual(
        counts.map((body) => body.revokedSessions).sort(),
        [0, 1],
        'one leader revokes, the follower reports 0'
      )
      assert.ok(session.revokedAt !== null)
      assert.equal(session.epoch, 2, 'the epoch may only be bumped once')
      const events = app.store.audit.filter(
        (entry) => entry.eventType === 'session_revoke' && entry.result === 'success'
      )
      assert.equal(events.length, 1, 'the recovered retry writes exactly one audit event')
      assert.equal(events[0]?.metadata.revokedSessions, 1)
    } finally {
      app.audit.append = originalAppend
    }
  })

  test('审计写入窗口内并发登录的新会话随后被撤销；窗口后登录不受影响（U249 P2-4）', async () => {
    const { app, base } = await start()
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const token = admin.body.accessToken ?? ''
    const sessionIdsBefore = new Set(sessionsOf(app, zhang.id).map((session) => session.id))

    // Park the leader inside its write-ahead audit, the exact U249 race window.
    const originalAppend = app.audit.append.bind(app.audit)
    let releaseAudit: () => void = () => {}
    const auditGate = new Promise<void>((resolve) => {
      releaseAudit = resolve
    })
    let signalAuditEntered: () => void = () => {}
    const auditEntered = new Promise<void>((resolve) => {
      signalAuditEntered = resolve
    })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    app.audit.append = async (input) => {
      if (input.eventType === 'session_revoke' && input.result === 'success') {
        signalAuditEntered()
        // A forgotten release must fail the case, not hang the runner.
        watchdog = setTimeout(releaseAudit, 5_000)
        watchdog.unref()
        await auditGate
      }
      return originalAppend(input)
    }
    try {
      const forced = revoke(base, token, zhang.id)
      await auditEntered
      // Two logins start and finish entirely inside the audit await. Both must
      // lose: they may be rejected or revoked afterwards, but never survive.
      const windowLogins = await Promise.all([
        login(base, 'zhangsan', 'Passw0rd!'),
        login(base, 'zhangsan', 'Passw0rd!')
      ])
      assert.deepEqual(
        windowLogins.map((entry) => entry.status),
        [200, 200],
        'the window logins themselves are not blocked'
      )
      const minted = sessionsOf(app, zhang.id).filter(
        (session) => !sessionIdsBefore.has(session.id)
      )
      assert.equal(minted.length, 2, 'each window login mints one session')
      releaseAudit()

      const response = await forced
      assert.equal(response.status, 200)
      assert.deepEqual((await response.json()) as RevokeBody, {
        ok: true,
        revokedSessions: 3
      })
      for (const session of minted) {
        assert.ok(session.revokedAt !== null, 'a session minted during the audit must die too')
        assert.equal(session.epoch, 2, 'the window session epoch must be bumped exactly once')
      }
      for (const entry of windowLogins) {
        const me = await fetch(`${base}/v1/me`, {
          headers: { authorization: `Bearer ${entry.body.accessToken ?? ''}` }
        })
        assert.equal(me.status, 401, 'the window access token must be dead')
      }
      // The audit stays write-ahead: it reports the pre-audit target count.
      const successEvents = app.store.audit.filter(
        (entry) => entry.eventType === 'session_revoke' && entry.result === 'success'
      )
      assert.equal(successEvents.length, 1, 'one leader action, one audit event')
      assert.equal(successEvents[0]?.metadata.revokedSessions, 1)

      // A login after the request settled is a normal login and must survive.
      const after = await login(base, 'zhangsan', 'Passw0rd!')
      assert.equal(after.status, 200)
      const liveAfter = sessionsOf(app, zhang.id).filter((session) => session.revokedAt === null)
      assert.equal(liveAfter.length, 1, 'only the post-window login stays live')
      const me = await fetch(`${base}/v1/me`, {
        headers: { authorization: `Bearer ${after.body.accessToken ?? ''}` }
      })
      assert.equal(me.status, 200)
    } finally {
      if (watchdog) clearTimeout(watchdog)
      releaseAudit()
      app.audit.append = originalAppend
    }
  })

  test('未知用户 404；无会话用户 200 且仍写宿主撤销', async () => {
    const { app, base } = await start()
    const admin = await login(base, 'admin', 'Adm1n!')
    const token = admin.body.accessToken ?? ''
    const quiet = app.store.seedUser({
      username: 'quiet',
      displayName: 'Quiet',
      dept: 'ops',
      email: 'quiet@example.com',
      groups: [],
      roles: ['developer'],
      status: 'active'
    })

    const missing = await revoke(base, token, 'user_does_not_exist')
    assert.equal(missing.status, 404)
    assert.equal(((await missing.json()) as RevokeBody).error?.code, 'USER_NOT_FOUND')

    const empty = await revoke(base, token, quiet.id)
    assert.equal(empty.status, 200)
    assert.deepEqual((await empty.json()) as RevokeBody, { ok: true, revokedSessions: 0 })
    assert.ok(
      app.store.revocations.some(
        (entry) => entry.targetType === 'user' && entry.targetId === 'quiet'
      ),
      'a user with no sessions still needs the host ticket revoked'
    )
    const events = app.store.audit.filter(
      (entry) => entry.eventType === 'session_revoke' && entry.targetId === quiet.id
    )
    assert.equal(events.length, 1, 'the zero-session revoke is still audited')
    assert.equal(events[0]?.metadata.revokedSessions, 0)
  })

  test('审计事件可按类型筛选，且目录/Web 下拉同步 session_revoke', async () => {
    const { app, base } = await start()
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const token = admin.body.accessToken ?? ''
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    assert.equal((await revoke(base, token, zhang.id, { reason: '应急' })).status, 200)

    const events = await auditEvents(base, token, 'eventType=session_revoke&result=success')
    const event = events.find((entry) => entry.targetId === zhang.id)
    assert.ok(event, 'the success event must be filterable by type')
    assert.equal(event.actor, 'admin')
    assert.equal(event.targetType, 'user')
    assert.equal(event.metadata.reason, '应急')
    assert.equal(event.metadata.revokedSessions, 1)

    const status = await fetch(`${base}/v1/audit/status`, {
      headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(status.status, 200)
    const capabilities = (await status.json()) as { eventTypes: string[] }
    assert.ok(capabilities.eventTypes.includes('session_revoke'))

    const appJs = readFileSync(new URL('../../apps/web/app.js', import.meta.url), 'utf8')
    assert.match(appJs, /session_revoke: '会话撤销'/, 'the console dropdown needs a zh label')
    assert.match(appJs, /'session_revoke'/, 'the fallback type list must mirror the catalog')
  })

  test('force-offline body 超 4 KiB → 按空 body 处理且撤销照常（U250 契约 B）', async () => {
    const { app, base } = await start()
    assert.equal((await login(base, 'zhangsan', 'Passw0rd!')).status, 200)
    const admin = await login(base, 'admin', 'Adm1n!')
    const zhang = app.store.usersByName.get('zhangsan')
    assert.ok(zhang)
    const session = sessionsOf(app, zhang.id)[0]
    assert.ok(session)
    const oversized = JSON.stringify({
      reason: 'x'.repeat(4 * 1024),
      pad: 'y'.repeat(4 * 1024)
    })
    assert.ok(Buffer.byteLength(oversized) > 4 * 1024, 'the fixture must exceed the cap')

    const forced = await revokeRaw(base, admin.body.accessToken ?? '', zhang.id, oversized)

    assert.equal(forced.status, 200, 'an optional note must never block a security action')
    assert.deepEqual((await forced.json()) as RevokeBody, { ok: true, revokedSessions: 1 })
    assert.ok(session.revokedAt !== null)
    assert.equal(session.epoch, 2)
    const event = app.store.audit.find(
      (entry) =>
        entry.eventType === 'session_revoke' &&
        entry.result === 'success' &&
        entry.targetId === zhang.id
    )
    assert.ok(event, 'the revocation must still be audited')
    assert.equal(event.metadata.revokedSessions, 1)
    assert.equal(
      'reason' in event.metadata,
      false,
      'an oversized body is discarded whole, never truncated into a reason'
    )
  })
})
