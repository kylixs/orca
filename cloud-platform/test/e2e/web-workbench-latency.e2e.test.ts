import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Browser } from 'playwright'
import { saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M97 (AC-01, G-12 remainder): the budget is "submit to an interactive
 * workbench, P95 ≤ 1.5 s", measured in a real browser rendering the real page —
 * not an API stopwatch. The earlier evidence timed only the API call, which says
 * nothing about whether the workbench painted.
 *
 * Real platform process serving apps/web, real Chrome (headless), 50 samples.
 */

const EVIDENCE = 'm97-workbench-latency'
const SAMPLES = 50
const BUDGET_MS = 1500

type Sample = { elapsedMs: number; projectRows: number }

// P95 by nearest-rank: the smallest value at or above 95% of the samples.
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * sorted.length)
  return sorted[Math.max(0, rank - 1)] ?? Number.POSITIVE_INFINITY
}

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'm97-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-workbench-latency'
  )
  // Headless and no viewport chrome: this must never take the user's screen.
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, { timeout: 180_000 })

after(async () => {
  await browser?.close()
  await service?.stop()
})

/**
 * One login sample. A fresh context each time means a cold localStorage and a
 * cold connection pool, which is what "不含首次安装" still has to pay for.
 */
async function sample(index: number, extraDelayMs = 0): Promise<Sample> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  try {
    const page = await context.newPage()
    if (extraDelayMs > 0) {
      // Sensitivity control: slow the data the workbench waits on.
      await page.route('**/v1/projects*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, extraDelayMs))
        await route.continue()
      })
    }
    await page.goto(`${service.url}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#loginForm', { state: 'visible' })
    await page.fill('#username', 'zhangsan')
    await page.fill('#password', 'Passw0rd!')

    const started = Date.now()
    await page.click('#loginBtn')
    // Interactive = the shell is up AND the project rows the user came for are painted.
    await page.waitForFunction(
      () => {
        const app = document.querySelector('#view-app')
        if (!app || app.hidden) return false
        const rows = document.querySelectorAll('#content table tbody tr')
        return (
          rows.length > 0 &&
          !document.querySelector('#content .muted')?.textContent?.includes('加载中')
        )
      },
      undefined,
      { timeout: 15_000 }
    )
    const elapsedMs = Date.now() - started
    const projectRows = await page.locator('#content table tbody tr').count()
    const text = await page.textContent('#content')
    assert.match(
      text ?? '',
      /payment-service/,
      `sample ${index}: workbench must list the visible project`
    )
    assert.equal(await page.isHidden('#adminNav'), true, 'a developer must not see the admin nav')
    return { elapsedMs, projectRows }
  } finally {
    await context.close()
  }
}

test('AC-01 提交登录到工作台可交互 P95 ≤ 1.5s（真实 Chrome 渲染，50 次采样）', { timeout: 300_000 }, async () => {
  // One warm-up sample: the requirement excludes first install, not steady state.
  await sample(-1)
  const samples: Sample[] = []
  for (let index = 0; index < SAMPLES; index += 1) {
    samples.push(await sample(index))
  }
  const elapsed = samples.map((entry) => entry.elapsedMs)
  const measuredP95 = p95(elapsed)
  assert.ok(
    measuredP95 <= BUDGET_MS,
    `P95 ${measuredP95}ms over budget ${BUDGET_MS}ms; samples=${JSON.stringify(elapsed)}`
  )
  assert.ok(samples.every((entry) => entry.projectRows > 0))

  // ---- sensitivity control: the same measurement must notice a slow backend ----
  const slow: number[] = []
  for (let index = 0; index < 10; index += 1) {
    slow.push((await sample(index, 400)).elapsedMs)
  }
  const slowP95 = p95(slow)

  saveEvidence(EVIDENCE, 'workbench-latency.json', {
    samples: SAMPLES,
    budgetMs: BUDGET_MS,
    measuredP95Ms: measuredP95,
    minMs: Math.min(...elapsed),
    medianMs: [...elapsed].sort((a, b) => a - b)[Math.floor(elapsed.length / 2)],
    maxMs: Math.max(...elapsed),
    elapsedMs: elapsed,
    projectRowsPerSample: [...new Set(samples.map((entry) => entry.projectRows))],
    sensitivityControl: {
      injectedDelayMs: 400,
      samples: slow.length,
      p95Ms: slowP95,
      deltaMs: slowP95 - measuredP95
    }
  })
  // Why a delta and not the budget: the page is fast enough that even a 400 ms
  // regression stays under 1.5 s, so the control has to prove the metric moves.
  assert.ok(
    slowP95 - measuredP95 >= 300,
    `a 400ms backend regression must show up; baseline ${measuredP95}ms vs slow ${slowP95}ms`
  )
})
