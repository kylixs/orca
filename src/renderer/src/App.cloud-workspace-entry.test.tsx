// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('./app-shell/AppRootSurfaces', () => ({ AppRootSurfaces: () => null }))
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
vi.mock('./cloud/cloud-project-repos', () => ({
  syncCloudProjectRepos,
  signOutCloudProjectRepos,
  planCloudProjectRepos: vi.fn(() => ({ add: [], rename: [] })),
  cloudProjectReposOnHosts: vi.fn(() => [])
}))

vi.mock('@/store', () => {
  const state = {
    repos: [],
    addRepoPath: vi.fn(async () => null),
    hydrateRuntimeEnvironmentStatuses: vi.fn(async () => undefined),
    purgeStaleRuntimeHostState: vi.fn()
  }
  return { useAppStore: { getState: () => state, setState: vi.fn() } }
})

import App from './App'

/**
 * M52: a cloud build signs in on its own screen and then lands in the ordinary
 * workspace shell. The old gate replaced the whole shell with the custom cloud
 * pages — that must never happen again.
 */

const projects = [
  {
    id: 'project-a',
    key: 'checkout',
    name: 'Checkout Service',
    hostName: 'dev-host',
    hostStatus: 'online',
    downloadRestricted: false
  },
  {
    id: 'project-b',
    key: 'payments',
    name: 'Payments',
    hostName: 'dev-host',
    hostStatus: 'online',
    downloadRestricted: false
  }
]

function cloudBridge(overrides: Record<string, unknown> = {}) {
  return {
    getState: async () => ({ status: 'signed-out' }),
    login: async () => ({ status: 'signed-in', displayName: 'zhangsan', projects }),
    logout: async () => ({ status: 'signed-out' }),
    registerProjects: async () => [
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

function signIn(): void {
  fireEvent.change(screen.getByLabelText('域账号'), { target: { value: 'zhangsan' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'Passw0rd!' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
}

describe('native cloud entry', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('shows the sign-in screen while signed out, never the workspace shell', async () => {
    installBridge(cloudBridge())
    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('域账号')).toBeTruthy())
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy()
    expect(screen.queryByTestId('workspace-shell')).toBeNull()
    expect(syncCloudProjectRepos).not.toHaveBeenCalled()
  })

  it('after sign-in renders the native shell and registers every project as a repo', async () => {
    installBridge(cloudBridge())
    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('域账号')).toBeTruthy())
    signIn()

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
    expect(screen.queryByLabelText('域账号')).toBeNull()
  })

  it('a failed default open surfaces the platform error code and still renders the shell', async () => {
    installBridge(
      cloudBridge({
        openWorkspace: async () => ({ ok: false, code: 'ENDPOINT_UNREACHABLE' })
      })
    )
    render(<App />)

    await waitFor(() => expect(screen.getByLabelText('域账号')).toBeTruthy())
    signIn()

    await waitFor(() => expect(screen.getByTestId('workspace-shell')).toBeTruthy())
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.any(String), {
        description: 'ENDPOINT_UNREACHABLE'
      })
    )
  })
})
