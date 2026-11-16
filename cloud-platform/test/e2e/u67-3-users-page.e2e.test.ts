import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { login, saveEvidence, spawnService, ROOT, type Service } from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U67-3 用户管理页：平台级三角色（普通/审计/管理员）的列表、写入与门禁。
 *
 * - 列表 GET /v1/users（admin-only）+ 非 admin 403 + denied 审计
 * - 角色写入 PUT /v1/users/{id}/roles：role_update 审计、服务端门禁实时生效
 *   （access token 是 opaque 键，角色每请求重算）、管理员降级撤凭证
 * - roleOverride 优先于 LDAP 种子：再次登录不被同步覆盖
 * - UI（U81/U82）：#/users 页渲染 + 原型结构对照 + 查询四态 + 只读列表 +
 *   详情弹框字段 + 弹框内角色修改确认链（降级 danger）→ 列表/弹框/来源同步
 */

const EVIDENCE = 'u67-3-users-page'
const INTERNAL_TOKEN = 'u67-3-users-internal'
/** 原型是 UI 权威：#/users 页的稳定文案锚点必须逐字出现在实现页里。 */
const PROTOTYPE_PATH = join(
  ROOT,
  '../remote-connectivity/design/2026-11-13-cloud-dev-platform/ui/prototype.html'
)

let service: Service
let adminToken = ''
let zhangsanToken = ''
let lisiToken = ''
let zhangsanId = ''
let lisiId = ''

type UserRow = {
  id: string
  username: string
  displayName: string
  dept: string
  groups: string[]
  roles: string[]
  status: string
  role: 'developer' | 'auditor' | 'admin'
  roleSource: 'ldap' | 'admin-override'
}

