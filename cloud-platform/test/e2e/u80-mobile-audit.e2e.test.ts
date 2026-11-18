import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { evidenceDir, spawnService, type Service } from './harness.ts'

/**
 * U80 M6: the phone face of 审计日志. Real Chrome proves the ≤700px folded
 * filter, the event cards, the full-screen event sheet, chain health/verify and
 * the gap banner. 768 and 1280 keep the desktop table byte for byte.
 */

const ADMIN = ['admin', 'Adm1n!'] as const
const INTERNAL_TOKEN = 'u80-mobile-audit-internal'
const EV = 'u80-mobile'

let service: Service
let browser: Browser

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u80-mobile-audit'
  )
  // 55 events cross the 50-per-page boundary so 「加载更早」 renders. The three
  // named ones are the newest seeds, so they survive the latest-50 page.
  for (let i = 0; i < 55; i += 1) {
    const name =
      i === 52
        ? 'u80-report.pdf'
        : i === 53
          ? 'u80-notes.md'
          : i === 54
            ? 'u80-blocked.bin'
            : `u80-${i}.log`
    const blocked = i === 54
    const res = await fetch(`${service.url}/v1/internal/audit/file-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify({
        eventType: blocked ? 'download_blocked' : 'file_download',
        result: blocked ? 'denied' : 'success',
        traceId: `tr_u80_${i}`,
        cloudSession: 'sess_u80',
        projectId: 'proj_payment',
        subject: 'user:zhangsan',
        metadata: {
          fileName: name,
          path: `srv/u80/very-long-directory-name/${'nested/'.repeat(6)}${name}`,
          sizeBytes: 4096,
          method: 'files.readChunk',
          kind: 'file',
          surface: 'desktop',
          capturePoint: blocked ? 'frontend-block' : 'download-runtime-client',
          policy: blocked ? 'deny' : 'allow',
          ...(blocked ? { reason: 'DOWNLOAD_DISABLED' } : {}),
          occurredAt: Date.now(),
          sha256: 'a'.repeat(64)
        }
      })
    })
    assert.equal(res.status, 200, await res.text())
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true })
}, { timeout: 180_000 })

after(async () => {
  await browser?.close()
  await service?.stop()
})

async function signIn(
  viewport: { width: number; height: number },
  [username, password]: readonly [string, string],
  hash = '#/audit',
  prepare?: (page: Page) => Promise<void>
): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    permissions: ['clipboard-read', 'clipboard-write']
  })
  const page = await context.newPage()
  await prepare?.(page)
  await page.goto(`${service.url}/${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#loginForm', { state: 'visible' })
  await page.fill('#username', username)
  await page.fill('#password', password)
  await page.click('#loginBtn')
  await page.waitForSelector('#view-app:not([hidden])')
  await page.waitForSelector('#content .page-head')
  return page
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
}

const GAP_STATUS = {
  chain: { ok: true, lastSeq: 55 },
  capacity: {
    fileEventsToday: 55,
    dailyEnvelope: 5000,
    fileEventsTotal: 55,
    totalEnvelope: 500000,
    overDailyEnvelope: false,
    overTotalEnvelope: false
  },
  gaps: { hostsWithGap: 1, droppedTotal: 2, suppressedTotal: 1, rateLimitedTotal: 0 },
  ingressGaps: { droppedTotal: 0, suppressedTotal: 0, rateLimitedTotal: 0 },
  persisted: true,
  eventTypes: ['file_download', 'file_copy', 'download_blocked', 'login']
}

test('390×844：筛选默认收起、展开单列 ≥44px、查询后摘要计数', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    const shell = page.locator('#auditFilterShell')
    assert.equal(await shell.getAttribute('open'), null, 'phone filter starts folded')
    assert.equal(await page.locator('.audit-filter-summary').isVisible(), true)
    assert.match(await page.locator('.audit-filter-summary').innerText(), /^筛选/)
    assert.equal(await page.locator('#auditKeyword').isVisible(), false, 'folded hides fields')

    await page.click('.audit-filter-summary')
    await page.waitForSelector('#auditFilterShell[open]')
    assert.equal(await page.locator('#auditKeyword').isVisible(), true)

    const columns = await page
      .locator('#auditFilterShell .audit-filter')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    assert.equal(columns, 1, 'expanded fields are single column')
    for (const selector of ['#auditKeyword', '#auditRange', '#auditType', '#auditResult']) {
      const box = await page.locator(selector).boundingBox()
      assert.ok(box && box.height >= 44, `${selector} >=44px, got ${box?.height}`)
    }
    const buttonHeights = await page
      .locator('.audit-filter-actions .btn')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
    assert.equal(buttonHeights.length, 2)
    assert.ok(
      buttonHeights.every((height) => height >= 44),
      '查询/重置 >=44px'
    )

    await page.fill('#auditKeyword', 'u80')
    await page.click('#auditApply')
    await page.waitForFunction(() => location.hash.includes('q=u80'))
    // The previous render is still mounted until the fresh query resolves.
    await page.waitForFunction(() =>
      document.querySelector('.audit-filter-summary')?.textContent?.includes('1 条件')
    )
    await page.waitForFunction(() => document.querySelectorAll('.audit-event-card').length > 0)
    assert.match(
      await page.locator('.audit-filter-summary').innerText(),
      /筛选 · 1 条件/,
      'summary counts the applied condition'
    )
    assert.equal(await page.locator('#auditFilterShell[open]').count(), 0, 'query refolds')
    assert.match(await page.locator('#auditResultSummary').innerText(), /已显示 \d+ 条/)
    assert.match(await page.locator('.audit-event-card').first().innerText(), /u80-/)

    assert.ok((await horizontalOverflow(page)) <= 1, '390px audit must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-audit.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：事件卡片时间/身份/类型/结果，文件名可复制，加载更早 ≥44px', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    assert.equal(await page.locator('#auditTableWrap').isVisible(), false, 'table → cards')
    const cards = page.locator('.audit-event-card')
    assert.ok((await cards.count()) > 0, 'seeded events render as cards')

    const card = cards.filter({ hasText: 'u80-report.pdf' }).first()
    assert.match(await card.locator('.aec-time').innerText(), /\d{4}\/\d{1,2}\/\d{1,2}/)
    assert.equal(await card.locator('.aec-actor').isVisible(), true, 'identity line')
    assert.match(await card.locator('.aec-type').innerText(), /file_download/)
    assert.match(await card.locator('.aec-head .badge').innerText(), /成功|失败|拒绝/)
    assert.equal(await card.locator('.aec-head .badge').count(), 1, 'result badge')

    const copy = card.locator('[data-copy-file]')
    assert.equal(await copy.count(), 1, 'file name/path is copyable')
    const copyBox = await copy.boundingBox()
    assert.ok(copyBox && copyBox.height >= 44, `copy target >=44px, got ${copyBox?.height}`)
    await copy.click()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes('已复制'))
    )

    const more = page.locator('#auditMore')
    assert.equal(await more.isVisible(), true, '55 events expose load-older')
    const moreBox = await more.boundingBox()
    assert.ok(moreBox && moreBox.height >= 44, `加载更早 >=44px, got ${moreBox?.height}`)
    const before = await cards.count()
    await more.click()
    await page.waitForFunction(
      (count) => document.querySelectorAll('.audit-event-card').length > count,
      before
    )
    assert.match(await page.locator('#auditResultSummary').innerText(), /已显示 \d+ 条/)

    assert.ok((await horizontalOverflow(page)) <= 1, 'cards must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-audit-cards.png') })
  } finally {
    await page.context().close()
  }
})

