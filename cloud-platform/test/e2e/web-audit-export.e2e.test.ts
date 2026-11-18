import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, spawnService, type Service } from './harness.ts'
import { loadWebConsolePage, type WebConsolePage } from './web-console-page.ts'

/**
 * U201 E11: the Web console's audit export entry point. The platform advertises
 * export through `/v1/audit/status` `auditExport`; without it no button exists.
 * The real export endpoints are stubbed here so the test owns the job's state
 * machine (queued → running → succeeded) and the timer boundaries.
 */

const TIMER_SCALE = 0.01
const EXPORT_PATH = 'POST /v1/audit/export'
const JOB_PATH = (jobId: string): string => `GET /v1/audit/exports/${jobId}`

let service: Service

before(async () => {
  service = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN: 'w201-e11-internal-token' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'web-audit-export'
  )
  await login(service.url, 'admin', 'Adm1n!')
}, { timeout: 120_000 })

after(async () => {
  await service?.stop()
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, label: string, timeout = 8_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Loads the console, optionally pre-seeding the audit deep link / status stub. */
async function openAuditPage(options: { hash?: string; statusStub?: unknown } = {}) {
  const page = loadWebConsolePage(service.url, {
    timerScale: TIMER_SCALE,
    ...(options.hash ? { hash: options.hash } : {})
  })
  if (options.statusStub !== undefined) {
    page.fail('GET', '/v1/audit/status', { status: 200, body: options.statusStub })
  }
  await page.settle()
  await page.submitLogin('admin', 'Adm1n!')
  // A seeded deep link already restored the audit query; the nav click would
  // rewrite the hash and drop those filters.
  if (!options.hash) await page.clickNav('audit')
  return page
}

function dialogIn(page: WebConsolePage): HTMLElement {
  const dialogs = [...page.window.document.querySelectorAll<HTMLElement>('.dialog-backdrop')]
  const dialog = dialogs.at(-1)
  assert.ok(dialog, 'the export dialog must be open')
  return dialog
}

function openExportDialog(page: WebConsolePage): HTMLElement {
  const button = page.window.document.querySelector<HTMLButtonElement>('#auditExport')
  assert.ok(button, 'the export entry must be rendered')
  button.click()
  return dialogIn(page)
}

function clickConfirm(dialog: HTMLElement): void {
  dialog.querySelector<HTMLButtonElement>('[data-action="0"]')!.click()
}

function statusText(dialog: HTMLElement): string {
  return dialog.querySelector('#auditExportStatus')?.textContent ?? ''
}

function postCount(page: WebConsolePage): number {
  return page.calls().filter((call) => call === EXPORT_PATH).length
}

function statusCallCount(page: WebConsolePage, jobId: string): number {
  return page.calls().filter((call) => call === JOB_PATH(jobId)).length
}

function postBodies(page: WebConsolePage): Record<string, unknown>[] {
  return page
    .bodies()
    .filter((entry) => entry.call === EXPORT_PATH)
    .map((entry) => entry.body as Record<string, unknown>)
}

const queuedJob = (jobId: string, format = 'csv') => ({
  jobId,
  status: 'queued',
  format,
  requestedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000
})

const succeededJob = (jobId: string, extra: Record<string, unknown> = {}) => ({
  jobId,
  status: 'succeeded',
  format: 'csv',
  requestedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  totalEvents: 3,
  bytes: 256,
  downloadUrl: `/v1/audit/exports/${jobId}/download?token=tok-${jobId}`,
  ...extra
})

test('U201-E11: 无 auditExport 能力字段时不渲染导出入口', async () => {
  const page = await openAuditPage({ statusStub: { eventTypes: ['login'] } })
  assert.equal(
    page.window.document.querySelector('#auditExport'),
    null,
    'an older platform must not show the export button'
  )
})

test('U201-E11: status 声明 auditExport 后显示导出入口', async () => {
  const page = await openAuditPage()
  assert.ok(
    page.window.document.querySelector('#auditExport'),
    'the capability field must render the export button'
  )
})

test('U201-E11: 取消确认不发任何导出请求', async () => {
  const page = await openAuditPage()
  const dialog = openExportDialog(page)
  dialog.querySelector<HTMLButtonElement>('[data-action="close"]')!.click()
  assert.equal(postCount(page), 0, 'closing the dialog must not POST')
})

test('U201-E11: 确认后只 POST 一次，筛选与格式同当前 URL', async () => {
  const page = await openAuditPage({
    hash: '#/audit?range=24&event=file_download&q=login&fileName=secret.txt'
  })
  page.fail('POST', '/v1/audit/export', {
    status: 202,
    body: queuedJob('exp_confirm', 'jsonl')
  })
  page.fail('GET', '/v1/audit/exports/exp_confirm', {
    status: 200,
    body: {
      jobId: 'exp_confirm',
      status: 'succeeded',
      format: 'jsonl',
      totalEvents: 2,
      bytes: 128
    }
  })

  const dialog = openExportDialog(page)
  dialog.querySelector<HTMLInputElement>(
    'input[name="auditExportFormat"][value="jsonl"]'
  )!.checked = true
  clickConfirm(dialog)

  await waitFor(() => statusText(dialog).includes('已生成'), 'success state')
  assert.equal(postCount(page), 1, 'one confirmation must send exactly one POST')
  const [body] = postBodies(page)
  assert.equal(body.format, 'jsonl')
  assert.equal(body.confirm, true)
  assert.equal(body.q, 'login')
  assert.equal(body.fileName, 'secret.txt')
  assert.deepEqual(body.eventTypes, ['file_download'])
  assert.equal(typeof body.since, 'string')
  assert.ok(Number.isFinite(Date.parse(String(body.since))), 'since must be ISO')
})

test('U201-E11: 轮询 queued→running→succeeded，成功后停止单一定时器', async () => {
  const job: Record<string, unknown> = queuedJob('exp_poll')
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', { status: 202, body: { ...job } })
  page.fail('GET', '/v1/audit/exports/exp_poll', { status: 200, body: job })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)

  await waitFor(
    () => statusCallCount(page, 'exp_poll') >= 2,
    'at least two status polls'
  )
  job.status = 'running'
  await waitFor(() => statusText(dialog).includes('正在生成'), 'running state')
  job.status = 'succeeded'
  await waitFor(() => statusText(dialog).includes('已生成'), 'succeeded state')

  const settled = statusCallCount(page, 'exp_poll')
  await sleep(150)
  assert.equal(
    statusCallCount(page, 'exp_poll'),
    settled,
    'a succeeded job must stop polling instead of scheduling another tick'
  )
})

test('U201-E11: 重复点击「开始导出」只产生一次 POST 和一个定时器', async () => {
  const job = queuedJob('exp_double')
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', { status: 202, body: { ...job } })
  page.fail('GET', '/v1/audit/exports/exp_double', { status: 200, body: job })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)
  clickConfirm(dialog)
  await waitFor(() => statusCallCount(page, 'exp_double') >= 2, 'polling to start')

  assert.equal(postCount(page), 1, 'double click must not create a second job')
  // One timer means one request per interval, not two overlapping chains.
  assert.ok(
    statusCallCount(page, 'exp_double') <= 4,
    `expected a single poll chain, saw ${statusCallCount(page, 'exp_double')} calls`
  )
})

