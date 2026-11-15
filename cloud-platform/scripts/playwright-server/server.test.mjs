/**
 * PS-1 server core tests. Uses the live local platform at ORCA_QA_BASE
 * (default https://127.0.0.1:18787); journey tests skip when it is unreachable.
 *
 * Run: node --test cloud-platform/scripts/playwright-server/server.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname
const SERVER = path.join(HERE, 'server.mjs')
const JOURNEY = path.join(HERE, 'example-journey.mjs')
const BASE = process.env.ORCA_QA_BASE || 'https://127.0.0.1:18787'

async function baseReachable() {
  // The local platform serves a dev self-signed cert; Node's fetch would reject it.
  const { request } = await import(BASE.startsWith('https:') ? 'node:https' : 'node:http')
  return new Promise((resolve) => {
    const req = request(
      `${BASE}/`,
      { method: 'GET', rejectUnauthorized: false, timeout: 3000 },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
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

async function startServer(extraEnv = {}) {
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'ps1-server-evidence-'))
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ps1-server-state-'))
  const child = spawn(
    process.execPath,
    [SERVER, '--port', '0', '--base', BASE, '--evidence-dir', evidenceDir, '--state-dir', stateDir],
    { env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const discoveryFile = path.join(evidenceDir, 'server.json')
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (existsSync(discoveryFile)) {
      const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8'))
      if (discovery.port) {
        return {
          child,
          discovery,
          evidenceDir,
          stateDir,
          output: () => output,
          stop: () => stopChild(child)
        }
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${output}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill('SIGKILL')
  throw new Error(`server did not start: ${output}`)
}

function stopChild(child) {
  if (child.exitCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  })
}

async function api(discovery, method, route, body) {
  const res = await fetch(`${discovery.url}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${discovery.token}`,
      'content-type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

test('server exposes status, tab lifecycle, execute and screenshots', async (t) => {
  const server = await startServer()
  t.after(async () => {
    await server.stop()
    rmSync(server.evidenceDir, { recursive: true, force: true })
    rmSync(server.stateDir, { recursive: true, force: true })
  })

  const status = await fetch(`${server.discovery.url}/status`).then((res) => res.json())
  assert.equal(status.ok, true)
  assert.equal(status.browser, true)

  const unauthorized = await fetch(`${server.discovery.url}/tabs`)
  assert.equal(unauthorized.status, 401)

  const created = await api(server.discovery, 'POST', '/tabs', {
    profile: 'zhangsan',
    url: `${BASE}/`
  })
  assert.equal(created.status, 201)
  assert.match(created.body.id, /^t\d+$/)
  assert.equal(created.body.profile, 'zhangsan')

  const second = await api(server.discovery, 'POST', '/tabs', {
    profile: 'admin',
    url: `${BASE}/`
  })
  assert.equal(second.status, 201)
  assert.notEqual(second.body.id, created.body.id)

  const tabs = await api(server.discovery, 'GET', '/tabs')
  assert.equal(tabs.status, 200)
  assert.equal(tabs.body.length, 2)
  assert.deepEqual(tabs.body.map((tab) => tab.id).sort(), [created.body.id, second.body.id].sort())

  const executed = await api(server.discovery, 'POST', `/tabs/${created.body.id}/execute`, {
    source: 'async ({ page }) => ({ title: await page.title(), url: page.url() })'
  })
  assert.equal(executed.status, 200)
  assert.equal(executed.body.ok, true)
  assert.match(executed.body.result.title, /Orca Cloud/)

  const screenshot = await api(server.discovery, 'POST', `/tabs/${created.body.id}/screenshot`, {
    path: 'shots/tab-one.png'
  })
  assert.equal(screenshot.status, 200)
  assert.equal(existsSync(screenshot.body.path), true)

  const escape = await api(server.discovery, 'POST', `/tabs/${created.body.id}/screenshot`, {
    path: '../../etc/escape.png'
  })
  assert.equal(escape.status, 400)

  const removed = await api(server.discovery, 'DELETE', `/tabs/${created.body.id}`)
  assert.equal(removed.status, 204)
  const remaining = await api(server.discovery, 'GET', '/tabs')
  assert.equal(remaining.body.length, 1)

  const shutdown = await fetch(`${server.discovery.url}/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.discovery.token}` }
  })
  assert.equal(shutdown.status, 200)
  await new Promise((resolve) => server.child.once('exit', resolve))
  assert.equal(server.child.exitCode, 0)
})

test('same journey file runs injected and standalone', async (t) => {
  if (!(await baseReachable())) {
    t.skip(`local platform not reachable at ${BASE}`)
    return
  }

  const server = await startServer()
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'ps1-journey-evidence-'))
  t.after(async () => {
    await server.stop()
    rmSync(server.evidenceDir, { recursive: true, force: true })
    rmSync(server.stateDir, { recursive: true, force: true })
    rmSync(evidenceDir, { recursive: true, force: true })
  })

  const tab = await api(server.discovery, 'POST', '/tabs', {
    profile: 'zhangsan',
    url: `${BASE}/`
  })
  const injected = await api(server.discovery, 'POST', `/tabs/${tab.body.id}/execute`, {
    script: 'example-journey.mjs',
    timeoutMs: 60000
  })
  assert.equal(injected.body.ok, true, JSON.stringify(injected.body.error))
  assert.match(injected.body.result.docTitle, /Orca Cloud/)
  assert.equal(injected.body.result.crumbs, '工作台')

  const standalone = await new Promise((resolve) => {
    const child = spawn(process.execPath, [JOURNEY], {
      env: {
        ...process.env,
        ORCA_QA_BASE: BASE,
        ORCA_PW_EVIDENCE_DIR: evidenceDir,
        ORCA_PW_PROFILE: 'zhangsan'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('exit', (code) => resolve({ code, stdout, stderr }))
  })
  assert.equal(standalone.code, 0, standalone.stderr)
  // Final JSON payload starts at column 0; step logs precede it.
  const payload = JSON.parse(standalone.stdout.slice(standalone.stdout.lastIndexOf('\n{') + 1))
  assert.equal(payload.ok, true)
  assert.equal(payload.mode, 'standalone')
  assert.equal(payload.result.crumbs, '工作台')
})

test('--ensure-env exits 2 when the platform is unreachable', async (t) => {
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'ps1-ensure-env-'))
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }))

  const result = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        SERVER,
        '--port',
        '0',
        '--base',
        'https://127.0.0.1:1',
        '--evidence-dir',
        evidenceDir,
        '--ensure-env'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('exit', (code) => resolve({ code, stderr }))
  })

  assert.equal(result.code, 2)
  assert.match(result.stderr, /base unreachable/)
  assert.match(result.stderr, /--ensure-env/)
  assert.equal(existsSync(path.join(evidenceDir, 'server.json')), false)
})
