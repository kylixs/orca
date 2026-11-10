import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileFileExplorerPanel } from './MobileFileExplorerPanel'
import type { MobileDirEntry } from './file-tree'
import type { RpcResponse } from '../transport/types'
import { recordFileReadFailure, resetFileReadFailures } from './file-read-failures'

type MockClient = {
  sendRequest: ReturnType<typeof vi.fn>
}

const mockTransport = vi.hoisted(
  (): {
    client: MockClient | null
    connectionState: string
    forceReconnect: ReturnType<typeof vi.fn> | null
  } => ({
    client: null,
    connectionState: 'connected',
    forceReconnect: vi.fn()
  })
)

const mockPush = vi.hoisted(() => vi.fn())

const mockPreference = vi.hoisted(
  (): {
    mode: 'ask' | 'preview' | 'source'
    load: ReturnType<typeof vi.fn<() => Promise<'ask' | 'preview' | 'source'>>>
    save: ReturnType<typeof vi.fn>
  } => ({ mode: 'ask', load: vi.fn(async () => mockPreference.mode), save: vi.fn(async () => {}) })
)

const mockFocus = vi.hoisted((): { effect: (() => void | (() => void)) | null } => ({
  effect: null
}))

const mockOpenModeSheet = vi.hoisted(
  (): {
    props: {
      visible: boolean
      fileLabel?: string
      onSelect: (mode: 'preview' | 'source', remember: boolean) => void
      onClose: () => void
    } | null
  } => ({ props: null })
)

vi.mock('../storage/preferences', () => ({
  loadMobileHtmlOpenMode: mockPreference.load,
  saveMobileHtmlOpenMode: mockPreference.save
}))

vi.mock('./MobileFileOpenModeSheet', () => ({
  MobileFileOpenModeSheet: (props: typeof mockOpenModeSheet.props) => {
    mockOpenModeSheet.props = props
    return null
  }
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: (props: {
      data: unknown[]
      keyExtractor: (item: unknown, index: number) => string
      renderItem: (info: {
        item: unknown
        index: number
        separators: Record<string, never>
      }) => unknown
    }) =>
      React.createElement(
        'FlatList',
        props,
        props.data.map((item, index) =>
          React.createElement(
            'FlatListItem',
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index, separators: {} })
          )
        )
      ),
    InteractionManager: {
      runAfterInteractions: (callback: () => void) => {
        callback()
        return { cancel: () => {} }
      }
    },
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView'
}))

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useRouter: () => ({
      back: vi.fn(),
      push: mockPush
    }),
    useFocusEffect: (callback: () => void | (() => void)) => {
      mockFocus.effect = callback
      React.useEffect(callback, [callback])
    }
  }
})

vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Clipboard: 'Clipboard',
  Copy: 'Copy',
  Download: 'Download',
  Ellipsis: 'Ellipsis',
  ExternalLink: 'ExternalLink',
  Eye: 'Eye',
  File: 'File',
  FileCode2: 'FileCode2',
  FileText: 'FileText',
  Folder: 'Folder',
  Image: 'Image',
  RotateCw: 'RotateCw',
  Search: 'Search',
  X: 'X'
}))

vi.mock('../platform/haptics', () => ({
  triggerMediumImpact: vi.fn(),
  triggerSelection: vi.fn()
}))

vi.mock('expo-file-system', () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: '' }
}))

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null
}))

vi.mock('expo-clipboard', () => ({
  setStringAsync: async () => true
}))

vi.mock('./file-action-capabilities', () => ({
  fileActionCapabilities: () => ({ saveToPhone: true, openWith: true }),
  fileActionCapabilitiesFor: () => ({ saveToPhone: true, openWith: true }),
  probeFileActionCapabilities: () => ({}),
  isSharingModuleAvailable: () => false,
  isIntentLauncherModuleAvailable: () => false
}))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetModal: 'ActionSheetModal',
  ActionSheetContent: 'ActionSheetContent'
}))

vi.mock('../transport/client-context', () => ({
  useForceReconnect: () => mockTransport.forceReconnect,
  useHostClient: () => ({
    client: mockTransport.client,
    state: mockTransport.connectionState
  })
}))

