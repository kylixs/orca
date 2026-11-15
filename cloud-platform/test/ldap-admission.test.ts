import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiConfig, type ApiHandle } from '../apps/api/src/server.ts'
import {
  MockLdapAdapter,
  ldapProfile,
  type LdapAdapter,
  type LdapProfile
} from '../apps/api/src/ldap.ts'

/**
 * LGAA-2 (ldap-group-admission-design.md §6.1 A1-A12): the login-chain admission
 * gate end to end over real HTTP, in-process. Adapter-side refusals ride the
 * default Mock + `ldapRequiredGroup` (production-shaped §5.1); gate-side
 * refusals inject a plain pre-LGAA adapter via `createApp({ ldap, ldapRequiredGroup })`.
 * The A2/A3 lock assertions are behavioural: after a refusal the same account's
 * wrong-password count must continue from its prior value — neither cleared nor
 * incremented — which only a specific 401/423 sequence can prove.
 */

const ZHANGSAN_PW = 'Passw0rd!'
const ADMIN_PW = 'Adm1n!'
const REFUSAL_CODE = 'LDAP_GROUP_NOT_ADMITTED'
const REFUSAL_MESSAGE = '账号未加入平台准入组。'

type Json = Record<string, unknown>
type ErrorBody = { error: { code: string; message: string; traceId: string } }
type LoginOk = {
  accessToken: string
  refreshToken: string
  user: { username: string; roles: string[]; permissions: string[] }
}
type Resp = { status: number; body: Json & Partial<LoginOk & ErrorBody> }

const openApps: ApiHandle[] = []
after(async () => {
  for (const app of openApps) await app.close()
})

type Ctx = {
  app: ApiHandle
  base: string
  post: (path: string, body?: Json, token?: string) => Promise<Resp>
  get: (path: string, token?: string) => Promise<Resp>
}

/** `ldapRequiredGroup: ''` default keeps a stray env var from leaking into a case. */
async function startApp(config: Partial<ApiConfig> = {}): Promise<Ctx> {
  const app = createApp({ port: 0, ldapRequiredGroup: '', ...config })
  const port = await app.listen()
  openApps.push(app)
  const base = `http://127.0.0.1:${port}`
  const request = async (method: string, path: string, body?: Json, token?: string): Promise<Resp> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: res.status, body: (await res.json()) as Resp['body'] }
  }
  return {
    app,
    base,
    post: (path: string, body?: Json, token?: string) => request('POST', path, body, token),
    get: (path: string, token?: string) => request('GET', path, undefined, token)
  }
}

type Login = (username: string, password: string) => Promise<Resp>

function loginWith(ctx: Ctx): Login {
  return (username, password) =>
    ctx.post('/v1/auth/login', { username, password, deviceName: 'ldap-admission-test' })
}

function expectRefusal(res: Resp, where: string): void {
  assert.equal(res.status, 401, `${where}: expected 401, got ${res.status} ${JSON.stringify(res.body)}`)
  assert.equal(res.body.error?.code, REFUSAL_CODE, where)
  assert.equal(res.body.error?.message, REFUSAL_MESSAGE, where)
}

function expectInvalidCredentials(res: Resp, where: string): void {
  assert.equal(res.status, 401, where)
  assert.equal(res.body.error?.code, 'INVALID_CREDENTIALS', where)
}

/** Pre-LGAA adapter: password-checked, no requiredGroup concept — the gate is the only admission point (§6.1-A3). */
function plainAdapter(accounts: Map<string, { password: string; profile: LdapProfile }>): LdapAdapter {
  return {
    async authenticate(username, password) {
      const account = accounts.get(username)
      if (!account || account.password !== password) return { ok: false, reason: 'invalid_credentials' }
      return { ok: true, profile: account.profile }
    }
  }
}

function account(
  username: string,
  password: string,
  groups: string[]
): [string, { password: string; profile: LdapProfile }] {
  return [
    username,
    {
      password,
      profile: ldapProfile({ username, displayName: username, dept: 'platform', groups })
    }
  ]
}

