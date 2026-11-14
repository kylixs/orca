import { gitExecFileAsync, promptGuardGitEnv } from '../git/runner'

/**
 * Turns a directory into a one-commit repository the cloud open flow can branch
 * from. `git init -b <branch>` would be the short form but arrived in Git 2.28
 * and the host baseline is Git 2.25, so the unborn HEAD is pinned with
 * `symbolic-ref` instead. The initial commit makes `git worktree add` possible
 * at all — on an unborn HEAD it dies with "invalid reference".
 */

const INITIAL_COMMIT_MESSAGE = 'Initial commit'

/** Only a missing identity is retried with the fallback; other failures are real. */
const MISSING_IDENTITY = /Please tell me who you are|user\.name|user\.email/i

const FALLBACK_IDENTITY = ['-c', 'user.name=orca-cloud', '-c', 'user.email=orca-cloud@localhost']

function failureText(error: unknown): string {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? error.stderr : ''
  return `${error instanceof Error ? error.message : String(error)}\n${String(stderr ?? '')}`
}

/** `init` + branch pin + one empty commit; the branch must already be validated. */
export async function initializeEmptyRepositoryAt(
  targetPath: string,
  branch: string
): Promise<void> {
  // Why env here: the identity probe matches untranslated English git output (#7808).
  const options = { cwd: targetPath, env: promptGuardGitEnv() }
  await gitExecFileAsync(['init', '--quiet'], options)
  await gitExecFileAsync(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], options)
  try {
    await gitExecFileAsync(['commit', '--allow-empty', '-m', INITIAL_COMMIT_MESSAGE], options)
  } catch (error) {
    if (!MISSING_IDENTITY.test(failureText(error))) {
      throw error
    }
    await gitExecFileAsync(
      [...FALLBACK_IDENTITY, 'commit', '--allow-empty', '-m', INITIAL_COMMIT_MESSAGE],
      options
    )
  }
}
