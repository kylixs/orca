import { describe, expect, it, vi } from 'vitest'
import type { CloudProjectEnvironment } from '../../../shared/cloud-platform-ipc'
import type { Repo } from '../../../shared/repo-types'
import {
  cloudProjectReposOnHosts,
  planCloudProjectRepos,
  signOutCloudProjectRepos,
  syncCloudProjectRepos,
  type CloudProjectRepoPorts
} from './cloud-project-repos'

/** M52: a cloud project becomes one native sidebar row owned by its runtime host. */

const environments: CloudProjectEnvironment[] = [
  {
    projectId: 'project-a',
    projectName: 'Checkout Service',
    projectRoot: '/srv/projects/checkout',
    environmentId: 'env-a'
  },
  {
    projectId: 'project-b',
    projectName: 'Payments',
    projectRoot: '/srv/projects/payments',
    environmentId: 'env-b'
  }
]

function hostRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-a',
    path: '/srv/projects/checkout',
    displayName: 'checkout',
    badgeColor: 'gray',
    addedAt: 1,
    ...overrides
  }
}

function ports(overrides: Partial<CloudProjectRepoPorts> = {}): CloudProjectRepoPorts {
  return {
    addRepo: vi.fn(async (target) =>
      hostRepo({ id: `repo-${target.projectId}`, path: target.path })
    ),
    renameRepo: vi.fn(),
    purgeRepos: vi.fn(),
    signOut: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('cloud projects as sidebar repos', () => {
  it('plans one row per project at the project root, owned by runtime:<envId>', () => {
    const plan = planCloudProjectRepos({ environments, repos: [] })
    expect(plan.add).toEqual([
      {
        projectId: 'project-a',
        displayName: 'Checkout Service',
        path: '/srv/projects/checkout',
        environmentId: 'env-a',
        executionHostId: 'runtime:env-a'
      },
      {
        projectId: 'project-b',
        displayName: 'Payments',
        path: '/srv/projects/payments',
        environmentId: 'env-b',
        executionHostId: 'runtime:env-b'
      }
    ])
    expect(plan.rename).toEqual([])
  })

  it('is idempotent across two sign-ins: the second pass adds nothing', async () => {
    const firstPorts = ports()
    const first = await syncCloudProjectRepos({ environments, repos: [], ports: firstPorts })
    expect(first.failed).toEqual([])
    expect(first.added).toHaveLength(2)
    expect(first.added.map((repo) => repo.executionHostId)).toEqual([
      'runtime:env-a',
      'runtime:env-b'
    ])

    const secondPorts = ports()
    const second = await syncCloudProjectRepos({
      environments,
      repos: first.added,
      ports: secondPorts
    })
    expect(secondPorts.addRepo).not.toHaveBeenCalled()
    expect(second.added).toEqual([])
    expect(second.renamed).toBe(0)
  })

  it('updates an existing row instead of adding a duplicate', async () => {
    const existing = hostRepo({ executionHostId: 'runtime:env-a', displayName: 'checkout' })
    const syncPorts = ports()
    const result = await syncCloudProjectRepos({
      environments: [environments[0]],
      repos: [existing],
      ports: syncPorts
    })
    expect(syncPorts.addRepo).not.toHaveBeenCalled()
    expect(result.renamed).toBe(1)
    expect(syncPorts.renameRepo).toHaveBeenCalledWith({
      repo: existing,
      displayName: 'Checkout Service'
    })
  })

  it('reports a project the host refused without throwing', async () => {
    const syncPorts = ports({ addRepo: vi.fn(async () => null) })
    const result = await syncCloudProjectRepos({ environments, repos: [], ports: syncPorts })
    expect(result.added).toEqual([])
    expect(result.failed.map((entry) => entry.projectId)).toEqual(['project-a', 'project-b'])
  })

  it('sign-out removes exactly the rows owned by the cloud environments', async () => {
    const otherHost = hostRepo({ id: 'repo-local', path: '/Users/me/local' })
    const rows = [
      hostRepo({ executionHostId: 'runtime:env-a' }),
      hostRepo({ id: 'repo-b', path: '/srv/projects/payments', executionHostId: 'runtime:env-b' }),
      otherHost
    ]
    expect(cloudProjectReposOnHosts(rows, ['env-a', 'env-b'])).toHaveLength(2)
    expect(cloudProjectReposOnHosts(rows, ['env-a'])).toEqual([rows[0]])

    const signOut = vi.fn(async () => undefined)
    const purgeRepos = vi.fn()
    const removed = await signOutCloudProjectRepos({
      environments,
      repos: rows,
      ports: { signOut, purgeRepos }
    })
    expect(removed).toHaveLength(2)
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(purgeRepos).toHaveBeenCalledWith(['env-a', 'env-b'])
    // Why order: main retires the environments before the renderer forgets their rows.
    expect(signOut.mock.invocationCallOrder[0]).toBeLessThan(purgeRepos.mock.invocationCallOrder[0])
  })
})
