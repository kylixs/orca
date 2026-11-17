import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { STATIC_CSP_REPORT_ONLY } from '../../apps/api/src/static-delivery.ts'
import {
  AuditExportJobStore,
  resolveAuditExportObjectPath
} from '../../apps/api/src/audit-export-jobs.ts'
import { login } from './harness.ts'

/**
 * U197 S6 / U224 (D10 phase 1): only HTML documents carry the report-only CSP.
 * JS/CSS/JSON/export/404 responses must not, because the shared static header
 * set is also inherited by JSON and audit-export downloads.
 */

const HEADER = 'content-security-policy-report-only'
const apps: ApiHandle[] = []

after(async () => {
  await Promise.all(apps.map((app) => app.close()))
})

function makeWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-csp-web-'))
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><script src="/app.js"></script></body></html>\n'
  )
  writeFileSync(join(root, 'app.js'), 'export const cspFixture = 1\n')
  writeFileSync(join(root, 'styles.css'), '.csp-fixture { color: #123456; }\n')
  // Filesystem fallback: present on disk but absent from the release manifest.
  writeFileSync(join(root, 'legacy.html'), '<!doctype html><p>legacy</p>\n')
  writeFileSync(join(root, 'notes.txt'), 'plain text\n')
  return root
}

/** `cspEnv: null` leaves the toggle unset, proving the default-on phase 1. */
async function start(
  options: {
    cspEnv?: string | null
    auditExportDir?: string
  } = {}
): Promise<{ base: string; webRoot: string }> {
  const webRoot = makeWebRoot()
  const archiveDir = join(mkdtempSync(join(tmpdir(), 'orca-csp-archive-')), 'releases')
  mkdirSync(archiveDir, { recursive: true })
  const previous = process.env.ORCA_CLOUD_CSP_REPORT_ONLY
  if (options.cspEnv === undefined || options.cspEnv === null) {
    delete process.env.ORCA_CLOUD_CSP_REPORT_ONLY
  } else {
    process.env.ORCA_CLOUD_CSP_REPORT_ONLY = options.cspEnv
  }
  try {
    const app = createApp({
      port: 0,
      webRoot,
      webReleaseArchiveDir: archiveDir,
      ...(options.auditExportDir ? { auditExportDir: options.auditExportDir } : {})
    })
    apps.push(app)
    const port = await app.listen()
    return { base: `http://127.0.0.1:${port}`, webRoot }
  } finally {
    // createApp resolves the toggle; restore before the next case runs.
    if (previous === undefined) {
      delete process.env.ORCA_CLOUD_CSP_REPORT_ONLY
    } else {
      process.env.ORCA_CLOUD_CSP_REPORT_ONLY = previous
    }
  }
}

async function seedSucceededExport(root: string, ownerId: string): Promise<string> {
  const store = new AuditExportJobStore({ root })
  const now = Date.now()
  const job = store.create({
    requestedBy: ownerId,
    requestedByUsername: 'admin',
    query: { limit: 50, since: now - 60 * 60_000, until: now },
    format: 'csv'
  })
  store.markRunning(job.jobId)
  const artifactPath = resolveAuditExportObjectPath(root, job.jobId, 'csv')
  assert.ok(artifactPath)
  mkdirSync(dirname(artifactPath), { recursive: true })
  const content = 'seq,eventType\n1,login\n'
  writeFileSync(artifactPath, content)
  store.markSucceeded(job.jobId, {
    totalEvents: 1,
    bytes: Buffer.byteLength(content)
  })
  return job.jobId
}

test('U197 S6：仅 HTML 文档下发 Report-Only CSP，JS/CSS/JSON/导出/404 不带', async () => {
  const exportRoot = mkdtempSync(join(tmpdir(), 'orca-csp-export-'))
  const { base } = await start({ auditExportDir: exportRoot })
  const release = (await (await fetch(`${base}/v1/web/release`)).json()) as { build: string }
  const hashedIndex = `/assets/${release.build}/index.html`
  const hashedApp = `/assets/${release.build}/app.js`

  // ① Documents: entry, explicit index, hashed entry, and the filesystem fallback.
  for (const path of ['/', '/index.html', hashedIndex, '/legacy.html']) {
    const res = await fetch(`${base}${path}`)
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get(HEADER), STATIC_CSP_REPORT_ONLY, path)
    assert.ok(!(res.headers.get(HEADER) ?? '').includes('upgrade-insecure-requests'), path)
  }

  // ② Non-documents: unhashed/hashed assets and the text fallback.
  for (const path of ['/app.js', '/styles.css', hashedApp, '/notes.txt']) {
    const res = await fetch(`${base}${path}`)
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get(HEADER), null, path)
  }
  // The fallback labels every file text/html; the header must still follow the
  // file name, not the contentType.
  const text = await fetch(`${base}/notes.txt`)
  assert.equal(text.headers.get('content-type'), 'text/html; charset=utf-8')

  // ③ JSON API responses do not inherit the document policy.
  const token = await login(base, 'admin', 'Adm1n!')
  const me = await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(me.status, 200)
  assert.equal(me.headers.get(HEADER), null)
  const meBody = (await me.json()) as { user: { id: string } }

  // ④ Audit-export downloads reuse STATIC_SECURITY_HEADERS; the policy must not spread.
  const jobId = await seedSucceededExport(exportRoot, meBody.user.id)
  const status = await fetch(`${base}/v1/audit/exports/${jobId}`, {
    headers: { authorization: `Bearer ${token}` }
  })
  assert.equal(status.status, 200)
  const { downloadUrl } = (await status.json()) as { downloadUrl?: string }
  assert.ok(downloadUrl)
  const download = await fetch(`${base}${downloadUrl}`)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get(HEADER), null)

  // ⑤ 404 pages keep their current shape: no policy header.
  const missing = await fetch(`${base}/missing.html`)
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get(HEADER), null)
})

test('U197 S6：ORCA_CLOUD_CSP_REPORT_ONLY=off 时不带该头（可回滚）', async () => {
  const { base } = await start({ cspEnv: 'off' })
  for (const path of ['/', '/index.html', '/legacy.html']) {
    const res = await fetch(`${base}${path}`)
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get(HEADER), null, path)
  }
})
