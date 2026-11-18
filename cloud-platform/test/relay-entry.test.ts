import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { preflightRelay } from '../apps/relay/src/relay.ts'

/**
 * U183 R3: `ExecStart` keeps pointing at `<root>/current`, so the entry guard
 * must compare realpaths on both sides; otherwise the main block never runs and
 * the relay exits 0 without listening.
 */

const PLATFORM_ROOT = resolve(import.meta.dirname, '..')
const RELAY_SRC = join(PLATFORM_ROOT, 'apps/relay/src')
const ENTRY_MODULE_SRC = join(PLATFORM_ROOT, 'apps/login-lockout/src')
const CONTRACT_SRC = join(PLATFORM_ROOT, 'packages/contract/src')
const RELEASE_SHA = 'a'.repeat(64)
const cleanups: Array<() => void> = []

after(() => {
  for (const cleanup of cleanups.reverse()) cleanup()
})

type RelayTree = { root: string; release: string; entry: string }

function makeRelayTree(): RelayTree {
  const root = mkdtempSync(join(tmpdir(), 'orca-relay-entry-'))
  const release = join(root, 'releases', RELEASE_SHA)
  mkdirSync(join(release, 'apps/relay/src'), { recursive: true })
  mkdirSync(join(release, 'apps/login-lockout/src'), { recursive: true })
  mkdirSync(join(release, 'packages/contract/src'), { recursive: true })
  cpSync(join(RELAY_SRC, 'relay.ts'), join(release, 'apps/relay/src/relay.ts'))
  cpSync(join(RELAY_SRC, 'sni.ts'), join(release, 'apps/relay/src/sni.ts'))
  cpSync(join(RELAY_SRC, 'relay-version.ts'), join(release, 'apps/relay/src/relay-version.ts'))
  cpSync(
    join(ENTRY_MODULE_SRC, 'entry-module.ts'),
    join(release, 'apps/login-lockout/src/entry-module.ts')
  )
  cpSync(
    join(CONTRACT_SRC, 'internal-fetch.ts'),
    join(release, 'packages/contract/src/internal-fetch.ts')
  )
  symlinkSync(release, join(root, 'current'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return { root, release, entry: join(release, 'apps/relay/src/relay.ts') }
}

function configuredEnv(port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ORCA_CLOUD_API_URL: 'http://127.0.0.1:18787',
    ORCA_CLOUD_INTERNAL_TOKEN: 'preflight-token',
    PORT: String(port)
  }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const { port } = server.address() as AddressInfo
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

async function isPortFree(port: number): Promise<boolean> {
  const server = createServer()
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolveListen())
    })
    return true
  } catch {
    return false
  } finally {
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
  }
}

function runPreflight(entry: string, env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [entry, '--preflight'], {
    env,
    encoding: 'utf8',
    timeout: 15_000
  })
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for value')
    await new Promise((done) => setTimeout(done, 50))
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((done) => child.once('exit', () => done())),
    new Promise<void>((done) => setTimeout(done, 3_000))
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function captureAnnouncement(
  entry: string,
  extraEnv: NodeJS.ProcessEnv
): Promise<{ id: string; port: number; installNonce?: string }> {
  const bodies: Array<{ id: string; port: number; installNonce?: string }> = []
  const platform: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      if (req.url === '/v1/internal/relay-routes') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ routes: [] }))
        return
      }
      if (req.url === '/v1/internal/relay-endpoint') {
        const parsed = JSON.parse(body) as { id: string; port: number; installNonce?: string }
        bodies.push(parsed)
        res.writeHead(204)
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    platform.once('error', reject)
    platform.listen(0, '127.0.0.1', () => resolveListen())
  })
  const { port: platformPort } = platform.address() as AddressInfo
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH,
      ORCA_CLOUD_API_URL: `http://127.0.0.1:${platformPort}`,
      ORCA_CLOUD_INTERNAL_TOKEN: 'announce-token',
      PORT: '0',
      ...extraEnv
    },
    stdio: 'ignore'
  })
  try {
    return await waitFor(() => bodies[0])
  } finally {
    await stopChild(child)
    await new Promise<void>((done) => platform.close(() => done()))
  }
}

