import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, login, spawnService, type Service } from './harness.ts'

/**
 * U146: a relay route is only trustworthy while its host keeps confirming it.
 * The admin host list must expose when the route was last confirmed, how old it
 * is, and whether it is stale (three missed beats, or an address the host no
 * longer advertises), and the console must show that verdict.
 */

const EVIDENCE = 'u146-relay-route-staleness'

type HostFields = {
  id: string
  online: boolean
  directAddrs: string[]
  relayTarget: string | null
  relayRouteUpdatedAt: number | null
  relayRouteAgeSec: number | null
  relayRouteStale: boolean | null
}

let api: Service
let browser: Browser
let page: Page
let adminToken = ''
let freshHostId = ''
let staleHostId = ''
let unboundHostId = ''

async function registerHost(body: Record<string, unknown>): Promise<{
  hostId: string
  credential: string
}> {
  const tokenRes = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(tokenRes.status, 201)
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${api.url}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      fingerprint: `host:${body.name}`,
      e2eePublicKeyB64: '',
      protocolVersion: 3,
      networkZone: 'intranet',
      runtimeCapabilities: ['pty'],
      ...body
    })
  })
  const text = await res.text()
  assert.equal(res.status, 201, text)
  return JSON.parse(text) as { hostId: string; credential: string }
}

async function heartbeat(hostId: string, credential: string, directAddrs?: string[]): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${hostId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
    body: JSON.stringify({ status: 'online', ...(directAddrs ? { directAddrs } : {}) })
  })
  assert.equal(res.status, 200, await res.text())
}

async function hostFields(hostId: string): Promise<HostFields> {
  const res = await fetch(`${api.url}/v1/hosts`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  assert.equal(res.status, 200)
  const { hosts } = (await res.json()) as { hosts: HostFields[] }
  const row = hosts.find((host) => host.id === hostId)
  assert.ok(row, 'registered host is listed')
  return row
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u146-relay-route-staleness'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')

  // Fresh: the route target is the address the beat reports.
  const fresh = await registerHost({
    name: 'u146-fresh-host',
    directAddrs: ['127.0.0.1:16811'],
    relayTarget: '127.0.0.1:16811',
    relayRoute: 'u146-fresh-host'
  })
  freshHostId = fresh.hostId
  await heartbeat(fresh.hostId, fresh.credential, ['127.0.0.1:16811'])

  // Stale: a derived route keeps an upstream the host no longer advertises.
  const stale = await registerHost({
    name: 'u146-stale-host',
    directAddrs: ['127.0.0.1:16812'],
    relayTarget: '10.9.9.9:19999'
  })
  staleHostId = stale.hostId
  await heartbeat(stale.hostId, stale.credential, ['127.0.0.1:16812'])

  // Unbound: nothing to confirm, so all three fields are null.
  const unbound = await registerHost({ name: 'u146-unbound-host' })
  unboundHostId = unbound.hostId

  browser = await chromium.launch({ channel: 'chrome', headless: true })
  page = await browser.newPage()
  await page.goto(`${api.url}/#/hosts`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', 'admin')
  await page.fill('#password', 'Adm1n!')
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app:not([hidden])')
  await page.waitForSelector('#hostTableWrap table')
}, 180_000)

after(async () => {
  await browser?.close()
  await api?.stop()
})

function tableCell(hostId: string) {
  return page.locator(`#hostTableWrap [data-relay-freshness="${hostId}"]`)
}

test('① 在线宿主确认后：API 新鲜，UI 显示确认秒数且无陈旧徽标', async () => {
  const row = await hostFields(freshHostId)
  assert.equal(row.online, true)
  assert.equal(typeof row.relayRouteUpdatedAt, 'number')
  assert.equal(typeof row.relayRouteAgeSec, 'number')
  assert.ok((row.relayRouteAgeSec ?? Infinity) < 60, 'a just-beat route is seconds old')
  assert.equal(row.relayRouteStale, false)

  const cell = tableCell(freshHostId)
  await cell.waitFor({ state: 'visible' })
  assert.match((await cell.innerText()).trim(), /^路由确认于 \d+ 秒前$/)
  assert.equal(await cell.locator('.badge.warn').count(), 0)

  writeFileSync(
    join(evidenceDir(EVIDENCE), 'fresh-api.json'),
    JSON.stringify(row, null, 2)
  )
})

test('② 路由指向宿主不再通告的地址：API 陈旧，UI 出现陈旧徽标', async () => {
  const row = await hostFields(staleHostId)
  assert.equal(row.online, true)
  assert.equal(typeof row.relayRouteAgeSec, 'number')
  assert.equal(row.relayRouteStale, true)
  assert.ok(row.relayTarget, 'the stale route still advertises a target')
  assert.ok(
    !row.directAddrs.includes(row.relayTarget),
    'the advertised target left the host addresses'
  )

  const cell = tableCell(staleHostId)
  await cell.waitFor({ state: 'visible' })
  assert.equal((await cell.innerText()).trim(), '路由陈旧')
  assert.equal(await cell.locator('.badge.warn').count(), 1)

  writeFileSync(
    join(evidenceDir(EVIDENCE), 'stale-api.json'),
    JSON.stringify(row, null, 2)
  )
})

test('③ 无路由宿主：API 三字段为 null，UI 显示 —', async () => {
  const row = await hostFields(unboundHostId)
  assert.equal(row.relayRouteUpdatedAt, null)
  assert.equal(row.relayRouteAgeSec, null)
  assert.equal(row.relayRouteStale, null)

  const cell = tableCell(unboundHostId)
  await cell.waitFor({ state: 'visible' })
  assert.equal((await cell.innerText()).trim(), '—')

  writeFileSync(
    join(evidenceDir(EVIDENCE), 'unbound-api.json'),
    JSON.stringify(row, null, 2)
  )
})

test('④ 抽屉复用同一判定，窄视口不横向溢出', async () => {
  const detail = page.locator(`#hostTableWrap button[data-host="${staleHostId}"]`)
  await detail.click()
  const drawerCell = page.locator(`.drawer [data-relay-freshness="${staleHostId}"]`)
  await drawerCell.waitFor({ state: 'visible' })
  assert.equal((await drawerCell.innerText()).trim(), '路由陈旧')
  await page.locator('.drawer .icon-btn').click()
  await page.locator('.drawer-backdrop').waitFor({ state: 'detached' })

  await page.setViewportSize({ width: 390, height: 844 })
  const cardCell = page.locator(`.host-list-card [data-relay-freshness="${freshHostId}"]`)
  await cardCell.waitFor({ state: 'visible' })
  assert.match((await cardCell.innerText()).trim(), /^路由确认于 \d+ 秒前$/)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  assert.ok(overflow <= 1, `host page must not overflow at 390px (got ${overflow})`)

  await page.screenshot({
    path: join(evidenceDir(EVIDENCE), 'hosts-390.png'),
    fullPage: true
  })
})
