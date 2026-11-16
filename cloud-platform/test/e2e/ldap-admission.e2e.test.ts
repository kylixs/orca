import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * LGAA-3 (ldap-group-admission-design.md §6.2 E1-E6): the LDAP group admission
 * gate over real spawned API processes. The env is read once at createApp
 * startup, so withdrawing it can only be observed through a restart — E4 stops
 * its gated service and respawns without the env to pin that semantics. Every
 * spawn sets ORCA_CLOUD_LDAP_REQUIRED_GROUP explicitly so a stray value on the
 * host cannot flip a case's gate (LGAA-2 `ldapRequiredGroup: ''` precedent).
 */

const EVIDENCE = 'lgaa3-ldap-admission'
const GATE_ENV = 'ORCA_CLOUD_LDAP_REQUIRED_GROUP'
const REFUSAL_CODE = 'LDAP_GROUP_NOT_ADMITTED'
const REFUSAL_MESSAGE = '账号未加入平台准入组。'
const ADMIN_PW = 'Adm1n!'
const DEV_PW = 'Passw0rd!'

type LoginBody = {
  accessToken?: string
  user?: { username: string; roles: string[] }
  error?: { code: string; message: string }
}
type Resp = { status: number; body: LoginBody }
type AuditEvent = { actor: string | null; result: string; metadata: Record<string, unknown> | null }
type AuditResp = {
  status: number
  body: { events?: AuditEvent[]; ok?: boolean; error?: { code: string } }
}

let gatedAdmins: Service
let gatedDevs: Service
let ungated: Service
let gatedE4: Service
/** E4's post-restart service; stopped in the test, kept for abort teardown. */
let restarted: Service | undefined
let adminToken = ''

function serviceEnv(gateValue: string): Record<string, string> {
  return { PORT: '0', [GATE_ENV]: gateValue }
}

async function login(service: Service, username: string, password: string): Promise<Resp> {
  const res = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, deviceName: 'lgaa3-e2e' })
  })
  return { status: res.status, body: (await res.json()) as LoginBody }
}

function expectRefusal(res: Resp, where: string): void {
  assert.equal(
    res.status,
    401,
    `${where}: expected 401, got ${res.status} ${JSON.stringify(res.body)}`
  )
  assert.equal(res.body.error?.code, REFUSAL_CODE, where)
  // 文案原样透传给 web（app.js 登录错误直显），所以这里按字节断言。
  assert.equal(res.body.error?.message, REFUSAL_MESSAGE, where)
}

