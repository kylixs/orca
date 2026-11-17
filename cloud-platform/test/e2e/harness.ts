import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { connect as connectNet, createServer as createNetServer } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { after } from 'node:test'

export const ROOT = new URL('../../', import.meta.url).pathname

export type Service = {
  proc: ChildProcess
  url: string
  port: number
  logs: string[]
  stop: () => Promise<void>
}

/**
 * Services this process spawned that have not exited yet. U29: a suite that
 * aborts (assertion, timeout, hard exit) before its own stop() ran used to
 * orphan every spawned platform process; this registry lets the teardown below
 * reap them regardless of how the suite ended.
 */
const spawned = new Set<Service>()

/** How long SIGTERM has to work before the reaper escalates to SIGKILL. */
const REAP_GRACE_MS = 2000

function isLive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

/** SIGTERM everything left over, then SIGKILL whatever outlives the grace. */
async function reapSpawned(): Promise<void> {
  const pending = [...spawned].filter((service) => isLive(service.proc))
  spawned.clear()
  if (pending.length === 0) return
  for (const service of pending) service.proc.kill('SIGTERM')
  await Promise.race([
    Promise.all(
      pending.map((service) => new Promise<void>((done) => service.proc.once('exit', () => done())))
    ),
    new Promise<void>((resolve) => setTimeout(resolve, REAP_GRACE_MS).unref())
  ])
  for (const service of pending) if (isLive(service.proc)) service.proc.kill('SIGKILL')
}

// Runs at file teardown, after every after() the suites registered themselves.
after(reapSpawned)

// Crash paths (unhandled rejection, process.exit) skip test hooks; 'exit'
// handlers run synchronously, so this last resort has no grace period.
process.on('exit', () => {
  for (const service of spawned) {
    if (isLive(service.proc)) service.proc.kill('SIGKILL')
  }
})

export function evidenceDir(name: string): string {
  const dir = join(ROOT, 'evidence', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function saveEvidence(name: string, file: string, content: unknown): string {
  const dir = evidenceDir(name)
  const target = join(dir, file)
  writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  return target
}

/** Spawns a service and waits for a `[name] ... :port` line on stdout. */
export function spawnService(
  script: string,
  env: Record<string, string>,
  readyPattern: RegExp,
  name: string
): Promise<Service> {
  const proc = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const logs: string[] = []
  const stop = (): Promise<void> =>
    new Promise<void>((done) => {
      // Explicit stop owns the kill; drop it so teardown never re-kills.
      spawned.delete(service)
      // A signal-killed child reports signalCode, not exitCode, and its 'exit'
      // already fired — re-registering would wait forever.
      if (proc.exitCode !== null || proc.signalCode !== null) return done()
      proc.once('exit', () => done())
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 2000)
    })
  const service: Service = { proc, url: '', port: 0, logs, stop }
  spawned.add(service)
  proc.once('exit', () => spawned.delete(service))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Nobody holds this service yet; leaving it running would orphan it.
      void service.stop()
      reject(new Error(`${name} did not start: ${logs.join('')}`))
    }, 15000)
    const onChunk = (chunk: Buffer): void => {
      logs.push(chunk.toString())
      // Match against the accumulated log: the ready line can straddle chunks.
      const match = readyPattern.exec(logs.join(''))
      if (match) {
        clearTimeout(timeout)
        service.port = Number(match[1])
        service.url = `http://127.0.0.1:${service.port}`
        resolve(service)
      }
    }
    proc.stdout.on('data', onChunk)
    proc.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()))
    proc.once('exit', (code) => {
      if (service.port === 0) reject(new Error(`${name} exited ${code}: ${logs.join('')}`))
    })
  })
}

export function makeTempWorkspace(): { root: string; projectRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-cloud-e2e-'))
  const projectRoot = join(root, 'srv', 'work', 'payment-service')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'calculator.ts'), 'export const fee = 100\n')
  writeFileSync(join(projectRoot, 'README.md'), '# payment-service\n')
  return { root, projectRoot }
}

