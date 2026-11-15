import { describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { CloudProjectEnvironment } from '../../../shared/cloud-platform-ipc'
import type { Repo } from '../../../shared/repo-types'
import { refreshCloudProjectWorktrees } from './cloud-entry-workspace-sync'

/**
 * U65b: a restart reuses persisted sidebar rows, but the host's actual checkout
 * list is authoritative. Every prepared project must be re-listed after sign-in
 * or restore instead of leaving the sidebar on a stale fallback row.
 */

const ENVIRONMENT: CloudProjectEnvironment = {
  projectId: 'proj_1',
  projectName: 'Payment Service',
  projectRoot: '/srv/work/payment-service',
  environmentId: 'env-1'
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: ENVIRONMENT.projectRoot,
    displayName: 'Payment Service',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    executionHostId: toRuntimeExecutionHostId(ENVIRONMENT.environmentId),
    ...overrides
  }
}

describe('cloud project worktree refresh (U65b)', () => {
  it('re-lists the repo owned by the prepared environment host', async () => {
    const fetchWorktrees = vi.fn(async () => true)

    await refreshCloudProjectWorktrees({
      environments: [ENVIRONMENT],
      repos: [repo()],
      fetchWorktrees
    })

    expect(fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      executionHostId: toRuntimeExecutionHostId(ENVIRONMENT.environmentId)
    })
  })

  it('ignores a same-path row owned by another host', async () => {
    const fetchWorktrees = vi.fn(async () => true)

    await refreshCloudProjectWorktrees({
      environments: [ENVIRONMENT],
      repos: [repo({ executionHostId: 'local' })],
      fetchWorktrees
    })

    expect(fetchWorktrees).not.toHaveBeenCalled()
  })

  it('continues to the next project when one host fails', async () => {
    const other: CloudProjectEnvironment = {
      ...ENVIRONMENT,
      projectId: 'proj_2',
      projectName: 'Infra Tools',
      projectRoot: '/srv/work/infra-tools',
      environmentId: 'env-2'
    }
    const fetchWorktrees = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unreachable'))
      .mockResolvedValueOnce(true)

    await refreshCloudProjectWorktrees({
      environments: [ENVIRONMENT, other],
      repos: [
        repo(),
        repo({
          id: 'repo-2',
          path: other.projectRoot,
          displayName: other.projectName,
          executionHostId: toRuntimeExecutionHostId(other.environmentId)
        })
      ],
      fetchWorktrees
    })

    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
  })
})