async function api(
  path: string,
  init: RequestInit & { token?: string } = {}
  // oxlint-disable-next-line typescript/no-explicit-any -- assert-driven shape
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${init.token ?? adminToken}`,
      ...init.headers
    },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function auditEvents(
  query: string
): Promise<
  { eventType: string; actor: string | null; result: string; metadata: Record<string, unknown> }[]
> {
  const res = await api(`/v1/audit/events?${query}&limit=50`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body.events
}

async function userByName(username: string): Promise<UserRow> {
  const res = await api('/v1/users')
  assert.equal(res.status, 200)
  const found = res.body.users.find((user: UserRow) => user.username === username)
  assert.ok(found, `user ${username} must be listed`)
  return found
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u67-3-users'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  zhangsanToken = await login(service.url, 'zhangsan', 'Passw0rd!')
  lisiToken = await login(service.url, 'lisi', 'Passw0rd!')
}, 120_000)

after(async () => {
  await service?.stop()
})

test('UG-6 UI：admin 渲染 #/users 页（U81 查询四态 + U82 只读列表/详情弹框/确认链）', async () => {
  const listed = await api('/v1/users')
  assert.equal(listed.status, 200)
  zhangsanId = listed.body.users.find((u: UserRow) => u.username === 'zhangsan').id
  // 变更前的来源是 LDAP 同步：翻转断言需要这个起点。
  assert.equal(listed.body.users.find((u: UserRow) => u.username === 'zhangsan').roleSource, 'ldap')
  // 本套件 before 已登录 admin/zhangsan/lisi 三个账号，目录即这三行。
  assert.deepEqual(listed.body.users.map((u: UserRow) => u.username).sort(), [
    'admin',
    'lisi',
    'zhangsan'
  ])

  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  assert.equal(page.hidden('#adminNav'), false)

  const usersNav = page.window.document.querySelector<HTMLElement>('.nav-item[data-route="users"]')
  assert.ok(usersNav, 'the users nav item must exist')
  assert.equal(usersNav.textContent?.trim(), '用户管理')
  assert.equal(usersNav.hidden, false, 'an admin must see the users nav item')

  await page.clickNav('users')
  assert.equal(page.text('#crumbs'), '用户管理')
  const doc = page.window.document
  assert.match(page.text('#content'), /用户管理/)

  // ---- 结构对照：原型 #/users 节（UI 权威）的锚点逐字出现 ----
  const prototype = readFileSync(PROTOTYPE_PATH, 'utf8')
  const sectionStart = prototype.indexOf('<section class="page" data-page="users"')
  const sectionEnd = prototype.indexOf('<section class="page" data-page="audit"')
  assert.ok(sectionStart > 0 && sectionEnd > sectionStart, 'prototype #/users section must exist')
  const prototypeSection = prototype.slice(sectionStart, sectionEnd)
  const prototypeText = prototypeSection.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const contentText = page.text('#content').replace(/\s+/g, ' ')
  const anchors = [
    '用户管理',
    'LDAP 同步正常',
    '角色 ≠ 资源授权（两层模型）',
    '账号与角色',
    '列表只读 · 角色在详情中修改 · 变更写入 role_update 审计',
    '按用户覆盖，覆盖记录留审计',
    '服务端按请求实时判定角色',
    '角色语义：普通',
    '新用户首登角色一律普通',
    '升权经用户管理页覆盖'
  ]
  const missing = anchors.filter(
    (anchor) => !prototypeText.includes(anchor) || !contentText.includes(anchor)
  )
  assert.deepEqual(missing, [], `prototype anchors missing from the live page: ${missing}`)

  // 表格列逐一对照原型（U82：角色只读 + 操作列）
  const prototypeColumns = [...prototypeSection.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) =>
    m[1].trim()
  )
  const liveColumns = [...doc.querySelectorAll('#content thead th')].map(
    (th) => th.textContent?.trim() ?? ''
  )
  assert.deepEqual(liveColumns, prototypeColumns)
  assert.deepEqual(liveColumns, ['用户', '部门', 'LDAP 组', '角色', '角色来源', '状态', '操作'])

  // ---- U81 查询栏：控件形态（关键字/角色/状态 + 查询/重置） ----
  const search = doc.querySelector<HTMLInputElement>('#userSearch')
  assert.ok(search, 'the keyword input must exist')
  assert.match(search.placeholder, /显示名或账号/)
  const roleFilter = doc.querySelector<HTMLSelectElement>('#userRoleFilter')
  assert.deepEqual(
    [...roleFilter!.options].map((option) => [option.value, option.textContent]),
    [
      ['all', '全部角色'],
      ['developer', '普通'],
      ['auditor', '审计'],
      ['admin', '管理员']
    ]
  )
  const statusFilter = doc.querySelector<HTMLSelectElement>('#userStatusFilter')
  assert.deepEqual(
    [...statusFilter!.options].map((option) => [option.value, option.textContent]),
    [
      ['all', '全部状态'],
      ['active', '活跃'],
      ['disabled', '已停用']
    ]
  )
  assert.equal(doc.querySelector('#userFilterApply')?.textContent?.trim(), '查询')
  assert.equal(doc.querySelector('#userFilterReset')?.textContent?.trim(), '重置')

  const rows = () => [...doc.querySelectorAll('#usersBody tr')]
  const foot = () => doc.querySelector('#usersFoot')?.textContent ?? ''
  const input = (selector: string, value: string) => {
    const el = doc.querySelector<HTMLInputElement>(selector)!
    el.value = value
    el.dispatchEvent(new page.window.Event('input', { bubbles: true }))
  }
  const select = (selector: string, value: string) => {
    const el = doc.querySelector<HTMLSelectElement>(selector)!
    el.value = value
    el.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  }
  const select0 = (el: HTMLSelectElement, value: string) => {
    el.value = value
    el.dispatchEvent(new page.window.Event('change', { bubbles: true }))
  }
  const rowText = (username: string) =>
    rows().find((row) => row.textContent?.includes(username))?.textContent ?? ''

  // 态 1：关键字（账号子串即输即筛）
  input('#userSearch', 'zhang')
  assert.equal(rows().length, 1, 'keyword must filter to zhangsan')
  assert.match(rows()[0].textContent ?? '', /张伟/)
  assert.match(foot(), /共 3 个账号 · 当前筛选 1 个/)
  // 态 1b：关键字（显示名子串）
  input('#userSearch', '李')
  assert.equal(rows().length, 2, 'display-name keyword must match 李静 and 李四')
  // 态 2：角色
  input('#userSearch', '')
  select('#userRoleFilter', 'admin')
  assert.equal(rows().length, 1)
  assert.match(rows()[0].textContent ?? '', /李静/)
  // 态 3：状态（目录无停用账号 → 空态）
  select('#userRoleFilter', 'all')
  select('#userStatusFilter', 'disabled')
  assert.equal(rows().length, 1, 'the empty state replaces rows with one row')
  assert.equal(
    doc.querySelector('#usersBody .table-empty')?.textContent?.trim(),
    '没有符合筛选条件的账号——请调整关键字或重置条件'
  )
  // 态 4：组合（关键字 + 角色 AND）
  select('#userStatusFilter', 'all')
  input('#userSearch', 'zhang')
  select('#userRoleFilter', 'admin')
  assert.equal(doc.querySelector('#usersBody .table-empty') !== null, true, 'AND must yield no row')
  // 「查询」按钮兜底：输入未触发 input 事件时也能重放
  select('#userRoleFilter', 'all')
  const searchEl = doc.querySelector<HTMLInputElement>('#userSearch')!
  searchEl.value = 'lisi'
  ;(doc.querySelector('#userFilterApply') as HTMLElement).click()
  assert.equal(rows().length, 1)
  assert.match(rows()[0].textContent ?? '', /李四/)
  // 重置：清空三条件并恢复双口径计数（无「当前筛选」）
  ;(doc.querySelector('#userFilterReset') as HTMLElement).click()
  assert.equal(rows().length, 3)
  assert.equal(searchEl.value, '')
  assert.match(foot(), /^共 3 个账号 · 服务端按请求实时判定角色/)
  assert.doesNotMatch(foot(), /当前筛选/)

  // ---- U82 列表只读：行内无任何写控件，唯一动作「详情」 ----
  assert.equal(doc.querySelector('#usersBody select'), null, 'the table row must carry no control')
  assert.equal(doc.querySelector('#content tbody select'), null)
  assert.equal(doc.querySelector('[data-user-role]'), null)
  assert.equal(doc.querySelectorAll('#usersBody [data-user-detail]').length, 3)
  assert.equal(rowText('zhangsan').includes('普通'), true, 'the role renders as plain text')
  assert.equal(rowText('zhangsan').includes('LDAP 同步'), true)

  // ---- U82 详情弹框：字段集 = users API 实有字段（不虚构创建时间/最近登录） ----
  ;(doc.querySelector(`[data-user-detail="${zhangsanId}"]`) as HTMLElement).click()
  const backdrops = () => [...doc.querySelectorAll('.dialog-backdrop')]
  const detail = () => backdrops()[backdrops().length - 1]
  assert.equal(backdrops().length, 1, 'the detail modal must open')
  assert.equal(detail().querySelector('h2')?.textContent, '用户详情 · 张伟')
  assert.deepEqual(
    [...detail().querySelectorAll('.kv dt')].map((dt) => dt.textContent),
    ['显示名', '账号', '部门', 'LDAP 组', '平台角色', '角色来源', '状态']
  )
  const detailValues = [...detail().querySelectorAll('.kv dd')].map((dd) => dd.textContent ?? '')
  assert.equal(detailValues[0].trim(), '张伟')
  assert.equal(detailValues[1].trim(), 'zhangsan')
  assert.equal(detailValues[2].trim(), '支付研发部')
  assert.match(detailValues[3], /developers, team-payment/)
  assert.match(detailValues[4], /点击可修改/)
  assert.match(detailValues[5], /LDAP 同步/)
  assert.match(detailValues[6], /活跃/)
  const detailRole = () => detail().querySelector<HTMLSelectElement>('[data-detail-role]')!
  assert.equal(detailRole().value, 'developer')
  assert.equal(detailRole().disabled, false)

  // ---- 角色修改确认链（升级）：弹框内下拉 → 确认 → PUT → 弹框/列表/来源同步 ----
  select0(detailRole(), 'auditor')
  assert.equal(backdrops().length, 2, 'change must open the confirm dialog above the detail')
  const confirmUp = backdrops()[backdrops().length - 1]
  const confirmText = confirmUp.textContent ?? ''
  assert.match(confirmText, /角色变更/)
  assert.match(confirmText, /张伟（zhangsan）：普通 → 审计/)
  assert.match(confirmText, /role_update 审计/)
  assert.match(confirmText, /按用户覆盖优先于 LDAP 同步/)
  assert.match(confirmText, /升级即时生效，不断开会话/)
  const upConfirm = confirmUp.querySelector<HTMLButtonElement>('[data-action="0"]')!
  assert.equal(upConfirm.textContent?.trim(), '确认变更')
  assert.equal(upConfirm.classList.contains('danger'), false, 'an upgrade is not danger-styled')
  upConfirm.click()
  await page.settle()

  assert.ok(
    page.calls().includes(`PUT /v1/users/${zhangsanId}/roles`),
    `the confirm must PUT the new role: ${page.calls().join(', ')}`
  )
  assert.match(doc.querySelector('.toast')?.textContent ?? '', /张伟 的角色更新为审计/)
  // 确认后弹框保持打开并刷新为新角色，来源翻「管理员覆盖」
  assert.equal(backdrops().length, 1, 'the detail modal stays open after confirming')
  assert.equal(detailRole().value, 'auditor')
  assert.match(
    [...detail().querySelectorAll('.kv dd')][5].textContent ?? '',
    /管理员覆盖/,
    'the override flips the detail source'
  )
  // 背后列表行同步（同一份远端数据）
  assert.match(rowText('zhangsan'), /审计/)
  assert.match(rowText('zhangsan'), /管理员覆盖/)
  // 服务端真值一致（生效机制：服务端门禁实时，无快照延迟）
  const afterUpgrade = await userByName('zhangsan')
  assert.equal(afterUpgrade.role, 'auditor')
  assert.equal(afterUpgrade.roleSource, 'admin-override')
  assert.deepEqual(afterUpgrade.roles, ['developer', 'platform:auditor'])

  // ---- 管理员降级：danger 分型 + 断会话文案，确认后来源仍「管理员覆盖」 ----
  select0(detailRole(), 'admin')
  ;(backdrops()[backdrops().length - 1].querySelector('[data-action="0"]') as HTMLElement).click()
  await page.settle()
  assert.equal(detailRole().value, 'admin')
  select0(detailRole(), 'auditor')
  const confirmDown = backdrops()[backdrops().length - 1]
  assert.match(confirmDown.textContent ?? '', /管理员 → 审计/)
  assert.match(confirmDown.textContent ?? '', /降级将断开该用户当前云会话（≤60 秒）/)
  const downConfirm = confirmDown.querySelector<HTMLButtonElement>('[data-action="0"]')!
  assert.equal(downConfirm.classList.contains('danger'), true, 'a demotion is danger-styled')
  downConfirm.click()
  await page.settle()
  assert.equal(detailRole().value, 'auditor')
  assert.match(rowText('zhangsan'), /管理员覆盖/)
  const afterDemote = await userByName('zhangsan')
  assert.equal(afterDemote.role, 'auditor')
  // P2 语义：roleOverride 已钉住后，来源始终=管理员覆盖（与 LDAP 种子不一致即覆盖）
  assert.equal(afterDemote.roleSource, 'admin-override')

  // 关闭详情弹框
  ;(detail().querySelector('[data-action="close"]') as HTMLElement).click()
  assert.equal(backdrops().length, 0)

  saveEvidence(EVIDENCE, 'users-page-structure.json', {
    prototypeAnchors: anchors,
    columns: liveColumns,
    accountCount: listed.body.users.length,
    query: {
      keywordAccount: 1,
      keywordDisplayName: 2,
      roleAdmin: 1,
      statusDisabled: 0,
      combination: 0,
      reset: 3
    },
    detailFields: 7,
    changeFlow: {
      dialog: true,
      upgrade: { danger: false, source: afterUpgrade.roleSource },
      demote: { danger: true, revokedCopy: true, source: afterDemote.roleSource },
      confirmedPut: `PUT /v1/users/${zhangsanId}/roles`
    }
  })
}, 120_000)

test('UG-2/UG-4：角色变更实时生效 + role_update 审计 + override 优先于 LDAP 重登录', async () => {
  // UI 测试已把 zhangsan 升为审计；先复位为普通，拿到「升级前无审计面」的起点。
  const reset = await api(`/v1/users/${zhangsanId}/roles`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'developer' })
  })
  assert.equal(reset.status, 200)
  // UG-2 前半：开发者旧 token 无审计面
  const before = await api('/v1/audit/events?limit=10', { token: zhangsanToken })
  assert.equal(before.status, 403)

  // 审计先行（fail-closed）→ 改 roles → 响应契约
  const changed = await api(`/v1/users/${zhangsanId}/roles`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'auditor' })
  })
  assert.equal(changed.status, 200)
  assert.deepEqual(changed.body, {
    ok: true,
    roles: ['developer', 'platform:auditor'],
    source: 'admin-override'
  })

  // 实时生效：同一个 access token（opaque 键，不内嵌角色快照）下一请求即按新角色判定
  const afterChange = await api('/v1/audit/events?limit=10', { token: zhangsanToken })
  assert.equal(afterChange.status, 200, 'auditor must read audit events on the same token')

  const event = (await auditEvents('eventType=role_update&result=success&username=admin')).find(
    (entry) => entry.metadata.username === 'zhangsan'
  )
  assert.ok(event, 'a role_update success audit must exist for zhangsan')
  assert.equal(event.metadata.from, 'developer')
  assert.equal(event.metadata.to, 'auditor')
  assert.equal(event.metadata.revoked, false)

  // UG-4：override 持久——重新登录（LDAP 无 auditor 组）角色仍含 platform:auditor
  const relogin = await fetch(`${service.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      devicePubKey: 'u67-3-relogin',
      deviceName: 'e2e'
    })
  })
  assert.equal(relogin.status, 200)
  const reloginBody = (await relogin.json()) as { user: { roles: string[] } }
  assert.ok(
    reloginBody.user.roles.includes('platform:auditor'),
    `override must win over the LDAP seed: ${JSON.stringify(reloginBody.user.roles)}`
  )

  // 双向实时：降回普通后同一 token 立即失去审计面，再升级立即恢复
  const demote = await api(`/v1/users/${zhangsanId}/roles`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'developer' })
  })
  assert.equal(demote.status, 200)
  const afterDemote = await api('/v1/audit/events?limit=10', { token: zhangsanToken })
  assert.equal(afterDemote.status, 403, 'demotion must take effect on the next request')
  const promote = await api(`/v1/users/${zhangsanId}/roles`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'auditor' })
  })
  assert.equal(promote.status, 200)
  const afterPromote = await api('/v1/audit/events?limit=10', { token: zhangsanToken })
  assert.equal(afterPromote.status, 200)

  saveEvidence(EVIDENCE, 'role-change-audit.json', {
    ug2: {
      beforeToken: before.status,
      afterChangeToken: afterChange.status,
      auditMetadata: event?.metadata
    },
    ug4: { reloginRoles: reloginBody.user.roles },
    realtimeBothWays: { afterDemote: afterDemote.status, afterPromote: afterPromote.status }
  })
}, 120_000)

