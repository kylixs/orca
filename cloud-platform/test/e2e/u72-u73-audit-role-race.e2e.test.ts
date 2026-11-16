import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { saveEvidence } from './harness.ts'
import { loadWebConsolePage } from './web-console-page.ts'

/**
 * U72 + U73: the audit role gate becomes role-aware and the audit query
 * becomes latest-wins, run as the real web console against a real platform.
 *
 * - U72 (R3-UA-01): auditor sees the audit nav entry, opens the page, and the
 *   real seeded events render; admin keeps every admin route; developer keeps
 *   no entry and a forced audit route still renders the forbidden page.
 * - U73 (R3-UA-02): a double-clicked query paints exactly the fresh rows (no
 *   `[...旧,...新]` accumulation), and 清除→立即查询 leaves only the new
 *   condition's rows in the table.
 */

const EVIDENCE = 'u72u73-fix'
const INTERNAL_TOKEN = 'u72-u73-internal'

const now = Date.now()
let app: ApiHandle
let url = ''
let adminToken = ''
let lisiToken = ''

before(async () => {
  app = createApp({ port: 0, now: () => now, internalToken: INTERNAL_TOKEN })
  const port = await app.listen()
  url = `http://127.0.0.1:${port}`

  // Two real audit events: both match fileName 'u73', only the alpha matches
  // 'u73-alpha' — the discriminators for the U73 row-count assertions.
  for (const fileName of ['u73-alpha.log', 'u73-beta.log']) {
    const res = await fetch(`${url}/v1/internal/audit/file-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify({
        eventType: 'file_download',
        result: 'success',
        traceId: `tr_u73_${fileName}`,
        cloudSession: 'sess_u73',
        projectId: 'proj_payment',
        subject: 'user:zhangsan',
        metadata: {
          fileName,
          path: `u73/${fileName}`,
          sizeBytes: 4096,
          method: 'files.readChunk',
          kind: 'file',
          surface: 'desktop',
          capturePoint: 'download-runtime-client',
          policy: 'allow',
          occurredAt: now,
          sha256: 'a'.repeat(64)
        }
      })
    })
    assert.equal(res.status, 200, await res.text())
  }

  adminToken = await loginToken('admin', 'Adm1n!', 'u72-admin-device')
  lisiToken = await loginToken('lisi', 'Passw0rd!', 'u72-lisi-device')
  const users = await fetch(`${url}/v1/users`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(users.status, 200)
  const lisiId = (
    ((await users.json()) as { users: { id: string; username: string }[] }).users.find(
      (user) => user.username === 'lisi'
    ) ?? { id: '' }
  ).id
  const promoted = await fetch(`${url}/v1/users/${lisiId}/roles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: 'auditor' })
  })
  assert.equal(promoted.status, 200, await promoted.text())
})

after(async () => {
  await app?.close()
})

async function loginToken(username: string, password: string, device: string): Promise<string> {
  const res = await fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceName: device,
      devicePubKey: Buffer.from(device).toString('base64')
    })
  })
  const body = (await res.json()) as { accessToken?: string }
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.accessToken ?? ''
}

function dataRows(page: ReturnType<typeof loadWebConsolePage>): Element[] {
  return [
    ...page.window.document.querySelectorAll('#content tbody tr:not(.audit-expand-row)')
  ]
}

function navButton(
  page: ReturnType<typeof loadWebConsolePage>,
  route: string
): HTMLElement | null {
  return page.window.document.querySelector<HTMLElement>(`.nav-item[data-route="${route}"]`)
}

function setValue(
  page: ReturnType<typeof loadWebConsolePage>,
  selector: string,
  value: string
): void {
  const element = page.window.document.querySelector<HTMLInputElement | HTMLSelectElement>(
    selector
  )
  assert.ok(element, `missing ${selector}`)
  element.value = value
}

