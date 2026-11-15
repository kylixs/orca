#!/usr/bin/env node
/**
 * PS-1 resident Playwright server: one headless Chromium, one BrowserContext per
 * identity (admin/zhangsan/lisi), tab registry, and a 127.0.0.1 HTTP control plane.
 *
 * Usage:
 *   node cloud-platform/scripts/playwright-server/server.mjs [--port 9223]
 *     [--base https://127.0.0.1:18787] [--evidence-dir <dir>] [--state-dir <dir>]
 *
 * Port: --port > ORCA_PW_SERVER_PORT > 9223. Pass 0 for a random loopback port.
 * Auth: Bearer token; generated per start, or ORCA_PW_SERVER_TOKEN. GET /status is anonymous.
 * Writes <evidence-dir>/server.json (mode 0600) so callers can discover port + token.
 */
import http from 'node:http'
import https from 'node:https'
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { createUi } from './ui.mjs'

const HERE = import.meta.dirname
const REPO_ROOT = path.resolve(HERE, '../../..')

function parseArgs(argv) {
  const options = {
    port: Number(process.env.ORCA_PW_SERVER_PORT ?? 9223),
    base: process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787',
    evidenceDir:
      process.env.ORCA_PW_EVIDENCE_DIR ||
      path.join(REPO_ROOT, 'cloud-platform/evidence/ps1-server-core'),
    stateDir: process.env.ORCA_PW_STATE_DIR || '',
    token: process.env.ORCA_PW_SERVER_TOKEN || '',
    ensureEnv: false,
    scriptsDirs: []
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined) {
        throw new Error(`${arg} needs a value`)
      }
      i += 1
      return next
    }
    if (arg === '--port') {
      options.port = Number(value())
    } else if (arg === '--base') {
      options.base = value()
    } else if (arg === '--evidence-dir') {
      options.evidenceDir = path.resolve(value())
    } else if (arg === '--state-dir') {
      options.stateDir = path.resolve(value())
    } else if (arg === '--token') {
      options.token = value()
    } else if (arg === '--scripts-dir') {
      options.scriptsDirs.push(path.resolve(value()))
    } else if (arg === '--ensure-env') {
      options.ensureEnv = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'node server.mjs [--port n] [--base url] [--evidence-dir dir] [--state-dir dir] [--token t] [--scripts-dir dir] [--ensure-env]'
      )
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  options.evidenceDir = path.resolve(options.evidenceDir)
  options.stateDir = options.stateDir || path.join(options.evidenceDir, 'state')
  options.token = options.token || randomBytes(18).toString('hex')
  const extra = (process.env.ORCA_PW_SERVER_SCRIPTS_DIRS || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.resolve(dir))
  options.scriptsDirs = [HERE, ...options.scriptsDirs, ...extra]
  return options
}

const options = parseArgs(process.argv.slice(2))
mkdirSync(options.evidenceDir, { recursive: true })
mkdirSync(path.join(options.evidenceDir, 'shots'), { recursive: true })
mkdirSync(options.stateDir, { recursive: true })
mkdirSync(path.join(options.evidenceDir, 'runs'), { recursive: true })

const startedAt = Date.now()

/** One-shot reachability probe for --base; self-signed dev TLS is expected. */
function probeBase(baseUrl, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(baseUrl)
    } catch {
      return resolve(false)
    }
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(
      target,
      { method: 'GET', rejectUnauthorized: false, timeout: timeoutMs },
      (res) => {
        res.resume()
        resolve(res.statusCode < 500)
      }
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

class BrowserHost {
  constructor({ stateDir }) {
    this.stateDir = stateDir
    this.browser = null
    this.contexts = new Map()
  }

  async start() {
    this.browser = await chromium.launch({ headless: true })
  }

  async contextFor(profile) {
    const existing = this.contexts.get(profile)
    if (existing) {
      return existing
    }
    const storageState = path.join(this.stateDir, `${profile}.json`)
    const context = await this.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
      ...(existsSync(storageState) ? { storageState } : {})
    })
    this.contexts.set(profile, context)
    return context
  }

  async persist(profile) {
    const context = this.contexts.get(profile)
    if (!context) {
      return null
    }
    const file = path.join(this.stateDir, `${profile}.json`)
    await context.storageState({ path: file })
    chmodSync(file, 0o600)
    return file
  }

  async close() {
    for (const context of this.contexts.values()) {
      await context.close().catch(() => undefined)
    }
    this.contexts.clear()
    if (this.browser) {
      await this.browser.close().catch(() => undefined)
    }
    this.browser = null
  }
}

