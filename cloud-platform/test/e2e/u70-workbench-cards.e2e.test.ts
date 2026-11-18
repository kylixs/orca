import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U70 / G05: the workbench's four stat cards must be rendered from the data the
 * platform returns (projects + download policy), not from board state; the
 * workbench stays inert to unrelated query params; and the detail history stack
 * works in both directions (T64 pinned back, this pins forward).
 */

const ADMIN = ['admin', 'Adm1n!'] as const

type ProjectRow = {
  id: string
  key: string
  hostStatus: string
  downloadPolicy: string
  downloadPolicyExplicit: boolean
}

type PolicyView = { downloadDefault: 'allow' | 'deny'; version: number }

type StatCard = { label: string; value: string; hint: string }

let service: Service
let adminToken = ''
let onlineA = ''
let onlineB = ''
let offline = ''

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${service.url}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminToken}`,
      ...init.headers
    }
  })
  const body = (await res.json().catch(() => ({}))) as T
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${JSON.stringify(body)}`)
  return body
}

async function createProject(key: string, hostId: string, path: string): Promise<string> {
  const created = await api<{ id: string }>('/v1/projects', {
    method: 'POST',
    body: JSON.stringify({ key, name: key, hostId, path })
  })
  return created.id
}

async function listProjects(): Promise<ProjectRow[]> {
  return (await api<{ projects: ProjectRow[] }>('/v1/projects')).projects
}

function effectivePolicy(project: ProjectRow, globalDefault: 'allow' | 'deny'): string {
  return project.downloadPolicyExplicit ? project.downloadPolicy : globalDefault
}

/** The page's four stat cards, keyed by their literal label. */
function statCards(page: WebConsolePage): StatCard[] {
  return [
    ...page.window.document.querySelectorAll<HTMLElement>('.grid-4 .card.stat')
  ].map((card) => ({
    label: card.querySelector('.stat-label')?.textContent?.trim() ?? '',
    value: card.querySelector('.stat-value')?.textContent?.trim() ?? '',
    hint: card.querySelector('.stat-hint')?.textContent?.trim() ?? ''
  }))
}

function card(cards: StatCard[], label: string): StatCard {
  const found = cards.find((entry) => entry.label === label)
  assert.ok(found, `missing stat card ${label}`)
  return found
}

async function openWithAdmin(hash?: string): Promise<WebConsolePage> {
  const page = loadWebConsolePage(service.url, hash === undefined ? {} : { hash })
  await page.settle()
  await page.submitLogin(ADMIN[0], ADMIN[1])
  return page
}

function dialog(page: WebConsolePage): HTMLElement | null {
  return page.window.document.querySelector<HTMLElement>('.dialog-backdrop')
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'u70-cards-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u70-cards'
  )
  adminToken = await login(service.url, ADMIN[0], ADMIN[1])

  // Two online hosts; registering stamps status=online with a fresh heartbeat.
  const a = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'u70-online-a',
    directAddr: '127.0.0.1:17021',
    relayTarget: '127.0.0.1:17021'
  })
  const b = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'u70-online-b',
    directAddr: '127.0.0.1:17022',
    relayTarget: '127.0.0.1:17022'
  })
  const c = await registerHost({
    apiUrl: service.url,
    adminToken,
    name: 'u70-offline',
    directAddr: '127.0.0.1:17023',
    relayTarget: '127.0.0.1:17023'
  })
  onlineA = a.hostId
  onlineB = b.hostId
  offline = c.hostId

  const projectA = await createProject('u70-online-a', onlineA, '/srv/work/u70-online-a')
  await createProject('u70-online-b', onlineB, '/srv/work/u70-online-b')
  // The project must be born while its host is online; a host-declared offline
  // beat is then authoritative immediately (AC-08 path).
  await createProject('u70-offline', offline, '/srv/work/u70-offline')
  await api(`/v1/hosts/${offline}/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.credential}` },
    body: JSON.stringify({ status: 'offline' })
  })

  // Default allow so a single pinned deny is visible as a distinct card value.
  await api('/v1/policies/download', {
    method: 'PUT',
    body: JSON.stringify({ downloadDefault: 'allow' })
  })
  await api(`/v1/projects/${projectA}/policy`, {
    method: 'PUT',
    body: JSON.stringify({ downloadPolicy: 'deny' })
  })
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
})