function entry(name: string, isDirectory = false): MobileDirEntry {
  return { name, isDirectory }
}

function ok(result: MobileDirEntry[]): RpcResponse {
  return { id: 'response-id', ok: true, result, _meta: { runtimeId: 'runtime-id' } }
}

function createMockClient(entriesByPath: Record<string, MobileDirEntry[]>): MockClient {
  return {
    sendRequest: vi.fn(async (_method: string, params: { relativePath: string }) => {
      return ok(entriesByPath[params.relativePath] ?? [])
    })
  }
}

const mountedRenderers: ReactTestRenderer[] = []

function unmountRenderedPanels(): void {
  act(() => {
    for (const renderer of mountedRenderers) {
      renderer.unmount()
    }
  })
  mountedRenderers.length = 0
}

async function renderExplorer(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(
      createElement(MobileFileExplorerPanel, {
        hostId: 'host-a',
        worktreeId: 'worktree-a',
        name: 'Example Worktree',
        embedded: true
      })
    )
  })
  if (!renderer) {
    throw new Error('MobileFileExplorerPanel did not render')
  }
  mountedRenderers.push(renderer)
  return renderer
}

async function updateExplorer(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.update(
      createElement(MobileFileExplorerPanel, {
        hostId: 'host-a',
        worktreeId: 'worktree-a',
        name: 'Example Worktree',
        embedded: true
      })
    )
  })
}

async function pressByLabel(
  renderer: ReactTestRenderer,
  accessibilityLabel: string
): Promise<void> {
  const pressable = renderer.root
    .findAllByType('Pressable')
    .find((node) => node.props.accessibilityLabel === accessibilityLabel)
  if (!pressable) {
    throw new Error(`Unable to find pressable: ${accessibilityLabel}`)
  }
  await act(async () => {
    pressable.props.onPress()
  })
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .flatMap((node) => node.props.children)
    .join(' ')
}

