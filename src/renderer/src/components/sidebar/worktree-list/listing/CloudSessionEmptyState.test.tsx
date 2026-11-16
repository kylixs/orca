// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarCloudSessionEmptyState } from './CloudSessionEmptyState'
import type {
  CloudWorkspaceInfoResponse,
  CloudWorkspacePermission
} from '../../../../../../shared/cloud-workspace-info'
import type { OpenCloudWorkspaceResult } from '../../../../../../shared/cloud-workspace-open'
import {
  resetWebCloudWorkspaceBootstrap,
  startWebCloudWorkspaceBootstrapForTests
} from '@/web/web-cloud-workspace-bootstrap'

const PROJECT_ROOT = '/srv/work/payment-service'
const WORKSPACE_PATH = `${PROJECT_ROOT}/.orca-worktrees/zhangsan/main`

function infoWith(perms: CloudWorkspacePermission[]): () => Promise<CloudWorkspaceInfoResponse> {
  return async () => ({
    project: { id: 'proj_1', root: PROJECT_ROOT, repoUrl: '', defaultBranch: 'main' },
    workspace: { root: `${PROJECT_ROOT}/.orca-worktrees/zhangsan`, path: null, branch: null },
    perms
  })
}

function ports(args: {
  info: () => Promise<CloudWorkspaceInfoResponse>
  ensure: () => Promise<OpenCloudWorkspaceResult>
}): Parameters<typeof startWebCloudWorkspaceBootstrapForTests>[0] {
  return {
    api: () => ({ info: args.info, ensure: args.ensure }),
    environment: () => ({ id: 'web-env', name: 'payment-service (cloud session)' }),
    hydrationSettled: () => true,
    subscribeTransport: () => () => {},
    ensureRepoRow: async () => ({
      id: 'repo_1',
      path: PROJECT_ROOT,
      displayName: 'payment-service',
      badgeColor: '#000000',
      addedAt: 0,
      connectionId: null,
      executionHostId: 'runtime:web-env'
    }),
    worktreesForRepo: () => [],
    fetchWorktrees: async () => true,
    waitForSessionTabsRestore: async () => {},
    activateWorkspace: () => {}
  }
}

beforeEach(() => {
  resetWebCloudWorkspaceBootstrap()
})

afterEach(() => {
  cleanup()
  resetWebCloudWorkspaceBootstrap()
})

describe('SidebarCloudSessionEmptyState', () => {
  it('explains the cloud scope instead of the native empty list', () => {
    render(<SidebarCloudSessionEmptyState />)
    expect(screen.getByText('Cloud project session')).toBeTruthy()
    expect(
      screen.getByText(
        'This browser session is scoped to the project opened from the cloud platform. The desktop project catalog is not part of a cloud session.'
      )
    ).toBeTruthy()
    // Same list landmarks the native empty state carries, so tours keep working.
    expect(document.querySelector('[data-worktree-sidebar-container]')).not.toBeNull()
    expect(document.querySelector('[data-contextual-tour-target="workspace-list"]')).not.toBeNull()
    // The native "no workspaces" copy never shows for a cloud session.
    expect(screen.queryByText('No workspaces found')).toBeNull()
  })

  it('reports the bootstrap phase while the checkout is being prepared', async () => {
    render(<SidebarCloudSessionEmptyState />)
    const gate: { release: (() => void) | null } = { release: null }
    const run = startWebCloudWorkspaceBootstrapForTests(
      ports({
        info: infoWith(['open', 'terminal']),
        ensure: async () => {
          await new Promise<void>((resolve) => {
            gate.release = resolve
          })
          return { ok: true, workspacePath: WORKSPACE_PATH, created: false, provisioned: false }
        }
      })
    )
    await vi.waitFor(() => {
      expect(screen.getByText('Preparing your project checkout…')).toBeTruthy()
    })
    expect(
      document.querySelector('[data-worktree-sidebar-container] svg.lucide-cloud')
    ).not.toBeNull()

    gate.release?.()
    await run
  })

  it('names an Orca server that predates the workspace view, without a retry', async () => {
    const run = startWebCloudWorkspaceBootstrapForTests(
      ports({
        info: async () => {
          throw Object.assign(new Error("Method 'workspace.info' was not found."), {
            code: 'method_not_found'
          })
        },
        ensure: async () => ({ ok: false, code: 'UNREACHABLE' })
      })
    )
    await run
    render(<SidebarCloudSessionEmptyState />)

    expect(
      screen.getByText('This Orca server’s version does not support the cloud workspace view yet.')
    ).toBeTruthy()
    expect(screen.queryByText('Retry')).toBeNull()
  })

  it('offers a retry after a failed ensure', async () => {
    let attempts = 0
    const run = startWebCloudWorkspaceBootstrapForTests(
      ports({
        info: infoWith(['open', 'terminal']),
        ensure: async () => {
          attempts += 1
          return { ok: false, code: 'WORKTREE_CREATE_FAILED', message: 'clone failed' }
        }
      })
    )
    await run
    render(<SidebarCloudSessionEmptyState />)

    expect(screen.getByText('The cloud workspace could not be opened.')).toBeTruthy()
    expect(screen.getByText('clone failed')).toBeTruthy()
    screen.getByText('Retry').click()
    await vi.waitFor(() => {
      expect(attempts).toBe(2)
    })
  })

  it('explains a ticket that grants no terminal permission', async () => {
    const run = startWebCloudWorkspaceBootstrapForTests(
      ports({
        info: infoWith(['open']),
        ensure: async () => ({ ok: false, code: 'UNREACHABLE' })
      })
    )
    await run
    render(<SidebarCloudSessionEmptyState />)

    expect(
      screen.getByText(
        'This project’s ticket does not grant terminal access, so no workspace opens.'
      )
    ).toBeTruthy()
  })
})