async function auditQuery(path: string): Promise<AuditResp> {
  const res = await fetch(`${gatedAdmins.url}${path}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  return { status: res.status, body: (await res.json()) as AuditResp['body'] }
}

before(async () => {
  gatedAdmins = await spawnService(
    'apps/api/src/server.ts',
    serviceEnv('platform-admins'),
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'lgaa3-gated-platform-admins'
  )
  gatedDevs = await spawnService(
    'apps/api/src/server.ts',
    serviceEnv('developers'),
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'lgaa3-gated-developers'
  )
  // 兜底 ''：宿主环境泄漏的准入组在这里被显式清掉（trim 后归 null = 关闸）。
  ungated = await spawnService(
    'apps/api/src/server.ts',
    serviceEnv(''),
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'lgaa3-ungated'
  )
  gatedE4 = await spawnService(
    'apps/api/src/server.ts',
    serviceEnv('platform-admins'),
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'lgaa3-gated-e4'
  )
  const admin = await login(gatedAdmins, 'admin', ADMIN_PW)
  assert.equal(admin.status, 200)
  adminToken = admin.body.accessToken ?? ''
}, 120_000)

after(async () => {
  await Promise.all(
    [gatedAdmins, gatedDevs, ungated, gatedE4, restarted].map((service) => service?.stop())
  )
})

describe('LGAA-3 LDAP 分组准入 e2e（§6.2 E1-E6）', () => {
  test('E1 requiredGroup=platform-admins：admin 200；zhangsan/lisi 401+文案', async () => {
    const admin = await login(gatedAdmins, 'admin', ADMIN_PW)
    assert.equal(admin.status, 200)
    assert.ok(admin.body.accessToken, 'in-group admin must get a session')
    // U145：用户页徽标读该字段，必须回显真实准入组而非静态文案。
    const users = await fetch(`${gatedAdmins.url}/v1/users`, {
      headers: { authorization: `Bearer ${admin.body.accessToken}` }
    })
    assert.equal(users.status, 200)
    const usersBody: { ldap?: { requiredGroup: string | null } } = await users.json()
    assert.deepEqual(usersBody.ldap, { requiredGroup: 'platform-admins' })
    const zhangsan = await login(gatedAdmins, 'zhangsan', DEV_PW)
    expectRefusal(zhangsan, 'zhangsan out of group')
    const lisi = await login(gatedAdmins, 'lisi', DEV_PW)
    expectRefusal(lisi, 'lisi out of group')
    saveEvidence(EVIDENCE, 'e1-platform-admins.json', {
      adminStatus: admin.status,
      zhangsan: zhangsan.body.error,
      lisi: lisi.body.error
    })
  })

  test('E2 requiredGroup=developers：zhangsan/lisi 200；admin 401（门不偏袒管理员）', async () => {
    for (const username of ['zhangsan', 'lisi']) {
      const res = await login(gatedDevs, username, DEV_PW)
      assert.equal(res.status, 200, `${username} is in developers and must pass`)
    }
    const adminRefused = await login(gatedDevs, 'admin', ADMIN_PW)
    expectRefusal(adminRefused, 'admin out of developers')
    saveEvidence(EVIDENCE, 'e2-developers.json', { adminError: adminRefused.body.error })
  })

  test('E3 不设 env（现网兼容）：三账户全 200', async () => {
    for (const [username, password] of [
      ['admin', ADMIN_PW],
      ['zhangsan', DEV_PW],
      ['lisi', DEV_PW]
    ] as const) {
      const res = await login(ungated, username, password)
      assert.equal(res.status, 200, `${username} must pass without the gate`)
    }
    saveEvidence(EVIDENCE, 'e3-ungated.json', { allThree: 200 })
  })

  test('E4 拒绝不污染锁定：5 次正确密码全 401 无 423；撤 env 重启后同账密 200', async () => {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await login(gatedE4, 'zhangsan', DEV_PW)
      expectRefusal(res, `correct-password refusal #${attempt + 1}`)
      statuses.push(res.status)
    }
    assert.ok(!statuses.includes(423), 'admission refusals must never lock')
    // 计数未被拒绝抬升：其后再错一次密码仍是 401 而非 423。
    const wrongAfter = await login(gatedE4, 'zhangsan', 'wrong-pass')
    assert.equal(wrongAfter.status, 401)
    assert.equal(wrongAfter.body.error?.code, 'INVALID_CREDENTIALS')

    // env 在 createApp 启动读点生效：撤 env 只能通过重启 spawnService 观察。
    await gatedE4.stop()
    restarted = await spawnService(
      'apps/api/src/server.ts',
      serviceEnv(''),
      /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'lgaa3-restarted-ungated'
    )
    const readmitted = await login(restarted, 'zhangsan', DEV_PW)
    assert.equal(
      readmitted.status,
      200,
      `same credentials must pass once the gate is gone: ${JSON.stringify(readmitted.body)}`
    )
    await restarted.stop()
    saveEvidence(EVIDENCE, 'e4-restart-readmits.json', {
      refusalStatuses: statuses,
      wrongAfterRefusals: wrongAfter.status,
      afterRestart: readmitted.status
    })
  })

  test('E5 handoff 传递覆盖：env 开启下先登录取码 → 兑换 200（闸门单点在登录）', async () => {
    const grant = await fetch(`${gatedAdmins.url}/v1/projects/proj_payment/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ subjectType: 'user', subjectId: 'admin', permissions: ['open'] })
    })
    assert.equal(grant.status, 200)
    const mint = await fetch(`${gatedAdmins.url}/v1/projects/proj_payment/web-handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` }
    })
    assert.equal(mint.status, 201)
    const { url } = (await mint.json()) as { url: string }
    const code = new URL(url).hash.match(/^#handoff=([^&]+)&project=/)?.[1] ?? ''
    assert.ok(code, 'the entry URL must carry the one-time code')
    const redeem = await fetch(`${gatedAdmins.url}/v1/web/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code })
    })
    const redeemed = (await redeem.json()) as LoginBody
    assert.equal(redeem.status, 200, 'handoff redeem must not re-run the login gate')
    assert.equal(redeemed.user?.username, 'admin')
    // 同一服务上登录闸仍然生效：单点性 = 兑换不触发、登录照拒。
    expectRefusal(await login(gatedAdmins, 'zhangsan', DEV_PW), 'login gate stays on')
    saveEvidence(EVIDENCE, 'e5-handoff-redeem.json', {
      redeemStatus: redeem.status,
      redeemedUser: redeemed.user?.username
    })
  })

  test('E6 审计可诊断：拒绝事件 reason=ldap_group_denied 可检索，与密码错误可区分', async () => {
    const wrong = await login(gatedAdmins, 'zhangsan', 'wrong-pass')
    assert.equal(wrong.status, 401)
    assert.equal(wrong.body.error?.code, 'INVALID_CREDENTIALS')
    const events = await auditQuery(
      '/v1/audit/events?eventType=login&result=failure&actor=zhangsan&limit=50'
    )
    assert.equal(events.status, 200)
    const reasons = (events.body.events ?? []).map((event) => event.metadata?.reason)
    assert.ok(
      reasons.includes('ldap_group_denied'),
      `refusals must be retrievable: ${JSON.stringify(reasons)}`
    )
    assert.ok(reasons.includes('invalid_credentials'), 'credential failures stay distinguishable')
    const verify = await auditQuery('/v1/audit/verify')
    assert.equal(verify.status, 200)
    assert.equal(verify.body.ok, true, 'refusal events must sit on an intact hash chain')
    saveEvidence(EVIDENCE, 'e6-audit.json', { reasons, chainOk: verify.body.ok })
  })
})
