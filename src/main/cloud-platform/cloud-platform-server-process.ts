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
  // Why: leave stderr unread and a mid-run crash is invisible — the client only
  // reports ECONNREFUSED with no cause, and a full stderr pipe can block the child.
  let logs = ''
  const append = (chunk: Buffer): void => {
    logs += chunk.toString()
  }
  proc.stdout?.on('data', append)
  proc.stderr?.on('data', append)
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  let stopping = false
  let rejectStart: ((error: Error) => void) | null = null
  let startupTimer: NodeJS.Timeout | null = null
  proc.once('exit', (code, signal) => {
    exit = { code, signal }
    if (rejectStart) {
      if (startupTimer) {
        clearTimeout(startupTimer)
      }
      rejectStart(
        new Error(
          `platform exited before ready (code=${code} signal=${signal}):\n${logs.slice(-4000)}`
        )
      )
      return
    }
    if (!stopping) {
      console.error(
        `[platform] exited before teardown (code=${code} signal=${signal}):\n${logs.slice(-4000)}`
      )
    }
  })
  const url = await new Promise<string>((resolve, reject) => {
    rejectStart = reject
    startupTimer = setTimeout(
      () => reject(new Error(`platform did not start:\n${logs.slice(-4000)}`)),
      15_000
    )
    proc.stdout?.on('data', () => {
      const match = /\[api\] listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(logs)
      if (!match) {
        return
      }
      if (startupTimer) {
        clearTimeout(startupTimer)
      }
      rejectStart = null
      resolve(match[1])
    })
  })
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        stopping = true
        // Why: a signal-killed child keeps exitCode null, so only the signalCode
        // check tells us the exit event already fired (otherwise: 60s hook hang).
        if (exit || proc.exitCode !== null || proc.signalCode !== null) {
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