class TabRegistry {
  constructor() {
    this.tabs = new Map()
    this.seq = 0
    this.activeId = null
  }

  async open({ profile, url, context }) {
    const page = await context.newPage()
    const id = `t${(this.seq += 1)}`
    const record = {
      id,
      profile,
      page,
      context,
      createdAt: new Date().toISOString()
    }
    this.tabs.set(id, record)
    this.activeId = id
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
    }
    return record
  }

  get(id) {
    const record = this.tabs.get(id)
    if (!record) {
      const error = new Error(`tab not found: ${id}`)
      error.statusCode = 404
      throw error
    }
    return record
  }

  list() {
    return [...this.tabs.values()].map((record) => this.describe(record))
  }

  describe(record) {
    const frames = record.page.frames().map((frame) => ({
      name: frame === record.page.mainFrame() ? 'main' : frame.name() || 'frame',
      url: frame.url(),
      workspace: frame.url().includes('cloud-admin.html')
    }))
    return {
      id: record.id,
      profile: record.profile,
      url: record.page.url(),
      title: '',
      active: record.id === this.activeId,
      frames,
      createdAt: record.createdAt
    }
  }

  async describeWithTitle(record) {
    const base = this.describe(record)
    base.title = await record.page.title().catch(() => '')
    return base
  }

  async listWithTitles() {
    const records = [...this.tabs.values()]
    return Promise.all(records.map((record) => this.describeWithTitle(record)))
  }

  async close(id) {
    const record = this.get(id)
    await record.page.close().catch(() => undefined)
    this.tabs.delete(id)
    if (this.activeId === id) {
      this.activeId = [...this.tabs.keys()].at(-1) ?? null
    }
  }

  async closeAll() {
    for (const id of this.tabs.keys()) {
      await this.close(id)
    }
  }
}

const host = new BrowserHost({ stateDir: options.stateDir })
const registry = new TabRegistry()

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(
          Object.assign(new Error('request body too large'), {
            statusCode: 413
          })
        )
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        return resolve({})
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('body must be JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function assertSafeEvidencePath(requested, fallback) {
  const resolved = path.resolve(options.evidenceDir, requested || fallback)
  if (resolved !== options.evidenceDir && !resolved.startsWith(options.evidenceDir + path.sep)) {
    throw Object.assign(new Error('path escapes evidence directory'), {
      statusCode: 400
    })
  }
  return resolved
}

function assertAllowedScriptPath(requested) {
  const resolved = path.resolve(requested)
  let real
  try {
    real = realpathSync(resolved)
  } catch {
    throw Object.assign(new Error(`script not found: ${requested}`), {
      statusCode: 404
    })
  }
  const allowed = options.scriptsDirs.some((dir) => {
    const realDir = existsSync(dir) ? realpathSync(dir) : dir
    return real === realDir || real.startsWith(realDir + path.sep)
  })
  if (!allowed) {
    throw Object.assign(new Error(`script path not allowed: ${requested}`), {
      statusCode: 403
    })
  }
  return real
}

function makeRunDir(label) {
  const runId = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
  const dir = path.join(options.evidenceDir, 'runs', runId)
  mkdirSync(path.join(dir, 'shots'), { recursive: true })
  return { runId, dir }
}

