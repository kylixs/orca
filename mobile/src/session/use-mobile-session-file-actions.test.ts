import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { useMobileSessionFileActions } from './use-mobile-session-file-actions'
import { useMobileSessionPreferenceFocus } from './use-mobile-session-preference-focus'
import {
  useMobileSessionScreenState,
  type TerminalLinkChoice
} from './use-mobile-session-screen-state'

const openExternalLink = vi.hoisted(() => vi.fn())
const dismiss = vi.hoisted(() => vi.fn())
const writeText = vi.hoisted(() => vi.fn(async () => undefined))
const consumeLegacy = vi.hoisted(() =>
  vi.fn(async (): Promise<'phone-browser' | 'orca-browser' | null> => null)
)
const saveMode = vi.hoisted(() => vi.fn(async () => undefined))
const loadMode = vi.hoisted(() =>
  vi.fn(async (): Promise<'ask' | 'phone-browser' | 'orca-browser'> => 'ask')
)
const loadTextScale = vi.hoisted(() => vi.fn(async () => 1))
const loadAutocomplete = vi.hoisted(() => vi.fn(async () => false))

vi.mock('expo-router', async () => {
  const react = await import('react')
  return {
    useFocusEffect: (callback: () => undefined | (() => void)) =>
      react.useEffect(() => callback(), [callback])
  }
})
vi.mock('react-native', () => ({
  Keyboard: { dismiss },
  Animated: {
    Value: class {
      constructor(_value: number) {}
    }
  }
}))
vi.mock('../platform/external-link', () => ({ openExternalLink }))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSuccess: vi.fn() }))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText })
}))
vi.mock('./use-mobile-file-tap-handlers', () => ({
  useMobileFileTapHandlers: () => ({
    handleFileTap: vi.fn(),
    handleNativeChatFileTap: vi.fn()
  })
}))
vi.mock('./use-terminal-live-input-mode-preference', () => ({
  useTerminalLiveInputModePreference: () => ({
    clearTerminalLiveInputDefault: vi.fn(),
    defaultTerminalHandlesToLiveInput: new Set(),
    liveInputTerminalHandles: new Set(),
    liveInputTerminalHandlesRef: { current: new Set() },
    pruneTerminalHandlesFromLiveInput: vi.fn(),
    toggleTerminalLiveInput: vi.fn()
  })
}))
vi.mock('./use-initial-session-terminal-autocreate', () => ({
  useWorktreeSessionTabsLoaded: () => [false, vi.fn()]
}))
vi.mock('./mobile-session-create-warning-state', () => ({
  createMobileSessionCreateWarningState: () => ({})
}))
vi.mock('./use-mobile-session-tab-action-targets', () => ({
  useMobileSessionTabActionTargets: () => ({})
}))
vi.mock('../storage/preferences', () => ({
  consumeLegacyTerminalLinkOpenMode: consumeLegacy,
  saveTerminalLinkOpenMode: saveMode,
  loadTerminalLinkOpenMode: loadMode,
  loadTerminalTextScale: loadTextScale,
  loadTerminalAutocompleteEnabled: loadAutocomplete
}))

