import { BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { normalizeBrowserUrl } from '../browser/browser-url'
import { captureMobileFileMutationOwnership } from '../files/mobile-file-mutation-ownership'
import {
  browserGoBack,
  browserGoForward,
  browserReload
} from '../browser/mobile-browser-command-operations'
import { sourceFileOpenRun } from '../source-control/mobile-source-file-open-operations'
import {
  sessionBrowserTabCreate,
  sessionMarkdownNoteCreate
} from './mobile-session-launch-operations'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import type { MobileBrowserNavigationMethod } from './MobileBrowserTabActionSheet'
import { isFileExistsErrorMessage } from './mobile-session-route-helpers'
import {
  TERMINAL_LINK_REMOTE_CREATING_HINT,
  TERMINAL_LINK_REMOTE_OFFLINE_HINT,
  TERMINAL_LINK_REMOTE_UNSUPPORTED_HINT,
  TERMINAL_LINK_REMOTE_WORKSPACE_HINT
} from './terminal-link-open-policy'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTerminalCreateActionsModel } from './use-mobile-session-terminal-create-actions'

/** The tab sheet names the method it wants; each one is a separate operation on the same policy. */
const BROWSER_NAVIGATION_COMMANDS = {
  'browser.back': browserGoBack,
  'browser.forward': browserGoForward,
  'browser.reload': browserReload
} as const

