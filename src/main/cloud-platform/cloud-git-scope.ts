/**
 * Which git RPCs may only touch a user's own workspace (design §8.3: "the main
 * checkout is read-only by default").
 *
 * The ticket grants git through `terminal`, but that says nothing about *where*.
 * Without this split, a cloud session could commit, reset or discard inside the
 * shared main checkout, which is everyone else's source of truth.
 *
 * Everything not listed as read-only is treated as a write: a newly added git
 * method must not land on the main checkout just because nobody classified it.
 */

const GIT_READ_METHODS: ReadonlySet<string> = new Set([
  'git.status',
  'git.diff',
  'git.history',
  'git.localBranches',
  'git.checkIgnored',
  'git.submoduleStatus',
  'git.upstreamStatus',
  'git.branchCompare',
  'git.commitCompare',
  'git.commitDiff',
  'git.branchDiff',
  'git.remoteCommitUrl',
  'git.remoteFileUrl',
  'git.conflictOperation',
  'git.discoverCommitMessageModels',
  'git.generateCommitMessage',
  'git.generatePullRequestFields',
  'git.cancelGenerateCommitMessage',
  'git.cancelGeneratePullRequestFields'
])

export function cloudGitAccessOf(method: string): 'read' | 'write' | null {
  if (!method.startsWith('git.')) {
    return null
  }
  return GIT_READ_METHODS.has(method) ? 'read' : 'write'
}

/** Param names carrying repo-relative paths in git calls. */
const GIT_PATH_PARAMS: readonly string[] = [
  'filePath',
  'filePaths',
  'paths',
  'oldPath',
  'submodulePath'
]

export function cloudGitPathsOf(params: unknown): string[] {
  if (!params || typeof params !== 'object') {
    return []
  }
  const paths: string[] = []
  for (const key of GIT_PATH_PARAMS) {
    if (!(key in params)) {
      continue
    }
    const value: unknown = key in params ? Reflect.get(params, key) : undefined
    if (typeof value === 'string') {
      paths.push(value)
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') {
          paths.push(entry)
        }
      }
    }
  }
  return paths
}