describe('MobileFileExplorerPanel', () => {
  afterEach(() => {
    unmountRenderedPanels()
    vi.restoreAllMocks()
    resetFileReadFailures()
    mockTransport.client = null
    mockTransport.connectionState = 'connected'
    mockTransport.forceReconnect = vi.fn()
    mockPush.mockReset()
    mockPreference.mode = 'ask'
    mockPreference.load.mockClear()
    mockPreference.save.mockReset()
    mockPreference.save.mockResolvedValue(undefined)
    mockOpenModeSheet.props = null
  })

  it('loads directories lazily and reuses cached children when reopened', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')],
      src: [entry('app.ts'), entry('components', true)]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()

    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(client.sendRequest).toHaveBeenLastCalledWith('files.readDir', {
      worktree: 'id:worktree-a',
      relativePath: ''
    })

    await pressByLabel(renderer, 'Open folder src')
    await vi.waitFor(() => expect(client.sendRequest).toHaveBeenCalledTimes(2))
    expect(client.sendRequest).toHaveBeenLastCalledWith('files.readDir', {
      worktree: 'id:worktree-a',
      relativePath: 'src'
    })
    expect(renderedText(renderer)).toContain('app.ts')

    await pressByLabel(renderer, 'Open folder src')
    await pressByLabel(renderer, 'Open folder src')

    expect(client.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('keeps the loaded tree visible during a transient disconnect', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('src')

    mockTransport.client = null
    mockTransport.connectionState = 'disconnected'
    await updateExplorer(renderer)

    expect(client.sendRequest).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).not.toContain('Waiting for desktop...')
  })

  it('refreshes the root in the background after reconnect without blanking the tree', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('README.md')

    mockTransport.client = null
    mockTransport.connectionState = 'disconnected'
    await updateExplorer(renderer)

    let resolveReload: ((response: RpcResponse) => void) | undefined
    const reconnectedClient: MockClient = {
      sendRequest: vi.fn(
        () =>
          new Promise<RpcResponse>((resolve) => {
            resolveReload = resolve
          })
      )
    }
    mockTransport.client = reconnectedClient
    mockTransport.connectionState = 'connected'
    await updateExplorer(renderer)

    expect(reconnectedClient.sendRequest).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')

    await act(async () => {
      resolveReload?.(ok([entry('src', true), entry('README.md'), entry('CHANGELOG.md')]))
    })
    expect(renderedText(renderer)).toContain('CHANGELOG.md')
  })

  it('keeps the cached tree when a post-reconnect root refresh fails', async () => {
    const client = createMockClient({
      '': [entry('src', true), entry('README.md')]
    })
    mockTransport.client = client

    const renderer = await renderExplorer()
    expect(renderedText(renderer)).toContain('README.md')

    mockTransport.client = null
    mockTransport.connectionState = 'disconnected'
    await updateExplorer(renderer)

    const failingClient: MockClient = {
      sendRequest: vi.fn(async () => {
        throw new Error('refresh failed')
      })
    }
    mockTransport.client = failingClient
    mockTransport.connectionState = 'connected'
    await updateExplorer(renderer)

    expect(failingClient.sendRequest).toHaveBeenCalledTimes(1)
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).not.toContain('refresh failed')
  })

  it('falls back to the capped files.list against desktops without files.readDir', async () => {
    const legacyClient: MockClient = {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'files.readDir') {
          return {
            id: 'response-id',
            ok: false,
            error: {
              code: 'forbidden',
              message: "Method 'files.readDir' is not available to mobile clients"
            },
            _meta: { runtimeId: 'runtime-id' }
          }
        }
        return {
          id: 'response-id',
          ok: true,
          result: {
            files: [
              { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' },
              { relativePath: 'README.md', basename: 'README.md', kind: 'text' }
            ],
            totalCount: 2,
            truncated: false
          },
          _meta: { runtimeId: 'runtime-id' }
        }
      })
    }
    mockTransport.client = legacyClient

    const renderer = await renderExplorer()

    expect(legacyClient.sendRequest).toHaveBeenCalledWith('files.list', {
      worktree: 'id:worktree-a'
    })
    expect(renderedText(renderer)).toContain('src')
    expect(renderedText(renderer)).toContain('README.md')

    await pressByLabel(renderer, 'Open folder src')
    expect(renderedText(renderer)).toContain('app.ts')
    // Every directory comes from the synthesized cache: one readDir attempt
    // plus one files.list call total, no per-directory RPCs afterwards.
    expect(legacyClient.sendRequest).toHaveBeenCalledTimes(2)
  })

  it('surfaces the legacy cap note when the files.list fallback is truncated', async () => {
    const legacyClient: MockClient = {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'files.readDir') {
          return {
            id: 'response-id',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'runtime-id' }
          }
        }
        return {
          id: 'response-id',
          ok: true,
          result: {
            files: [{ relativePath: 'README.md', basename: 'README.md', kind: 'text' }],
            totalCount: 6000,
            truncated: true
          },
          _meta: { runtimeId: 'runtime-id' }
        }
      })
    }
    mockTransport.client = legacyClient

    const renderer = await renderExplorer()

    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).toContain('Showing first 5000')
  })

  it('reports the files.list failure when the fallback itself fails', async () => {
    const legacyClient: MockClient = {
      sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
        if (method === 'files.readDir') {
          return {
            id: 'response-id',
            ok: false,
            error: {
              code: 'forbidden',
              message: "Method 'files.readDir' is not available to mobile clients"
            },
            _meta: { runtimeId: 'runtime-id' }
          }
        }
        return {
          id: 'response-id',
          ok: false,
          error: { code: 'internal', message: 'legacy list failed' },
          _meta: { runtimeId: 'runtime-id' }
        }
      })
    }
    mockTransport.client = legacyClient

    const renderer = await renderExplorer()

    expect(renderedText(renderer)).toContain('legacy list failed')
    expect(renderedText(renderer)).not.toContain('not available to mobile clients')
  })

  describe('Retry while the host is unreachable', () => {
    function failingClient(failedPaths: Set<string>): MockClient {
      return {
        sendRequest: vi.fn(async (_method: string, params: { relativePath: string }) =>
          failedPaths.has(params.relativePath)
            ? {
                id: 'response-id',
                ok: false,
                error: { code: 'internal', message: 'read failed' },
                _meta: { runtimeId: 'runtime-id' }
              }
            : ok(params.relativePath === '' ? [entry('src', true)] : [entry('app.ts')])
        )
      }
    }

    async function unreachableAfterRootFailure(): Promise<ReactTestRenderer> {
      mockTransport.client = failingClient(new Set(['']))
      const renderer = await renderExplorer()
      mockTransport.connectionState = 'reconnecting'
      await updateExplorer(renderer)
      return renderer
    }

    function retryButtons(renderer: ReactTestRenderer) {
      return renderer.root
        .findAllByType('Pressable')
        .filter((node) =>
          node.findAllByType('Text').some((text) => text.props.children === 'Retry')
        )
    }

    it('offers no root Retry on the page, where nothing can re-dial', async () => {
      mockTransport.forceReconnect = null
      const renderer = await unreachableAfterRootFailure()
      expect(renderedText(renderer)).toContain('Waiting for desktop...')
      expect(retryButtons(renderer)).toHaveLength(0)
    })

    it('still offers it natively, and re-dials this host', async () => {
      const forceReconnect = vi.fn()
      mockTransport.forceReconnect = forceReconnect
      const renderer = await unreachableAfterRootFailure()
      const [retry] = retryButtons(renderer)
      await act(async () => {
        retry?.props.onPress()
      })
      expect(forceReconnect.mock.calls).toEqual([['host-a']])
    })

    it("keeps a folder's Retry on the page, whose read runs when the shell reconnects", async () => {
      // The one retry that does something without a re-dial: it queues the folder, and the
      // queue drains on the next `connected` whoever brought it back.
      mockTransport.forceReconnect = null
      const client = failingClient(new Set(['src']))
      mockTransport.client = client
      const renderer = await renderExplorer()
      await pressByLabel(renderer, 'Open folder src')
      await vi.waitFor(() => expect(renderedText(renderer)).toContain('read failed'))
      mockTransport.connectionState = 'reconnecting'
      await updateExplorer(renderer)
      client.sendRequest = failingClient(new Set()).sendRequest
      await pressByLabel(renderer, 'Retry loading src')
      mockTransport.connectionState = 'connected'
      await updateExplorer(renderer)
      await vi.waitFor(() =>
        expect(client.sendRequest).toHaveBeenLastCalledWith('files.readDir', {
          worktree: 'id:worktree-a',
          relativePath: 'src'
        })
      )
    })
  })
})

