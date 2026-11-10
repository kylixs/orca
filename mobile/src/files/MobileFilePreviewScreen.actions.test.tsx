import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'

const deps = vi.hoisted(
  (): {
    bodyProps: {
      onDraftChange?: (content: string) => void
      htmlMode?: 'preview' | 'source'
      htmlRenderable?: boolean
      sourceOnly?: boolean
      truncatedNote?: string
      imageWidth?: number
      imageHeight?: number
      preview?: { status: string }
    } | null
    sheetProps: {
      visible: boolean
      actions: { label: string; hint?: string }[]
    } | null
    modeSheetProps: {
      visible: boolean
      previewDisabled?: boolean
      onSelect?: (mode: 'preview' | 'source', remember: boolean) => void
    } | null
    saveMode: ReturnType<typeof vi.fn>
    preference: 'ask' | 'preview' | 'source'
    dimensions: { width: number; height: number }
  } => ({
    bodyProps: null,
    sheetProps: null,
    modeSheetProps: null,
    saveMode: vi.fn(async () => {}),
    preference: 'ask',
    dimensions: { width: 390, height: 844 }
  })
)

vi.mock('../storage/preferences', () => ({
  loadMobileHtmlOpenMode: async () => deps.preference,
  saveMobileHtmlOpenMode: deps.saveMode
}))

const transport = vi.hoisted(
  (): {
    client: { sendRequest: ReturnType<typeof vi.fn> } | null
    state: string
  } => ({ client: null, state: 'connected' })
)

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  BackHandler: { addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  useWindowDimensions: () => deps.dimensions
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Clipboard: 'Icon',
  Code: 'Icon',
  Copy: 'Icon',
  Download: 'Icon',
  Ellipsis: 'Icon',
  ExternalLink: 'Icon',
  Eye: 'Icon',
  FileCode2: 'Icon',
  RotateCw: 'Icon',
  Save: 'Icon',
  X: 'Icon'
}))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetModal: (props: { visible: boolean; actions: { label: string }[] }) => {
    deps.sheetProps = props
    return null
  }
}))
vi.mock('./MobileFileOpenModeSheet', () => ({
  MobileFileOpenModeSheet: (props: {
    visible: boolean
    previewDisabled?: boolean
    onSelect?: (mode: 'preview' | 'source', remember: boolean) => void
  }) => {
    deps.modeSheetProps = props
    return null
  }
}))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ back: () => {}, canGoBack: () => false })
}))
vi.mock('./use-mobile-file-preview-back', () => ({
  useMobileFilePreviewBack: () => ({
    confirmingDiscard: false,
    requestBack: () => {},
    stay: () => {},
    discard: () => {}
  })
}))
vi.mock('./MobileFilePreviewBody', () => ({
  MobileFilePreviewBody: (props: { onDraftChange: (content: string) => void }) => {
    deps.bodyProps = props
    return null
  }
}))
vi.mock('expo-file-system', () => ({
  Directory: class {},
  File: class {},
  Paths: { cache: '' }
}))
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }))
vi.mock('./file-action-capabilities', () => ({
  fileActionCapabilities: () => ({ saveToPhone: true, openWith: true }),
  fileActionCapabilitiesFor: () => ({ saveToPhone: true, openWith: true }),
  probeFileActionCapabilities: () => ({}),
  isSharingModuleAvailable: () => false,
  isIntentLauncherModuleAvailable: () => false
}))
vi.mock('../transport/client-context', () => ({
  useForceReconnect: () => vi.fn(),
  useHostClient: () => ({ client: transport.client, state: transport.state })
}))

import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'
import { resetFileReadFailures } from './file-read-failures'

function ok(result: unknown): RpcResponse {
  return { id: 'response-id', ok: true, result, _meta: { runtimeId: 'runtime-id' } }
}

function connectedClient(result: unknown) {
  return {
    sendRequest: vi.fn(async () => ok(result))
  }
}

function failedClient(message: string) {
  return {
    sendRequest: vi.fn(async () => ({
      id: 'response-id',
      ok: false as const,
      error: { code: 'internal', message },
      _meta: { runtimeId: 'runtime-id' }
    }))
  }
}

