// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type * as CloudProjectReposModule from './cloud/cloud-project-repos'

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>
}))
vi.mock('./components/confirmation-dialog', () => ({
  ConfirmationDialogProvider: ({ children }: { children?: ReactNode }) => <>{children}</>
}))
vi.mock('./components/browser-webauthn-account-dialog', () => ({
  BrowserWebAuthnAccountDialog: () => null
}))
vi.mock('./components/browser-pane/workspace-doc/doc-preview-external-link-confirmation', () => ({
  DocPreviewExternalLinkConfirmation: () => null
}))
vi.mock('./components/link-routing-preference-dialog', () => ({
  LinkRoutingPreferenceDialogProvider: ({ children }: { children?: ReactNode }) => <>{children}</>
}))
vi.mock('./components/skills/SkillFreshnessNudge', () => ({ SkillFreshnessNudge: () => null }))
vi.mock('./components/terminal-pane/PinnedTabCloseDialog', () => ({ default: () => null }))
vi.mock('./components/terminal-pane/RunningTerminalCloseDialog', () => ({ default: () => null }))
vi.mock('./components/WorktreeBaseFallbackDialog', () => ({ default: () => null }))
vi.mock('./hooks/useUnreadDockBadge', () => ({ useUnreadDockBadge: () => () => undefined }))
vi.mock('./app-shell/AppBackgroundServices', () => ({ AppBackgroundServices: () => null }))
// The permanent sign-in entry lives in the status bar's segment row (W11), so the
// flow tests host the real segment where the bar would.
vi.mock('./app-shell/AppRootSurfaces', async () => {
  const { CloudLoginStatusSegment } = await import('./cloud/cloud-login-entry')
  return {
    AppRootSurfaces: () => (
      <div data-testid="root-surfaces">
        <CloudLoginStatusSegment />
      </div>
    )
  }
})
vi.mock('./app-shell/AppWorkspaceShell', () => ({
  AppWorkspaceShell: () => <div data-testid="workspace-shell" />
}))
vi.mock('./app-shell/WindowControls', () => ({ WindowControls: () => null }))
vi.mock('./app-shell/app-window-chrome', () => ({
  MAC_TRAFFIC_LIGHTS_WIDTH: '78px',
  WINDOW_CONTROLS_HEIGHT: '32px',
  WINDOW_CONTROLS_WIDTH: '138px',
  hasCustomTitleBar: false
}))
vi.mock('./app-shell/use-app-chrome-layout', () => ({
  useAppChromeLayout: () => ({ collapsedSidebarHeaderWidth: 48 })
}))
vi.mock('./app-shell/use-app-session-persistence', () => ({
  useAppSessionPersistence: () => undefined
}))
vi.mock('./app-shell/use-app-shell-services', () => ({ useAppShellServices: () => undefined }))
vi.mock('./app-shell/use-app-startup-hydration', () => ({
  useAppStartupHydration: () => undefined
}))
vi.mock('./app-shell/native-chat-draft-startup', () => ({
  startNativeChatDraftLoad: () => undefined
}))
vi.mock('./app-shell/use-document-appearance', () => ({ useDocumentAppearance: () => undefined }))
vi.mock('./app-shell/use-floating-workspace-panel', () => ({
  useFloatingWorkspacePanel: () => ({ open: false, cancelReturnFocusFrame: () => undefined })
}))
vi.mock('./app-shell/use-global-keybindings', () => ({ useGlobalKeybindings: () => undefined }))
vi.mock('./app-shell/use-onboarding-and-feature-tips', () => ({
  useOnboardingAndFeatureTips: () => ({ applyStartupOnboardingState: () => undefined })
}))
vi.mock('./app-shell/use-persisted-ui-writer', () => ({ usePersistedUIWriter: () => undefined }))
vi.mock('./app-shell/use-runtime-graph-sync', () => ({ useRuntimeGraphSync: () => undefined }))
vi.mock('./app-shell/use-window-visibility-effects', () => ({
  useWindowVisibilityEffects: () => undefined
}))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() }
}))

