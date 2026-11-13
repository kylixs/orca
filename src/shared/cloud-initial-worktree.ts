import { normalizeRuntimePathForComparison } from './cross-platform-path'
import type { Repo } from './repo-types'
import type { Worktree } from './worktree/types'

/**
 * The sidebar row a cloud entry should activate: the worktree whose checkout is
 * the path the host opened for this project. DOM-free so both the entry hook and
 * the real end-to-end test can share the exact selection rule.
 */

export type CloudInitialWorktreeInput = {
  /** The checkout the host created or reused; null for sidecars without one. */
  workspacePath: string | null | undefined
  /** The registered sidebar repo that owns the checkout. */
  repo: Pick<Repo, 'id' | 'path'>
  /** The repo's sidebar rows, in the order the sidebar renders them. */
  worktrees: readonly Pick<Worktree, 'id' | 'repoId' | 'path'>[]
}

export function selectCloudInitialWorktreeId({
  workspacePath,
  repo,
  worktrees
}: CloudInitialWorktreeInput): string | null {
  if (!workspacePath) {
    return null
  }
  const wanted = normalizeRuntimePathForComparison(workspacePath)
  // Why exact path and repoId: a nested checkout never selects its parent
  // worktree, and a same-path row on another host is not this project's row.
  const match = worktrees.find(
    (worktree) =>
      worktree.repoId === repo.id && normalizeRuntimePathForComparison(worktree.path) === wanted
  )
  // Why first row: the sidebar renders listing order, so a duplicate path is
  // host malformation and the first row is what a click on that card activates.
  return match?.id ?? null
}
