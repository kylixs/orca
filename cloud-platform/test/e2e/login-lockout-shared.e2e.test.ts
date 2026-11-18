import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M84 (G-11 / AC-02): the five-failure lock belongs to the account, not to a
 * replica. Three real API processes share one counter service; five wrong
 * passwords spread round-robin must lock on the fifth, and an unreachable
 * counter must fail closed instead of letting attempts through.
 */

const EVIDENCE = 'm84-shared-login-lockout'
const INTERNAL_TOKEN = 'm84-lockout-token'

let counter: Service
let replicas: Service[] = []

type LoginBody = { accessToken?: string; error?: { code: string } }

async function startCounter(): Promise<Service> {
  return spawnService(
    'apps/login-lockout/src/lockout.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[login-lockout\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'login-lockout'
  )
}

async function startReplica(counterUrl: string, index: number): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_LOGIN_LOCKOUT_URL: counterUrl },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    `api-lockout-${index}`
  )
}

async function login(
  replica: Service,
  password: string,
  deviceName: string
): Promise<{ status: number; body: LoginBody }> {
  const res = await fetch(`${replica.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password,
      deviceName,
      devicePubKey: Buffer.from(`m84-${deviceName}`).toString('base64')
    })
  })
  return { status: res.status, body: (await res.json()) as LoginBody }
}

before(async () => {
  counter = await startCounter()
  replicas = await Promise.all([0, 1, 2].map((index) => startReplica(counter.url, index)))
}, { timeout: 120_000 })

after(async () => {
  await Promise.all(replicas.map((replica) => replica.stop()))
  await counter?.stop()
})

test('AC-02 三副本共享锁计数：5 次失败分散到不同副本仍锁定，成功登录后清零', async () => {
  // ---- five failures spread round-robin: each replica only sees 1-2 ----
  const statuses: number[] = []
  for (let index = 0; index < 5; index += 1) {
    const replica = replicas[index % replicas.length]
    const result = await login(replica, 'wrong-password', `m84-bad-${index}`)
    statuses.push(result.status)
  }
  // The 5th attempt is the one that locks, wherever it landed.
  assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401])
  assert.equal(statuses[4], 423, `fifth failure must lock, got ${JSON.stringify(statuses)}`)

  // A different replica, with the correct password, is still locked out.
  const elsewhere = await login(replicas[2], 'Passw0rd!', 'm84-after-lock')
  assert.equal(elsewhere.status, 423)
  assert.equal(elsewhere.body.error?.code, 'ACCOUNT_LOCKED')

  // ---- a second account is unaffected, and success clears its own counter ----
  const admin = async (password: string): Promise<number> => {
    const res = await fetch(`${replicas[1].url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'lisi',
        password,
        deviceName: 'm84-lisi',
        devicePubKey: Buffer.from('m84-lisi').toString('base64')
      })
    })
    return res.status
  }
  assert.equal(await admin('wrong'), 401)
  assert.equal(await admin('wrong'), 401)
  const ok = await admin('Passw0rd!')
  assert.equal(ok, 200)
  // Counter cleared: four more failures are needed again, not two.
  const after = [await admin('wrong'), await admin('wrong'), await admin('wrong')]
  assert.deepEqual(after, [401, 401, 401])

  saveEvidence(EVIDENCE, 'shared-lockout.json', {
    replicas: replicas.length,
    failureStatuses: statuses,
    lockedOnOtherReplica: { status: elsewhere.status, code: elsewhere.body.error?.code },
    successClearsCounter: { successStatus: ok, nextFailures: after }
  })
})

test('AC-02 计数服务不可达时登录 fail-closed（503），而不是放行', async () => {
  await counter.stop()
  for (const replica of replicas) {
    const result = await login(replica, 'Passw0rd!', 'm84-counter-down')
    assert.equal(result.status, 503, `${replica.url} must refuse while the counter is gone`)
    assert.equal(result.body.error?.code, 'PLATFORM_UNAVAILABLE')
  }
  saveEvidence(EVIDENCE, 'lockout-unavailable.json', {
    replicas: replicas.length,
    refusedWith: 'PLATFORM_UNAVAILABLE'
  })
  // Restart for the after-hook's orderly shutdown.
  counter = await startCounter()
})
