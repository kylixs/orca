import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

export const ROOT = new URL('../../', import.meta.url).pathname

export type Service = {
  proc: ChildProcess
  url: string
  port: number
  logs: string[]
  stop: () => Promise<void>
}

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
  let port = 0
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${name} did not start: ${logs.join('')}`)), 15000)
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString()
      logs.push(text)
      const match = readyPattern.exec(text)
      if (match) {
        clearTimeout(timeout)
        port = Number(match[1])
        resolve({
          proc,
          port,
          url: `http://127.0.0.1:${port}`,
          logs,
          stop: () =>
            new Promise<void>((done) => {
              if (proc.exitCode !== null) return done()
              proc.once('exit', () => done())
              proc.kill('SIGTERM')
              setTimeout(() => proc.kill('SIGKILL'), 2000)
            })
        })
      }
    }
    proc.stdout.on('data', onChunk)
    proc.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()))
    proc.once('exit', (code) => {
      if (port === 0) reject(new Error(`${name} exited ${code}: ${logs.join('')}`))
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

export function makeTlsCerts(): { key: string; cert: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-cert-'))
  const key = join(dir, 'server.key')
  const cert = join(dir, 'server.crt')
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
    '/CN=dev-001.relay.local',
    '-addext',
    'subjectAltName=DNS:dev-001.relay.local,DNS:localhost,IP:127.0.0.1'
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
      runtimeCapabilities: ['pty', 'files', 'managed-credential']
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
