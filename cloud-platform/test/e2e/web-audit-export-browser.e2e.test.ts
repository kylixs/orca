import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { connect as connectNet } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, login, spawnService, type Service } from './harness.ts'

/**
 * U201 real-browser acceptance: capability probe → confirm dialog → POST →
 * poll → download, all through the resident Playwright server and headless
 * Chromium (no happy-dom). Only test/evidence files are added.
 */

const GENERATED_AT = new Date().toISOString()
const EVIDENCE_DIR = join(
  ROOT,
  'evidence',
  `u201-web-browser-${GENERATED_AT.replace(/[:.]/g, '-')}`
)
const READY_API = /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const READY_PW = /\[playwright-server\] listening on http:\/\/127\.0\.0\.1:(\d+)/
const PW_TOKEN = 'u201-web-browser-token'

type Result = { name: string; ok: boolean; durationMs: number; error?: string }

let api: Service | undefined
let pw: Service | undefined
let adminToken = ''
let tabId = ''
let jobId = ''
let totalEvents = 0
let downloadMode = ''
let downloadPath = ''
let cardCount = 0
let cleanup: Record<string, unknown> = { resident18787: 'untouched' }

const results: Result[] = []

function testCase(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    const started = Date.now()
    try {
      await fn()
      results.push({ name, ok: true, durationMs: Date.now() - started })
    } catch (error) {
      results.push({
        name,
        ok: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
}

function pwUrl(pathname: string): string {
  assert.ok(pw, 'playwright server must be running')
  return `${pw.url}${pathname}`
}

async function pwFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(pwUrl(pathname), {
    ...init,
    headers: {
      authorization: `Bearer ${PW_TOKEN}`,
      'content-type': 'application/json',
      ...init.headers
    }
  })
}

async function pwJson<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await pwFetch(pathname, init)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`playwright ${pathname} -> ${res.status}: ${text}`)
  }
  return (text ? JSON.parse(text) : null) as T
}

type ExecutePayload = {
  ok: boolean
  result?: unknown
  logs?: string[]
  error?: { message?: string }
}

async function execute<T>(
  source: string,
  params: Record<string, unknown> = {},
  timeoutMs = 90_000
): Promise<T> {
  const payload = await pwJson<ExecutePayload>(`/tabs/${tabId}/execute`, {
    method: 'POST',
    body: JSON.stringify({ source, params, timeoutMs })
  })
  if (!payload.ok) {
    throw new Error(
      `page step failed: ${payload.error?.message ?? 'unknown'}\n${payload.logs?.join('\n') ?? ''}`
    )
  }
  return payload.result as T
}

