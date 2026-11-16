import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U116① W4: admin-only archive/restore entries on rows, mobile cards and the
 * detail footer, each behind a dialog() consequence card.
 *
 * - cancel sends no request; confirm sends exactly one
 * - archive success moves the row into the folded history group
 * - restore success moves it back to the live list
 * - a 409 restore conflict surfaces the server message verbatim and leaves the
 *   row archived
 * - a developer sees neither entry
 */

let service: Service
let adminToken = ''
let hostId = ''
let liveId = ''
let restoreId = ''
let conflictId = ''

async function adminApi(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...(init.headers ?? {})
    },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function createProject(key: string, name: string, path: string): Promise<string> {
  const created = await adminApi('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name, hostId, path })
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  return (created.body as { id: string }).id
}

async function archive(id: string): Promise<void> {
  const res = await adminApi(`/v1/projects/${id}/archive`, { method: 'POST' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u116-w4-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u116-w4'
  )
  adminToken = await login(service.url, 'admin', 'Adm1n!')
  const host = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'u116-w4-host',
    directAddr: '127.0.0.1:17117',
    relayTarget: '127.0.0.1:17117'
  })
  hostId = host.hostId
  liveId = await createProject('w4-live', 'w4-live', '/srv/work/w4-live')
  restoreId = await createProject('w4-restore', 'w4-restore', '/srv/work/w4-restore')
  conflictId = await createProject('w4-conflict', 'w4-conflict-old', '/srv/work/w4-conflict')
  await archive(restoreId)
  await archive(conflictId)
  // The released key is reusable by a new live project; restore must now 409.
  await createProject('w4-conflict', 'w4-conflict-new', '/srv/work/w4-conflict-new')
}, 120_000)

after(async () => {
  await service?.stop()
})

function doc(page: WebConsolePage): Document {
  return page.window.document
}

function liveRow(page: WebConsolePage, text: string): HTMLElement | undefined {
  return [...doc(page).querySelectorAll<HTMLElement>('#projectTableWrap tbody tr')].find((row) =>
    row.textContent?.includes(text)
  )
}

function archivedRows(page: WebConsolePage, text: string): HTMLElement[] {
  const group = doc(page).querySelector<HTMLDetailsElement>('.archived-group')
  if (!group) return []
  return [...group.querySelectorAll<HTMLElement>('tbody tr')].filter((row) =>
    row.textContent?.includes(text)
  )
}

function backdrops(page: WebConsolePage): HTMLElement[] {
  return [...doc(page).querySelectorAll<HTMLElement>('.dialog-backdrop')]
}

function topDialog(page: WebConsolePage): HTMLElement {
  const all = backdrops(page)
  assert.ok(all.length > 0, 'expected a dialog')
  return all[all.length - 1]
}

function toasts(page: WebConsolePage): string[] {
  return [...doc(page).querySelectorAll<HTMLElement>('.toast')].map((el) => el.textContent ?? '')
}

function postCalls(page: WebConsolePage, action: 'archive' | 'restore'): string[] {
  return page
    .calls()
    .filter(
      (call) =>
        /^POST \/v1\/projects\/[^/]+\/(archive|restore)$/.test(call) && call.endsWith(`/${action}`)
    )
}

async function adminProjects(): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  await page.clickNav('projects')
  return page
}

test('W4-1 归档确认卡逐字后果、默认焦点取消、取消零请求', async () => {
  const page = await adminProjects()
  const row = liveRow(page, 'w4-live')
  assert.ok(row, 'precondition: live row visible')
  const entry = row.querySelector<HTMLButtonElement>('[data-archive]')
  assert.ok(entry, 'admin row carries 归档')
  assert.equal(entry.textContent, '归档')
  assert.ok(entry.classList.contains('danger'), '归档 is a danger entry')

  entry.click()
  await page.settle()
  const dialog = topDialog(page)
  assert.match(dialog.querySelector('h2')?.textContent ?? '', /归档项目「w4-live」？/)
  const copy = dialog.textContent ?? ''
  assert.match(copy, /云端工作区会话会被断开/)
  assert.match(copy, /主机磁盘上的项目目录与代码不会被删除/)
  assert.match(copy, /项目 Key 与路径会被释放/)
  assert.match(copy, /恢复时若已被占用，将无法恢复/)
  assert.match(copy, /之后可由管理员在「已归档」中恢复/)
  assert.equal(
    doc(page).activeElement?.textContent,
    '取消',
    'cancel owns the first focus target (T10)'
  )

  dialog.querySelector<HTMLButtonElement>('[data-action="0"]')!.click()
  await page.settle()
  assert.equal(backdrops(page).length, 0, 'cancel closes the card')
  assert.equal(postCalls(page, 'archive').length, 0, 'cancel sends no archive request')
})

test('W4-2 确认归档恰好一次请求，成功后行移入归档分组', async () => {
  const page = await adminProjects()
  liveRow(page, 'w4-live')!.querySelector<HTMLButtonElement>('[data-archive]')!.click()
  await page.settle()
  topDialog(page).querySelector<HTMLButtonElement>('[data-action="1"]')!.click()
  await page.settle()

  assert.deepEqual(postCalls(page, 'archive'), [`POST /v1/projects/${liveId}/archive`])
  assert.ok(
    toasts(page).some((text) => text.includes('已归档')),
    'archive success toasts'
  )
  assert.equal(liveRow(page, 'w4-live'), undefined, 'the row leaves the live table')
  assert.equal(archivedRows(page, 'w4-live').length, 1, 'the row lands in the history group')
  assert.ok(
    archivedRows(page, 'w4-live')[0].querySelector('[data-restore]'),
    'archived rows carry 恢复'
  )
  assert.equal(
    archivedRows(page, 'w4-live')[0].querySelector('[data-open]'),
    null,
    'archived rows expose no open entry'
  )
})

