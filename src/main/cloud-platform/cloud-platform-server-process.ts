import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The platform API app as a real child process for the cloud host tests: a real
 * server issuing signed tickets, so the platform's signing path is exercised the
 * same way in every suite that needs it.
 */

export const REPO_ROOT = new URL('../../..', import.meta.url).pathname
export const DEFAULT_INTERNAL_TOKEN = 'cloud-e2e-internal-token'

export type Platform = { url: string; stop: () => Promise<void> }

// accessTtlMs shortens the access token so a test can observe expiry.
export type PlatformOptions = { accessTtlMs?: number; refreshTtlMs?: number }

export async function startPlatform(options: PlatformOptions = {}): Promise<Platform> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: '0',
    INTERNAL_TOKEN: DEFAULT_INTERNAL_TOKEN
  }
  if (options.accessTtlMs !== undefined) {
    env.ORCA_CLOUD_ACCESS_TTL_MS = String(options.accessTtlMs)
  }
  if (options.refreshTtlMs !== undefined) {
    env.ORCA_CLOUD_REFRESH_TTL_MS = String(options.refreshTtlMs)
  }
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('platform did not start')), 15_000)
    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /\[api\] listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.once('exit', (code) => reject(new Error(`platform exited ${code}`)))
  })
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
      })
  }
}

/** A throwaway certificate for a real wss:// runtime in tests, as the platform hands out `wss://`. */
export function makeSelfSignedTls(commonName = 'dev-cloud'): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-tls-'))
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
    `/CN=${commonName}`,
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}
