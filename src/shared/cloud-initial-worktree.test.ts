import { describe, expect, it } from 'vitest'
import type { Repo } from './repo-types'
import type { Worktree } from './worktree/types'
import { selectCloudInitialWorktreeId } from './cloud-initial-worktree'

type Row = Pick<Worktree, 'id' | 'repoId' | 'path'>

const repo: Pick<Repo, 'id' | 'path'> = { id: 'repo-a', path: '/srv/projects/checkout' }

function row(path: string, options: { id?: string; repoId?: string } = {}): Row {
  const repoId = options.repoId ?? repo.id
  return { id: options.id ?? `${repoId}::${path}`, repoId, path }
}

describe('select cloud initial worktree', () => {
  it('selects the row whose path equals the opened checkout', () => {
    const worktrees = [
      row('/srv/projects/checkout'),
      row('/srv/work/feature-x'),
      row('/srv/work/feature-y')
    ]
    expect(
      selectCloudInitialWorktreeId({ workspacePath: '/srv/work/feature-x', repo, worktrees })
    ).toBe('repo-a::/srv/work/feature-x')
  })

  it('compares resolved paths, so a trailing separator still matches', () => {
    const worktrees = [row('/srv/projects/checkout'), row('/srv/work/feature-x')]
    expect(
      selectCloudInitialWorktreeId({ workspacePath: '/srv/work/feature-x/', repo, worktrees })
    ).toBe('repo-a::/srv/work/feature-x')
  })

  it('returns null when the checkout is nested in a worktree but has no row of its own', () => {
    const worktrees = [row('/srv/projects/checkout'), row('/srv/work/feature-x')]
    expect(
      selectCloudInitialWorktreeId({
        workspacePath: '/srv/work/feature-x/nested/user-checkout',
        repo,
        worktrees
      })
    ).toBeNull()
  })

  it('returns null when no row matches', () => {
    expect(
      selectCloudInitialWorktreeId({
        workspacePath: '/srv/work/missing',
        repo,
        worktrees: [row('/srv/projects/checkout')]
      })
    ).toBeNull()
  })

  it('never selects a same-path row owned by a different repo', () => {
    const worktrees = [row('/srv/work/feature-x', { repoId: 'repo-b' })]
    expect(
      selectCloudInitialWorktreeId({ workspacePath: '/srv/work/feature-x', repo, worktrees })
    ).toBeNull()
  })

  it('picks the first row when duplicate paths arrive from the host', () => {
    const worktrees = [
      row('/srv/work/feature-x', { id: 'repo-a::first' }),
      row('/srv/work/feature-x', { id: 'repo-a::second' })
    ]
    expect(
      selectCloudInitialWorktreeId({ workspacePath: '/srv/work/feature-x', repo, worktrees })
    ).toBe('repo-a::first')
  })

  it('returns null without a checkout path', () => {
    expect(
      selectCloudInitialWorktreeId({
        workspacePath: null,
        repo,
        worktrees: [row('/srv/projects/checkout')]
      })
    ).toBeNull()
  })
})
