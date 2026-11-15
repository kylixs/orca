/**
 * Dual-mode journey runtime. A journey file imports this module, defines
 * `{name, run}` once, and works both when injected into the resident server
 * (server mode) and when executed directly with `node file.mjs` (standalone).
 */
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUi } from './ui.mjs'

export function defineJourney({ name, tags = [], run }) {
  if (!name || typeof name !== 'string') {
    throw new Error('defineJourney: name required')
  }
  if (typeof run !== 'function') {
    throw new Error('defineJourney: run must be a function')
  }
  return { name, tags: [...tags], run }
}

export function isMain(importMetaUrl) {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entry)
  } catch {
    return false
  }
}

function parseParams() {
  if (!process.env.ORCA_PW_PARAMS) {
    return {}
  }
  try {
    return JSON.parse(process.env.ORCA_PW_PARAMS)
  } catch {
    throw new Error('ORCA_PW_PARAMS must be JSON')
  }
}

/** Standalone runner used by `runIfMain`. Server imports the same file; then this is a no-op. */
export async function runIfMain(importMetaUrl, journey) {
  if (!isMain(importMetaUrl)) {
    return false
  }

  const { chromium } = await import('playwright')
  const baseUrl = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'
  const profile = process.env.ORCA_PW_PROFILE || 'zhangsan'
  const evidenceDir =
    process.env.ORCA_PW_EVIDENCE_DIR ||
    path.resolve(
      path.dirname(fileURLToPath(importMetaUrl)),
      '../../..',
      'cloud-platform/evidence/ps1-server-core/standalone'
    )
  mkdirSync(path.join(evidenceDir, 'shots'), { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 }
  })
  const page = await context.newPage()
  const ui = createUi({
    page,
    baseUrl,
    profile,
    evidenceDir,
    mode: 'standalone'
  })
  const startedAt = Date.now()

  let payload
  try {
    const result = await journey.run({
      page,
      ui,
      context,
      mode: 'standalone',
      params: parseParams(),
      log: ui.log,
      screenshot: (name, opts) => ui.screenshot(name, opts)
    })
    payload = {
      ok: true,
      name: journey.name,
      mode: 'standalone',
      result,
      steps: ui.steps,
      logs: ui.logs,
      durationMs: Date.now() - startedAt
    }
  } catch (error) {
    payload = {
      ok: false,
      name: journey.name,
      mode: 'standalone',
      error: {
        message: error.message,
        stack: error.stack,
        failedStep: ui.failedStep()
      },
      steps: ui.steps,
      logs: ui.logs,
      durationMs: Date.now() - startedAt
    }
    process.exitCode = 1
  } finally {
    writeFileSync(
      path.join(evidenceDir, `${journey.name}-standalone.json`),
      JSON.stringify(payload, null, 2)
    )
    await browser.close()
  }

  console.log(JSON.stringify(payload, null, 2))
  return true
}