function buildInlineFunction(source) {
  try {
    const fn = new Function(`return (${source})`)()
    if (typeof fn === 'function') {
      return { fn, positional: false }
    }
  } catch {
    // fall through to statement-body form
  }
  return {
    fn: new Function('page', 'ui', 'context', 'params', 'log', source),
    positional: true
  }
}

async function loadScriptModule(requestedPath) {
  const allowed = assertAllowedScriptPath(requestedPath)
  const mod = await import(`${pathToFileURL(allowed).href}?v=${Date.now()}`)
  return mod.default ?? mod.journey ?? mod
}

async function runInTab(tab, body) {
  const { runId, dir } = makeRunDir('run')
  const ui = createUi({
    page: tab.page,
    baseUrl: options.base,
    profile: tab.profile,
    evidenceDir: dir,
    mode: 'server',
    onLogin: () => host.persist(tab.profile)
  })
  const startedAtRun = Date.now()
  const timeoutMs = Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 120000
  const context = {
    page: tab.page,
    ui,
    context: tab.context,
    params: body.params ?? {},
    mode: 'server',
    log: ui.log,
    screenshot: (name, opts) => ui.screenshot(name, opts)
  }

  let work
  if (typeof body.source === 'string' && body.source.trim()) {
    const { fn, positional } = buildInlineFunction(body.source)
    work = () => (positional ? fn(tab.page, ui, tab.context, context.params, ui.log) : fn(context))
  } else {
    const requested = body.path ?? body.script
    if (!requested) {
      throw Object.assign(new Error('execute needs source, path or script'), {
        statusCode: 400
      })
    }
    const scriptPath = path.isAbsolute(requested) ? requested : path.join(HERE, requested)
    work = async () => {
      const journey = await loadScriptModule(scriptPath)
      if (journey && typeof journey.run === 'function') {
        return journey.run(context)
      }
      if (typeof journey === 'function') {
        return journey(context)
      }
      throw new Error('script module must export a journey ({run}) or a function')
    }
  }

  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`run timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  let payload
  try {
    const result = await Promise.race([work(), timeout])
    payload = {
      ok: true,
      runId,
      mode: 'server',
      result: result ?? null,
      steps: ui.steps,
      logs: ui.logs,
      durationMs: Date.now() - startedAtRun
    }
  } catch (error) {
    payload = {
      ok: false,
      runId,
      mode: 'server',
      error: {
        message: error.message,
        stack: error.stack,
        failedStep: ui.failedStep()
      },
      steps: ui.steps,
      logs: ui.logs,
      durationMs: Date.now() - startedAtRun
    }
  } finally {
    clearTimeout(timer)
  }

  await host.persist(tab.profile).catch(() => undefined)
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(payload, null, 2))
  writeFileSync(path.join(dir, 'logs.txt'), ui.logs.join('\n'))
  return payload
}

function authorize(req) {
  const header = req.headers.authorization || ''
  return header === `Bearer ${options.token}`
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    const parts = url.pathname.split('/').filter(Boolean)

    // Loopback-only control: reject DNS-rebinding hosts and cross-origin callers.
    if (discovery && req.headers.host !== `127.0.0.1:${discovery.port}`) {
      return json(res, 403, {
        error: { code: 'BAD_HOST', message: 'Host must be 127.0.0.1:<port>' }
      })
    }
    if (req.headers.origin && discovery && req.headers.origin !== discovery.url) {
      return json(res, 403, {
        error: {
          code: 'BAD_ORIGIN',
          message: 'cross-origin requests are refused'
        }
      })
    }

    if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/health')) {
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        port: options.port,
        url: `http://127.0.0.1:${options.port}`,
        baseUrl: options.base,
        browser: Boolean(host.browser),
        profiles: [...host.contexts.keys()],
        tabs: registry.tabs.size,
        uptimeMs: Date.now() - startedAt
      })
    }

    if (!authorize(req)) {
      return json(res, 401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'missing or invalid bearer token'
        }
      })
    }

    if (req.method === 'GET' && url.pathname === '/tabs') {
      return json(res, 200, await registry.listWithTitles())
    }

    if (req.method === 'POST' && url.pathname === '/tabs') {
      const body = await readBody(req)
      if (body.id) {
        const tab = registry.get(body.id)
        if (body.url) {
          await tab.page.goto(body.url, { waitUntil: 'domcontentloaded' })
        }
        registry.activeId = tab.id
        return json(res, 200, await registry.describeWithTitle(tab))
      }
      const profile = body.profile || 'zhangsan'
      const context = await host.contextFor(profile)
      const tab = await registry.open({
        profile,
        url: body.url || `${options.base}/`,
        context
      })
      return json(res, 201, await registry.describeWithTitle(tab))
    }

    if (parts[0] === 'tabs' && parts[1]) {
      const tab = registry.get(parts[1])
      const action = parts[2]

      if (req.method === 'POST' && action === 'execute') {
        const body = await readBody(req)
        const payload = await runInTab(tab, body)
        return json(res, 200, payload)
      }

      if (req.method === 'POST' && action === 'screenshot') {
        const body = await readBody(req)
        const fallback = `shots/${tab.id}-${Date.now()}.png`
        const file = assertSafeEvidencePath(body.path, fallback)
        mkdirSync(path.dirname(file), { recursive: true })
        await tab.page.screenshot({
          path: file,
          fullPage: Boolean(body.fullPage)
        })
        return json(res, 200, { path: file, bytes: true })
      }

      if (req.method === 'DELETE' && !action) {
        await registry.close(tab.id)
        res.writeHead(204)
        return res.end()
      }
    }

    if (req.method === 'POST' && url.pathname === '/shutdown') {
      json(res, 200, { ok: true, shuttingDown: true })
      return setTimeout(() => shutdown('http'), 50)
    }

    return json(res, 404, {
      error: {
        code: 'NOT_FOUND',
        message: `no route for ${req.method} ${url.pathname}`
      }
    })
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: {
        code: error.statusCode ? 'BAD_REQUEST' : 'INTERNAL',
        message: error.message
      }
    })
  }
})