/** Exact 401→423 arithmetic over the FR-1.4 counter (threshold 5). */
async function wrongUntilLocked(
  login: Login,
  username: string,
  wrongPassword: string,
  expectedFirstLock: number
): Promise<void> {
  for (let attempt = 1; attempt <= expectedFirstLock; attempt += 1) {
    const res = await login(username, wrongPassword)
    if (attempt < expectedFirstLock) {
      expectInvalidCredentials(res, `wrong #${attempt} must stay 401 (count continues, not reset/jumped)`)
    } else {
      assert.equal(res.status, 423, `wrong #${attempt} must hit the FR-1.4 lock`)
      assert.equal(res.body.error?.code, 'ACCOUNT_LOCKED')
    }
  }
}

function deniedEvents(app: ApiHandle, actor?: string) {
  return app.store.audit.filter(
    (event) =>
      event.eventType === 'login' &&
      event.result === 'failure' &&
      (event.metadata as { reason?: string } | undefined)?.reason === 'ldap_group_denied' &&
      (actor === undefined || event.actor === actor)
  )
}

describe('LDAP 分组准入登录链（§6.1 A1-A12）', () => {
  test('A1 在组登录成功：adapter 侧与闸门侧各验，种子角色与组无关', async () => {
    // adapter 侧（生产同形）：默认 Mock + config；lisi 不在 store 预种子，首登即种。
    const adapterSide = await startApp({ ldapRequiredGroup: 'developers' })
    const lisi = loginWith(adapterSide)
    const lisiOk = await lisi('lisi', ZHANGSAN_PW)
    assert.equal(lisiOk.status, 200)
    assert.deepEqual(lisiOk.body.user?.roles, ['developer'])
    assert.ok(adapterSide.app.store.usersByName.get('lisi')?.groups.includes('developers'))

    // 闸门侧：注入 adapter + config；profile 含 platform-admins 也不再派生管理员（§4.2 废除实证）。
    const accounts = new Map([account('wangwu', ZHANGSAN_PW, ['platform-admins', 'orca-cloud'])])
    const gateSide = await startApp({ ldap: plainAdapter(accounts), ldapRequiredGroup: 'orca-cloud' })
    const wangwu = loginWith(gateSide)
    const wangwuOk = await wangwu('wangwu', ZHANGSAN_PW)
    assert.equal(wangwuOk.status, 200)
    assert.deepEqual(wangwuOk.body.user?.roles, ['developer'])
    assert.ok(gateSide.app.store.usersByName.get('wangwu')?.groups.includes('orca-cloud'))
  })

  test('A2 adapter 侧不在组拒绝：401+码+文案；不 seed；锁定不增不清（行为等价）', async () => {
    const ctx = await startApp({ ldapRequiredGroup: 'platform-admins' })
    const login = loginWith(ctx)
    // 既有计数=1：一次错误密码。
    expectInvalidCredentials(await login('zhangsan', 'wrong-pass'), 'pre-refusal failure #1')
    // 正确密码、不在组 → 查询侧 not_admitted → 统一拒绝。
    expectRefusal(await login('zhangsan', ZHANGSAN_PW), 'adapter-side refusal')
    // 行为等价：既有值 1 继续 → 其后再错 3 次仍 401，第 4 次触锁 423。
    // 被清零则第 4 次仍是 401（第 5 次才锁）；被 +1 则第 3 次就 423。
    await wrongUntilLocked(login, 'zhangsan', 'wrong-pass', 4)
    // lisi 不在 store 预种子（仅 admin/zhangsan）：拒绝后同样不物化 User 行。
    expectRefusal(await login('lisi', ZHANGSAN_PW), 'adapter-side refusal (unseeded account)')
    assert.equal(ctx.app.store.usersByName.has('lisi'), false, 'refused user must not be seeded')
  })

  test('A3 闸门侧不在组拒绝：同码同文案同审计；清零已发生、不增量（行为等价）', async () => {
    const accounts = new Map([account('wangwu', ZHANGSAN_PW, ['developers'])])
    const ctx = await startApp({ ldap: plainAdapter(accounts), ldapRequiredGroup: 'orca-cloud' })
    const login = loginWith(ctx)
    expectInvalidCredentials(await login('wangwu', 'wrong-pass'), 'pre-refusal failure #1')
    // 密码已验（adapter ok）→ clearLoginFailures 已跑 → 闸门统一拒绝。
    expectRefusal(await login('wangwu', ZHANGSAN_PW), 'gate-side refusal')
    assert.equal(ctx.app.store.usersByName.has('wangwu'), false)
    assert.equal(deniedEvents(ctx.app, 'wangwu').length, 1, 'gate refusal must audit ldap_group_denied')
    // 清零后从头计数：其后再错 4 次 401，第 5 次才触锁。
    // 未清零则第 4 次就 423；清零后又 +1 则第 4 次也 423 —— 只有「清零且不增量」对上本序列。
    await wrongUntilLocked(login, 'wangwu', 'wrong-pass', 5)
  })

  test('A4 拒绝后再入组：同账密立即 200，无锁定残留', async () => {
    const accounts = new Map([account('zhangsan', ZHANGSAN_PW, ['developers'])])
    const ctx = await startApp({
      ldap: new MockLdapAdapter(accounts, { requiredGroup: 'platform-admins' }),
      ldapRequiredGroup: 'platform-admins'
    })
    const login = loginWith(ctx)
    expectRefusal(await login('zhangsan', ZHANGSAN_PW), 'refusal before joining group')
    // adapter 改判在组（目录侧入组）→ 同账密立即通过。
    accounts.get('zhangsan')?.profile.groups.push('platform-admins')
    const ok = await login('zhangsan', ZHANGSAN_PW)
    assert.equal(ok.status, 200, `re-admitted login must pass: ${JSON.stringify(ok.body)}`)
    assert.deepEqual(ok.body.user?.roles, ['developer'])
  })

  test('A5 未配置准入组：三 mock 账户全 200；无 not_admitted、无拒绝审计；lisi 首登 developer', async () => {
    const ctx = await startApp({})
    const login = loginWith(ctx)
    for (const [username, password] of [
      ['admin', ADMIN_PW],
      ['zhangsan', ZHANGSAN_PW],
      ['lisi', ZHANGSAN_PW]
    ] as const) {
      const res = await login(username, password)
      assert.equal(res.status, 200, `${username} must pass without admission config`)
    }
    assert.deepEqual(ctx.app.store.usersByName.get('lisi')?.roles, ['developer'])
    assert.equal(deniedEvents(ctx.app).length, 0, 'no ldap_group_denied audit without the gate')
  })

  test('A6 种子用户兼容：admin 种子角色保留；roleOverride 优先；移出组下次登录即拒', async () => {
    const accounts = new Map([account('admin', ADMIN_PW, ['platform-admins'])])
    const ctx = await startApp({
      ldap: new MockLdapAdapter(accounts, { requiredGroup: 'platform-admins' }),
      ldapRequiredGroup: 'platform-admins'
    })
    const login = loginWith(ctx)
    // 启动种子 admin：在组通过，种子角色不因准入改动而丢。
    const seeded = await login('admin', ADMIN_PW)
    assert.equal(seeded.status, 200)
    assert.deepEqual(seeded.body.user?.roles, ['platform:admin', 'developer'])
    // roleOverride 优先于种子（准入与角色正交）：组只管门，角色只看 override。
    const admin = ctx.app.store.usersByName.get('admin')
    if (admin) admin.roleOverride = 'auditor'
    const overridden = await login('admin', ADMIN_PW)
    assert.deepEqual(overridden.body.user?.roles, ['developer', 'platform:auditor'])
    // 种子用户被移出组：下次登录同样 401（不因既有 User 行豁免）。
    const profile = accounts.get('admin')?.profile
    if (profile) profile.groups = []
    expectRefusal(await login('admin', ADMIN_PW), 'seeded user removed from group')
  })

  test('A7 匹配边界：精确 CN 命中；前缀相似/大小写偏差 fail-closed（闸门+Mock 双验）', async () => {
    const cases = [
      { groups: ['team-x', 'orca-cloud'], admitted: true },
      { groups: ['orca-cloud-2'], admitted: false },
      { groups: ['Orca-Cloud'], admitted: false }
    ] as const
    // 闸门侧：注入 adapter，profile 可变。
    const gateAccounts = new Map([account('zhangsan', ZHANGSAN_PW, [])])
    const gate = await startApp({ ldap: plainAdapter(gateAccounts), ldapRequiredGroup: 'orca-cloud' })
    const gateLogin = loginWith(gate)
    // Mock 侧：MockLdapAdapter 自带 requiredGroup（查询侧同形）。
    const mockAccounts = new Map([account('zhangsan', ZHANGSAN_PW, [])])
    const mock = await startApp({
      ldap: new MockLdapAdapter(mockAccounts, { requiredGroup: 'orca-cloud' })
    })
    const mockLogin = loginWith(mock)
    for (const { groups, admitted } of cases) {
      const gateProfile = gateAccounts.get('zhangsan')?.profile
      if (gateProfile) gateProfile.groups = [...groups]
      const mockProfile = mockAccounts.get('zhangsan')?.profile
      if (mockProfile) mockProfile.groups = [...groups]
      const gateRes = await gateLogin('zhangsan', ZHANGSAN_PW)
      const mockRes = await mockLogin('zhangsan', ZHANGSAN_PW)
      const where = `groups=${JSON.stringify(groups)}`
      if (admitted) {
        assert.equal(gateRes.status, 200, `gate side ${where}`)
        assert.equal(mockRes.status, 200, `mock side ${where}`)
      } else {
        expectRefusal(gateRes, `gate side ${where}`)
        expectRefusal(mockRes, `mock side ${where}`)
      }
    }
  })

  test('A8 凭据失败优先：错误密码在组/不在组均 INVALID_CREDENTIALS 并计数', async () => {
    const ctx = await startApp({ ldapRequiredGroup: 'platform-admins' })
    const login = loginWith(ctx)
    // 错误密码 + 在组（admin）→ 凭据路径，非准入拒绝。
    expectInvalidCredentials(await login('admin', 'wrong-pass'), 'wrong pw + in group')
    // 错误密码 + 不在组（zhangsan）→ Mock 先验密码（§5.1 如实差异）。
    expectInvalidCredentials(await login('zhangsan', 'wrong-pass'), 'wrong pw + out of group')
    // 凭据路径计数照走：zhangsan 既有计数 1，再错 4 次触锁（第 5 次失败即锁）。
    await wrongUntilLocked(login, 'zhangsan', 'wrong-pass', 4)
    // 闸门侧不掩盖凭据路径：注入 adapter 的 invalid_credentials 同样 401+码。
    const gate = await startApp({
      ldap: plainAdapter(new Map([account('zhangsan', ZHANGSAN_PW, ['developers'])])),
      ldapRequiredGroup: 'orca-cloud'
    })
    expectInvalidCredentials(
      await loginWith(gate)('zhangsan', 'wrong-pass'),
      'gate side wrong pw stays credentials path'
    )
  })

  test('A9 移出组不追溯（一期边界）：存量会话/refresh 仍 200；再登录 401', async () => {
    const accounts = new Map([account('zhangsan', ZHANGSAN_PW, ['developers'])])
    const ctx = await startApp({
      ldap: new MockLdapAdapter(accounts, { requiredGroup: 'developers' })
    })
    const login = loginWith(ctx)
    const first = await login('zhangsan', ZHANGSAN_PW)
    assert.equal(first.status, 200)
    const { accessToken, refreshToken } = first.body as LoginOk
    const profile = accounts.get('zhangsan')?.profile
    if (profile) profile.groups = []
    // 存量会话不追溯：refresh 与 me 均仍 200。
    const refresh = await ctx.post('/v1/auth/refresh', { refreshToken })
    assert.equal(refresh.status, 200, 'existing session must survive removal (phase-1 boundary)')
    const me = await ctx.get('/v1/me', accessToken)
    assert.equal(me.status, 200, 'existing session must survive removal (phase-1 boundary)')
    // 下次登录即拒。
    expectRefusal(await login('zhangsan', ZHANGSAN_PW), 'login after removal')
  })

  test('A10 空白配置值归一为关闭：等价 A5 全放行', async () => {
    for (const blank of ['   ', '']) {
      const ctx = await startApp({ ldapRequiredGroup: blank })
      const login = loginWith(ctx)
      for (const [username, password] of [
        ['admin', ADMIN_PW],
        ['zhangsan', ZHANGSAN_PW],
        ['lisi', ZHANGSAN_PW]
      ] as const) {
        const res = await login(username, password)
        assert.equal(res.status, 200, `${username} must pass with blank value ${JSON.stringify(blank)}`)
      }
      assert.equal(deniedEvents(ctx.app).length, 0)
    }
  })

  test('A11 准入开启 + LDAP 不可达：fail-closed 无会话无 seed；现状 401+计数如实记录', async () => {
    const unavailable: LdapAdapter = {
      async authenticate() {
        return { ok: false, reason: 'unavailable' }
      }
    }
    const ctx = await startApp({ ldap: unavailable, ldapRequiredGroup: 'orca-cloud' })
    const login = loginWith(ctx)
    // 现状疣（:1703-1720 不分 reason）：unavailable 走凭据分支 401+计数，不改进为 503。
    expectInvalidCredentials(await login('lisi', ZHANGSAN_PW), 'unavailable maps to 401 (documented wart)')
    assert.equal(ctx.app.store.usersByName.has('lisi'), false, 'no seed on unavailable')
    assert.equal(ctx.app.store.sessions.size, 0, 'no session on unavailable')
    assert.equal(deniedEvents(ctx.app).length, 0, 'unavailable is not an admission refusal')
    // 无准入绕过且计数照走：既有 1 次 + 再 4 次 → 第 5 次触锁。
    await wrongUntilLocked(login, 'lisi', ZHANGSAN_PW, 4)
  })

  test('A12 审计落链：拒绝事件经 /v1/audit/verify 通过；按 reason 检索；metadata 改写断链', async () => {
    // 闸门侧 app：worker 不在组（拒），auditor 在组并授审计角色（持牌查询）。
    const gateAccounts = new Map([
      account('worker', ZHANGSAN_PW, ['developers']),
      account('auditor', ZHANGSAN_PW, ['orca-cloud'])
    ])
    const gate = await startApp({ ldap: plainAdapter(gateAccounts), ldapRequiredGroup: 'orca-cloud' })
    const gateLogin = loginWith(gate)
    const auditorFirst = await gateLogin('auditor', ZHANGSAN_PW)
    assert.equal(auditorFirst.status, 200)
    const auditorUser = gate.app.store.usersByName.get('auditor')
    if (auditorUser) auditorUser.roleOverride = 'auditor'
    const auditor = await gateLogin('auditor', ZHANGSAN_PW)
    assert.deepEqual(auditor.body.user?.roles, ['developer', 'platform:auditor'])
    const auditorToken = (auditor.body as LoginOk).accessToken
    // 两条可区分的失败：闸门准入拒绝 + 密码错误。
    expectInvalidCredentials(await gateLogin('worker', 'wrong-pass'), 'worker wrong pw')
    expectRefusal(await gateLogin('worker', ZHANGSAN_PW), 'worker gate refusal')
    // 验链通过（拒绝事件在链上）。
    const verify = await gate.get('/v1/audit/verify', auditorToken)
    assert.equal(verify.status, 200)
    assert.equal(verify.body.ok, true)
    // 按查询检索：同 actor 的两类 failure 各就各位，reason 可区分。
    const events = await gate.get('/v1/audit/events?eventType=login&result=failure&actor=worker&limit=50', auditorToken)
    assert.equal(events.status, 200)
    const reasons = ((events.body as { events: { metadata?: { reason?: string } }[] }).events ?? []).map(
      (event) => event.metadata?.reason
    )
    assert.ok(reasons.includes('ldap_group_denied'), `refusal must be retrievable: ${JSON.stringify(reasons)}`)
    assert.ok(reasons.includes('invalid_credentials'), 'credential failure must stay distinguishable')
    // metadata 参与哈希：改写拒绝事件 metadata → verify 断链 409。
    const refused = deniedEvents(gate.app, 'worker')[0]
    assert.ok(refused, 'refusal event present in chain')
    refused.metadata = { reason: 'tampered' }
    const afterTamper = await gate.get('/v1/audit/verify', auditorToken)
    assert.equal(afterTamper.status, 409)
    assert.equal(afterTamper.body.ok, false)
    assert.equal(afterTamper.body.brokenAtSeq, refused.seq)

    // adapter 侧（A2 生产同形路径）的拒绝事件同样验链通过。
    const adapterSide = await startApp({ ldapRequiredGroup: 'platform-admins' })
    const adapterLogin = loginWith(adapterSide)
    expectRefusal(await adapterLogin('zhangsan', ZHANGSAN_PW), 'adapter-side refusal for audit')
    const adminToken = (await adapterLogin('admin', ADMIN_PW)).body as LoginOk
    const adapterVerify = await adapterSide.get('/v1/audit/verify', adminToken.accessToken)
    assert.equal(adapterVerify.status, 200)
    assert.equal(adapterVerify.body.ok, true)
    assert.equal(deniedEvents(adapterSide.app, 'zhangsan').length, 1)
  })
})