test('UG-1：非 admin 直调 GET/PUT 均 403 + denied 审计（requiredPermission=platform:admin）', async () => {
  const listDenied = await api('/v1/users', { token: lisiToken })
  assert.equal(listDenied.status, 403)
  assert.equal(listDenied.body.error?.code, 'PERMISSION_DENIED')

  const putDenied = await api(`/v1/users/${zhangsanId}/roles`, {
    method: 'PUT',
    token: lisiToken,
    body: JSON.stringify({ role: 'admin' })
  })
  assert.equal(putDenied.status, 403)
  assert.equal(putDenied.body.error?.code, 'PERMISSION_DENIED')

  const denied = await auditEvents('eventType=role_update&result=denied&username=lisi')
  const hit = denied.find((entry) => entry.metadata.requiredPermission === 'platform:admin')
  assert.ok(hit, 'the refused write must carry a role_update denied audit')
  const listDeniedEvent = (await auditEvents('eventType=user_list&result=denied&username=lisi'))[0]
  assert.ok(listDeniedEvent, 'the refused list read must be audited too')

  // 越权未落任何变更
  const unchanged = await userByName('lisi')
  assert.equal(unchanged.role, 'developer')
  assert.equal(unchanged.roleSource, 'ldap')

  saveEvidence(EVIDENCE, 'denied-writes.json', {
    listDenied: listDenied.status,
    putDenied: putDenied.status,
    requiredPermission: hit?.metadata.requiredPermission,
    roleUnchanged: unchanged.role
  })
}, 120_000)

