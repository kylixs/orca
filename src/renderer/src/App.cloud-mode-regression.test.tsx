// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { getDefaultSettings } from '../../shared/constants'

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }))
vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>
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
// Why a narrow host: the audited anchors live in the real status bar; the other
// root surfaces (crash report, star-nag) need their own bridges and are inert here.
vi.mock('./app-shell/AppRootSurfaces', async () => {
  const { StatusBar } = await import('./components/status-bar/StatusBar')
  return {
    AppRootSurfaces: ({ floatingWorkspace }: { floatingWorkspace: { open: boolean } }) => (
      <StatusBar floatingTerminalOpen={floatingWorkspace.open} />
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

import App from './App'

/**
 * A permissive `window.api` for the root surfaces this test does not assert on:
 * every member resolves to a callable that resolves (or unsubscribes), so the
 * status bar's sibling surfaces stay inert without enumerating their bridges.
 */
function looseApiStub(depth = 0): object {
  const stub = (...args: unknown[]): unknown =>
    typeof args[0] === 'function' ? () => undefined : Promise.resolve({})
  if (depth > 3) {
    return stub
  }
  return new Proxy(stub, {
    get: (target, prop) =>
      prop === 'then' ? undefined : (Reflect.get(target, prop) ?? looseApiStub(depth + 1))
  })
}

function installApi(members: Record<string, unknown>, cloud?: Record<string, unknown>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy(looseApiStub(), {
      get: (target, prop) => {
        if (prop === 'cloud') {
          return cloud
        }
        if (prop in members) {
          return Reflect.get(members, prop)
        }
        return Reflect.get(target, prop)
      }
    })
  })
}

/** Typed shapes the status bar's own effects consume (arrays, not blobs). */
function statusBarStubs(): Record<string, unknown> {
  return {
    preflight: {
      detectAgents: async () => [],
      detectRemoteAgents: async () => []
    },
    agentAwake: {
      getStatus: async () => ({ mode: 'off', active: false }),
      onChanged: () => () => undefined
    }
  }
}

function unsignedInCloudBridge(): Record<string, unknown> {
  return {
    getState: vi.fn(async () => ({ status: 'signed-out' })),
    getLoginContext: vi.fn(async () => ({ platformUrl: null, username: null, locked: false })),
    login: vi.fn(),
    registerProjects: vi.fn(),
    onConnectionChanged: vi.fn(() => () => undefined)
  }
}

/**
 * W11 (FR-2.7 revision): every build starts in the native shell — signed in or
 * not — and the cloud platform joins it as one segment of the real status bar.
 * The assertions are structural on purpose: the entry must be a child of the
 * bar's own segment row, shared with the native controls, so a floating corner
 * chip — the shape that once covered the bar's native right end (audit M1) —
 * fails this file again.
 */
describe('native shell keeps its status bar row under the cloud entry', () => {
  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
    useAppStore.setState(useAppStore.getInitialState())
  })

  it('mounts the cloud entry inside the status bar, beside the native controls', async () => {
    const cloud = unsignedInCloudBridge()
    installApi(statusBarStubs(), cloud)
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/home/orca'),
        floatingTerminalEnabled: true,
        floatingTerminalTriggerLocation: 'status-bar'
      }
    })

    render(<App />)

    await waitFor(() => expect(document.querySelector('[data-status-bar]')).not.toBeNull())
    const bar = document.querySelector('[data-status-bar]')
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()

    // The entry is a segment of the bar, not a floating sibling over it.
    await waitFor(() => expect(document.querySelector('[data-cloud-login-entry]')).not.toBeNull())
    const chip = document.querySelector('[data-cloud-login-entry]')
    if (!chip || !bar) {
      throw new Error('the cloud entry did not mount inside the status bar')
    }
    expect(bar.contains(chip)).toBe(true)

    // Native anchor: the floating-terminal toggle shares the bar's segment row
    // and still receives its clicks.
    const toggle = await screen.findByRole('button', { name: 'Show Floating Workspace' })
    const segmentRow = chip.parentElement
    expect(segmentRow?.contains(toggle)).toBe(true)

    let toggled = 0
    window.addEventListener(TOGGLE_FLOATING_TERMINAL_EVENT, () => {
      toggled += 1
    })
    await userEvent.click(toggle)
    expect(toggled).toBe(1)

    // The dialog stays closed until the user asks for it, and a signed-out
    // startup reaches for neither login nor project registration.
    expect(screen.queryByLabelText('域账号')).toBeNull()
    expect(cloud.login).not.toHaveBeenCalled()
    expect(cloud.registerProjects).not.toHaveBeenCalled()
    expect(screen.queryByText('登录云端开发平台')).toBeNull()
  })

  it('opening the login dialog keeps the native status bar row in place', async () => {
    installApi(statusBarStubs(), unsignedInCloudBridge())

    render(<App />)

    await waitFor(() => expect(document.querySelector('[data-status-bar]')).not.toBeNull())
    const bar = document.querySelector('[data-status-bar]')
    await waitFor(() => expect(document.querySelector('[data-cloud-login-entry]')).not.toBeNull())
    const chip = document.querySelector('[data-cloud-login-entry]')
    if (!chip || !bar) {
      throw new Error('the cloud entry did not mount inside the status bar')
    }
    expect(bar.contains(chip)).toBe(true)

    await userEvent.click(chip)
    await waitFor(() => expect(screen.getByLabelText('平台地址')).toBeTruthy())
    expect(bar?.contains(chip)).toBe(true)
    expect(document.querySelectorAll('[data-status-bar]')).toHaveLength(1)
  })

  it('still renders the native shell when no cloud bridge is exposed at all', () => {
    installApi(statusBarStubs())

    render(<App />)

    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登录云端平台' })).toBeNull()
    expect(screen.queryByText(/未配置云端开发平台地址/)).toBeNull()
  })
})