test('390×844：事件详情 sheet 字段换行、traceId 可复制、无横向溢出', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN)
  try {
    const card = page.locator('.audit-event-card').filter({ hasText: 'u80-report.pdf' }).first()
    await card.locator('[data-audit-detail]').click()
    await page.waitForSelector('.dialog-backdrop.dialog-sheet')
    const sheet = await page.locator('.dialog-backdrop.dialog-sheet .dialog').boundingBox()
    assert.ok(sheet, 'sheet must be laid out')
    assert.ok(sheet.width >= 389 && sheet.height >= 843, 'sheet spans the phone viewport')
    assert.equal(await page.locator('.dialog-sheet-close').isVisible(), true, 'back button')

    assert.match(await page.locator('.dialog-sheet .audit-kv').innerText(), /traceId/)
    const overflowing = await page.locator('.dialog-sheet .audit-kv dd').evaluateAll((els) => {
      const limit = document.documentElement.clientWidth
      return els.filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width > 0 && rect.right > limit + 1
      }).length
    })
    assert.equal(overflowing, 0, 'detail values wrap inside the sheet')

    const traceCopy = page.locator('#auditTraceCopy')
    assert.equal(await traceCopy.isVisible(), true, 'traceId copy action')
    const traceBox = await traceCopy.boundingBox()
    assert.ok(traceBox && traceBox.height >= 44, `trace copy >=44px, got ${traceBox?.height}`)
    await traceCopy.click()
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.toast')].some((el) => el.textContent?.includes('已复制'))
    )
    assert.ok((await horizontalOverflow(page)) <= 1, 'open event sheet must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-audit-sheet.png') })

    await page.click('.dialog-sheet .foot [data-action="close"]')
    await page.waitForFunction(() => !document.querySelector('.dialog-backdrop'))
  } finally {
    await page.context().close()
  }
})