describe('入口守卫 realpath（R3）', () => {
  test('真实路径、current 叶子链接、/tmp 前缀链接都执行主块', async () => {
    const { root, release, entry } = makeRelayTree()
    const port = await freePort()

    const direct = runPreflight(entry, configuredEnv(port))
    assert.equal(direct.status, 0, String(direct.stderr))
    assert.match(String(direct.stdout), /\[relay\] preflight ok/)

    const viaCurrent = runPreflight(
      join(root, 'current/apps/relay/src/relay.ts'),
      configuredEnv(port)
    )
    assert.equal(viaCurrent.status, 0, String(viaCurrent.stderr))
    assert.match(String(viaCurrent.stdout), /\[relay\] preflight ok/)

    const linkParent = mkdtempSync(join(tmpdir(), 'orca-relay-prefix-'))
    cleanups.push(() => rmSync(linkParent, { recursive: true, force: true }))
    const prefix = join(linkParent, 'prefix')
    symlinkSync(root, prefix)
    const viaPrefix = runPreflight(
      join(prefix, 'releases', RELEASE_SHA, 'apps/relay/src/relay.ts'),
      configuredEnv(port)
    )
    assert.equal(viaPrefix.status, 0, String(viaPrefix.stderr))
    assert.match(String(viaPrefix.stdout), /\[relay\] preflight ok/)

    assert.equal(release, join(root, 'releases', RELEASE_SHA))
  })

  test('被 import 时不执行主块', () => {
    const { root, entry } = makeRelayTree()
    const importer = join(root, 'import-probe.ts')
    writeFileSync(
      importer,
      [
        `import { preflightRelay, startRelay } from ${JSON.stringify(pathToFileURL(entry).href)}`,
        `if (typeof preflightRelay !== 'function' || typeof startRelay !== 'function') {`,
        `  throw new Error('relay exports missing')`,
        `}`,
        `console.log('IMPORTED_OK')`
      ].join('\n')
    )
    const result = runPreflight(importer, configuredEnv(18443))
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(String(result.stdout), /IMPORTED_OK/)
    assert.doesNotMatch(String(result.stdout), /\[relay\] preflight ok/)
  })
})

describe('--preflight（R3）', () => {
  test('配置齐全 exit 0 且不 listen', async () => {
    const { entry } = makeRelayTree()
    const port = await freePort()
    const result = runPreflight(entry, configuredEnv(port))
    assert.equal(result.status, 0, String(result.stderr))
    assert.match(String(result.stdout), /\[relay\] preflight ok/)
    assert.equal(await isPortFree(port), true, 'preflight must not bind the configured port')
  })

  test('缺配置 exit 78', () => {
    const { entry } = makeRelayTree()
    const result = runPreflight(entry, { PATH: process.env.PATH })
    assert.equal(result.status, 78, String(result.stderr))
  })

  test('Node 版本低于 22.18 exit 64', () => {
    const result = preflightRelay(
      {
        ORCA_CLOUD_API_URL: 'http://127.0.0.1:18787',
        ORCA_CLOUD_INTERNAL_TOKEN: 'token',
        PORT: '18443'
      },
      '21.9.0'
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.exitCode, 64)
  })
})

describe('RELAY_ID（R3）', () => {
  test('显式 ORCA_CLOUD_RELAY_ID 进入上报 payload', async () => {
    const { entry } = makeRelayTree()
    const body = await captureAnnouncement(entry, { ORCA_CLOUD_RELAY_ID: 'edge-alpha' })
    assert.equal(body.id, 'edge-alpha')
  })

  test('缺省 id 为 relay:<实际端口>', async () => {
    const { entry } = makeRelayTree()
    const body = await captureAnnouncement(entry, {})
    assert.equal(body.id, `relay:${body.port}`)
  })
})

describe('installNonce（R10a）', () => {
  test('ORCA_CLOUD_INSTALL_NONCE 进入上报 payload', async () => {
    const { entry } = makeRelayTree()
    const body = await captureAnnouncement(entry, {
      ORCA_CLOUD_INSTALL_NONCE: 'install-AbC_123-'
    })
    assert.equal(body.installNonce, 'install-AbC_123-')
  })

  test('未设置或空白时不发送该字段（旧平台不必认识它）', async () => {
    const { entry } = makeRelayTree()
    const absent = await captureAnnouncement(entry, {})
    assert.equal('installNonce' in absent, false)
    const blank = await captureAnnouncement(entry, { ORCA_CLOUD_INSTALL_NONCE: '  ' })
    assert.equal('installNonce' in blank, false)
  })
})