test('U201-E11: 轮询达到上限后停止', async () => {
  const job: Record<string, unknown> = { ...queuedJob('exp_cap'), status: 'running' }
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', { status: 202, body: { ...job } })
  page.fail('GET', '/v1/audit/exports/exp_cap', { status: 200, body: job })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)
  await waitFor(() => statusText(dialog).includes('超过 60 秒'), 'polling cap')
  assert.equal(statusCallCount(page, 'exp_cap'), 60, 'the cap is 60 one-second ticks')

  await sleep(150)
  assert.equal(statusCallCount(page, 'exp_cap'), 60, 'no tick may outlive the cap')
})

test('U201-E11: 400/403/429/410 都给出可读中文原因', async () => {
  const page = await openAuditPage()
  const cases = [
    {
      status: 400,
      body: { error: { code: 'INVALID_QUERY', message: 'q 至少 2 个字符。' } },
      expected: '导出条件无效：q 至少 2 个字符。'
    },
    {
      status: 400,
      body: { error: { code: 'TIME_WINDOW_TOO_LARGE', message: '查询时间窗最大 31 天。' } },
      expected: '查询时间窗最大 31 天'
    },
    {
      status: 403,
      body: { error: { code: 'PERMISSION_DENIED', message: '拒绝访问。' } },
      expected: '无导出权限'
    },
    {
      status: 429,
      body: { error: { code: 'EXPORT_BUSY', message: '导出任务过多。' } },
      expected: '导出任务过多'
    },
    {
      status: 410,
      body: { error: { code: 'EXPORT_EXPIRED', message: '导出任务已过期。' } },
      expected: '导出任务已过期'
    }
  ] as const

  for (const item of cases) {
    page.clearFails()
    page.fail('POST', '/v1/audit/export', { status: item.status, body: item.body })
    const dialog = openExportDialog(page)
    clickConfirm(dialog)
    await waitFor(() => statusText(dialog).includes(item.expected), item.expected)
    assert.match(statusText(dialog), new RegExp(item.expected))
    dialog.querySelector<HTMLButtonElement>('[data-action="close"]')!.click()
  }
  assert.equal(postCount(page), cases.length)
})

test('U201-E11: 路由切换清理轮询定时器', async () => {
  const job: Record<string, unknown> = { ...queuedJob('exp_route'), status: 'running' }
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', { status: 202, body: { ...job } })
  page.fail('GET', '/v1/audit/exports/exp_route', { status: 200, body: job })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)
  await waitFor(() => statusCallCount(page, 'exp_route') >= 2, 'polling to start')

  await page.clickNav('workbench')
  const settled = statusCallCount(page, 'exp_route')
  await sleep(200)
  assert.equal(
    statusCallCount(page, 'exp_route'),
    settled,
    'leaving the audit route must stop the export poll'
  )
  dialog.querySelector<HTMLButtonElement>('[data-action="close"]')!.click()
})