let shuttingDown = false
async function shutdown(reason) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  console.log(`[playwright-server] shutting down (${reason})`)
  await registry.closeAll().catch(() => undefined)
  await host.close().catch(() => undefined)
  server.closeIdleConnections?.()
  setTimeout(() => process.exit(0), 2000).unref()
  await new Promise((resolve) => server.close(resolve))
  try {
    writeFileSync(
      path.join(options.evidenceDir, 'server.json'),
      JSON.stringify({ ...discovery, stoppedAt: new Date().toISOString(), reason }, null, 2)
    )
  } catch {
    // best effort
  }
  process.exit(0)
}

let discovery = null
if (await probeBase(options.base)) {
  console.log(`[playwright-server] base reachable: ${options.base}`)
} else {
  console.error(
    `[playwright-server] WARN base unreachable: ${options.base}; start it with: node cloud-platform/scripts/local-env-reseed.mjs`
  )
  if (options.ensureEnv) {
    console.error('[playwright-server] --ensure-env: exiting 2')
    process.exit(2)
  }
}
await host.start()
server.listen(options.port, '127.0.0.1', () => {
  const port = server.address().port
  options.port = port
  discovery = {
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    token: options.token,
    baseUrl: options.base,
    pidFile: path.join(options.evidenceDir, 'server.json'),
    startedAt: new Date(startedAt).toISOString()
  }
  const file = path.join(options.evidenceDir, 'server.json')
  writeFileSync(file, JSON.stringify(discovery, null, 2))
  chmodSync(file, 0o600)
  console.log(
    `[playwright-server] listening on http://127.0.0.1:${port} base=${options.base} pid=${process.pid}`
  )
})

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