test('UG-3：管理员降级撤凭证（revocation + 断开）且重登录不再获得管理员', async () => {
  const listed = await api('/v1/users')
  lisiId = listed.body.users.find((u: UserRow) => u.username === 'lisi').id

  // 升为管理员，拿一个真实的 admin token
  const promote = await api(`/v1/users/${lisiId}/roles`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'admin' })
  })
  assert.equal(promote.status, 200)
  const lisiAdminToken = await login(service.url, 'lisi', 'Passw0rd!')
  assert.equal((await api('/v1/users', { token: lisiAdminToken })).status, 200)

  // 降级：审计 metadata.revoked=true，用户撤销记录落 store（≤60s 心跳取走）
  const demote = await api(`/v1/users/${lisiId}/roles`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'developer' })
  })
  assert.equal(demote.status, 200)
  assert.deepEqual(demote.body.roles, ['developer'])

  const event = (await auditEvents('eventType=role_update&result=success&username=admin')).find(
    (entry) => entry.metadata.username === 'lisi' && entry.metadata.to === 'developer'
  )
  assert.ok(event, 'the demotion must be audited')
  assert.equal(event.metadata.from, 'admin')
  assert.equal(event.metadata.revoked, true)

  const revocations = await fetch(`${service.url}/v1/internal/revocations`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(revocations.status, 200)
  const revocationBody = (await revocations.json()) as { users: { id: string }[] }
  assert.ok(
    revocationBody.users.some((entry) => entry.id === 'lisi'),
    `the demoted admin must have a user revocation: ${JSON.stringify(revocationBody.users)}`
  )

  // 门禁实时：旧 token 下一请求即失去管控面
  assert.equal((await api('/v1/users', { token: lisiAdminToken })).status, 403)

  // 重登录不再获得管理员（override=developer 优先于任何 LDAP 组推导）
  const relogin = await login(service.url, 'lisi', 'Passw0rd!')
  assert.equal((await api('/v1/users', { token: relogin })).status, 403)
  const me = await api('/v1/me', { token: relogin })
  assert.deepEqual(me.body.user.roles, ['developer'])

  saveEvidence(EVIDENCE, 'demotion-revocation.json', {
    auditMetadata: event?.metadata,
    revocationUsers: revocationBody.users,
    oldTokenAfter: 403,
    reloginRoles: me.body.user.roles
  })
}, 120_000)

