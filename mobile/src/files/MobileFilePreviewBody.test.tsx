import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileFilePreviewResult } from './mobile-file-preview-request'

const captured = vi.hoisted(
  (): {
    frame: Record<string, unknown> | null
    source: Record<string, unknown> | null
  } => ({ frame: null, source: null })
)

const preference = vi.hoisted(
  (): { load: ReturnType<typeof vi.fn<() => Promise<'ask' | 'preview' | 'source'>>> } => ({
    load: vi.fn()
  })
)

vi.mock('../storage/preferences', () => ({
  loadMobileHtmlOpenMode: preference.load,
  saveMobileHtmlOpenMode: vi.fn(async () => {})
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children)
  return {
    ActivityIndicator: host('ActivityIndicator'),
    Image: host('Image'),
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View')
  }
})

vi.mock('../components/MobileHtmlPreview', async () => {
  const React = await import('react')
  return {
    MobileHtmlPreviewFrame: (props: Record<string, unknown>) => {
      captured.frame = props
      return React.createElement('Frame', props)
    }
  }
})

vi.mock('./MobileFilePreviewSourceText', async () => {
  const React = await import('react')
  return {
    MobileFilePreviewSourceText: (props: Record<string, unknown>) => {
      captured.source = props
      return React.createElement('SourceText', props)
    }
  }
})

vi.mock('./MobileFilePreviewEditableSource', () => ({
  MobileFilePreviewEditableSource: () => null
}))
vi.mock('./MobileFileMarkdownPreview', () => ({
  MobileFileMarkdownPreview: () => null
}))
vi.mock('./MobileFileMediaPreview', () => ({
  MobileFileMediaPreview: () => null
}))
vi.mock('../platform/external-link', () => ({
  openExternalLink: vi.fn()
}))

import { MobileFilePreviewBody } from './MobileFilePreviewBody'
import { useMobileFilePreviewHtmlMode } from './use-mobile-file-preview-html-mode'

const renderers: ReactTestRenderer[] = []

function htmlPreview(
  content: string,
  overrides: { truncated?: boolean } = {}
): MobileFilePreviewResult {
  return {
    status: 'ready',
    kind: 'html',
    content,
    truncated: overrides.truncated ?? false,
    byteLength: content.length
  }
}

function mount(props: Parameters<typeof MobileFilePreviewBody>[0]): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(MobileFilePreviewBody, props))
  })
  renderers.push(renderer)
  return renderer
}

function body(
  preview: MobileFilePreviewResult,
  overrides: Partial<Parameters<typeof MobileFilePreviewBody>[0]> = {}
): Parameters<typeof MobileFilePreviewBody>[0] {
  return {
    preview,
    relativePath: 'site/index.html',
    title: 'index.html',
    editable: false,
    draftContent: '',
    saveError: '',
    lineColumn: null,
    imageWidth: 320,
    imageHeight: 480,
    htmlMode: 'preview',
    htmlRenderable: true,
    sourceOnly: false,
    onDraftChange: () => {},
    onImageError: () => {},
    onRetry: null,
    ...overrides
  }
}

function textOf(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text')
    .flatMap((node) => node.props.children)
    .join(' ')
}

afterEach(() => {
  captured.frame = null
  captured.source = null
  preference.load.mockReset()
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

const BARE_HTML_ROUTE = {
  hostId: 'host-a',
  worktreeId: 'wt-1',
  relativePath: 'site/index.html',
  name: 'index.html'
}

function HtmlModeBodyHarness() {
  const { mode } = useMobileFilePreviewHtmlMode({
    params: BARE_HTML_ROUTE,
    htmlFile: true,
    terminalArtifact: false,
    truncated: false,
    readFailed: false
  })
  return createElement(MobileFilePreviewBody, body(htmlPreview('<h1>Hi</h1>'), { htmlMode: mode }))
}

describe('MobileFilePreviewBody HTML rendering', () => {
  it('mounts one frame with its own toolbar off and puts the asset warning above it', () => {
    const renderer = mount(body(htmlPreview('<img src="./hero.png">')))

    expect(captured.frame).toMatchObject({ mode: 'preview', showToolbar: false })
    expect(captured.source).toBeNull()
    expect(textOf(renderer)).toContain('Relative assets may not load: ./hero.png')

    const ordered = renderer.root.findAll(
      (node) => String(node.type) === 'Text' || String(node.type) === 'Frame'
    )
    const warningIndex = ordered.findIndex(
      (node) =>
        String(node.type) === 'Text' &&
        String(node.props.children).startsWith('Relative assets may not load')
    )
    const frameIndex = ordered.findIndex((node) => String(node.type) === 'Frame')
    expect(warningIndex).toBeGreaterThanOrEqual(0)
    expect(warningIndex).toBeLessThan(frameIndex)
    // The body owns no mode toolbar: the screen's second row is the only one.
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Pressable')
        .filter((node) => node.props.accessibilityRole === 'tab')
    ).toEqual([])
  })

  it('shows source when the screen chose source', () => {
    mount(
      body(htmlPreview('<h1>Hi</h1>'), {
        htmlMode: 'source',
        lineColumn: { line: 7, column: null }
      })
    )

    expect(captured.frame).toBeNull()
    expect(captured.source).toMatchObject({
      content: '<h1>Hi</h1>',
      initialLine: 7
    })
  })

  it('never mounts the frame for a source-only terminal artifact', () => {
    mount(
      body(htmlPreview('<h1>Hi</h1>'), {
        htmlMode: 'preview',
        sourceOnly: true
      })
    )

    expect(captured.frame).toBeNull()
    expect(captured.source).toMatchObject({ content: '<h1>Hi</h1>' })
  })

  it('keeps a truncated read in source with the exact note', () => {
    mount(
      body(htmlPreview('<h1>Hi</h1>', { truncated: true }), {
        htmlRenderable: false,
        truncatedNote: 'Showing first 512 KB'
      })
    )

    expect(captured.frame).toBeNull()
    expect(captured.source).toMatchObject({
      truncated: true,
      truncatedNote: 'Showing first 512 KB'
    })
  })

  it('mounts no frame until a bare route preference resolves', async () => {
    let resolveLoad: ((mode: 'ask' | 'preview' | 'source') => void) | undefined
    preference.load.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    )

    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(HtmlModeBodyHarness))
    })
    renderers.push(renderer)

    expect(captured.frame).toBeNull()
    expect(captured.source).toMatchObject({ content: '<h1>Hi</h1>' })

    await act(async () => {
      resolveLoad?.('source')
      await Promise.resolve()
    })

    expect(captured.frame).toBeNull()
    expect(captured.source).toMatchObject({ content: '<h1>Hi</h1>' })
  })

  it('shows the empty state for a zero-byte HTML file', () => {
    const renderer = mount(body({ status: 'empty', kind: 'html' }))

    expect(captured.frame).toBeNull()
    expect(textOf(renderer)).toContain('Empty file')
  })

  it('passes CJK and emoji content and file names through untouched', () => {
    mount(
      body(htmlPreview('你好，世界 👋'), {
        relativePath: '文档/页面😀.html',
        title: '页面😀.html',
        htmlMode: 'source'
      })
    )

    expect(captured.source).toMatchObject({
      content: '你好，世界 👋',
      relativePath: '文档/页面😀.html'
    })
  })
})