test('W4-3 恢复确认取消零请求，确认后回到在营列表', async () => {
  const page = await adminProjects()
  const row = archivedRows(page, 'w4-restore')[0]
  assert.ok(row, 'precondition: archived row visible')
  row.querySelector<HTMLButtonElement>('[data-restore]')!.click()
  await page.settle()

  const dialog = topDialog(page)
  assert.match(dialog.querySelector('h2')?.textContent ?? '', /恢复项目「w4-restore」？/)
  assert.match(dialog.textContent ?? '', /会先进入「准备中」/)
  assert.match(dialog.textContent ?? '', /恢复会失败，项目保持归档/)

  dialog.querySelector<HTMLButtonElement>('[data-action="0"]')!.click()
  await page.settle()
  assert.equal(postCalls(page, 'restore').length, 0, 'cancel sends no restore request')

  archivedRows(page, 'w4-restore')[0].querySelector<HTMLButtonElement>('[data-restore]')!.click()
  await page.settle()
  topDialog(page).querySelector<HTMLButtonElement>('[data-action="1"]')!.click()
  await page.settle()

  assert.deepEqual(postCalls(page, 'restore'), [`POST /v1/projects/${restoreId}/restore`])
  assert.ok(
    toasts(page).some((text) => text.includes('已恢复')),
    'restore success toasts'
  )
  assert.ok(liveRow(page, 'w4-restore'), 'the project returns to the live table')
  assert.equal(archivedRows(page, 'w4-restore').length, 0, 'the archive row is gone')
})

test('W4-4 恢复 409 冲突逐字 toast，项目保持归档', async () => {
  const page = await adminProjects()
  page.fail('POST', `/v1/projects/${conflictId}/restore`, {
    status: 409,
    body: {
      error: { code: 'PROJECT_KEY_TAKEN', message: '项目 Key 已被占用，无法恢复。' }
    }
  })
  archivedRows(page, 'w4-conflict-old')[0]
    .querySelector<HTMLButtonElement>('[data-restore]')!
    .click()
  await page.settle()
  topDialog(page).querySelector<HTMLButtonElement>('[data-action="1"]')!.click()
  await page.settle()

  assert.ok(
    toasts(page).some((text) => text === '恢复失败：项目 Key 已被占用，无法恢复。'),
    `verbatim 409 toast, got ${JSON.stringify(toasts(page))}`
  )
  assert.equal(archivedRows(page, 'w4-conflict-old').length, 1, 'row stays archived')
  assert.equal(liveRow(page, 'w4-conflict-old'), undefined, 'no live copy appears')
  page.clearFails()
})

test('W4-5 非 admin 看不到归档/恢复入口', async () => {
  const page = loadWebConsolePage(service.url)
  await page.settle()
  await page.submitLogin('zhangsan', 'Passw0rd!')
  await page.clickNav('projects')

  assert.equal(doc(page).querySelector('[data-archive]'), null)
  assert.equal(doc(page).querySelector('[data-restore]'), null)
  assert.equal(doc(page).querySelector('.archived-group'), null)
  assert.equal(
    page.calls().some((call) => call.includes('includeArchived=1')),
    false
  )
})

test('W4-6 详情页脚：在营项目有归档项目，归档项目有恢复项目', async () => {
  const live = loadWebConsolePage(service.url, { hash: `#/projects/${restoreId}` })
  await live.settle()
  await live.submitLogin('admin', 'Adm1n!')
  const liveFoot = doc(live).querySelector<HTMLElement>('.dialog .foot')!
  const liveLabels = [...liveFoot.querySelectorAll('button')].map((b) => b.textContent)
  assert.ok(liveLabels.includes('归档项目'), `live footer entries: ${liveLabels.join(',')}`)
  assert.ok(
    liveFoot.querySelector<HTMLButtonElement>('[data-action="1"]')?.classList.contains('danger'),
    '归档项目 is danger'
  )

  const archived = loadWebConsolePage(service.url, { hash: `#/projects/${liveId}` })
  await archived.settle()
  await archived.submitLogin('admin', 'Adm1n!')
  const archivedFoot = doc(archived).querySelector<HTMLElement>('.dialog .foot')!
  const archivedLabels = [...archivedFoot.querySelectorAll('button')].map((b) => b.textContent)
  assert.ok(
    archivedLabels.includes('恢复项目'),
    `archived footer entries: ${archivedLabels.join(',')}`
  )
})

test('W4-7 移动卡片：在营卡有归档、归档卡有恢复（同数据同操作）', async () => {
  const page = await adminProjects()
  const liveCard = [
    ...doc(page).querySelectorAll<HTMLElement>('#projectList .project-list-card')
  ].find((card) => card.textContent?.includes('w4-restore'))
  assert.ok(liveCard, 'live card visible')
  assert.ok(liveCard.querySelector('[data-archive]'), 'live card carries 归档')
  assert.ok(liveCard.querySelector('[data-open]'), 'live card keeps 打开工作区')

  const group = doc(page).querySelector<HTMLElement>('.archived-group')!
  const archivedCard = [...group.querySelectorAll<HTMLElement>('.project-list-card')].find((card) =>
    card.textContent?.includes('w4-live')
  )
  assert.ok(archivedCard, 'archived card visible')
  assert.ok(archivedCard.querySelector('[data-restore]'), 'archived card carries 恢复')
  assert.equal(archivedCard.querySelector('[data-open]'), null)
})
