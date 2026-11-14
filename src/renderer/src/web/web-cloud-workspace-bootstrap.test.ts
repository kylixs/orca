// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CloudWorkspaceInfo,
  CloudWorkspaceInfoResponse
} from '../../../shared/cloud-workspace-info'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { OpenCloudWorkspaceResult } from '../../../shared/cloud-workspace-open'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  readWebCloudWorkspaceBootstrapStatus,
  resetWebCloudWorkspaceBootstrap,
  retryWebCloudWorkspaceBootstrap,
  startWebCloudWorkspaceBootstrapForTests,
  type WebCloudWorkspaceBootstrapStatus
} from './web-cloud-workspace-bootstrap'
import type {
  WebCloudWorkspaceBootstrapApi,
  WebCloudWorkspaceBootstrapPorts
} from './web-cloud-workspace-store-ports'

const PROJECT_ROOT = '/srv/work/payment-service'
const WORKSPACE_ROOT = `${PROJECT_ROOT}/.orca-worktrees/zhangsan`
const WORKSPACE_PATH = `${WORKSPACE_ROOT}/main`
const EXECUTION_HOST_ID = 'runtime:web-bootstrap-env'

function workspaceInfo(overrides: Partial<CloudWorkspaceInfo> = {}): CloudWorkspaceInfo {
  return {
    project: { id: 'proj_1', root: PROJECT_ROOT, repoUrl: '', defaultBranch: 'main' },
    workspace: { root: WORKSPACE_ROOT, path: null, branch: null },
    perms: ['open', 'terminal', 'file:read', 'file:write'],
    ...overrides
  }
}

function repoFixture(): Repo {
  return {
    id: 'repo_1',
    path: PROJECT_ROOT,
    displayName: 'payment-service',
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: null,
    executionHostId: EXECUTION_HOST_ID
  }
}

