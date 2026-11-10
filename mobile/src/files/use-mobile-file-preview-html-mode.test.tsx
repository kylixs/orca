import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileFilePreviewRouteParams } from './mobile-file-preview-route'

const deps = vi.hoisted(() => ({
  load: vi.fn<() => Promise<'ask' | 'preview' | 'source'>>(),
  save: vi.fn<(mode: 'preview' | 'source') => Promise<void>>()
}))

vi.mock('../storage/preferences', () => ({
  loadMobileHtmlOpenMode: deps.load,
  saveMobileHtmlOpenMode: deps.save
}))

import { useMobileFilePreviewHtmlMode } from './use-mobile-file-preview-html-mode'

type Api = ReturnType<typeof useMobileFilePreviewHtmlMode>
const latest: { api: Api | null } = { api: null }

const BARE: MobileFilePreviewRouteParams = {
  hostId: 'host-1',
  worktreeId: 'wt-1',
  relativePath: 'index.html',
  name: 'index.html'
}

function Harness(props: {
  params: MobileFilePreviewRouteParams | null
  truncated?: boolean
  readFailed?: boolean
  terminalArtifact?: boolean
  htmlFile?: boolean
}) {
  latest.api = useMobileFilePreviewHtmlMode({
    params: props.params,
    htmlFile: props.htmlFile ?? true,
    terminalArtifact: props.terminalArtifact ?? false,
    truncated: props.truncated ?? false,
    readFailed: props.readFailed ?? false
  })
  return null
}

let tree: ReactTestRenderer | null = null

async function render(props: Parameters<typeof Harness>[0]): Promise<Api> {
  await act(async () => {
    tree = create(createElement(Harness, props))
  })
  await flush()
  if (!latest.api) {
    throw new Error('the hook did not render')
  }
  return latest.api
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  deps.load.mockReset()
  deps.save.mockReset()
  deps.save.mockResolvedValue(undefined)
})

afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = null
  latest.api = null
})

describe('useMobileFilePreviewHtmlMode', () => {
  it('does not let a late preference read overwrite a manual choice', async () => {
    let resolveLoad: ((mode: 'ask' | 'preview' | 'source') => void) | undefined
    deps.load.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    )
    const api = await render({ params: BARE })

    act(() => api.setMode('source'))
    expect(latest.api?.mode).toBe('source')

    await act(async () => {
      resolveLoad?.('preview')
      await Promise.resolve()
    })

    expect(latest.api?.mode).toBe('source')
    expect(deps.save).not.toHaveBeenCalled()
  })

  it('keeps a truncated file in Source even when the stored preference is Preview', async () => {
    deps.load.mockResolvedValue('preview')

    const api = await render({ params: BARE, truncated: true })

    expect(api.mode).toBe('source')
    expect(api.sheetVisible).toBe(false)
  })

  it('hides the chooser and skips storage when the read failed', async () => {
    deps.load.mockResolvedValue('ask')

    const api = await render({ params: BARE, readFailed: true })

    expect(api.mode).toBe('source')
    expect(api.sheetVisible).toBe(false)
    expect(deps.load).not.toHaveBeenCalled()
  })

  it('resolves a line target before a stored Preview preference', async () => {
    deps.load.mockResolvedValue('preview')

    const api = await render({ params: { ...BARE, line: '42' } })

    expect(api.mode).toBe('source')
    // The explicit line target already decided, so no preference read was needed.
    expect(deps.load).not.toHaveBeenCalled()
  })

  it('lets an explicit route mode beat a line target', async () => {
    const api = await render({ params: { ...BARE, line: '42', mode: 'preview' } })

    expect(api.mode).toBe('preview')
  })

  it('opens the chooser only for a bare route whose stored preference asks', async () => {
    deps.load.mockResolvedValue('ask')

    const api = await render({ params: BARE })

    expect(api.sheetVisible).toBe(true)
    expect(api.mode).toBe('preview')
  })

  it('opens a stored mode directly', async () => {
    deps.load.mockResolvedValue('source')

    const api = await render({ params: BARE })

    expect(api.sheetVisible).toBe(false)
    expect(api.mode).toBe('source')
  })

  it('keeps a bare route in source until the stored preference resolves', async () => {
    let resolveLoad: ((mode: 'ask' | 'preview' | 'source') => void) | undefined
    deps.load.mockReturnValue(
      new Promise((resolve) => {
        resolveLoad = resolve
      })
    )
    const api = await render({ params: BARE })

    // Preview here would mount the JS-enabled frame before we know the stored mode.
    expect(api.mode).toBe('source')
    expect(api.sheetVisible).toBe(false)

    await act(async () => {
      resolveLoad?.('source')
      await Promise.resolve()
    })

    expect(latest.api?.mode).toBe('source')
    expect(latest.api?.sheetVisible).toBe(false)
  })

  it('forces terminal artifacts to Source regardless of the route', async () => {
    const api = await render({
      params: { ...BARE, mode: 'preview' },
      terminalArtifact: true
    })

    expect(api.mode).toBe('source')
    expect(deps.load).not.toHaveBeenCalled()
  })
})
