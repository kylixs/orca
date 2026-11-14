// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

import App from './App'

/**
 * W11 (FR-2.7 revision): every build — including a dev build whose platform
 * address is unset — starts in the native shell and never auto-signs in. The
 * cloud platform shows up only as the persistent sign-in chip; the shell is
 * never replaced by a login page or the custom cloud pages.
 */
describe('native shell with an unsigned-in cloud entry', () => {
  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('renders the workspace shell and the sign-in chip, and touches nothing', async () => {
    const cloud = {
      getState: vi.fn(async () => ({ status: 'signed-out' })),
      getLoginContext: vi.fn(async () => ({ platformUrl: null, username: null, locked: false })),
      login: vi.fn(),
      registerProjects: vi.fn(),
      onConnectionChanged: vi.fn(() => () => undefined)
    }
    Object.defineProperty(window, 'api', { configurable: true, value: { cloud } })

    render(<App />)

    await waitFor(() => expect(screen.getByRole('button', { name: '登录云端平台' })).toBeTruthy())
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
    // The dialog stays closed until the user asks for it.
    expect(screen.queryByLabelText('域账号')).toBeNull()
    // No auto-login, no project registration, no full-page cloud takeover.
    expect(cloud.login).not.toHaveBeenCalled()
    expect(cloud.registerProjects).not.toHaveBeenCalled()
    expect(screen.queryByText('登录云端开发平台')).toBeNull()
  })

  it('still renders the native shell when no cloud bridge is exposed at all', () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} })

    render(<App />)

    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登录云端平台' })).toBeNull()
    expect(screen.queryByText(/未配置云端开发平台地址/)).toBeNull()
  })
})