type HarnessScope = Record<string, unknown> & {
  terminalLinkOpenMode: 'ask' | 'phone-browser' | 'orca-browser'
  activeHandle: string | null
  activeHandleRef: { current: string | null }
  handleCreateBackgroundBrowserRef: { current: ((url?: string) => Promise<boolean>) | null }
  handleCreateBrowserRef: { current: unknown }
  pendingBrowserFocusPageIdRef: { current: string | null }
  liveInputRef: { current: { blur: ReturnType<typeof vi.fn> } | null }
  focusLiveInput: ReturnType<typeof vi.fn>
  showToast: ReturnType<typeof vi.fn>
  setTerminalLinkOpenMode: (value: 'ask' | 'phone-browser' | 'orca-browser') => void
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function makeScope(overrides: Record<string, unknown> = {}): HarnessScope {
  const scope = {
    hostId: 'host-1',
    worktreeId: 'wt-1',
    routeWorktreeName: 'wt',
    isFolderWorkspaceRoute: false,
    isFloatingWorkspaceRoute: false,
    client: {},
    connState: 'connected',
    hostCapabilities: [BROWSER_TAB_CREATE_BACKGROUND_RUNTIME_CAPABILITY],
    statusReadable: true,
    creatingBrowser: false,
    sessionTabsRef: { current: [] },
    terminalLinkOpenMode: 'ask' as const,
    setTerminalLinkOpenMode: vi.fn((_value: 'ask' | 'phone-browser' | 'orca-browser') => {}),
    activeHandle: 'h1',
    keyboardHeight: 1,
    liveInputRef: { current: { blur: vi.fn() } },
    focusLiveInput: vi.fn(),
    showToast: vi.fn(),
    activeSessionTabIdRef: { current: null },
    terminalCwdRef: { current: new Map() },
    activeHandleRef: { current: 'h1' },
    activeSessionTab: null,
    activeSessionTabTypeRef: { current: 'terminal' },
    switchSessionTabRef: { current: null },
    handleCreateBrowserRef: { current: null },
    handleCreateBackgroundBrowserRef: { current: vi.fn(async () => true) },
    pendingBrowserFocusPageIdRef: { current: null },
    scheduleDelayedAction: vi.fn(),
    nativeChatSendError: { show: vi.fn() },
    fetchSessionTabs: vi.fn(),
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the fields supplied here.
  return scope as unknown as HarnessScope
}

function renderActions(initialScope: HarnessScope) {
  let actions!: ReturnType<typeof useMobileSessionFileActions>
  let latestChoice: TerminalLinkChoice | null = null
  let updateActiveHandle: (handle: string | null) => void = () => {}
  const setMode = initialScope.setTerminalLinkOpenMode
  function Harness(): null {
    const [mode, setTerminalLinkOpenMode] = useState(initialScope.terminalLinkOpenMode)
    const [choice, setTerminalLinkChoice] = useState<TerminalLinkChoice | null>(null)
    const [activeHandle, setActiveHandle] = useState<string | null>(initialScope.activeHandle)
    latestChoice = choice
    updateActiveHandle = setActiveHandle
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only the fields supplied here.
    actions = useMobileSessionFileActions({
      ...initialScope,
      terminalLinkOpenMode: mode,
      setTerminalLinkOpenMode: (value: 'ask' | 'phone-browser' | 'orca-browser') => {
        setMode(value)
        setTerminalLinkOpenMode(value)
      },
      activeHandle,
      terminalLinkChoice: choice,
      setTerminalLinkChoice
    } as never)
    return null
  }
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(createElement(Harness))
  })
  return {
    actions,
    tree: tree!,
    rerender: () => act(() => tree!.update(createElement(Harness))),
    choice: () => latestChoice,
    setActiveHandle: (handle: string | null) => updateActiveHandle(handle),
    /** The hook snapshot, because `actions` is reassigned on every render. */
    current: () => actions
  }
}

/** The real screen-state and preference-focus hooks, so A21 exercises the production wiring. */
function renderScreenHarness(initialScope: HarnessScope) {
  let actions!: ReturnType<typeof useMobileSessionFileActions>
  let state!: ReturnType<typeof useMobileSessionScreenState>
  let tree: ReactTestRenderer | null = null
  function Harness(): null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the screen-state hook reads only these three foundation fields.
    state = useMobileSessionScreenState({
      hostId: 'host-1',
      worktreeId: 'wt-1',
      initialCreateWarning: undefined
    } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the file-actions hook reads only the real screen state plus the storage-free doubles.
    const scope = { ...initialScope, ...state } as never
    useMobileSessionPreferenceFocus(scope)
    actions = useMobileSessionFileActions(scope)
    return null
  }
  act(() => {
    tree = create(createElement(Harness))
  })
  return {
    state: () => state,
    current: () => actions,
    unmount: () => act(() => tree?.unmount())
  }
}