function click(page: ReturnType<typeof loadWebConsolePage>, selector: string): void {
  const element = page.window.document.querySelector<HTMLElement>(selector)
  assert.ok(element, `missing ${selector}`)
  element.click()
}

test('U72-1 审计员登录：侧栏审计入口可见、其余管理入口隐藏，审计页渲染真实事件', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('lisi', 'Passw0rd!')

  assert.equal(page.text('#roleChip'), '审计员')
  assert.equal(page.hidden('#adminNav'), false, 'the audit entry needs a visible group')
  assert.equal(navButton(page, 'audit')?.hidden, false, 'auditor must see the audit entry')
  for (const route of ['hosts', 'relays', 'users', 'settings']) {
    assert.equal(
      navButton(page, route)?.hidden,
      true,
      `${route} must stay hidden from an auditor`
    )
  }

  await page.clickNav('audit')
  assert.equal(page.text('#crumbs'), '审计日志')
  const text = page.text('#content')
  assert.doesNotMatch(text, /无权访问/)
  assert.match(text, /u73-alpha\.log/, 'the seeded download must render for the auditor')
  assert.match(text, /u73-beta\.log/, 'the second seeded download must render for the auditor')
  assert.ok(
    page.calls().some((entry) => entry.startsWith('GET /v1/audit/events')),
    'the page must query the audit events endpoint'
  )

  // U67 §7.2: the audit role is query-only — the directory stays admin-only.
  const directory = await fetch(`${url}/v1/users`, {
    headers: { authorization: `Bearer ${lisiToken}` }
  })
  assert.equal(directory.status, 403)

  saveEvidence(EVIDENCE, 'u72-auditor-entry.json', {
    roleChip: page.text('#roleChip'),
    auditEntryVisible: true,
    hiddenAdminRoutes: ['hosts', 'relays', 'users', 'settings'],
    crumbs: page.text('#crumbs'),
    seededEventsRendered: ['u73-alpha.log', 'u73-beta.log'],
    directoryApiStatus: directory.status
  })
}, 120_000)

/**
 * F6 E5 (AC-M7-14): an auditor's project/host dropdowns are empty because both
 * list endpoints are denied (hosts) or ACL-filtered to nothing (projects), and
 * the page swallows that. Characterization pin: if either list gains auditor
 * data, or the page starts explaining the empty state, this fails.
 */
test('U72-4 审计员项目/主机筛选仅有「全部」，空态不解释（F6 E5 现状钉）', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('lisi', 'Passw0rd!')
  await page.clickNav('audit')

  const options = (selector: string): { value: string; text: string }[] => {
    const select = page.window.document.querySelector<HTMLSelectElement>(selector)
    assert.ok(select, `missing ${selector}`)
    return [...select.options].map((option) => ({ value: option.value, text: option.text }))
  }
  assert.deepEqual(options('#auditProject'), [{ value: '', text: '全部项目' }])
  assert.deepEqual(options('#auditHost'), [{ value: '', text: '全部主机' }])

  // The host list denial is what empties the host select; the page must still
  // render the events it is allowed to query, and must not claim a load failure.
  const hosts = await fetch(`${url}/v1/hosts`, {
    headers: { authorization: `Bearer ${lisiToken}` }
  })
  assert.equal(hosts.status, 403, 'precondition: auditors are denied the host list')
  assert.doesNotMatch(page.text('#content'), /加载失败|无权访问/)
  assert.match(page.text('#content'), /u73-alpha\.log/, 'events still render')

  saveEvidence(EVIDENCE, 'u72-auditor-empty-filters.json', {
    projectOptions: options('#auditProject'),
    hostOptions: options('#auditHost'),
    hostsApiStatus: hosts.status,
    explained: false
  })
}, 120_000)