const syncCloudProjectRepos = vi.hoisted(() =>
  vi.fn(async () => ({ added: [], renamed: 0, failed: [] }))
)
const signOutCloudProjectRepos = vi.hoisted(() => vi.fn(async () => []))
vi.mock('./cloud/cloud-project-repos', async (importOriginal) => {
  const actual = await importOriginal<typeof CloudProjectReposModule>()
  return { ...actual, syncCloudProjectRepos, signOutCloudProjectRepos }
})

type WorktreeRow = Pick<Worktree, 'id' | 'repoId' | 'path' | 'hostId'>

type StoreMock = {
  repos: Repo[]
  worktreesByRepo: Record<string, WorktreeRow[]>
  addRepoPath: ReturnType<typeof vi.fn>
  hydrateRuntimeEnvironmentStatuses: ReturnType<typeof vi.fn>
  purgeStaleRuntimeHostState: ReturnType<typeof vi.fn>
  fetchWorktrees: ReturnType<typeof vi.fn>
  setActiveWorktree: ReturnType<typeof vi.fn>
}

const storeMock: { state: StoreMock } = vi.hoisted(() => ({
  state: {
    repos: [],
    worktreesByRepo: {},
    addRepoPath: vi.fn(async () => null),
    hydrateRuntimeEnvironmentStatuses: vi.fn(async () => undefined),
    purgeStaleRuntimeHostState: vi.fn(),
    fetchWorktrees: vi.fn(async (_repoId: string) => true),
    setActiveWorktree: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => storeMock.state, setState: vi.fn() }
}))

import App from './App'

/**
 * W11 (FR-2.7 revision): the app always starts in the native shell — signed in
 * or not — and the cloud platform joins it through the persistent sign-in chip
 * and its dialog. Cloud projects then land in the sidebar as extra repos.
 */

const projects = [
  {
    id: 'project-a',
    key: 'checkout',
    name: 'Checkout Service',
    hostName: 'dev-host',
    hostStatus: 'online',
    downloadRestricted: false,
    status: 'ready',
    provisioningError: null
  },
  {
    id: 'project-b',
    key: 'payments',
    name: 'Payments',
    hostName: 'dev-host',
    hostStatus: 'online',
    downloadRestricted: false,
    status: 'ready',
    provisioningError: null
  }
]

function cloudBridge(overrides: Record<string, unknown> = {}) {
  return {
    getState: async () => ({ status: 'signed-out' }),
    login: async () => ({ status: 'signed-in', displayName: 'zhangsan', projects }),
    getLoginContext: async () => ({
      platformUrl: 'https://cloud.example.com',
      username: 'zhangsan',
      locked: false
    }),
    logout: async () => ({ status: 'signed-out' }),
    registerProjects: async () => ({
      environments: [
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
      ],
      failures: [],
      removedEnvironmentIds: []
    }),
    retryPrepare: async () => ({ ok: false, code: 'CLONE_FAILED' }),
    createProject: async () => ({ ok: false, code: 'CREATE_FAILED' }),
    archiveProject: async () => ({ ok: false, code: 'ARCHIVE_FAILED' }),
    listProvisionableHosts: async () => [],
    openWorkspace: async (projectId: string) => ({
      ok: true,
      projectId,
      route: 'direct',
      workspaceRoot: '/srv/work',
      capabilities: ['terminal']
    }),
    closeProject: async () => ({ ok: true }),
    listProjects: async () => projects,
    rpc: async () => ({ ok: true, result: {} }),
    onConnectionChanged: () => () => undefined,
    ...overrides
  }
}

function installBridge(bridge: ReturnType<typeof cloudBridge>): void {
  Object.defineProperty(window, 'api', { configurable: true, value: { cloud: bridge } })
}

