// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
vi.mock('./cloud/cloud-workspace-entry', () => ({
  CloudWorkspaceEntry: ({ children }: { children?: ReactNode }) => <>{children}</>
}))
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
vi.mock('./app-shell/native-chat-draft-startup', () => ({
  startNativeChatDraftLoad: () => undefined,
  waitForNativeChatDraftsAtStartup: () => Promise.resolve()
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
vi.mock('./components/terminal-pane/codex-detached-pane-restart-scheduler', () => ({
  installCodexDetachedPaneRestartExecutor: () => () => undefined
}))
vi.mock('./components/terminal-pane/terminal-appearance', () => ({
  publishTerminalViewAttributesAtAppStart: () => undefined
}))
vi.mock('./components/terminal/terminal-provider-snapshot-capability', () => ({
  collectTerminalProviderSnapshotPtyIds: () => [],
  refreshTerminalProviderSnapshotCapabilities: () => Promise.resolve()
}))
vi.mock('@/runtime/local-structured-chats', () => ({
  restoreLocalStructuredChatsAtStartup: () => Promise.resolve()
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: () => Promise.resolve()
}))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  sweepRestoredCodexPanesForStaleAccounts: () => undefined
}))
vi.mock('@/lib/ui-zoom', () => ({ syncZoomCSSVar: () => undefined }))

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() }
}))

// The cloud-scope decision is the branch under test; the page boots either way.
const cloudScope = vi.hoisted(() => ({ active: false }))
vi.mock('@/web/web-cloud-session-scope', () => ({
  isActiveWebClientCloudSession: () => cloudScope.active,
  resetWebCloudSessionScope: () => {
    cloudScope.active = false
  }
}))

type StartupActionName =
  | 'fetchReposForAllHosts'
  | 'awaitLocalRepoCatalogSettlement'
  | 'fetchProjectGroupsForAllHosts'
  | 'fetchFolderWorkspacesForAllHosts'
  | 'fetchAllWorktrees'
  | 'fetchWorktrees'
  | 'fetchWorktreeLineage'
  | 'fetchOrcaProfiles'
  | 'fetchSettings'
  | 'awaitOwnerWorktreeVisibilityDefaultsHydration'
  | 'fetchKeybindings'
  | 'initGitHubCache'
  | 'hydrateWorkspaceSession'
  | 'hydrateTabsSession'
  | 'hydrateEditorSession'
  | 'hydrateBrowserSession'
  | 'fetchBrowserSessionProfiles'
  | 'reconnectPersistedTerminals'
  | 'setTerminalStartupRestorationReady'
  | 'setDeferredSshReconnectTargets'
  | 'removeDeferredSshReconnectTarget'
  | 'setSshConnectionState'
  | 'hydratePersistedUI'
  | 'setHydrationSucceeded'
  | 'pruneLastVisitedTimestamps'
  | 'seedActiveWorktreeLastVisitedIfMissing'
  | 'reconcileWorktreeTabModels'

type MockStoreState = Record<StartupActionName, ReturnType<typeof vi.fn>> & { repos: never[] }

function makeStartupActions(): MockStoreState {
  const noop = () => vi.fn()
  const resolve = () => vi.fn(async () => undefined)
  return {
    fetchReposForAllHosts: resolve(),
    awaitLocalRepoCatalogSettlement: resolve(),
    fetchProjectGroupsForAllHosts: resolve(),
    fetchFolderWorkspacesForAllHosts: resolve(),
    fetchAllWorktrees: resolve(),
    fetchWorktrees: resolve(),
    fetchWorktreeLineage: resolve(),
    fetchOrcaProfiles: resolve(),
    fetchSettings: resolve(),
    awaitOwnerWorktreeVisibilityDefaultsHydration: resolve(),
    fetchKeybindings: resolve(),
    initGitHubCache: resolve(),
    hydrateWorkspaceSession: noop(),
    hydrateTabsSession: noop(),
    hydrateEditorSession: noop(),
    hydrateBrowserSession: noop(),
    fetchBrowserSessionProfiles: resolve(),
    reconnectPersistedTerminals: resolve(),
    setTerminalStartupRestorationReady: noop(),
    setDeferredSshReconnectTargets: noop(),
    removeDeferredSshReconnectTarget: noop(),
    setSshConnectionState: noop(),
    hydratePersistedUI: noop(),
    setHydrationSucceeded: noop(),
    pruneLastVisitedTimestamps: noop(),
    seedActiveWorktreeLastVisitedIfMissing: noop(),
    reconcileWorktreeTabModels: noop(),
    repos: []
  }
}

const storeState = vi.hoisted((): { current: MockStoreState } => ({
  current: makeStartupActions()
}))