test('契约负向：非法角色 400 ROLE_INVALID；未知用户 404 USER_NOT_FOUND', async () => {
  const invalid = await api(`/v1/users/${zhangsanId}/roles`, {
    method: 'PUT',
    body: JSON.stringify({ role: 'superadmin' })
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error?.code, 'ROLE_INVALID')

  const missing = await api('/v1/users/user_does_not_exist/roles', {
    method: 'PUT',
    body: JSON.stringify({ role: 'auditor' })
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error?.code, 'USER_NOT_FOUND')

  // 负向不落库
  const zhangsan = await userByName('zhangsan')
  assert.equal(zhangsan.role, 'auditor')
}, 120_000)

test('UG-6 UI：developer 无用户管理导航，强制路由显示无权限页', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('lisi', 'Passw0rd!')
  assert.equal(page.text('#roleChip'), '开发者')
  assert.equal(page.hidden('#adminNav'), true, 'the admin nav group must stay hidden')

  const usersNav = page.window.document.querySelector<HTMLElement>('.nav-item[data-route="users"]')
  assert.ok(usersNav, 'the guarded nav item must exist in the markup')
  assert.equal(page.hidden('#adminNav'), true, '…but only inside the hidden admin group')

  await page.clickNav('users')
  assert.equal(page.text('#crumbs'), '无权访问')
  assert.match(page.text('#content'), /没有平台管理权限/)
  assert.doesNotMatch(page.text('#content'), /账号与角色/)

  saveEvidence(EVIDENCE, 'developer-gating.json', {
    roleChip: page.text('#roleChip'),
    adminNavHidden: true,
    forcedRoute: { crumbs: page.text('#crumbs'), showsForbidden: true }
  })
}, 120_000)