export function useMobileSessionContentCreateActions(
  scope: MobileSessionTerminalCreateActionsModel
) {
  const {
    worktreeId,
    client,
    connState,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    hostCapabilities,
    creatingBrowser,
    setCreatingBrowser,
    creatingMarkdown,
    setCreatingMarkdown,
    setCreateError,
    pendingBrowserFocusPageIdRef,
    handleCreateBrowserRef,
    handleCreateBackgroundBrowserRef,
    browserScreencastSupportedRef,
    scheduleDelayedAction,
    showToast,
    fetchSessionTabs,
    fetchPendingBrowserSessionTabs
  } = scope
  async function handleCreateMarkdownNote() {
    if (!client || creatingMarkdown) {
      return
    }

    setCreatingMarkdown(true)
    setCreateError('')

    try {
      const worktree = `id:${worktreeId}`
      const mutationOwnership = await captureMobileFileMutationOwnership(client, worktree)
      for (let attempt = 1; attempt <= 100; attempt += 1) {
        const relativePath = attempt === 1 ? 'untitled.md' : `untitled-${attempt}.md`
        const createResponse = await sessionMarkdownNoteCreate.request(
          client,
          { worktree, relativePath, ...mutationOwnership },
          { timeoutMs: 15_000 }
        )
        if (!createResponse.ok) {
          const message = createResponse.error.message
          if (isFileExistsErrorMessage(message) && attempt < 100) {
            continue
          }
          throw new Error(message || 'Failed to create markdown note')
        }

        const openResponse = await sourceFileOpenRun.request(
          client,
          { worktree, relativePath },
          { timeoutMs: 15_000 }
        )
        interpretOrThrowRefusalMessage(() => sourceFileOpenRun.interpret(openResponse), '')
        scheduleDelayedAction(() => void fetchSessionTabs(), 300)
        return
      }
      throw new Error('Unable to create untitled markdown note')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create markdown note'
      setCreateError(message)
      showToast(message, 1800)
    } finally {
      setCreatingMarkdown(false)
    }
  }

  async function handleCreateBrowser(rawUrl = 'about:blank'): Promise<boolean> {
    if (!client || creatingBrowser) {
      return false
    }
    // Why: read via ref so a tap before the capability probe resolves (or a stale callback) still sees the live value.
    if (browserScreencastSupportedRef.current !== true) {
      showToast('Desktop update required for mobile browser streaming', 1600)
      return false
    }
    const url = normalizeBrowserUrl(rawUrl)
    if (!url) {
      const message = 'Enter a valid URL'
      setCreateError(message)
      showToast(message, 1400)
      return false
    }

    setCreatingBrowser(true)
    setCreateError('')
    try {
      const response = await sessionBrowserTabCreate.request(
        client,
        {
          worktree: `id:${worktreeId}`,
          url,
          // The user opened this tab (tapped HTML / address bar) → focus it.
          activate: true
        },
        { timeoutMs: 30_000 }
      )
      const created = interpretOrThrowRefusalMessage(
        () => sessionBrowserTabCreate.interpret(response),
        ''
      )
      // Focus the new browser tab once it syncs; refresh a few times since the desktop registers the tab asynchronously.
      if (created.browserPageId) {
        pendingBrowserFocusPageIdRef.current = created.browserPageId
      }
      void fetchSessionTabs()
      scheduleDelayedAction(() => void fetchPendingBrowserSessionTabs(), 400)
      scheduleDelayedAction(() => void fetchPendingBrowserSessionTabs(), 1200)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create browser'
      setCreateError(message)
      showToast(message, 1800)
      return false
    } finally {
      setCreatingBrowser(false)
    }
  }
  // Keep the ref at the latest handleCreateBrowser so a terminal URL tap always runs the current closure.
  handleCreateBrowserRef.current = handleCreateBrowser

  /**
   * The terminal link sheet's desktop action: create the tab in the background and leave the
   * phone on its terminal. It deliberately does not set `pendingBrowserFocusPageIdRef`, which is
   * what would make the next tab snapshot switch the phone to the new browser tab.
   */
  async function handleCreateBackgroundBrowser(rawUrl = 'about:blank'): Promise<boolean> {
    // Why: a sheet rendered one frame ago can reach this after its gate changed. Every refusal
    // says why, because a tap that does nothing reads as a broken link.
    if (isFolderWorkspaceRoute || isFloatingWorkspaceRoute) {
      showToast(TERMINAL_LINK_REMOTE_WORKSPACE_HINT, 2000)
      return false
    }
    if (!client || connState !== 'connected') {
      showToast(TERMINAL_LINK_REMOTE_OFFLINE_HINT, 2000)
      return false
    }
    if (creatingBrowser) {
      showToast(TERMINAL_LINK_REMOTE_CREATING_HINT, 2000)
      return false
    }
    if (!hostCapabilities.includes(BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY)) {
      showToast(TERMINAL_LINK_REMOTE_UNSUPPORTED_HINT, 2000)
      return false
    }
    const url = normalizeBrowserUrl(rawUrl)
    if (!url) {
      showToast('Enter a valid URL', 1400)
      return false
    }

    setCreatingBrowser(true)
    try {
      const response = await sessionBrowserTabCreate.request(
        client,
        {
          worktree: `id:${worktreeId}`,
          url,
          activate: false
        },
        { timeoutMs: 30_000 }
      )
      sessionBrowserTabCreate.interpret(response)
      void fetchSessionTabs()
      scheduleDelayedAction(() => void fetchPendingBrowserSessionTabs(), 400)
      scheduleDelayedAction(() => void fetchPendingBrowserSessionTabs(), 1200)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open link on the desktop'
      showToast(message, 1800)
      return false
    } finally {
      setCreatingBrowser(false)
    }
  }
  // Why: mount harnesses that only exercise the foreground path may omit this ref.
  if (handleCreateBackgroundBrowserRef) {
    handleCreateBackgroundBrowserRef.current = handleCreateBackgroundBrowser
  }

  async function handleBrowserNavigationCommand(
    tab: Extract<MobileSessionTab, { type: 'browser' }>,
    method: MobileBrowserNavigationMethod
  ) {
    if (!client || !tab.browserPageId) {
      showToast('Browser page is not available yet.', 1500)
      return
    }
    try {
      const command = BROWSER_NAVIGATION_COMMANDS[method]
      const response = await command.request(
        client,
        {
          worktree: `id:${worktreeId}`,
          page: tab.browserPageId
        },
        { timeoutMs: 15_000 }
      )
      interpretOrThrowRefusalMessage(() => command.interpret(response), '')
      scheduleDelayedAction(() => void fetchSessionTabs(), 250)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Browser command failed'
      showToast(message, 1600)
    }
  }
  return {
    handleCreateMarkdownNote,
    handleCreateBrowser,
    handleCreateBackgroundBrowser,
    handleBrowserNavigationCommand
  }
}

export type MobileSessionContentCreateActionsModel = MobileSessionTerminalCreateActionsModel &
  ReturnType<typeof useMobileSessionContentCreateActions>