const WORKTREE_ROUTE = {
  ok: true as const,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    relativePath: 'README.md',
    name: 'README.md'
  }
}

const HTML_ROUTE = {
  ok: true as const,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    relativePath: 'site/index.html',
    name: 'index.html',
    mode: 'preview' as const
  }
}

const HTML_ASK_ROUTE = {
  ok: true as const,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    relativePath: 'site/index.html',
    name: 'index.html'
  }
}

const HTML_SOURCE_ROUTE = {
  ok: true as const,
  params: {
    ...HTML_ROUTE.params,
    mode: 'source' as const
  }
}

const TERMINAL_HTML_ROUTE = {
  ok: true as const,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    source: 'terminalArtifact' as const,
    absolutePath: '/tmp/index.html',
    grantId: 'grant-1',
    name: 'index.html',
    mode: 'preview' as const
  }
}

const TERMINAL_ROUTE = {
  ok: true as const,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    source: 'terminalArtifact' as const,
    absolutePath: '/tmp/result.txt',
    grantId: 'grant-1',
    pathText: '~/result.txt',
    name: 'result.txt'
  }
}

let tree: ReactTestRenderer | null = null

async function render(
  route:
    | typeof WORKTREE_ROUTE
    | typeof TERMINAL_ROUTE
    | typeof HTML_ROUTE
    | typeof HTML_ASK_ROUTE
    | typeof HTML_SOURCE_ROUTE
    | typeof TERMINAL_HTML_ROUTE
): Promise<void> {
  await act(async () => {
    tree = create(createElement(MobileFilePreviewScreen, { route }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function pressByLabel(label: string): void {
  const node = tree?.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((candidate) => candidate.props.accessibilityLabel === label)
  if (!node) {
    throw new Error(`Missing pressable: ${label}`)
  }
  act(() => node.props.onPress())
}

function actionsButton() {
  return tree?.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) => node.props.accessibilityLabel === 'File actions')
}

function tabs() {
  return (
    tree?.root
      .findAll((node) => String(node.type) === 'Pressable')
      .filter((node) => node.props.accessibilityRole === 'tab') ?? []
  )
}

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  deps.bodyProps = null
  deps.sheetProps = null
  deps.modeSheetProps = null
  deps.saveMode.mockReset()
  deps.saveMode.mockResolvedValue(undefined)
  deps.preference = 'ask'
  deps.dimensions = { width: 390, height: 844 }
  transport.client = null
  transport.state = 'connected'
  resetFileReadFailures()
})

describe('the preview header action sheet', () => {
  it('omits Preview, because the file is already open', async () => {
    transport.client = connectedClient({
      content: '# Readme',
      truncated: false,
      byteLength: 8
    })
    await render(WORKTREE_ROUTE)

    pressByLabel('File actions')

    expect(deps.sheetProps?.visible).toBe(true)
    expect(deps.sheetProps?.actions.map((action) => action.label)).toEqual([
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
  })

  it('offers the same actions for a terminal artifact', async () => {
    transport.client = connectedClient({
      content: 'result',
      truncated: false,
      byteLength: 6
    })
    await render(TERMINAL_ROUTE)

    pressByLabel('File actions')

    expect(deps.sheetProps?.actions.map((action) => action.label)).toEqual([
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
  })
})

describe('HTML open modes in the preview screen', () => {
  it('shows one Preview and one Source before the shared external actions', async () => {
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_ROUTE)

    pressByLabel('File actions')

    expect(deps.sheetProps?.actions.map((action) => action.label)).toEqual([
      'Preview',
      'Source',
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
    expect(deps.sheetProps?.actions.filter((action) => action.label === 'Preview')).toHaveLength(1)
  })

  it('renders only one mode toolbar and switches page-local state without writing a preference', async () => {
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_SOURCE_ROUTE)

    expect(tabs().map((node) => node.props.accessibilityLabel)).toEqual([
      'Preview rendered HTML',
      'View HTML source'
    ])
    expect(deps.bodyProps?.htmlMode).toBe('source')

    act(() => tabs()[0]?.props.onPress())
    expect(deps.bodyProps?.htmlMode).toBe('preview')
    expect(deps.saveMode).not.toHaveBeenCalled()
  })

  it('forces Source with a notice when the read was truncated', async () => {
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: true,
      byteLength: 600 * 1024
    })
    await render(HTML_ROUTE)

    expect(deps.bodyProps?.htmlMode).toBe('source')
    expect(deps.bodyProps?.truncatedNote).toBe('Showing first 512 KB')
    expect(renderedText()).toContain('File is larger than 512 KB')
    expect(deps.modeSheetProps?.previewDisabled).toBe(true)
    expect(tabs()[0]?.props.accessibilityState).toEqual({ selected: false, disabled: true })
    expect(tabs()[1]?.props.accessibilityState).toEqual({ selected: true })

    pressByLabel('File actions')
    expect(deps.sheetProps?.actions.map((action) => action.label)).toEqual([
      'Source',
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
    expect(deps.sheetProps?.actions.find((action) => action.label === 'Copy content')?.hint).toBe(
      'Copies the first 512 KB'
    )
  })

  it('renders 511 and 512 KB but forces Source at 513 KB and 1 MB', async () => {
    const cases = [
      { bytes: 511 * 1024, truncated: false },
      { bytes: 512 * 1024, truncated: false },
      { bytes: 513 * 1024, truncated: true },
      { bytes: 1024 * 1024, truncated: true }
    ]

    for (const { bytes, truncated } of cases) {
      await act(async () => tree?.unmount())
      transport.client = connectedClient({
        content: 'x'.repeat(32),
        truncated,
        byteLength: bytes
      })
      await render(HTML_ROUTE)

      expect(deps.bodyProps?.htmlMode, `${bytes} bytes`).toBe(truncated ? 'source' : 'preview')
      expect(deps.bodyProps?.htmlRenderable, `${bytes} bytes`).toBe(!truncated)
      if (truncated) {
        expect(deps.bodyProps?.truncatedNote, `${bytes} bytes`).toBe('Showing first 512 KB')
        expect(deps.modeSheetProps?.previewDisabled, `${bytes} bytes`).toBe(true)
        expect(renderedText(), `${bytes} bytes`).toContain('File is larger than 512 KB')
      }
    }
  })

  it('omits Preview from the action sheet at 513 KB and 1 MB', async () => {
    for (const bytes of [513 * 1024, 1024 * 1024]) {
      await act(async () => tree?.unmount())
      transport.client = connectedClient({
        content: 'x'.repeat(32),
        truncated: true,
        byteLength: bytes
      })
      await render(HTML_ROUTE)

      pressByLabel('File actions')

      expect(
        deps.sheetProps?.actions.map((action) => action.label),
        `${bytes} bytes`
      ).toEqual(['Source', 'Save to phone', 'Open with', 'Copy content', 'Copy path', 'Cancel'])
    }
  })

  it('shows the empty state for a zero-byte HTML file', async () => {
    transport.client = connectedClient({ content: '', truncated: false, byteLength: 0 })
    await render(HTML_ROUTE)

    expect(deps.bodyProps?.preview?.status).toBe('empty')
    expect(deps.bodyProps?.htmlMode).toBe('preview')
  })

  it('does not carry a manual toggle back to the next visit', async () => {
    deps.preference = 'source'
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_ASK_ROUTE)
    expect(deps.bodyProps?.htmlMode).toBe('source')

    act(() => tabs()[0]?.props.onPress())
    expect(deps.bodyProps?.htmlMode).toBe('preview')

    await act(async () => tree?.unmount())
    await render(HTML_ASK_ROUTE)

    expect(deps.bodyProps?.htmlMode).toBe('source')
    expect(deps.saveMode).not.toHaveBeenCalled()
  })

  it('reports the overflow sheet expanded state to accessibility', async () => {
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_ROUTE)

    expect(actionsButton()?.props.accessibilityState).toEqual({ expanded: false })
    pressByLabel('File actions')
    expect(actionsButton()?.props.accessibilityState).toEqual({ expanded: true })
  })

  it('keeps the read-failed error uncovered and hides the chooser on a bare route', async () => {
    deps.preference = 'ask'
    transport.client = failedClient('EACCES: permission denied')
    await render(HTML_ASK_ROUTE)

    expect(deps.modeSheetProps?.visible).toBe(false)
    expect(tabs()).toHaveLength(0)
    pressByLabel('File actions')
    expect(deps.sheetProps?.actions.map((action) => action.label)).toEqual([
      'Retry read',
      'Save to phone',
      'Open with',
      'Copy path',
      'Cancel'
    ])
  })

  it('keeps the page-local mode and sizes across rotation', async () => {
    deps.preference = 'source'
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_ASK_ROUTE)
    act(() => tabs()[0]?.props.onPress())
    expect(deps.bodyProps?.htmlMode).toBe('preview')

    deps.dimensions = { width: 844, height: 390 }
    await act(async () => {
      tree?.update(createElement(MobileFilePreviewScreen, { route: HTML_ASK_ROUTE }))
    })

    expect(deps.bodyProps?.htmlMode).toBe('preview')
    expect(deps.bodyProps?.imageWidth).toBe(820)
    expect(deps.bodyProps?.imageHeight).toBe(240)
    expect(tabs().map((node) => node.props.accessibilityLabel)).toEqual([
      'Preview rendered HTML',
      'View HTML source'
    ])
  })

  it('offers Retry and no content actions when the read failed', async () => {
    transport.client = failedClient('EACCES: permission denied')
    await render(HTML_ROUTE)

    pressByLabel('File actions')

    expect(deps.sheetProps?.actions.map((action) => action.label)).toEqual([
      'Retry read',
      'Save to phone',
      'Open with',
      'Copy path',
      'Cancel'
    ])
  })

  it('asks on a bare route and remembers only when the switch says so', async () => {
    deps.preference = 'ask'
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_ASK_ROUTE)

    expect(deps.modeSheetProps?.visible).toBe(true)

    await act(async () => {
      deps.modeSheetProps?.onSelect?.('preview', false)
    })
    expect(deps.bodyProps?.htmlMode).toBe('preview')
    expect(deps.saveMode).not.toHaveBeenCalled()

    await act(async () => {
      deps.modeSheetProps?.onSelect?.('source', true)
    })
    expect(deps.saveMode).toHaveBeenCalledWith('source')
  })

  it('opens a bare route directly when a mode is stored', async () => {
    deps.preference = 'source'
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_ASK_ROUTE)

    expect(deps.modeSheetProps?.visible).toBe(false)
    expect(deps.bodyProps?.htmlMode).toBe('source')
  })

  it('reports a refused remembered mode without blocking the open', async () => {
    deps.preference = 'ask'
    deps.saveMode.mockRejectedValueOnce(new Error('storage unavailable'))
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(HTML_ASK_ROUTE)

    await act(async () => {
      deps.modeSheetProps?.onSelect?.('source', true)
    })

    expect(deps.bodyProps?.htmlMode).toBe('source')
    await vi.waitFor(() => expect(renderedText()).toContain('Could not save HTML open mode'))
  })

  it('keeps terminal artifact HTML source-only and does not offer rendering', async () => {
    transport.client = connectedClient({
      content: '<h1>Hi</h1>',
      truncated: false,
      byteLength: 11
    })
    await render(TERMINAL_HTML_ROUTE)

    expect(deps.bodyProps?.sourceOnly).toBe(true)
    expect(deps.bodyProps?.htmlMode).toBe('source')
    expect(
      tree?.root
        .findAll((node) => String(node.type) === 'Pressable')
        .filter((node) => node.props.accessibilityRole === 'tab')
    ).toHaveLength(0)
  })
})

function renderedText(): string {
  return (
    tree?.root
      .findAll((node) => String(node.type) === 'Text')
      .flatMap((node) => node.props.children)
      .join(' ') ?? ''
  )
}

describe('the terminal artifact header Save', () => {
  it('renders only once the editable text has unsaved changes', async () => {
    transport.client = connectedClient({
      content: 'result',
      truncated: false,
      byteLength: 6
    })
    await render(TERMINAL_ROUTE)

    expect(findSave()).toBeUndefined()

    act(() => deps.bodyProps?.onDraftChange?.('result changed'))

    expect(findSave()?.props.disabled).toBe(false)
  })
})

function findSave() {
  return tree?.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) => node.props.accessibilityLabel === 'Save terminal artifact')
}