test('G05 工作台统计卡四项逐字来自 API：项目数/在线数/禁用下载数/策略默认+version', async () => {
  const projects = await listProjects()
  const policy = await api<PolicyView>('/v1/policies/download')
  const expected = {
    total: projects.length,
    online: projects.filter((project) => project.hostStatus === 'online').length,
    denied: projects.filter((project) => effectivePolicy(project, policy.downloadDefault) === 'deny')
      .length,
    defaultValue: policy.downloadDefault === 'deny' ? '禁止' : '允许',
    versionHint: `策略版本 v${policy.version}`
  }

  // The three fixtures must actually exercise the cards: 2 online + 1 offline,
  // and exactly one pinned deny (the other two follow the allow default).
  const ours = projects.filter((project) => project.key.startsWith('u70-'))
  assert.equal(ours.length, 3)
  assert.equal(ours.filter((project) => project.hostStatus === 'online').length, 2)
  assert.equal(ours.filter((project) => project.hostStatus === 'offline').length, 1)
  assert.equal(
    ours.filter((project) => effectivePolicy(project, policy.downloadDefault) === 'deny').length,
    1
  )
  assert.equal(expected.denied, 1, 'the seeded data must not add another denied project')

  const page = await openWithAdmin('#/workbench')
  const cards = statCards(page)
  assert.equal(cards.length, 4, 'the workbench renders exactly four stat cards')

  assert.deepEqual(card(cards, '可访问项目'), {
    label: '可访问项目',
    value: String(expected.total),
    hint: '按 ACL 过滤'
  })
  assert.deepEqual(card(cards, '在线项目'), {
    label: '在线项目',
    value: String(expected.online),
    hint: '60 秒无心跳转离线'
  })
  assert.deepEqual(card(cards, '禁用下载项目'), {
    label: '禁用下载项目',
    value: String(expected.denied),
    hint: '导出入口已隐藏'
  })
  assert.deepEqual(card(cards, '下载默认策略'), {
    label: '下载默认策略',
    value: expected.defaultValue,
    hint: expected.versionHint
  })

  // Fixtures are visible with the state each card counted: the pinned deny is
  // the only denied card, and the offline host's row reports 主机离线.
  const cards3 = [...page.window.document.querySelectorAll<HTMLElement>('.grid-3 .project-card')]
  const cardText = (name: string): string =>
    cards3.find((entry) => entry.textContent?.includes(name))?.textContent ?? ''
  assert.match(cardText('u70-online-a'), /下载已禁用/, 'the pinned deny project is the denied one')
  assert.match(cardText('u70-online-b'), /允许下载/)
  const rows = [...page.window.document.querySelectorAll<HTMLElement>('#content table tbody tr')]
  const offlineRow =
    rows.find((row) => row.textContent?.includes('u70-offline'))?.textContent ?? ''
  assert.match(offlineRow, /主机离线/)
  assert.equal(page.window.location.hash, '#/workbench')
})

test('G05 characterization：#/workbench?foo=bar 正常渲染且请求集合与无 query 一致', async () => {
  const plain = await openWithAdmin('#/workbench')
  const withQuery = await openWithAdmin('#/workbench?foo=bar')

  assert.equal(withQuery.window.location.hash, '#/workbench?foo=bar', 'the query stays in the URL')
  assert.equal(statCards(withQuery).length, 4, 'the workbench renders the same cards')
  assert.deepEqual(statCards(withQuery), statCards(plain), 'the query must not change the view')

  // No extra request: the workbench ignores query params it does not own.
  assert.deepEqual(
    [...withQuery.calls()].sort(),
    [...plain.calls()].sort(),
    'an unrelated query param must not add requests'
  )
})

test('G05 详情历史栈前进：列表→详情→back→forward 复开详情', async () => {
  const page = await openWithAdmin('#/workbench')
  await page.clickNav('projects')

  const button = page.window.document.querySelector<HTMLButtonElement>('[data-detail]')
  assert.ok(button, 'the projects list carries 详情')
  const id = button!.dataset.detail
  button!.click()
  await page.settle()

  assert.ok(dialog(page), 'clicking 详情 opens the dialog')
  assert.equal(page.window.location.hash, `#/projects/${id}`)

  page.window.history.back()
  await page.settle()
  assert.equal(dialog(page), null, 'back closes the dialog')
  assert.equal(page.window.location.hash, '#/projects')

  page.window.history.forward()
  await page.settle()
  assert.ok(dialog(page), 'forward reopens the same detail')
  assert.equal(page.window.location.hash, `#/projects/${id}`, 'forward restores the detail URL')
})