beforeEach(() => {
  openExternalLink.mockReset()
  dismiss.mockReset()
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  consumeLegacy.mockReset()
  consumeLegacy.mockResolvedValue(null)
  saveMode.mockReset()
  saveMode.mockResolvedValue(undefined)
  loadMode.mockReset()
  loadMode.mockResolvedValue('ask')
  loadTextScale.mockReset()
  loadTextScale.mockResolvedValue(1)
  loadAutocomplete.mockReset()
  loadAutocomplete.mockResolvedValue(false)
})

describe('terminal link entry', () => {
  it('dismisses the keyboard before opening the ask sheet and preselects the legacy mode once', async () => {
    consumeLegacy.mockResolvedValue('orca-browser')
    const scope = makeScope()
    const harness = renderActions(scope)

    await act(async () => {
      harness.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await Promise.resolve()
    })

    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(scope.liveInputRef.current?.blur).toHaveBeenCalledTimes(1)
    expect(harness.choice()).toEqual({
      handle: 'h1',
      url: 'https://example.com',
      preselect: 'orca-browser'
    })
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('opens a stored phone preference directly', () => {
    const scope = makeScope({ terminalLinkOpenMode: 'phone-browser', keyboardHeight: 0 })
    const harness = renderActions(scope)

    act(() => harness.current().handleTerminalOpenUrl('h1', 'https://example.com'))

    expect(openExternalLink).toHaveBeenCalledWith('https://example.com', expect.any(Function))
    expect(harness.choice()).toBeNull()
  })

  it('reports a phone browser that could not open the link', () => {
    openExternalLink.mockImplementation((_url: string, onFailure?: () => void) => onFailure?.())
    const scope = makeScope({ terminalLinkOpenMode: 'phone-browser', keyboardHeight: 0 })
    const harness = renderActions(scope)

    act(() => harness.current().handleTerminalOpenUrl('h1', 'https://example.com'))

    expect(scope.showToast).toHaveBeenCalledWith("Couldn't open link", 1600)
  })

  it('falls back to the sheet without downgrading an unavailable stored desktop mode', async () => {
    const scope = makeScope({
      terminalLinkOpenMode: 'orca-browser',
      statusReadable: false,
      keyboardHeight: 0
    })
    const harness = renderActions(scope)

    act(() => harness.current().handleTerminalOpenUrl('h1', 'https://example.com'))

    expect(scope.handleCreateBackgroundBrowserRef.current).not.toHaveBeenCalled()
    expect(harness.choice()).toMatchObject({
      handle: 'h1',
      preselect: null
    })
    expect(harness.current().terminalLinkRemoteAvailability).toMatchObject({
      available: false,
      reason: 'unknown'
    })
  })

  it('opens a stored desktop preference directly when the host still qualifies', () => {
    const scope = makeScope({ terminalLinkOpenMode: 'orca-browser', keyboardHeight: 0 })
    const harness = renderActions(scope)

    act(() => harness.current().handleTerminalOpenUrl('h1', 'https://example.com'))

    expect(scope.handleCreateBackgroundBrowserRef.current).toHaveBeenCalledWith(
      'https://example.com'
    )
    expect(harness.choice()).toBeNull()
  })

  it('restores the pre-open keyboard state when the sheet closes', async () => {
    const scope = makeScope({ keyboardHeight: 1 })
    const harness = renderActions(scope)

    await act(async () => {
      harness.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await Promise.resolve()
    })
    act(() => harness.current().closeTerminalLinkSheet())

    expect(harness.choice()).toBeNull()
    expect(scope.focusLiveInput).toHaveBeenCalledTimes(1)

    // A sheet opened with no keyboard leaves it closed.
    const closedScope = makeScope({ keyboardHeight: 0 })
    const closed = renderActions(closedScope)
    await act(async () => {
      closed.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await Promise.resolve()
    })
    act(() => closed.current().closeTerminalLinkSheet())
    expect(closedScope.focusLiveInput).not.toHaveBeenCalled()
  })

  it('falls back to the sheet when a direct desktop open is refused at action time', async () => {
    const create = vi.fn(async () => false)
    const scope = makeScope({
      terminalLinkOpenMode: 'orca-browser',
      keyboardHeight: 0,
      handleCreateBackgroundBrowserRef: { current: create }
    })
    const harness = renderActions(scope)

    await act(async () => {
      harness.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(create).toHaveBeenCalledWith('https://example.com')
    expect(harness.choice()).toMatchObject({
      handle: 'h1',
      url: 'https://example.com'
    })
  })

  it('A21: stays on ask until the stored mode finishes loading', async () => {
    const storedMode = deferred<'ask' | 'phone-browser' | 'orca-browser'>()
    loadMode.mockReturnValueOnce(storedMode.promise)
    const scope = makeScope({ keyboardHeight: 0 })
    const harness = renderScreenHarness(scope)
    act(() => harness.state().setActiveHandle('h1'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(harness.state().terminalLinkOpenMode).toBe('ask')

    await act(async () => {
      harness.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await Promise.resolve()
    })

    expect(harness.current().terminalLinkChoice).toMatchObject({
      handle: 'h1',
      url: 'https://example.com'
    })
    expect(openExternalLink).not.toHaveBeenCalled()
    expect(scope.handleCreateBackgroundBrowserRef.current).not.toHaveBeenCalled()

    // The loaded mode applies once storage answers; the next tap opens directly.
    await act(async () => {
      storedMode.resolve('orca-browser')
      await Promise.resolve()
    })
    expect(harness.state().terminalLinkOpenMode).toBe('orca-browser')
    act(() => harness.current().closeTerminalLinkSheet())
    act(() => harness.current().handleTerminalOpenUrl('h1', 'https://example.com'))

    expect(scope.handleCreateBackgroundBrowserRef.current).toHaveBeenCalledWith(
      'https://example.com'
    )
    expect(harness.current().terminalLinkChoice).toBeNull()
    harness.unmount()
  })

  it('A30b: a stored desktop mode survives an unavailable host and opens directly once it recovers', async () => {
    const scope = makeScope({
      terminalLinkOpenMode: 'orca-browser',
      statusReadable: false,
      keyboardHeight: 0
    })
    const harness = renderActions(scope)
    const create = scope.handleCreateBackgroundBrowserRef.current

    await act(async () => {
      harness.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await Promise.resolve()
    })

    expect(harness.choice()).toMatchObject({
      handle: 'h1',
      url: 'https://example.com'
    })
    expect(create).not.toHaveBeenCalled()
    expect(saveMode).not.toHaveBeenCalled()
    // The unavailable host never downgrades the stored mode.
    expect(scope.setTerminalLinkOpenMode).not.toHaveBeenCalled()

    // Same stored mode, capability recovered: the next tap skips the sheet.
    act(() => harness.current().closeTerminalLinkSheet())
    scope.statusReadable = true
    harness.rerender()
    act(() => harness.current().handleTerminalOpenUrl('h1', 'https://example.com'))

    expect(create).toHaveBeenCalledWith('https://example.com')
    expect(harness.choice()).toBeNull()
    expect(saveMode).not.toHaveBeenCalled()
  })

  it('ignores a tap whose handle is no longer active', () => {
    const scope = makeScope()
    scope.activeHandleRef.current = 'h2'
    const harness = renderActions(scope)

    act(() => harness.current().handleTerminalOpenUrl('h1', 'https://example.com'))

    expect(harness.choice()).toBeNull()
  })
})

describe('terminal link actions', () => {
  async function openSheet() {
    const scope = makeScope({ keyboardHeight: 0 })
    const harness = renderActions(scope)
    await act(async () => {
      harness.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await Promise.resolve()
    })
    return { scope, harness }
  }

  it('rechecks the active handle at action time', async () => {
    const { scope, harness } = await openSheet()
    scope.activeHandleRef.current = 'h2'

    act(() => harness.current().runTerminalLinkAction('phone-browser', false))

    expect(openExternalLink).not.toHaveBeenCalled()
    expect(harness.choice()).toBeNull()
  })

  it('writes the preference only for a remembered open', async () => {
    const first = await openSheet()

    await act(async () => {
      first.harness.current().runTerminalLinkAction('phone-browser', true)
      await Promise.resolve()
    })
    expect(saveMode).toHaveBeenCalledWith('phone-browser')
    expect(openExternalLink).toHaveBeenCalledTimes(1)

    saveMode.mockClear()
    const second = await openSheet()
    await act(async () => {
      second.harness.current().runTerminalLinkAction('copy', false)
      await Promise.resolve()
    })
    expect(saveMode).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('https://example.com')
  })

  it('does not write when Remember is off, and still opens when the write fails', async () => {
    const off = await openSheet()
    await act(async () => {
      off.harness.current().runTerminalLinkAction('phone-browser', false)
      await Promise.resolve()
    })
    expect(saveMode).not.toHaveBeenCalled()
    expect(openExternalLink).toHaveBeenCalledTimes(1)

    saveMode.mockRejectedValueOnce(new Error('storage unavailable'))
    const failed = await openSheet()
    await act(async () => {
      failed.harness.current().runTerminalLinkAction('phone-browser', true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(failed.scope.showToast).toHaveBeenCalledWith("Couldn't save link preference", 1600)
    expect(openExternalLink).toHaveBeenCalledTimes(2)
  })

  it('executes a double-tapped action once', async () => {
    const copy = await openSheet()
    await act(async () => {
      copy.harness.current().runTerminalLinkAction('copy', false)
      copy.harness.current().runTerminalLinkAction('copy', false)
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledTimes(1)

    const open = await openSheet()
    act(() => {
      open.harness.current().runTerminalLinkAction('phone-browser', false)
      open.harness.current().runTerminalLinkAction('phone-browser', false)
    })
    expect(openExternalLink).toHaveBeenCalledTimes(1)
  })

  it('runs the desktop action in the background', async () => {
    const { scope, harness } = await openSheet()

    await act(async () => {
      harness.current().runTerminalLinkAction('orca-browser', false)
      await Promise.resolve()
    })

    expect(scope.handleCreateBackgroundBrowserRef.current).toHaveBeenCalledWith(
      'https://example.com'
    )
    expect(harness.choice()).toBeNull()
  })

  it('A16: an active-handle change closes the sheet and suppresses the action', async () => {
    const scope = makeScope({ keyboardHeight: 1 })
    const harness = renderActions(scope)
    await act(async () => {
      harness.current().handleTerminalOpenUrl('h1', 'https://example.com')
      await Promise.resolve()
    })
    expect(harness.choice()).not.toBeNull()

    act(() => harness.setActiveHandle('h2'))

    expect(harness.choice()).toBeNull()
    expect(scope.focusLiveInput).toHaveBeenCalledTimes(1)

    scope.activeHandleRef.current = 'h2'
    act(() => harness.current().runTerminalLinkAction('phone-browser', false))
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('A29: reports a failed copy', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    const { scope, harness } = await openSheet()

    await act(async () => {
      harness.current().runTerminalLinkAction('copy', false)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(scope.showToast).toHaveBeenCalledWith("Couldn't copy link", 1500)
  })

  it('A29: reports a desktop action with no handler', async () => {
    const { scope, harness } = await openSheet()
    scope.handleCreateBackgroundBrowserRef.current = null

    act(() => harness.current().runTerminalLinkAction('orca-browser', false))

    expect(scope.showToast).toHaveBeenCalledWith("Couldn't open link on desktop", 1600)
  })
})
