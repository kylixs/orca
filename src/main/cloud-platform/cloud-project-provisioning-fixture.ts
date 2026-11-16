import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { REPO_ROOT } from './cloud-session-e2e-harness'

/** Git/evidence fixtures shared by the M57 provisioning suite. */

export const PROVISIONING_EVIDENCE_DIR = join(
  REPO_ROOT,
  'cloud-platform',
  'evidence',
  'm57-project-provisioning'
)

export const PROVISIONING_README = '# payment-service\n'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

/** A bare repository with one commit on `main`, cloned over the local path transport. */
export function makeBareRepository(base: string): string {
  const work = join(base, 'origin-work')
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'config', 'user.email', 'e2e@example.com')
  git(work, 'config', 'user.name', 'e2e')
  writeFileSync(join(work, 'README.md'), PROVISIONING_README)
  git(work, 'add', '.')
  git(work, 'commit', '-qm', 'init')
  const bare = join(base, 'payment-service.git')
  git(base, 'init', '-q', '--bare', bare)
  git(work, 'remote', 'add', 'origin', bare)
  git(work, 'push', '-q', 'origin', 'main')
  return bare
}

export type LocalGitDaemon = {
  /** A repoUrl both the platform and the host validators accept: a real git:// remote. */
  urlFor: (repoName: string) => string
  stop: () => Promise<void>
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  if (address === null || typeof address === 'string') {
    throw new Error('failed to reserve a loopback port')
  }
  return address.port
}

async function waitForLoopbackPort(port: number, isExited: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    if (isExited()) {
      throw new Error('git daemon exited before accepting connections')
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1')
        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })
        socket.once('error', (error) => {
          socket.destroy()
          reject(error)
        })
      })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`git daemon did not accept connections: ${String(lastError)}`)
}

/**
 * Serves the bare repos under `base` over git://. The platform rejects bare local
 * paths and the host rejects file://, so the fixture repo has to arrive as a URL
 * both sides accept.
 */
export async function startLocalGitDaemon(base: string): Promise<LocalGitDaemon> {
  const port = await reserveLoopbackPort()
  const child = spawnProcess({
    program: 'git',
    args: [
      'daemon',
      '--reuseaddr',
      '--export-all',
      `--base-path=${base}`,
      '--listen=127.0.0.1',
      `--port=${port}`,
      base
    ],
    stdio: 'ignore'
  })
  await waitForLoopbackPort(port, () => child.exitCode !== null)
  return {
    urlFor: (repoName) => `git://127.0.0.1:${port}/${repoName}`,
    stop: async () => {
      if (child.exitCode !== null) {
        return
      }
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill()
      })
    }
  }
}

export function saveProvisioningEvidence(file: string, content: unknown): void {
  mkdirSync(PROVISIONING_EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(PROVISIONING_EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}