test('U72-2 管理员不回退：全部管理入口可见，审计页与用户页照常渲染', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')

  assert.equal(page.text('#roleChip'), '平台管理员')
  assert.equal(page.hidden('#adminNav'), false)
  for (const route of ['hosts', 'relays', 'users', 'audit', 'settings']) {
    assert.equal(navButton(page, route)?.hidden, false, `admin must still see ${route}`)
  }

  await page.clickNav('audit')
  assert.equal(page.text('#crumbs'), '审计日志')
  assert.match(page.text('#content'), /u73-alpha\.log/)

  await page.clickNav('users')
  assert.equal(page.text('#crumbs'), '用户管理')
  assert.doesNotMatch(page.text('#content'), /无权访问/)

  saveEvidence(EVIDENCE, 'u72-admin-unchanged.json', {
    roleChip: page.text('#roleChip'),
    visibleRoutes: ['hosts', 'relays', 'users', 'audit', 'settings']
  })
}, 120_000)

test('U72-3 普通开发者：无任何管理入口，强制直达 audit/hosts 仍渲染无权访问', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')

  assert.equal(page.text('#roleChip'), '开发者')
  assert.equal(page.hidden('#adminNav'), true)
  for (const route of ['hosts', 'relays', 'users', 'audit', 'settings']) {
    assert.equal(navButton(page, route)?.hidden, true, `${route} must stay hidden`)
  }

  await page.clickNav('audit')
  assert.equal(page.text('#crumbs'), '无权访问')
  assert.match(page.text('#content'), /没有平台管理权限/)
  assert.doesNotMatch(page.text('#content'), /u73-alpha\.log/)

  await page.clickNav('hosts')
  assert.equal(page.text('#crumbs'), '无权访问')

  saveEvidence(EVIDENCE, 'u72-developer-denied.json', {
    roleChip: page.text('#roleChip'),
    forcedAuditRoute: 'forbidden',
    forcedHostsRoute: 'forbidden'
  })
}, 120_000)

test('U73-1 双击查询：两代请求仅最新一代生效，行数等于真实事件数 2', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('audit')

  setValue(page, '#auditFileName', 'u73')
  // Two clicks in one task: both queries go out before either can paint.
  click(page, '#auditApply')
  click(page, '#auditApply')
  await page.settle()

  const rows = dataRows(page)
  assert.equal(rows.length, 2, `double click must paint exactly the 2 real events, got ${rows.length}`)
  const names = rows.map((row) => row.textContent ?? '').join('|')
  assert.match(names, /u73-alpha\.log/)
  assert.match(names, /u73-beta\.log/)
  assert.match(page.text('#content'), /已显示 2 条/)

  saveEvidence(EVIDENCE, 'u73-double-click.json', {
    fileNameFilter: 'u73',
    rowCountAfterDoubleClick: rows.length,
    rows: names.slice(0, 300)
  })
}, 120_000)

test('U73-2 清除后立即换条件查询：仅新条件行，不与未过滤结果混表', async () => {
  const page = loadWebConsolePage(url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('audit')

  // Start from the u73-filtered view, then 清除 and immediately query the
  // narrower condition in the same task — the abandoned 清除 query must not
  // merge its rows into the final table.
  setValue(page, '#auditFileName', 'u73')
  click(page, '#auditApply')
  await page.settle()

  click(page, '#auditReset')
  setValue(page, '#auditFileName', 'u73-alpha')
  click(page, '#auditApply')
  await page.settle()

  const rows = dataRows(page)
  assert.equal(rows.length, 1, `only the alpha row must survive, got ${rows.length}`)
  const text = page.text('#content')
  assert.match(text, /u73-alpha\.log/)
  assert.doesNotMatch(text, /u73-beta\.log/, 'the abandoned unfiltered query must not paint')
  assert.match(text, /已显示 1 条/)

  saveEvidence(EVIDENCE, 'u73-clear-then-query.json', {
    fileNameFilter: 'u73-alpha',
    rowCountAfterClearAndQuery: rows.length,
    betaAbsent: true
  })
}, 120_000)
