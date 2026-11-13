import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M77 (G-02 / AC-29) platform half: when a host reports a different E2EE key,
 * the platform leaves an auditable record — the only durable trace of what a
 * client-side pin would later reject.
 */

const EVIDENCE = 'm77-host-key-pinning'
let api: Service
let adminToken = ''
let hostId = ''
let credential = ''

type AuditRow = {
  eventType: string
  targetType: string
  targetId: string
  result: string
  metadata: Record<string, unknown>
}

async function heartbeat(e2eePublicKeyB64: string): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ status: 'online', e2eePublicKeyB64 })
  })
  assert.equal(res.status, 200)
}

async function keyChangeEvents(): Promise<AuditRow[]> {
  const res = await fetch(`${api.url}/v1/audit/events?eventType=host_e2ee_key_changed`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: AuditRow[] }).events
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-host-key-audit'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  const registered = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'm77-keyed-host',
    directAddr: '127.0.0.1:16772',
    relayTarget: '127.0.0.1:16772'
  })
  hostId = registered.hostId
  credential = registered.credential
})

after(async () => {
  await api?.stop()
})

test('主机上报不同 E2EE 公钥：写审计并只记录指纹，connect 下发新公钥', async () => {
  const first = Buffer.from('m77-e2ee-key-A').toString('base64')
  const second = Buffer.from('m77-e2ee-key-B').toString('base64')

  // The registration key differs from the first beat, so that one is already a change.
  await heartbeat(first)
  const afterFirst = await keyChangeEvents()
  assert.ok(afterFirst.length >= 1)
  assert.equal(afterFirst[0].targetType, 'host')
  assert.equal(afterFirst[0].targetId, hostId)
  assert.equal(afterFirst[0].result, 'success')
  assert.match(String(afterFirst[0].metadata.fingerprint), /^sha256:[0-9a-f]{16}$/)
  // Never the key itself: the audit is readable by auditors who need no E2EE material.
  assert.equal(JSON.stringify(afterFirst[0].metadata).includes(first), false)

  // Repeating the same key must not spam the chain.
  await heartbeat(first)
  assert.equal((await keyChangeEvents()).length, afterFirst.length)

  await heartbeat(second)
  const afterSecond = await keyChangeEvents()
  assert.equal(afterSecond.length, afterFirst.length + 1)
  assert.notEqual(afterSecond[0].metadata.fingerprint, afterSecond[1].metadata.fingerprint)
  assert.equal(afterSecond[0].metadata.previousFingerprint, afterSecond[1].metadata.fingerprint)

  const devLogin = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      deviceName: 'm77-dev',
      devicePubKey: Buffer.from('m77-device').toString('base64')
    })
  })
  const dev = (await devLogin.json()) as { accessToken?: string; device?: { id: string } }
  assert.ok(dev.accessToken && dev.device?.id)

  const created = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'm77-keyed-svc',
      name: 'm77-keyed-svc',
      hostId,
      path: '/srv/work/m77-keyed-svc'
    })
  })
  assert.equal(created.status, 201)
  const project = (await created.json()) as { id: string }
  const grant = await fetch(`${api.url}/v1/projects/${project.id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: ['open'] })
  })
  assert.equal(grant.status, 200)

  const connect = await fetch(`${api.url}/v1/projects/${project.id}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${dev.accessToken}` },
    body: JSON.stringify({
      deviceId: dev.device.id,
      devicePubKey: Buffer.from('m77-device').toString('base64'),
      clientVersion: '1.5.0'
    })
  })
  assert.equal(connect.status, 200)
  const ticket = (await connect.json()) as { host: { e2eePublicKeyB64: string } }
  assert.equal(ticket.host.e2eePublicKeyB64, second)

  saveEvidence(EVIDENCE, 'platform-key-change-audit.json', {
    events: afterSecond.slice(0, 2),
    ticketKeyMatchesLatest: ticket.host.e2eePublicKeyB64 === second,
    eventCount: afterSecond.length
  })
})