test('U201-E12: succeeded 显示同源 <a download>，点击不 window.open、不发 api 请求', async () => {
  const job = succeededJob('exp_download')
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', {
    status: 202,
    body: queuedJob('exp_download')
  })
  page.fail('GET', '/v1/audit/exports/exp_download', { status: 200, body: job })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)
  await waitFor(() => statusText(dialog).includes('已生成'), 'succeeded state')

  const link = dialog.querySelector<HTMLAnchorElement>('#auditExportDownload')
  assert.ok(link, 'a succeeded export must offer a download link')
  assert.equal(link.getAttribute('href'), job.downloadUrl)
  assert.ok(link.hasAttribute('download'), 'the control must be an <a download>')
  assert.equal(link.getAttribute('target'), null, 'a download must not target a new window')

  let opened = 0
  page.window.open = () => {
    opened += 1
    return null
  }
  // happy-dom navigation opens a window even for `<a download>`; a real browser
  // downloads in place, so suppress the default action to observe app behavior.
  const suppressNavigation = (event: Event): void => event.preventDefault()
  page.window.document.addEventListener('click', suppressNavigation, true)
  const callsBefore = page.calls().length
  link.click()
  link.click() // a second click must not replay the downloaded state
  page.window.document.removeEventListener('click', suppressNavigation, true)

  assert.equal(opened, 0, 'a download must never call window.open')
  assert.equal(page.calls().length, callsBefore, 'the anchor must not go through api() (no Bearer)')
  assert.ok(
    !page.calls().some((call) => call.includes('/v1/audit/exports/exp_download/download')),
    'the download URL must never be fetched with the session header'
  )

  await waitFor(() => statusText(dialog).includes('已下载'), 'consumed link state')
  assert.equal(
    (statusText(dialog).match(/已下载/g) ?? []).length,
    1,
    'a second click must not append the state twice'
  )
})

test('U201-E12: 已下载/无 downloadUrl 时给出说明且不渲染下载链接', async () => {
  const job = succeededJob('exp_used', {
    downloadUrl: undefined,
    downloaded: true,
    downloadUnavailableReason: 'deleted_after_download'
  })
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', { status: 202, body: queuedJob('exp_used') })
  page.fail('GET', '/v1/audit/exports/exp_used', { status: 200, body: job })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)
  await waitFor(() => statusText(dialog).includes('已生成'), 'succeeded state')

  assert.equal(
    dialog.querySelector('#auditExportDownload'),
    null,
    'a consumed export must not render a dead link'
  )
  assert.match(statusText(dialog), /已下载/)
  assert.match(statusText(dialog), /重新导出/)
})

test('U201-E12: 状态 410 显示过期文案与重新导出入口，且轮询停止', async () => {
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', { status: 202, body: queuedJob('exp_gone') })
  page.fail('GET', '/v1/audit/exports/exp_gone', {
    status: 410,
    body: { error: { code: 'EXPORT_EXPIRED', message: '导出任务已过期。' } }
  })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)
  await waitFor(() => statusText(dialog).includes('导出任务已过期'), 'expired state')
  assert.match(statusText(dialog), /重新导出/)
  const retry = dialog.querySelector<HTMLButtonElement>('#auditExportRetry')
  assert.ok(retry, 'the expired state must offer a retry entry')

  const polls = statusCallCount(page, 'exp_gone')
  await sleep(150)
  assert.equal(statusCallCount(page, 'exp_gone'), polls, 'an expired job must stop polling')

  retry.click()
  assert.equal(
    page.window.document.querySelectorAll('.dialog-backdrop').length,
    1,
    'retry must replace the dialog instead of stacking a second one'
  )
  assert.ok(
    page.window.document.querySelector('.dialog-backdrop [data-action="0"]'),
    'retry must reopen the confirmation dialog'
  )
})

test('U201-E12: deleteAfterDownload 由服务端决定，响应标志驱动提示', async () => {
  const job = { ...succeededJob('exp_delete'), deleteAfterDownload: true }
  const page = await openAuditPage()
  page.fail('POST', '/v1/audit/export', { status: 202, body: queuedJob('exp_delete') })
  page.fail('GET', '/v1/audit/exports/exp_delete', { status: 200, body: job })

  const dialog = openExportDialog(page)
  clickConfirm(dialog)
  await waitFor(() => statusText(dialog).includes('已生成'), 'succeeded state')

  const [body] = postBodies(page)
  assert.equal(
    body.deleteAfterDownload,
    undefined,
    'the console leaves the D8 default (false) to the server'
  )
  assert.match(statusText(dialog), /下载后文件将删除/)
  assert.ok(
    dialog.querySelector('#auditExportDownload'),
    'the link stays available before the first click'
  )
})