test('390×844：链健康/容量可读、校验按钮 ≥44px、缺口横幅可见且不溢出', async () => {
  const page = await signIn({ width: 390, height: 844 }, ADMIN, '#/audit', async (target) => {
    await target.route('**/v1/audit/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(GAP_STATUS)
      })
    )
  })
  try {
    const gap = page.locator('#auditGapWarning')
    assert.equal(await gap.isVisible(), true, 'non-zero gap must stay visible')
    assert.match(await gap.innerText(), /审计缺口：1 台主机有缺口/)
    const fontSize = await gap.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
    assert.ok(fontSize >= 13, `gap banner readable, got ${fontSize}px`)
    const gapOverflow = await gap.evaluate(
      (el) => el.scrollWidth - el.getBoundingClientRect().width
    )
    assert.ok(gapOverflow <= 1, 'gap banner text wraps')

    const health = page.locator('#auditHealth')
    const summary = health.locator('summary')
    assert.match(await summary.innerText(), /链健康与容量/)
    const summaryBox = await summary.boundingBox()
    assert.ok(summaryBox && summaryBox.height >= 44, 'health summary >=44px')
    await summary.click()
    await page.waitForSelector('#auditHealth[open]')
    assert.match(await health.innerText(), /链健康：正常.*容量：未超限/s)

    const verify = page.locator('#auditVerify')
    const verifyBox = await verify.boundingBox()
    assert.ok(verifyBox && verifyBox.height >= 44, `校验审计链 >=44px, got ${verifyBox?.height}`)
    await verify.click()
    await page.waitForFunction(() =>
      document.querySelector('#auditVerifyResult')?.textContent?.includes('校验通过')
    )
    assert.match(await page.locator('#auditVerifyResult').innerText(), /校验通过：已校验 \d+ 条/)

    assert.ok((await horizontalOverflow(page)) <= 1, 'health block must not overflow')
    await page.screenshot({ path: join(evidenceDir(EV), '390x844-audit-health.png') })
  } finally {
    await page.context().close()
  }
})

for (const width of [768, 1280] as const) {
  test(`${width}px：桌面表格与筛选不变、卡片列表隐藏、无横向溢出`, async () => {
    const page = await signIn({ width, height: width === 768 ? 1024 : 900 }, ADMIN)
    try {
      assert.equal(await page.locator('#auditTableWrap').isVisible(), true, 'desktop keeps table')
      assert.equal(await page.locator('#auditList').isVisible(), false, 'cards stay phone-only')
      assert.equal(await page.locator('.audit-filter-summary').isVisible(), false)
      assert.equal(
        await page.locator('#auditFilterShell').getAttribute('open'),
        '',
        'desktop filter is open'
      )
      assert.equal(await page.locator('#auditKeyword').isVisible(), true)

      const columns = await page
        .locator('.audit-filter')
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
      assert.equal(columns, width === 1280 ? 12 : 6, `${width}px keeps its grid breakpoint`)
      assert.ok((await horizontalOverflow(page)) <= 1, `${width}px must not overflow`)
      await page.screenshot({
        path: join(evidenceDir(EV), `${width}-audit-desktop.png`)
      })
    } finally {
      await page.context().close()
    }
  })
}
