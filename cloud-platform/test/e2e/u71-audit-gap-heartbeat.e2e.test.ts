import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { saveEvidence } from './harness.ts'

/**
 * U71: the heartbeat's auditGap lands as `host.audit_gap` chain events as
 * per-boot deltas (§2.10.4). The same counters on every 10s beat must not
 * flood the chain, a rising counter lands once as its increment, and a restart
 * (new bootId) with undelivered pending counts once as dropped.
 */

const INTERNAL_TOKEN = 'u71-internal'
let clock = 1_900_000_000_000
// U274: unique legal ports — U265's isDialableDirectAddr rejects out-of-range ones.
let nextDirectPort = 17001
let app: ApiHandle
let url = ''
let adminToken = ''

const gapEvents = (hostId: string) =>
  app.store.audit.filter(
    (event) => event.eventType === 'host.audit_gap' && event.targetId === hostId
  )

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceName: `u71-${username}`,
      devicePubKey: Buffer.from(`u71-${username}`).toString('base64')
    })
  })
  const body = (await res.json()) as { accessToken?: string }
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.accessToken ?? ''
}

async function registerHost(name: string): Promise<{ hostId: string; credential: string }> {
  const directAddr = `127.0.0.1:${nextDirectPort++}`
  const tokenRes = await fetch(`${url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name,
      fingerprint: `sha256:${name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: [directAddr],
      relayTarget: directAddr,
      relayRoute: name,
      runtimeCapabilities: ['pty', 'files']
    })
  })
  const body = (await res.json()) as { hostId: string; credential: string }
  assert.equal(res.status, 201, JSON.stringify(body))
  return body
}

async function beat(
  hostId: string,
  credential: string,
  auditGap: Record<string, unknown>
): Promise<void> {
  clock += 1_000
  const res = await fetch(`${url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ status: 'online', auditGap })
  })
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(res.status, 200, JSON.stringify(body))
}

before(async () => {
  app = createApp({ port: 0, now: () => clock, internalToken: INTERNAL_TOKEN })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`
  adminToken = await login('admin', 'Adm1n!')
})

after(async () => {
  saveEvidence('u71-audit-gap', 'audit-gap-heartbeat.json', {
    generatedAt: new Date().toISOString(),
    hostAuditGapEvents: app.store.audit.filter((event) => event.eventType === 'host.audit_gap'),
    chain: app.audit.verify()
  })
  await app.close()
})

describe('U71 auditGap 同值不刷屏：心跳 delta 早退专测', () => {
  test('同一 bootId 相同计数器连发两拍 → 链上恰 1 条 host.audit_gap', async () => {
    const { hostId, credential } = await registerHost('u71-steady')
    const gap = { bootId: 'boot-steady', pending: 2, dropped: 3, suppressed: 1, rateLimited: 4 }

    await beat(hostId, credential, gap)
    assert.equal(gapEvents(hostId).length, 1, 'the first beat lands its full counters once')
    const first = gapEvents(hostId)[0]
    assert.equal(first.actor, `host:u71-steady`)
    assert.equal(first.targetId, hostId)
    assert.equal(first.metadata.bootId, 'boot-steady')
    assert.equal(first.metadata.pending, 2)
    assert.equal(first.metadata.dropped, 3)
    assert.equal(first.metadata.suppressed, 1)
    assert.equal(first.metadata.rateLimited, 4)

    await beat(hostId, credential, { ...gap })
    assert.equal(
      gapEvents(hostId).length,
      1,
      'the second beat with identical counters must not append a second host.audit_gap'
    )
  })

  test('计数变化再发一拍 → 新增恰 1 条，metadata 是增量而非累计值', async () => {
    const { hostId, credential } = await registerHost('u71-rising')
    const zero = { bootId: 'boot-rise', pending: 0, dropped: 0, suppressed: 0, rateLimited: 0 }

    await beat(hostId, credential, { ...zero })
    assert.equal(gapEvents(hostId).length, 0, 'an all-zero beat changes nothing')

    await beat(hostId, credential, { ...zero, dropped: 5 })
    assert.equal(gapEvents(hostId).length, 1)
    assert.equal(
      gapEvents(hostId)[0].metadata.dropped,
      5,
      'first sight of a counter lands its full value'
    )

    await beat(hostId, credential, { ...zero, dropped: 7, rateLimited: 2 })
    assert.equal(gapEvents(hostId).length, 2, 'exactly one new event for the changed beat')
    const latest = gapEvents(hostId)[1]
    assert.equal(latest.metadata.dropped, 2, 'the delta is 7-5=2, never the cumulative 7')
    assert.equal(latest.metadata.rateLimited, 2)
    assert.equal(latest.metadata.suppressed, 0)
  })

  test('bootId 变化 + 旧 boot pending>0 → 恰 1 条，丢的 pending 记一次 dropped', async () => {
    const { hostId, credential } = await registerHost('u71-restart')

    await beat(hostId, credential, {
      bootId: 'boot-old',
      pending: 3,
      dropped: 0,
      suppressed: 0,
      rateLimited: 0
    })
    assert.equal(gapEvents(hostId).length, 0, 'pending alone never lands a chain event')

    await beat(hostId, credential, {
      bootId: 'boot-new',
      pending: 0,
      dropped: 0,
      suppressed: 0,
      rateLimited: 0
    })
    assert.equal(gapEvents(hostId).length, 1, 'the restart counts the lost pending exactly once')
    const restart = gapEvents(hostId)[0]
    assert.equal(restart.metadata.bootId, 'boot-new')
    assert.equal(restart.metadata.pending, 0)
    assert.equal(restart.metadata.dropped, 3, 'lostPending = the old boot\'s pending')
    assert.equal(restart.metadata.suppressed, 0)
    assert.equal(restart.metadata.rateLimited, 0)
  })

  test('三台主机的 gap 事件后链校验通过', async () => {
    const verdict = await app.audit.verify()
    assert.equal(verdict.ok, true)
    assert.equal(
      app.store.audit.filter((event) => event.eventType === 'host.audit_gap').length,
      4
    )
  })
})
