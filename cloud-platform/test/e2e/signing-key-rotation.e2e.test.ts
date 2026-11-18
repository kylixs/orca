import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { verifyCredential } from '../../packages/contract/src/credential.ts'
import { KEY_RETENTION_MS } from '../../apps/api/src/signing-key-ring.ts'
import { saveEvidence } from './harness.ts'

/**
 * M76 (G-03 / AC-31): rotating the credential signing key must not invalidate
 * tickets already handed out, and retired public keys must stay published for
 * the 60-day retention window so hosts that refetch the JWKS keep verifying.
 */

const T0 = 1_900_000_000_000
const DAY = 24 * 60 * 60_000
let clock = T0
let app: ApiHandle | null = null

async function startApp(): Promise<string> {
  clock = T0
  app = createApp({ port: 0, now: () => clock })
  const port = await app.listen()
  return `http://127.0.0.1:${port}`
}

afterEach(async () => {
  await app?.close()
  app = null
})

type LoginBody = { accessToken?: string; device?: { id: string } }
type TicketBody = { credential?: string; error?: { code: string } }
type JwksBody = { keys: { kid: string; publicKeyPem: string }[] }
type RotateBody = {
  kid?: string
  previousKid?: string
  publishedKids?: string[]
  error?: { code: string }
}

const deviceKey = (username: string): string => Buffer.from(`m76-${username}`).toString('base64')

async function login(url: string, username: string, password: string): Promise<LoginBody> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceName: `m76-${username}`,
      devicePubKey: deviceKey(username)
    })
  })
  assert.equal(res.status, 200)
  return (await res.json()) as LoginBody
}

async function connect(
  url: string,
  accessToken: string,
  deviceId: string,
  username = 'zhangsan'
): Promise<string> {
  const res = await fetch(`${url}/v1/projects/proj_payment/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      deviceId,
      devicePubKey: deviceKey(username),
      clientVersion: '1.5.0'
    })
  })
  const body = (await res.json()) as TicketBody
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.credential ?? ''
}

async function jwks(url: string): Promise<Map<string, string>> {
  const res = await fetch(`${url}/v1/jwks`)
  const body = (await res.json()) as JwksBody
  return new Map(body.keys.map((entry) => [entry.kid, entry.publicKeyPem]))
}

function kidOf(credential: string): string {
  const header = JSON.parse(
    Buffer.from(credential.split('.')[0], 'base64url').toString('utf8')
  ) as {
    kid: string
  }
  return header.kid
}

async function rotate(url: string, token: string): Promise<{ status: number; body: RotateBody }> {
  const res = await fetch(`${url}/v1/admin/signing-keys/rotate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  })
  return { status: res.status, body: (await res.json()) as RotateBody }
}

