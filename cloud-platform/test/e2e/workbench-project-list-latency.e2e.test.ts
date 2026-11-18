import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Browser } from 'playwright'
import { login, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M106 (requirements §5.1): the workbench project list, at the ≤200-project scale
 * the requirement names, loads in P95 ≤ 500ms. Measured in real Chrome against a
 * real platform process holding 200 granted projects — the API stopwatch alone
 * would not say whether the table painted.
 *
 * The requirement's number is the list load, not the login: each sample starts
 * from the workbench and times the click on 我的项目 until all 200 rows exist.
 */

const EVIDENCE = 'm106-workbench-project-list-latency'
const BUDGET_MS = 500
const PROJECTS = 200
const SAMPLES = 30
const CONTROL_SAMPLES = 5
const INJECTED_DELAY_MS = 700

type Sample = { elapsedMs: number; rows: number }
type Stats = { samples: number; p50: number; p95: number; min: number; max: number }

function statsOf(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percent: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)
    return Math.round((sorted[Math.max(0, index)] ?? 0) * 100) / 100
  }
  return {
    samples: sorted.length,
    p50: at(50),
    p95: at(95),
    min: Math.round((sorted[0] ?? 0) * 100) / 100,
    max: Math.round((sorted.at(-1) ?? 0) * 100) / 100
  }
}

/** The acceptance check; the delayed run must make this throw. */
function assertListBudget(stats: Stats, budget: number): void {
  if (stats.p95 > budget) {
    throw new Error(`project list P95 ${stats.p95}ms over budget ${budget}ms`)
  }
}

let service: Service
let browser: Browser

async function api(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  return fetch(`${service.url}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : {})
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  })
}

/** 199 more projects through the real creation endpoint, each granted to the group. */
async function seedProjects(): Promise<number> {
  const adminToken = await login(service.url, 'admin', 'Adm1n!')
  for (let index = 2; index <= PROJECTS; index += 1) {
    const suffix = String(index).padStart(3, '0')
    const created = await api(adminToken, '/v1/projects', {
      method: 'POST',
      body: {
        key: `service-${suffix}`,
        name: `service-${suffix}`,
        hostId: 'host_dev001',
        path: `/srv/work/service-${suffix}`
      }
    })
    assert.equal(created.status, 201, await created.clone().text())
    const { id } = (await created.json()) as { id: string }
    const granted = await api(adminToken, `/v1/projects/${id}/grants`, {
      method: 'PUT',
      body: {
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open', 'file:read']
      }
    })
    assert.equal(granted.status, 200, await granted.clone().text())
  }
  const devToken = await login(service.url, 'zhangsan', 'Passw0rd!')
  const listed = await api(devToken, '/v1/projects?includeArchived=1')
  assert.equal(listed.status, 200)
  const { projects } = (await listed.json()) as { projects: { id: string }[] }
  return projects.length
}

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'm106-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-m106'
  )
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, { timeout: 300_000 })

after(async () => {
  await browser?.close()
  await service?.stop()
})

/** Signed-in workbench, ready for list samples. */
async function signedInPage(): Promise<import('playwright').Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto(`${service.url}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', 'zhangsan')
  await page.fill('#password', 'Passw0rd!')
  await page.click('#loginBtn')
  await page.waitForFunction(() => {
    const app = document.querySelector('#view-app')
    return Boolean(app) && !app!.hidden
  })
  return page
}

/** One list load: from clicking 我的项目 to every row painted. */
async function listSample(page: import('playwright').Page): Promise<Sample> {
  await page.click('button[data-route="workbench"]')
  await page.waitForSelector('#content table tr')
  const started = Date.now()
  await page.click('button[data-route="projects"]')
  await page.waitForFunction(
    (expected) => {
      const rows = document.querySelectorAll('#projectBody tr')
      const loading = document.querySelector('#content .muted')?.textContent ?? ''
      return rows.length === expected && !loading.includes('加载中')
    },
    PROJECTS,
    { timeout: 15_000 }
  )
  const elapsedMs = Date.now() - started
  const rows = await page.locator('#projectBody tr').count()
  return { elapsedMs, rows }
}

test('M106-1 200 个项目的工作台列表加载 P95 ≤ 500ms；注入 700ms 延迟时同一断言转红', { timeout: 300_000 }, async () => {
  const total = await seedProjects()
  assert.equal(total, PROJECTS, `developer must see exactly ${PROJECTS} projects, saw ${total}`)

  const page = await signedInPage()
  await listSample(page) // warm-up: caches and a live connection, not first install
  const samples: Sample[] = []
  for (let index = 0; index < SAMPLES; index += 1) {
    samples.push(await listSample(page))
  }
  const normal = statsOf(samples.map((entry) => entry.elapsedMs))
  assert.ok(
    samples.every((entry) => entry.rows === PROJECTS),
    JSON.stringify(samples)
  )
  assertListBudget(normal, BUDGET_MS)

  // Same rows must really be rendered, not just counted.
  const tableText = await page.locator('#projectBody').textContent()
  assert.match(tableText ?? '', /service-199/)
  assert.match(tableText ?? '', /payment-service/)

  // Negative control: slow the list endpoint the page waits on.
  await page.route('**/v1/projects*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, INJECTED_DELAY_MS))
    await route.continue()
  })
  await listSample(page)
  const injectedSamples: Sample[] = []
  for (let index = 0; index < CONTROL_SAMPLES; index += 1) {
    injectedSamples.push(await listSample(page))
  }
  const injected = statsOf(injectedSamples.map((entry) => entry.elapsedMs))
  assert.throws(() => assertListBudget(injected, BUDGET_MS), /over budget/)

  await page.unroute('**/v1/projects*')
  await listSample(page)
  const restoredSamples: Sample[] = []
  for (let index = 0; index < CONTROL_SAMPLES; index += 1) {
    restoredSamples.push(await listSample(page))
  }
  const restored = statsOf(restoredSamples.map((entry) => entry.elapsedMs))
  assertListBudget(restored, BUDGET_MS)

  saveEvidence(EVIDENCE, 'project-list-latency.json', {
    budgetMs: BUDGET_MS,
    projects: total,
    samples: SAMPLES,
    normal,
    injected: { delayMs: INJECTED_DELAY_MS, ...injected },
    restored,
    rowsRendered: samples[0]?.rows ?? 0,
    platform: process.platform,
    node: process.version
  })

  await page.context().close()
})