const storeSetState = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector(storeState.current),
    {
      getState: () => storeState.current,
      setState: storeSetState,
      subscribe: () => () => undefined
    }
  )
}))

import { getDefaultUIState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import App from './App'

function emptySession(): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), activeConnectionIdsAtShutdown: ['ssh-desktop-target'] }
}

const sshConnect = vi.hoisted(() =>
  vi.fn(async (args: { targetId: string }) => ({
    targetId: args.targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0
  }))
)

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: {
        startupDiagnostic: vi.fn(async () => undefined),
        awaitFirstWindowStartupServices: vi.fn(async () => undefined),
        awaitGitEnvironmentStartupBarrier: vi.fn(async () => undefined),
        prepareTerminalStartupRestoration: vi.fn(async () => undefined),
        recoverLegacyWorkerTerminalsForRendererStartup: vi.fn(async () => undefined),
        relaunch: vi.fn(async () => undefined)
      },
      ui: { get: vi.fn(async () => getDefaultUIState()) },
      onboarding: { get: vi.fn(async () => null) },
      session: {
        get: vi.fn(async () => emptySession()),
        listHostIds: vi.fn(async () => [])
      },
      runtimeEnvironments: { list: vi.fn(async () => []) },
      pty: { getAuthoritativeBufferSnapshotCapabilities: vi.fn(async () => []) },
      ssh: {
        listTargets: vi.fn(async () => [
          { id: 'ssh-desktop-target', label: 'Desktop', lastRequiredPassphrase: false }
        ]),
        connect: sshConnect,
        getState: vi.fn(async (args: { targetId: string }) => ({
          targetId: args.targetId,
          status: 'connected',
          error: null,
          reconnectAttempt: 0
        }))
      }
    }
  })
}

beforeEach(() => {
  storeState.current = makeStartupActions()
  cloudScope.active = false
  storeSetState.mockClear()
  sshConnect.mockClear()
  installWindowApi()
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
})

async function renderAndWaitForHydrated(): Promise<void> {
  render(<App />)
  await waitFor(() => expect(storeState.current.setHydrationSucceeded).toHaveBeenCalledWith(true))
}

describe('web cloud-session startup (W7c)', () => {
  it('boots the workspace shell without native-only catalog RPCs or the degraded toast', async () => {
    cloudScope.active = true
    render(<App />)

    expect(screen.getByTestId('workspace-shell')).toBeTruthy()

    await renderAndWaitForHydrated()
    // Let the deferred post-hydration refresh settle before judging the calls.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Native-catalog reads are desktop-owned state a cloud ticket never carries.
    expect(storeState.current.fetchReposForAllHosts).not.toHaveBeenCalled()
    expect(storeState.current.fetchProjectGroupsForAllHosts).not.toHaveBeenCalled()
    expect(storeState.current.fetchFolderWorkspacesForAllHosts).not.toHaveBeenCalled()
    expect(storeState.current.fetchAllWorktrees).not.toHaveBeenCalled()
    expect(storeState.current.fetchWorktreeLineage).not.toHaveBeenCalled()
    expect(storeState.current.awaitOwnerWorktreeVisibilityDefaultsHydration).not.toHaveBeenCalled()
    // A doomed SSH reconnect is skipped even if a stale partition names one.
    expect(sshConnect).not.toHaveBeenCalled()
    expect(storeState.current.setSshConnectionState).not.toHaveBeenCalled()

    // The session itself still hydrates, and the boot is a success, not degraded.
    expect(storeState.current.hydrateWorkspaceSession).toHaveBeenCalled()
    expect(storeState.current.setTerminalStartupRestorationReady).toHaveBeenCalledWith(true)
    expect(toastError).not.toHaveBeenCalled()
    expect(storeSetState).toHaveBeenCalledWith(
      expect.objectContaining({ startupWorktreeRefreshCompleted: true })
    )
  }, 15_000)

  it('keeps the native boot chain intact when the page is not a cloud session', async () => {
    cloudScope.active = false
    render(<App />)

    await renderAndWaitForHydrated()

    expect(storeState.current.fetchReposForAllHosts).toHaveBeenCalledWith({ remoteHosts: 'skip' })
    expect(storeState.current.fetchProjectGroupsForAllHosts).toHaveBeenCalledWith({
      remoteHosts: 'skip'
    })
    expect(storeState.current.fetchFolderWorkspacesForAllHosts).toHaveBeenCalledWith({
      remoteHosts: 'skip'
    })
    // The persisted shutdown target still reconnects on a native/paired boot.
    await waitFor(() => expect(sshConnect).toHaveBeenCalledWith({ targetId: 'ssh-desktop-target' }))
    expect(toastError).not.toHaveBeenCalled()
  }, 15_000)
})