export type TlsCertOptions = {
  commonName?: string
  subjectAltName?: string
  /** Mark the cert as a CA so it can also serve as the peer's trust anchor. */
  trustAnchor?: boolean
}

export function makeTlsCerts(options: TlsCertOptions = {}): {
  key: string
  cert: string
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-cert-'))
  const key = join(dir, 'server.key')
  const cert = join(dir, 'server.crt')
  const subjectAltName =
    options.subjectAltName ?? 'DNS:dev-001.relay.local,DNS:localhost,IP:127.0.0.1'
  const extensions = ['-addext', `subjectAltName=${subjectAltName}`]
  if (options.trustAnchor) {
    extensions.push('-addext', 'basicConstraints=critical,CA:TRUE')
  }
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    `/CN=${options.commonName ?? 'dev-001.relay.local'}`,
    ...extensions
  ])
  return { key, cert, dir }
}

export function makeDeviceKey(): string {
  const { publicKey } = generateKeyPairSync('x25519')
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

export async function registerHost(input: {
  apiUrl: string
  adminToken: string
  name: string
  directAddr: string
  relayTarget: string
  relayRoute?: string
  /** Parent directory for developer self-service projects. */
  projectsRoot?: string
}): Promise<{ hostId: string; credential: string }> {
  const tokenRes = await fetch(`${input.apiUrl}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.adminToken}` }
  })
  const { token } = (await tokenRes.json()) as { token: string }
  const res = await fetch(`${input.apiUrl}/v1/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: input.name,
      fingerprint: `sha256:${input.name}`,
      e2eePublicKeyB64: 'test-e2ee-key',
      orcaVersion: '1.5.0',
      protocolVersion: 3,
      networkZone: 'intranet',
      directAddrs: [input.directAddr],
      relayTarget: input.relayTarget,
      relayRoute: input.relayRoute ?? input.name,
      runtimeCapabilities: ['pty', 'files', 'managed-credential'],
      ...(input.projectsRoot ? { projectsRoot: input.projectsRoot } : {})
    })
  })
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`)
  return (await res.json()) as { hostId: string; credential: string }
}

export async function login(apiUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${apiUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, devicePubKey: makeDeviceKey(), deviceName: 'e2e' })
  })
  const body = (await res.json()) as { accessToken?: string; error?: { code: string } }
  if (!res.ok) throw new Error(`login failed: ${body.error?.code}`)
  return body.accessToken!
}

export function readEvidence(path: string): string {
  return readFileSync(path, 'utf8')
}

export type TcpDelayHop = {
  url: string
  port: number
  /** Delays the target→caller direction, so a response is late by this much. */
  setDelayMs: (ms: number) => void
  close: () => Promise<void>
}

export type TcpHopOptions = {
  /** Forwarder listen address. Containers need 0.0.0.0 to reach the host. */
  bindHost?: string
}

/**
 * A TCP hop whose replies can be held back, so a latency budget can be shown to
 * move with the path instead of being a constant. Delay 0 is a pass-through.
 */
export async function startTcpDelayHop(
  targetPort: number | (() => number),
  options: TcpHopOptions = {}
): Promise<TcpDelayHop> {
  let delayMs = 0
  const server = createNetServer((caller) => {
    const target = connectNet(
      typeof targetPort === 'number' ? targetPort : targetPort(),
      '127.0.0.1'
    )
    caller.pipe(target)
    target.on('data', (chunk: Buffer) => {
      // Why pause: with a delay the reply must land after the timer, and pausing
      // keeps later chunks from overtaking this one.
      if (delayMs === 0) {
        caller.write(chunk)
        return
      }
      target.pause()
      setTimeout(() => {
        caller.write(chunk)
        target.resume()
      }, delayMs)
    })
    const drop = (): void => {
      caller.destroy()
      target.destroy()
    }
    caller.on('error', drop)
    target.on('error', drop)
    caller.on('close', () => target.destroy())
    target.on('close', () => caller.destroy())
  })
  await new Promise<void>((resolve) =>
    server.listen(0, options.bindHost ?? '127.0.0.1', () => resolve())
  )
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setDelayMs: (ms) => {
      delayMs = ms
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