async function apiJson<T>(pathname: string): Promise<T> {
  assert.ok(api, 'api must be running')
  const res = await fetch(`${api.url}${pathname}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const text = await res.text()
  assert.equal(res.status, 200, `${pathname} -> ${res.status}: ${text}`)
  return JSON.parse(text) as T
}

function waitExit(proc: Service['proc'], timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectNet({ host: '127.0.0.1', port })
    const done = (closed: boolean): void => {
      socket.destroy()
      resolve(closed)
    }
    socket.setTimeout(1000)
    socket.once('connect', () => done(false))
    socket.once('error', () => done(true))
    socket.once('timeout', () => done(true))
  })
}

function writeEvidenceFiles(): void {
  const verdict = results.length === 0 ? 'INVALID' : results.every((r) => r.ok) ? 'PASS' : 'FAIL'
  const summary = {
    generatedAt: GENERATED_AT,
    finishedAt: new Date().toISOString(),
    verdict,
    assertions: results,
    capability: { auditExportChecked: 'via GET /v1/audit/status' },
    export: { jobId, totalEvents, downloadMode, cardCount },
    download: downloadPath
      ? {
          path: downloadPath,
          bytes: existsSync(downloadPath) ? readFileSync(downloadPath).length : 0,
          sha256: existsSync(downloadPath)
            ? createHash('sha256').update(readFileSync(downloadPath)).digest('hex')
            : null
        }
      : null,
    environment: {
      apiBase: api?.url ?? null,
      playwrightServer: pw?.url ?? null,
      browser: 'chromium headless (resident server)'
    },
    cleanup
  }
  writeFileSync(join(EVIDENCE_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(
    join(EVIDENCE_DIR, 'results.json'),
    `${JSON.stringify({ generatedAt: GENERATED_AT, results }, null, 2)}\n`
  )
  writeFileSync(join(EVIDENCE_DIR, 'cleanup.json'), `${JSON.stringify(cleanup, null, 2)}\n`)
  writeFileSync(
    join(EVIDENCE_DIR, 'server.log'),
    [
      '=== platform api ===',
      ...(api?.logs ?? []),
      '=== playwright server ===',
      ...(pw?.logs ?? [])
    ].join('')
  )
}

before(async () => {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-u201-browser-export-'))
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN: 'u201-web-browser-internal-token',
      ORCA_AUDIT_EXPORT_DIR: exportDir
    },
    READY_API,
    'u201-web-browser-api'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  // Produce a mixed audit trail; the export is filtered to login events.
  await login(api.url, 'zhangsan', 'Passw0rd!')
  await login(api.url, 'lisi', 'Passw0rd!')
  await fetch(`${api.url}/v1/audit/events?limit=10`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })

  const stateDir = mkdtempSync(join(tmpdir(), 'orca-u201-browser-state-'))
  pw = await spawnService(
    'scripts/playwright-server/server.mjs',
    {
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_PW_SERVER_PORT: '0',
      ORCA_QA_BASE: api.url,
      ORCA_PW_EVIDENCE_DIR: EVIDENCE_DIR,
      ORCA_PW_STATE_DIR: stateDir,
      ORCA_PW_SERVER_TOKEN: PW_TOKEN
    },
    READY_PW,
    'u201-web-browser-playwright'
  )

  const tab = await pwJson<{ id: string }>('/tabs', {
    method: 'POST',
    body: JSON.stringify({ profile: 'admin', url: `${api.url}/` })
  })
  tabId = tab.id
}, 180_000)

after(async () => {
  const apiCtx = api
  const pwCtx = pw
  if (pwCtx) {
    await pwFetch('/shutdown', { method: 'POST' }).catch(() => undefined)
    const exited = await waitExit(pwCtx.proc, 5000)
    await pwCtx.stop()
    cleanup.playwright = {
      pid: pwCtx.proc.pid,
      exited,
      port: pwCtx.port,
      portClosed: await portClosed(pwCtx.port)
    }
  }
  if (apiCtx) {
    const exited = await waitExit(apiCtx.proc, 3000)
    await apiCtx.stop()
    cleanup.api = {
      pid: apiCtx.proc.pid,
      exited,
      port: apiCtx.port,
      portClosed: await portClosed(apiCtx.port)
    }
  }
  writeEvidenceFiles()
}, 60_000)

testCase('capability probe: auditExport field advertises jsonl', async () => {
  const status = await apiJson<{
    auditExport?: { formats?: string[]; jobTtlSeconds?: number; downloadTokenTtlSeconds?: number }
  }>('/v1/audit/status')
  assert.ok(status.auditExport, 'GET /v1/audit/status must expose auditExport')
  assert.ok(
    status.auditExport.formats?.includes('jsonl'),
    `formats must include jsonl: ${JSON.stringify(status.auditExport.formats)}`
  )
  assert.ok(Number(status.auditExport.jobTtlSeconds) > 0, 'jobTtlSeconds must be positive')
})

testCase('audit page renders the export button and applies the login filter', async () => {
  const view = await execute<{ button: string; rows: number; selectedType: string }>(
    `async ({ page, ui }) => {
      await ui.login('admin')
      await ui.navigateMenu('audit')
      await page.waitForSelector('#auditExport', { state: 'visible', timeout: 20000 })
      await page.selectOption('#auditType', 'login')
      await page.click('#auditApply')
      await page.waitForFunction(
        () => document.querySelectorAll('#auditTableWrap tbody tr').length > 0,
        null,
        { timeout: 20000 }
      )
      return {
        button: (await page.locator('#auditExport').innerText()).trim(),
        selectedType: await page.locator('#auditType').inputValue(),
        rows: await page.locator('#auditTableWrap tbody tr').count()
      }
    }`
  )
  assert.equal(view.button, '导出')
  assert.equal(view.selectedType, 'login')
  assert.ok(view.rows > 0, 'the filtered audit table must render rows')
  cardCount = view.rows
  await pwJson(`/tabs/${tabId}/screenshot`, {
    method: 'POST',
    body: JSON.stringify({ path: 'audit-page.png' })
  })
})

testCase('export dialog shows the filter summary and jsonl format', async () => {
  const dialog = await execute<{
    title: string
    summary: string
    radios: { value: string; checked: boolean }[]
  }>(
    `async ({ page }) => {
      await page.click('#auditExport')
      await page.waitForSelector('.dialog-backdrop .dialog', { state: 'visible' })
      const view = page.locator('.dialog-backdrop').last()
      return {
        title: await view.locator('h2').innerText(),
        summary: await view.locator('.body ul').innerText(),
        radios: await view
          .locator('input[name="auditExportFormat"]')
          .evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, checked: node.checked })))
      }
    }`
  )
  assert.equal(dialog.title, '导出审计日志')
  assert.match(
    dialog.summary,
    /操作类型：登录/,
    `summary must carry the login filter: ${dialog.summary}`
  )
  assert.match(dialog.summary, /时间：/, 'summary must carry the time range')
  assert.deepEqual(
    dialog.radios.map((radio) => radio.value).sort(),
    ['csv', 'jsonl'],
    'both advertised formats must be offered'
  )
})

testCase('confirming jsonl reaches succeeded and renders the download link', async () => {
  const done = await execute<{
    jobId: string
    postStatus: number
    deleteAfterDownload: boolean
    href: string
    statusText: string
    statusBody?: { status?: string; format?: string; totalEvents?: number }
  }>(
    `async ({ page }) => {
      const view = page.locator('.dialog-backdrop').last()
      await view.locator('input[name="auditExportFormat"][value="jsonl"]').check()
      // Capture the polling payload: a later status read would rotate the token
      // and silently invalidate the link that is on screen.
      const statusBodies = []
      page.on('response', async (response) => {
        const pathname = new URL(response.url()).pathname
        if (response.request().method() !== 'GET' || !pathname.startsWith('/v1/audit/exports/')) return
        try { statusBodies.push(await response.json()) } catch {}
      })
      const posted = page.waitForResponse(
        (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/v1/audit/export',
        { timeout: 20000 }
      )
      await view.locator('[data-action="0"]').click()
      const response = await posted
      const job = await response.json()
      await page.waitForSelector('#auditExportDownload', { state: 'visible', timeout: 60000 })
      await page.waitForTimeout(100)
      return {
        jobId: job.jobId,
        postStatus: response.status(),
        deleteAfterDownload: job.deleteAfterDownload === true,
        href: await page.locator('#auditExportDownload').evaluate((node) => node.href),
        statusText: await page.locator('#auditExportStatus').innerText(),
        statusBody: statusBodies.filter((body) => body.status === 'succeeded').at(-1) ?? null
      }
    }`,
    {},
    90_000
  )
  assert.equal(done.postStatus, 202)
  assert.match(done.jobId, /^exp_[0-9a-f]{24}$/)
  assert.match(done.statusText, /导出已生成/)
  assert.match(done.href, /\/download\?token=/)
  jobId = done.jobId

  assert.ok(done.statusBody, 'the polling response body must be captured')
  assert.equal(done.statusBody?.status, 'succeeded')
  assert.equal(done.statusBody?.format, 'jsonl')
  assert.ok((done.statusBody?.totalEvents ?? 0) > 0, 'a succeeded export must count events')
  totalEvents = done.statusBody?.totalEvents ?? 0

  await pwJson(`/tabs/${tabId}/screenshot`, {
    method: 'POST',
    body: JSON.stringify({ path: 'audit-export-dialog.png' })
  })
})

testCase(
  'clicking the download link yields a file whose every line parses as the filter',
  async () => {
    downloadPath = join(EVIDENCE_DIR, 'audit-export.jsonl')
    const downloaded = await execute<{
      mode: string
      suggestedFilename?: string
      failure?: string | null
      fallbackStatus?: number
    }>(
      `async ({ page, params }) => {
      let download = null
      try {
        const waiting = page.waitForEvent('download', { timeout: 20000 })
        await page.locator('#auditExportDownload').click()
        download = await waiting
      } catch (error) {
        return { mode: 'no-download-event', error: error.message }
      }
      const failure = await download.failure().catch((error) => 'failure-error:' + error.message)
      try {
        await download.saveAs(params.savePath)
        return {
          mode: 'download-event',
          suggestedFilename: download.suggestedFilename(),
          failure,
          downloadUrl: download.url()
        }
      } catch (saveError) {
        return {
          mode: 'download-save-failed',
          suggestedFilename: download.suggestedFilename(),
          failure,
          downloadUrl: download.url(),
          saveError: saveError.message
        }
      }
    }`,
      { savePath: downloadPath },
      60_000
    )
    downloadMode = downloaded.mode
    assert.equal(
      downloadMode,
      'download-event',
      `download must be captured by Playwright: ${JSON.stringify(downloaded)}`
    )
    assert.equal(downloaded.failure ?? null, null)
    assert.ok(existsSync(downloadPath), 'the downloaded artifact must exist')

    const lines = readFileSync(downloadPath, 'utf8').split('\n').filter(Boolean)
    assert.ok(lines.length > 0, 'artifact must contain at least one JSONL line')
    assert.equal(
      lines.length,
      totalEvents,
      `line count ${lines.length} must equal totalEvents ${totalEvents}`
    )
    for (const [index, line] of lines.entries()) {
      const event = JSON.parse(line) as { eventType?: string }
      assert.equal(event.eventType, 'login', `line ${index + 1} must match the login filter`)
    }
    assert.ok(downloaded.suggestedFilename?.endsWith('.jsonl'), 'suggested filename must be .jsonl')
  }
)

testCase('evidence validates with --check-generated-at', async () => {
  writeEvidenceFiles()
  const { spawnSync } = await import('node:child_process')
  const validation = spawnSync(
    process.execPath,
    [
      'scripts/validate-evidence.mjs',
      EVIDENCE_DIR,
      '--check-generated-at',
      '--require=summary.json,results.json,server.log,audit-export.jsonl,audit-page.png,audit-export-dialog.png'
    ],
    { cwd: ROOT, encoding: 'utf8' }
  )
  assert.equal(
    validation.status,
    0,
    `validate-evidence failed: ${validation.stdout}${validation.stderr}`
  )
})