async function signIn(): Promise<void> {
  // W11: the sign-in form lives in the chip's dialog, not on a full-page screen.
  fireEvent.click(screen.getByRole('button', { name: '登录云端平台' }))
  await waitFor(() => expect(screen.getByLabelText('平台地址')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('平台地址'), {
    target: { value: 'https://cloud.example.com' }
  })
  fireEvent.change(screen.getByLabelText('域账号'), { target: { value: 'zhangsan' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'Passw0rd!' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
}

function checkoutRepo(): Repo {
  return {
    id: 'repo-a',
    path: '/srv/projects/checkout',
    displayName: 'Checkout Service',
    badgeColor: 'gray',
    addedAt: 1,
    executionHostId: 'runtime:env-a'
  }
}

describe('native cloud entry', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    storeMock.state.repos = []
    storeMock.state.worktreesByRepo = {}
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('starts in the native shell while signed out, with the sign-in chip present', async () => {
    installBridge(cloudBridge())
    render(<App />)

    await waitFor(() => expect(screen.getByRole('button', { name: '登录云端平台' })).toBeTruthy())
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
    // Signed out: nothing may reach for the platform on its own.
    expect(syncCloudProjectRepos).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '登录云端平台' }))
    await waitFor(() => expect(screen.getByLabelText('域账号')).toBeTruthy())
    expect(screen.getByLabelText<HTMLInputElement>('平台地址').value).toBe(
      'https://cloud.example.com'
    )
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })

  it('after sign-in renders the native shell and registers every project as a repo', async () => {
    installBridge(cloudBridge())
    render(<App />)

    await waitFor(() => expect(screen.getByRole('button', { name: '登录云端平台' })).toBeTruthy())
    await signIn()

    await waitFor(() => expect(screen.getByTestId('workspace-shell')).toBeTruthy())
    await waitFor(() =>
      expect(syncCloudProjectRepos).toHaveBeenCalledWith(
        expect.objectContaining({
          environments: [
            expect.objectContaining({ projectId: 'project-a', environmentId: 'env-a' }),
            expect.objectContaining({ projectId: 'project-b', environmentId: 'env-b' })
          ]
        })
      )
    )
    // The dialog closed and the chip now shows the account with its way out.
    await waitFor(() => expect(screen.queryByLabelText('域账号')).toBeNull())
    expect(screen.getByText('zhangsan')).toBeTruthy()
    expect(screen.getByRole('button', { name: '登出' })).toBeTruthy()
  })

  it('activates the sidebar row for the checkout the bridge opened', async () => {
    storeMock.state.repos = [checkoutRepo()]
    storeMock.state.fetchWorktrees.mockImplementation(async (repoId: string) => {
      storeMock.state.worktreesByRepo[repoId] = [
        { id: 'repo-a::/srv/projects/checkout', repoId: 'repo-a', path: '/srv/projects/checkout' },
        { id: 'repo-a::/srv/work/project-a', repoId: 'repo-a', path: '/srv/work/project-a' }
      ]
      return true
    })
    installBridge(
      cloudBridge({
        openWorkspace: async (projectId: string) => ({
          ok: true,
          projectId,
          route: 'direct',
          workspaceRoot: '/srv/work',
          workspacePath: '/srv/work/project-a',
          capabilities: ['terminal']
        })
      })
    )
    render(<App />)

    await signIn()

    await waitFor(() =>
      expect(storeMock.state.setActiveWorktree).toHaveBeenCalledWith(
        'repo-a::/srv/work/project-a',
        'runtime:env-a'
      )
    )
    expect(storeMock.state.fetchWorktrees).toHaveBeenCalledWith('repo-a', {
      executionHostId: 'runtime:env-a'
    })
  })

  it('leaves the default view untouched when the open reply has no checkout path', async () => {
    storeMock.state.repos = [checkoutRepo()]
    const openWorkspace = vi.fn(async (projectId: string) => ({
      ok: true,
      projectId,
      route: 'direct',
      workspaceRoot: '/srv/work',
      capabilities: ['terminal']
    }))
    installBridge(cloudBridge({ openWorkspace }))
    render(<App />)

    await signIn()

    await waitFor(() => expect(openWorkspace).toHaveBeenCalled())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // The entry still refreshes the registered repo, but with no checkout path
    // in the reply there is nothing to activate.
    expect(storeMock.state.fetchWorktrees).toHaveBeenCalledWith('repo-a', {
      executionHostId: 'runtime:env-a'
    })
    expect(storeMock.state.setActiveWorktree).not.toHaveBeenCalled()
  })

  it('a failed default open surfaces the platform error code and still renders the shell', async () => {
    installBridge(
      cloudBridge({
        openWorkspace: async () => ({ ok: false, code: 'ENDPOINT_UNREACHABLE' })
      })
    )
    render(<App />)

    await signIn()

    await waitFor(() => expect(screen.getByTestId('workspace-shell')).toBeTruthy())
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.any(String), {
        description: 'ENDPOINT_UNREACHABLE'
      })
    )
  })
})