function worktreeFixture(): Worktree {
  return {
    id: `repo_1::${WORKSPACE_PATH}`,
    repoId: 'repo_1',
    path: WORKSPACE_PATH,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

type Harness = {
  ports: WebCloudWorkspaceBootstrapPorts
  info: ReturnType<typeof vi.fn<() => Promise<CloudWorkspaceInfoResponse>>>
  ensure: ReturnType<typeof vi.fn<(input: unknown) => Promise<OpenCloudWorkspaceResult>>>
  ensureRepoRow: ReturnType<
    typeof vi.fn<
      (input: {
        path: string
        displayName: string
        runtimeEnvironmentId: string
      }) => Promise<Repo | null>
    >
  >
  fetchWorktrees: ReturnType<typeof vi.fn<(repoId: string, hostId: string) => Promise<boolean>>>
  activateWorkspace: ReturnType<
    typeof vi.fn<
      (input: { worktreeId: string; executionHostId: string; mountExplorer: boolean }) => void
    >
  >
  emitTransport: (transport: RuntimeHostStatusSnapshot['transport']) => void
  setHydrationSettled: (settled: boolean) => void
}

function makeHarness(args?: {
  info?: () => Promise<CloudWorkspaceInfoResponse>
  ensure?: () => Promise<OpenCloudWorkspaceResult>
  repo?: Repo | null
  worktrees?: readonly Worktree[]
}): Harness {
  const transportListeners = new Set<(transport: RuntimeHostStatusSnapshot['transport']) => void>()
  let hydrationSettled = true
  const info = vi.fn<() => Promise<CloudWorkspaceInfoResponse>>(
    args?.info ?? (async () => workspaceInfo())
  )
  const ensure = vi.fn<(input: unknown) => Promise<OpenCloudWorkspaceResult>>(
    args?.ensure ??
      (async () => ({
        ok: true,
        workspacePath: WORKSPACE_PATH,
        created: false,
        provisioned: false
      }))
  )
  const api: WebCloudWorkspaceBootstrapApi = { info, ensure }
  const ensureRepoRow = vi.fn<
    (input: {
      path: string
      displayName: string
      runtimeEnvironmentId: string
    }) => Promise<Repo | null>
  >(async () => (args?.repo === undefined ? repoFixture() : args.repo))
  const fetchWorktrees = vi.fn<(repoId: string, hostId: string) => Promise<boolean>>(
    async () => true
  )
  const activateWorkspace =
    vi.fn<
      (input: { worktreeId: string; executionHostId: string; mountExplorer: boolean }) => void
    >()
  const ports: WebCloudWorkspaceBootstrapPorts = {
    api: () => api,
    environment: () => ({ id: 'web-bootstrap-env', name: 'payment-service (cloud session)' }),
    hydrationSettled: () => hydrationSettled,
    subscribeTransport: (listener) => {
      transportListeners.add(listener)
      return () => {
        transportListeners.delete(listener)
      }
    },
    ensureRepoRow,
    worktreesForRepo: () => args?.worktrees ?? [worktreeFixture()],
    fetchWorktrees,
    activateWorkspace
  }
  return {
    ports,
    info,
    ensure,
    ensureRepoRow,
    fetchWorktrees,
    activateWorkspace,
    emitTransport: (transport) => {
      for (const listener of transportListeners) {
        listener(transport)
      }
    },
    setHydrationSettled: (settled) => {
      hydrationSettled = settled
    }
  }
}

async function collectStatusPhases(run: () => Promise<void>): Promise<string[]> {
  const { subscribeToWebCloudWorkspaceBootstrap } = await import('./web-cloud-workspace-bootstrap')
  const history: WebCloudWorkspaceBootstrapStatus[] = []
  const unsubscribe = subscribeToWebCloudWorkspaceBootstrap(() => {
    history.push(readWebCloudWorkspaceBootstrapStatus())
  })
  try {
    await run()
  } finally {
    unsubscribe()
  }
  return history.map((entry) => entry.phase)
}

describe('web cloud workspace bootstrap (W13b)', () => {
  beforeEach(() => {
    resetWebCloudWorkspaceBootstrap()
  })

  afterEach(() => {
    resetWebCloudWorkspaceBootstrap()
    vi.restoreAllMocks()
  })

  it('runs info → ensure → seeding and activates the host-managed checkout', async () => {
    const harness = makeHarness()
    const phases = await collectStatusPhases(() =>
      startWebCloudWorkspaceBootstrapForTests(harness.ports)
    )

    expect(readWebCloudWorkspaceBootstrapStatus().phase).toBe('done')
    expect(phases).toEqual(['loading', 'registering', 'ensuring', 'activating', 'done'])
    expect(harness.ensure.mock.calls).toEqual([
      [
        {
          projectId: 'proj_1',
          roots: { projectRoot: PROJECT_ROOT, workspaceRoot: WORKSPACE_ROOT, defaultBranch: 'main' }
        }
      ]
    ])
    // The stored environment name carries the cloud-session marker; the sidebar row does not.
    expect(harness.ensureRepoRow.mock.calls).toEqual([
      [
        {
          path: PROJECT_ROOT,
          displayName: 'payment-service',
          runtimeEnvironmentId: 'web-bootstrap-env'
        }
      ]
    ])
    expect(harness.fetchWorktrees.mock.calls).toEqual([['repo_1', EXECUTION_HOST_ID]])
    expect(harness.activateWorkspace.mock.calls).toEqual([
      [
        {
          worktreeId: `repo_1::${WORKSPACE_PATH}`,
          executionHostId: EXECUTION_HOST_ID,
          mountExplorer: true
        }
      ]
    ])
    expect(readWebCloudWorkspaceBootstrapStatus().terminalNotGranted).toBe(false)
  })

  it('registers only after the boot chain settles, so hydration cannot clear it', async () => {
    const harness = makeHarness()
    harness.setHydrationSettled(false)
    const run = startWebCloudWorkspaceBootstrapForTests(harness.ports)
    await vi.waitFor(() => {
      expect(harness.info).toHaveBeenCalledTimes(1)
    })
    // The boot chain still owns the store here, so nothing has registered yet.
    expect(harness.ensureRepoRow).not.toHaveBeenCalled()
    harness.setHydrationSettled(true)
    await run
    expect(harness.ensureRepoRow).toHaveBeenCalledTimes(1)
    expect(readWebCloudWorkspaceBootstrapStatus().phase).toBe('done')
  })

  it('keeps the cloud card on a host predating workspace.info, with nothing registered', async () => {
    const harness = makeHarness({
      info: async () => {
        throw Object.assign(new Error("Method 'workspace.info' was not found."), {
          code: 'method_not_found'
        })
      }
    })
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)

    expect(readWebCloudWorkspaceBootstrapStatus()).toMatchObject({
      phase: 'fallback',
      fallbackReason: 'unsupported-host',
      retryable: false
    })
    expect(harness.ensure).not.toHaveBeenCalled()
    expect(harness.ensureRepoRow).not.toHaveBeenCalled()
  })

  it('keeps the cloud card when the host refuses to describe the session', async () => {
    const harness = makeHarness({
      info: async () => ({
        ok: false,
        code: 'CLOUD_SESSION_REQUIRED',
        message: 'This method is only available to a cloud session.'
      })
    })
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)

    expect(readWebCloudWorkspaceBootstrapStatus()).toMatchObject({
      phase: 'fallback',
      fallbackReason: 'failed',
      fallbackDetail: 'This method is only available to a cloud session.',
      retryable: false
    })
    expect(harness.ensure).not.toHaveBeenCalled()
  })

  it('offers a retry when the ensure flow fails, and the retry recovers', async () => {
    let attempts = 0
    const harness = makeHarness({
      ensure: async () => {
        attempts += 1
        if (attempts === 1) {
          return { ok: false, code: 'WORKTREE_CREATE_FAILED', message: 'clone failed' }
        }
        return { ok: true, workspacePath: WORKSPACE_PATH, created: true, provisioned: false }
      }
    })
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)
    expect(readWebCloudWorkspaceBootstrapStatus()).toMatchObject({
      phase: 'fallback',
      fallbackReason: 'failed',
      fallbackDetail: 'clone failed',
      retryable: true
    })

    await retryWebCloudWorkspaceBootstrap()
    expect(attempts).toBe(2)
    expect(readWebCloudWorkspaceBootstrapStatus().phase).toBe('done')
    expect(harness.activateWorkspace).toHaveBeenCalledTimes(1)
  })

  it('degrades to the cloud card when the page has no cloudWorkspace namespace', async () => {
    const harness = makeHarness()
    const ports: WebCloudWorkspaceBootstrapPorts = { ...harness.ports, api: () => null }
    await startWebCloudWorkspaceBootstrapForTests(ports)

    expect(readWebCloudWorkspaceBootstrapStatus()).toMatchObject({
      phase: 'fallback',
      fallbackReason: 'unavailable',
      retryable: false
    })
    expect(harness.ensureRepoRow).not.toHaveBeenCalled()
  })

  it('registers the row but drives no workspace when the ticket lacks terminal', async () => {
    const harness = makeHarness({ info: async () => workspaceInfo({ perms: ['open'] }) })
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)

    expect(readWebCloudWorkspaceBootstrapStatus()).toMatchObject({
      phase: 'done',
      terminalNotGranted: true
    })
    expect(harness.ensure).not.toHaveBeenCalled()
    expect(harness.ensureRepoRow).toHaveBeenCalledTimes(1)
    expect(harness.fetchWorktrees).not.toHaveBeenCalled()
    expect(harness.activateWorkspace).not.toHaveBeenCalled()
  })

  it('activates a terminal-only ticket with the explorer withheld (§4.3)', async () => {
    // A platform grant may carry `terminal` without `file:read`, so the workspace
    // still activates — the explorer reveal is the only file-RPC trigger the
    // bootstrap owns, and withholding it is what keeps the console denial-free.
    const harness = makeHarness({
      info: async () => workspaceInfo({ perms: ['open', 'terminal'] })
    })
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)

    expect(readWebCloudWorkspaceBootstrapStatus()).toMatchObject({
      phase: 'done',
      terminalNotGranted: false
    })
    expect(harness.ensure).toHaveBeenCalledTimes(1)
    expect(harness.ensureRepoRow).toHaveBeenCalledTimes(1)
    expect(harness.activateWorkspace).toHaveBeenCalledTimes(1)
    expect(harness.activateWorkspace.mock.calls).toEqual([
      [
        {
          worktreeId: `repo_1::${WORKSPACE_PATH}`,
          executionHostId: EXECUTION_HOST_ID,
          mountExplorer: false
        }
      ]
    ])
  })

  it('falls back retryable when the checkout is missing from the workspace catalog', async () => {
    const harness = makeHarness({ worktrees: [] })
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)

    expect(readWebCloudWorkspaceBootstrapStatus()).toMatchObject({
      phase: 'fallback',
      fallbackReason: 'failed',
      retryable: true
    })
    expect(harness.activateWorkspace).not.toHaveBeenCalled()
  })

  it('dedupes concurrent starts and never repeats a settled run', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const info = vi.fn<() => Promise<CloudWorkspaceInfoResponse>>(async () => {
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
      return workspaceInfo()
    })
    const harness = makeHarness({ info })
    const first = startWebCloudWorkspaceBootstrapForTests(harness.ports)
    const second = startWebCloudWorkspaceBootstrapForTests(harness.ports)
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledTimes(1)
    })
    gate.release?.()
    await Promise.all([first, second])
    expect(readWebCloudWorkspaceBootstrapStatus().phase).toBe('done')

    await startWebCloudWorkspaceBootstrapForTests(harness.ports)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('reruns once after the transport drops and comes back', async () => {
    const harness = makeHarness()
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)
    expect(harness.info).toHaveBeenCalledTimes(1)

    harness.emitTransport('disconnected')
    harness.emitTransport('ready')
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)

    expect(harness.info).toHaveBeenCalledTimes(2)
    expect(readWebCloudWorkspaceBootstrapStatus().phase).toBe('done')

    // One allowance: a ready transition without a disconnect does not re-run.
    harness.emitTransport('ready')
    await startWebCloudWorkspaceBootstrapForTests(harness.ports)
    expect(harness.info).toHaveBeenCalledTimes(2)
  })
})
