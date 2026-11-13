/**
 * A real cloud platform for Electron specs: the API process, an admin token and
 * a host enrolment token. The host itself is another Orca instance in cloud
 * host mode, which is how the product runs a development machine.
 */

import { execFileSync, spawn } from 'node:child_process'
import { connect as connectNet, createServer as createNetServer } from 'node:net'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'

/** Minimal checked readers: the spec typechecks without the renderer's module graph. */
export function readField(source: unknown, key: string): unknown {
  return source !== null && typeof source === 'object' ? Reflect.get(source, key) : undefined
}

export function readString(source: unknown, key: string): string | null {
  const value = readField(source, key)
  return typeof value === 'string' ? value : null
}

export function readArray(source: unknown, key: string): unknown[] | null {
  const value = readField(source, key)
  return Array.isArray(value) ? value : null
}

export function readStringArray(source: unknown, key: string): string[] | null {
  const value = readField(source, key)
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : null
}

export type CloudPlatform = {
  url: string
  port: number
  logs: () => string
  stop: () => Promise<void>
}

const INTERNAL_TOKEN = 'orca-e2e-cloud-internal'

/** Spawns the platform API and waits for its listening line. */
export async function startCloudPlatform(): Promise<CloudPlatform> {
  const proc = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  const append = (chunk: Buffer): void => {
    out += chunk.toString()
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`platform did not start: ${out}`)), 30_000)
    const tick = (): void => {
      const match = out.match(/\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
        return
      }
      if (proc.exitCode !== null) {
        clearTimeout(timer)
        reject(new Error(`platform exited early: ${out}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    logs: () => out,
    stop: () => stopProcess(proc)
  }
}

function stopProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve()
      return
    }
    proc.once('exit', () => resolve())
    proc.kill('SIGTERM')
    setTimeout(() => proc.kill('SIGKILL'), 2_000)
  })
}

export async function adminTokenOf(platformUrl: string): Promise<string> {
  const res = await fetch(`${platformUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'e2e-admin' })
  })
  const body: unknown = await res.json()
  const accessToken = readString(body, 'accessToken')
  if (!accessToken) {
    throw new Error(`admin login failed: ${JSON.stringify(body)}`)
  }
  return accessToken
}

/** The one-time credential the host instance presents on enrolment. */
export async function hostTokenOf(platformUrl: string, adminToken: string): Promise<string> {
  const res = await fetch(`${platformUrl}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const body: unknown = await res.json()
  const token = readString(body, 'token')
  if (!token) {
    throw new Error(`host token missing: ${JSON.stringify(body)}`)
  }
  return token
}

/**
 * Environment for an Orca instance acting as the development host. `projectsRoot`
 * lets the developer create projects under their own directory (self-service).
 */
export function cloudHostEnv(input: {
  platformUrl: string
  hostToken: string
  hostName: string
  projectsRoot: string
  /** Serves the runtime socket over TLS; the platform always hands out `wss://`. */
  tls?: { certPath: string; keyPath: string }
}): Record<string, string> {
  return {
    ORCA_CLOUD_API_URL: input.platformUrl,
    ORCA_CLOUD_HOST_TOKEN: input.hostToken,
    ORCA_CLOUD_HOST_NAME: input.hostName,
    ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1',
    ORCA_CLOUD_TLS_INSECURE: '1',
    ORCA_CLOUD_PROJECTS_ROOT: input.projectsRoot,
    ...(input.tls
      ? {
          ORCA_CLOUD_TLS_CERT_PATH: input.tls.certPath,
          ORCA_CLOUD_TLS_KEY_PATH: input.tls.keyPath
        }
      : {})
  }
}

/** A self-signed certificate with the loopback SAN the direct address resolves to. */
export function makeHostTls(commonName: string): {
  certPath: string
  keyPath: string
  fingerprint: string
} {
  const dir = mkdtempSync('/tmp/orca-cloud-tls-')
  const keyPath = path.join(dir, 'server.key')
  const certPath = path.join(dir, 'server.crt')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    `/CN=${commonName}`,
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])
  const der = new X509Certificate(readFileSync(certPath, 'utf8')).raw
  return {
    certPath,
    keyPath,
    fingerprint: `sha256:${createHash('sha256').update(der).digest('hex')}`
  }
}

/** Environment for an Orca instance acting as the developer's client. */
export function cloudClientEnv(platformUrl: string): Record<string, string> {
  return {
    ORCA_CLOUD_API_URL: platformUrl,
    ORCA_CLOUD_TLS_INSECURE: '1'
  }
}

export async function waitForHostOnline(
  platformUrl: string,
  adminToken: string,
  hostName: string,
  timeoutMs = 60_000
): Promise<{ id: string }> {
  // A host is only usable once its runtime is bound: the heartbeat then carries
  // the E2EE key and at least one direct address a client can reach.
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${platformUrl}/v1/hosts`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })
    if (res.ok) {
      const body: unknown = await res.json()
      const host = findHost(readArray(body, 'hosts'), hostName)
      const addrs = host ? readStringArray(host, 'directAddrs') : null
      if (
        host &&
        readField(host, 'online') === true &&
        (addrs?.length ?? 0) > 0 &&
        readString(host, 'e2eePublicKey')
      ) {
        return { id: readString(host, 'id') ?? '' }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`host ${hostName} never came online`)
}

function findHost(hosts: unknown[] | null, name: string): unknown {
  for (const entry of hosts ?? []) {
    if (readString(entry, 'name') === name) {
      return entry
    }
  }
  return null
}

export type TcpDelayHop = {
  url: string
  /** Delays the platform's replies, so every control-plane round trip costs more. */
  setDelayMs: (ms: number) => void
  close: () => Promise<void>
}

/**
 * A TCP hop in front of the platform whose replies can be held back. The client
 * talks to the platform through it, so a latency budget can be shown to move with
 * the control plane instead of being a constant.
 */
export async function startTcpDelayHop(targetPort: number): Promise<TcpDelayHop> {
  let delayMs = 0
  const server = createNetServer((caller) => {
    const target = connectNet(targetPort, '127.0.0.1')
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    setDelayMs: (ms) => {
      delayMs = ms
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

export function mainEntryPath(): string {
  return path.join(process.cwd(), 'out', 'main', 'index.js')
}
