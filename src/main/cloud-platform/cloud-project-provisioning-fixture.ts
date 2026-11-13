import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

export function saveProvisioningEvidence(file: string, content: unknown): void {
  mkdirSync(PROVISIONING_EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(PROVISIONING_EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}