function nodeByLabel(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType('Pressable')
    .find((candidate) => candidate.props.accessibilityLabel === label)
  if (!node) {
    throw new Error(`Unable to find pressable: ${label}`)
  }
  return node
}

async function longPressByLabel(renderer: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    nodeByLabel(renderer, label).props.onLongPress()
  })
}

function actionSheet(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('ActionSheetModal')[0]
}

const SCOPE = { hostId: 'host-a', worktreeId: 'worktree-a' }

describe('MobileFileExplorerPanel actions', () => {
  afterEach(() => {
    unmountRenderedPanels()
    resetFileReadFailures()
    mockTransport.client = null
    mockTransport.connectionState = 'connected'
    mockTransport.forceReconnect = vi.fn()
    mockPush.mockReset()
    mockPreference.mode = 'ask'
    mockPreference.load.mockClear()
    mockPreference.save.mockReset()
    mockPreference.save.mockResolvedValue(undefined)
    mockOpenModeSheet.props = null
    mockFocus.effect = null
  })

  it('uses the specified 500 ms long-press delay', async () => {
    mockTransport.client = createMockClient({ '': [entry('README.md')] })
    const renderer = await renderExplorer()

    expect(nodeByLabel(renderer, 'Preview file README.md').props.delayLongPress).toBe(500)
  })

  it('opens the file action sheet from a row long press and the row-end ellipsis', async () => {
    mockTransport.client = createMockClient({ '': [entry('README.md')] })
    const renderer = await renderExplorer()

    await longPressByLabel(renderer, 'Preview file README.md')
    expect(actionSheet(renderer)?.props.visible).toBe(true)
    expect(
      actionSheet(renderer)?.props.actions.map((action: { label: string }) => action.label)
    ).toEqual(['Preview', 'Save to phone', 'Open with', 'Copy content', 'Copy path', 'Cancel'])

    await act(async () => {
      nodeByLabel(renderer, 'File actions for README.md').props.onPress()
    })
    expect(actionSheet(renderer)?.props.visible).toBe(true)
  })

  it('shows only Copy path for a directory', async () => {
    mockTransport.client = createMockClient({ '': [entry('src', true)] })
    const renderer = await renderExplorer()

    await longPressByLabel(renderer, 'Open folder src')
    expect(
      actionSheet(renderer)?.props.actions.map((action: { label: string }) => action.label)
    ).toEqual(['Copy path', 'Cancel'])
  })

  it('keeps binary rows actionable and shows their action set', async () => {
    mockTransport.client = createMockClient({ '': [entry('manual.pdf')] })
    const renderer = await renderExplorer()

    await longPressByLabel(renderer, 'File manual.pdf')
    expect(
      actionSheet(renderer)?.props.actions.map((action: { label: string }) => action.label)
    ).toEqual(['Save to phone', 'Open with', 'Copy path', 'Cancel'])
  })

  it('shows the shared read-failure badge and a Retry action', async () => {
    recordFileReadFailure(SCOPE, 'README.md', 'EACCES: permission denied')
    mockTransport.client = createMockClient({ '': [entry('README.md')] })
    const renderer = await renderExplorer()

    expect(renderedText(renderer)).toContain('Read failed')
    await longPressByLabel(renderer, 'Preview file README.md')
    expect(
      actionSheet(renderer)?.props.actions.map((action: { label: string }) => action.label)
    ).toEqual(['Retry read', 'Save to phone', 'Open with', 'Copy path', 'Cancel'])
  })

  it('asks for an open mode on the first HTML tap and writes it only when remembered', async () => {
    mockTransport.client = createMockClient({ '': [entry('index.html')] })
    const renderer = await renderExplorer()

    await pressByLabel(renderer, 'Preview file index.html')
    expect(mockOpenModeSheet.props?.visible).toBe(true)
    expect(mockPush).not.toHaveBeenCalled()

    await act(async () => {
      mockOpenModeSheet.props?.onSelect('source', true)
    })

    expect(mockPreference.save).toHaveBeenCalledWith('source')
    expect(mockPush.mock.calls[0]?.[0]).toMatchObject({
      params: { relativePath: 'index.html', mode: 'source' }
    })
  })

  it('does not write the preference for a long-press mode choice', async () => {
    mockTransport.client = createMockClient({ '': [entry('index.html')] })
    const renderer = await renderExplorer()

    await longPressByLabel(renderer, 'Preview file index.html')
    expect(
      actionSheet(renderer)?.props.actions.map((action: { label: string }) => action.label)
    ).toEqual([
      'Preview',
      'Source',
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
    await act(async () => {
      actionSheet(renderer)
        ?.props.actions.find((action: { label: string }) => action.label === 'Source')
        ?.onPress()
    })

    expect(mockPreference.save).not.toHaveBeenCalled()
    expect(mockPush.mock.calls[0]?.[0]).toMatchObject({
      params: { relativePath: 'index.html', mode: 'source' }
    })
  })

  it('does not attach an HTML mode to a non-HTML long-press Preview', async () => {
    mockTransport.client = createMockClient({ '': [entry('README.md')] })
    const renderer = await renderExplorer()

    await longPressByLabel(renderer, 'Preview file README.md')
    await act(async () => {
      actionSheet(renderer)
        ?.props.actions.find((action: { label: string }) => action.label === 'Preview')
        ?.onPress()
    })

    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush.mock.calls[0]?.[0]).toMatchObject({
      params: { relativePath: 'README.md' }
    })
    expect(mockPush.mock.calls[0]?.[0]?.params).not.toHaveProperty('mode')
  })

  it('does not preview on the release after a long press, but a later tap still does', async () => {
    mockTransport.client = createMockClient({ '': [entry('index.html')] })
    const renderer = await renderExplorer()
    const row = nodeByLabel(renderer, 'Preview file index.html')

    await act(async () => {
      row.props.onPressIn()
      row.props.onLongPress()
    })
    expect(actionSheet(renderer)?.props.visible).toBe(true)
    expect(renderer.root.findAllByType('ActionSheetModal')).toHaveLength(1)
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockOpenModeSheet.props?.visible).toBe(false)

    // Pressability's suppression has no observable release handler here, so drive the guarded path.
    await act(async () => {
      row.props.onPress()
    })
    expect(actionSheet(renderer)?.props.visible).toBe(true)
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockOpenModeSheet.props?.visible).toBe(false)

    // The guard is per gesture, not time-based: a fresh press-in resets it for a genuine tap.
    await act(async () => {
      row.props.onPressIn()
      row.props.onPress()
    })
    expect(mockOpenModeSheet.props?.visible).toBe(true)
  })

  it('keeps a remembered choice when the focus preference read resolves late', async () => {
    let resolveLoad: ((mode: 'ask' | 'preview' | 'source') => void) | undefined
    mockPreference.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        })
    )
    mockTransport.client = createMockClient({ '': [entry('index.html')] })
    const renderer = await renderExplorer()

    await pressByLabel(renderer, 'Preview file index.html')
    expect(mockOpenModeSheet.props?.visible).toBe(true)
    await act(async () => {
      mockOpenModeSheet.props?.onSelect('source', true)
    })
    expect(mockPush).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveLoad?.('ask')
      await Promise.resolve()
    })

    await pressByLabel(renderer, 'Preview file index.html')
    expect(mockOpenModeSheet.props?.visible).toBe(false)
    expect(mockPush.mock.calls[1]?.[0]).toMatchObject({
      params: { relativePath: 'index.html', mode: 'source' }
    })
  })

  it('opens a remembered HTML mode directly without the chooser', async () => {
    mockPreference.mode = 'preview'
    mockTransport.client = createMockClient({ '': [entry('index.html')] })
    const renderer = await renderExplorer()

    await pressByLabel(renderer, 'Preview file index.html')

    expect(mockOpenModeSheet.props?.visible).toBe(false)
    expect(mockPush.mock.calls[0]?.[0]).toMatchObject({
      params: { relativePath: 'index.html', mode: 'preview' }
    })
  })

  it('asks again on the next tap after Browser settings stores Ask', async () => {
    mockPreference.mode = 'preview'
    mockTransport.client = createMockClient({ '': [entry('index.html')] })
    const renderer = await renderExplorer()
    await pressByLabel(renderer, 'Preview file index.html')
    expect(mockOpenModeSheet.props?.visible).toBe(false)

    // The settings screen writes the shared preference; the list relearns it on focus.
    mockPreference.mode = 'ask'
    await act(async () => {
      mockFocus.effect?.()
    })

    await pressByLabel(renderer, 'Preview file index.html')
    expect(mockOpenModeSheet.props?.visible).toBe(true)
    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  it('reverts to asking and reports when the remembered mode cannot be saved', async () => {
    mockPreference.save.mockRejectedValueOnce(new Error('storage unavailable'))
    mockTransport.client = createMockClient({ '': [entry('index.html')] })
    const renderer = await renderExplorer()

    await pressByLabel(renderer, 'Preview file index.html')
    await act(async () => {
      mockOpenModeSheet.props?.onSelect('preview', true)
    })

    expect(mockPush).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(renderedText(renderer)).toContain('Could not save HTML open mode')
    )
  })

  it('filters the loaded tree by category', async () => {
    mockTransport.client = createMockClient({
      '': [entry('src', true), entry('README.md'), entry('logo.png')],
      src: [entry('app.ts')]
    })
    const renderer = await renderExplorer()

    await act(async () => {
      nodeByLabel(renderer, 'Show Docs files').props.onPress()
    })
    expect(renderedText(renderer)).toContain('README.md')
    expect(renderedText(renderer)).not.toContain('logo.png')
    // src was never expanded, so its contents are unknown and the filter keeps it with a note.
    expect(renderedText(renderer)).toContain('not loaded')
  })
})
