import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { useMobileSessionContentCreateActions } from './use-mobile-session-content-create-actions'
import { runAcceptedMobileSessionTabsEffects } from './mobile-session-tabs-accepted-effects'
import {
  TERMINAL_LINK_REMOTE_CREATING_HINT,
  TERMINAL_LINK_REMOTE_OFFLINE_HINT,
  TERMINAL_LINK_REMOTE_UNSUPPORTED_HINT,
  TERMINAL_LINK_REMOTE_WORKSPACE_HINT
} from './terminal-link-open-policy'
import type { MobileSessionTerminalCreateActionsModel } from './use-mobile-session-terminal-create-actions'

const browserRequest = vi.hoisted(() => vi.fn())

vi.mock('./mobile-session-launch-operations', () => ({
  sessionBrowserTabCreate: {
    request: browserRequest,
    interpret: () => ({ browserPageId: 'page-1' })
  },
  sessionMarkdownNoteCreate: {
    request: vi.fn(),
    interpret: vi.fn()
  }
}))

function makeScope(overrides: Record<string, unknown> = {}) {
  const pendingBrowserFocusPageIdRef: { current: string | null } = { current: null }
  const handleCreateBrowserRef: { current: unknown } = { current: null }
  const handleCreateBackgroundBrowserRef: { current: unknown } = { current: null }
  const scope = {
    worktreeId: 'wt-1',
    client: {},
    connState: 'connected',
    isFolderWorkspaceRoute: false,
    isFloatingWorkspaceRoute: false,
    hostCapabilities: [BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY],
    creatingBrowser: false,
    setCreatingBrowser: vi.fn(),
    creatingMarkdown: false,
    setCreatingMarkdown: vi.fn(),
    setCreateError: vi.fn(),
    pendingBrowserFocusPageIdRef,
    handleCreateBrowserRef,
    handleCreateBackgroundBrowserRef,
    browserScreencastSupportedRef: { current: true },
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    fetchSessionTabs: vi.fn(),
    fetchPendingBrowserSessionTabs: vi.fn(),
    ...overrides
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the fields supplied here.
    scope: scope as unknown as MobileSessionTerminalCreateActionsModel,
    pendingBrowserFocusPageIdRef,
    handleCreateBrowserRef,
    handleCreateBackgroundBrowserRef,
    scopeFields: scope
  }
}

function renderActions(model: ReturnType<typeof makeScope>) {
  let actions!: ReturnType<typeof useMobileSessionContentCreateActions>
  function Harness(): null {
    actions = useMobileSessionContentCreateActions(model.scope)
    return null
  }
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(createElement(Harness))
  })
  return { actions, tree: tree! }
}

beforeEach(() => {
  browserRequest.mockReset()
  browserRequest.mockResolvedValue({ ok: true })
})

describe('background browser tabs', () => {
  it('creates with activate:false and leaves the phone focus untouched', async () => {
    const model = makeScope()
    const { actions } = renderActions(model)

    await act(async () => {
      await actions.handleCreateBackgroundBrowser('https://example.com/a')
    })

    expect(browserRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ worktree: 'id:wt-1', activate: false }),
      expect.anything()
    )
    expect(model.pendingBrowserFocusPageIdRef.current).toBeNull()
    expect(model.scopeFields.setCreatingBrowser).toHaveBeenCalledWith(true)
    expect(model.scopeFields.fetchSessionTabs).toHaveBeenCalled()
  })

  it('surfaces every refusing guard instead of returning silently', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ isFolderWorkspaceRoute: true }, TERMINAL_LINK_REMOTE_WORKSPACE_HINT],
      [{ isFloatingWorkspaceRoute: true }, TERMINAL_LINK_REMOTE_WORKSPACE_HINT],
      [{ client: null }, TERMINAL_LINK_REMOTE_OFFLINE_HINT],
      [{ connState: 'disconnected' }, TERMINAL_LINK_REMOTE_OFFLINE_HINT],
      [{ creatingBrowser: true }, TERMINAL_LINK_REMOTE_CREATING_HINT],
      [{ hostCapabilities: ['browser.screencast.v1'] }, TERMINAL_LINK_REMOTE_UNSUPPORTED_HINT]
    ]
    for (const [overrides, hint] of cases) {
      const model = makeScope(overrides)
      const { actions } = renderActions(model)
      await act(async () => {
        await expect(actions.handleCreateBackgroundBrowser('https://example.com')).resolves.toBe(
          false
        )
      })
      expect(browserRequest, JSON.stringify(overrides)).not.toHaveBeenCalled()
      expect(model.scopeFields.showToast, JSON.stringify(overrides)).toHaveBeenCalledWith(
        hint,
        2000
      )
    }
  })

  it('A29: reports a failed background create and returns false', async () => {
    browserRequest.mockRejectedValueOnce(new Error('relay refused'))
    const model = makeScope()
    const { actions } = renderActions(model)

    await act(async () => {
      await expect(actions.handleCreateBackgroundBrowser('https://example.com')).resolves.toBe(
        false
      )
    })

    expect(model.scopeFields.showToast).toHaveBeenCalledWith('relay refused', 1800)
    expect(model.scopeFields.setCreatingBrowser).toHaveBeenLastCalledWith(false)
  })

  it('A12: creating in the background never pulls the phone off its terminal, even after reconnect', async () => {
    const model = makeScope()
    const { actions } = renderActions(model)

    await act(async () => {
      await actions.handleCreateBackgroundBrowser('https://example.com/a')
    })
    expect(model.pendingBrowserFocusPageIdRef.current).toBeNull()

    const activateBrowserTab = vi.fn()
    const tabs = [
      { id: 'terminal-1', type: 'terminal', isActive: true },
      { id: 'browser-1', type: 'browser', isActive: false, browserPageId: 'page-1' }
    ]
    const consume = (): void =>
      runAcceptedMobileSessionTabsEffects({
        effectiveTabs: tabs,
        source: 'stream',
        getPendingBrowserPageId: () => model.pendingBrowserFocusPageIdRef.current,
        clearPendingBrowserPageId: (pageId) => {
          if (model.pendingBrowserFocusPageIdRef.current === pageId) {
            model.pendingBrowserFocusPageIdRef.current = null
          }
        },
        activateBrowserTab,
        markActiveMarkdownStale: vi.fn()
      })

    consume()
    // The reconnect path re-applies the same accepted snapshot; a background tab must stay put.
    consume()

    expect(activateBrowserTab).not.toHaveBeenCalled()
    expect(model.pendingBrowserFocusPageIdRef.current).toBeNull()
  })
})

describe('foreground browser tabs keep their focus contract', () => {
  it('creates with activate:true and sets the pending focus page', async () => {
    const model = makeScope()
    const { actions } = renderActions(model)

    await act(async () => {
      await actions.handleCreateBrowser('https://example.com/foreground')
    })

    expect(browserRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ activate: true }),
      expect.anything()
    )
    expect(model.pendingBrowserFocusPageIdRef.current).toBe('page-1')
  })
})