test('AC-31 轮换后新旧 kid 并行验签，60 天后旧公钥不再发布', async () => {
  const url = await startApp()
  const admin = (await login(url, 'admin', 'Adm1n!')).accessToken ?? ''
  const dev = await login(url, 'zhangsan', 'Passw0rd!')
  assert.ok(dev.accessToken && dev.device?.id)

  const before = await connect(url, dev.accessToken, dev.device.id)
  const beforeKid = kidOf(before)
  const initialKeys = await jwks(url)
  assert.equal(initialKeys.size, 1)
  assert.equal(verifyCredential(before, initialKeys, Math.floor(clock / 1000)).ok, true)

  const rotated = await rotate(url, admin)
  assert.equal(rotated.status, 200)
  assert.notEqual(rotated.body.kid, beforeKid)
  assert.equal(rotated.body.previousKid, beforeKid)

  // Why: a ticket in flight was signed by the retired key; hosts that already
  // refetched must still accept it rather than forcing a reconnect.
  const afterRotationKeys = await jwks(url)
  assert.deepEqual(
    [...afterRotationKeys.keys()].sort(),
    [...initialKeys.keys(), rotated.body.kid].sort()
  )
  const stillValid = verifyCredential(before, afterRotationKeys, Math.floor(clock / 1000))
  assert.equal(stillValid.ok, true)
  if (stillValid.ok) {
    assert.equal(stillValid.kid, beforeKid)
  }

  const fresh = await connect(url, dev.accessToken, dev.device.id)
  const freshKid = kidOf(fresh)
  assert.equal(freshKid, rotated.body.kid)
  assert.equal(verifyCredential(fresh, afterRotationKeys, Math.floor(clock / 1000)).ok, true)

  // 59 days later: still published, so the old signature verifies at its own issuance
  // time (a ticket itself is only valid 60s — retention is about the public key).
  clock = T0 + 59 * DAY
  const nearEnd = await jwks(url)
  assert.equal(nearEnd.has(beforeKid), true)
  assert.equal(verifyCredential(before, nearEnd, Math.floor(T0 / 1000)).ok, true)

  // Past retention: the retired key is gone, so an old-kid ticket is unknown.
  clock = T0 + KEY_RETENTION_MS + DAY
  const expired = await jwks(url)
  assert.equal(expired.has(beforeKid), false)
  assert.equal(expired.has(rotated.body.kid ?? ''), true)
  const rejected = verifyCredential(before, expired, Math.floor(T0 / 1000))
  assert.equal(rejected.ok, false)
  if (!rejected.ok) {
    assert.equal(rejected.reason, 'unknown_kid')
  }

  // The clock moved 60 days, so the original admin token has expired; sign in again.
  const freshAdmin = (await login(url, 'admin', 'Adm1n!')).accessToken ?? ''
  const auditRes = await fetch(`${url}/v1/audit/events?eventType=signing_key_rotate`, {
    headers: { authorization: `Bearer ${freshAdmin}` }
  })
  const auditBody = (await auditRes.json()) as {
    events: { actor: string; result: string; metadata: Record<string, unknown> }[]
  }
  assert.ok(auditBody.events.length > 0)
  assert.equal(auditBody.events[0].result, 'success')
  assert.equal(auditBody.events[0].metadata.previousKid, beforeKid)

  saveEvidence('m76-signing-key-rotation', 'ac-31-rotation.json', {
    beforeKid,
    newKid: rotated.body.kid,
    publishedAfterRotation: rotated.body.publishedKids,
    oldTicketValidAfterRotation: stillValid.ok,
    freshTicketKid: freshKid,
    retainedAtDay59: nearEnd.has(beforeKid),
    goneAfterRetention: expired.has(beforeKid),
    oldTicketVerdictAfterRetention: rejected.ok ? 'accepted' : rejected.reason,
    audit: auditBody.events[0] ?? null
  })
})

test('AC-31 非管理员轮换被 403 拒绝并写审计', async () => {
  const url = await startApp()
  const dev = (await login(url, 'zhangsan', 'Passw0rd!')).accessToken ?? ''
  const denied = await rotate(url, dev)
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error?.code, 'PERMISSION_DENIED')

  // The key ring is untouched: a ticket still carries the original kid.
  const keys = await jwks(url)
  assert.equal(keys.size, 1)

  const admin = (await login(url, 'admin', 'Adm1n!')).accessToken ?? ''
  // The clock moved 60 days, so the original admin token has expired; sign in again.
  const freshAdmin = (await login(url, 'admin', 'Adm1n!')).accessToken ?? ''
  const auditRes = await fetch(`${url}/v1/audit/events?eventType=signing_key_rotate`, {
    headers: { authorization: `Bearer ${freshAdmin}` }
  })
  const auditBody = (await auditRes.json()) as { events: { actor: string; result: string }[] }
  assert.equal(auditBody.events[0]?.result, 'denied')
  assert.equal(auditBody.events[0]?.actor, 'zhangsan')

  saveEvidence('m76-signing-key-rotation', 'ac-31-denied.json', {
    status: denied.status,
    code: denied.body.error?.code,
    publishedKidsAfterDenied: [...keys.keys()],
    audit: auditBody.events[0] ?? null
  })
})
