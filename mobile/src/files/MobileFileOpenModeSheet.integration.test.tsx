import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const drawer = vi.hoisted((): { onClose?: () => void; onAfterClose?: () => void } => ({}))

const preference = vi.hoisted(
  (): {
    load: ReturnType<typeof vi.fn<() => Promise<'ask' | 'preview' | 'source'>>>
    save: ReturnType<typeof vi.fn<(mode: 'preview' | 'source') => Promise<void>>>
  } => ({
    load: vi.fn(async () => 'ask' as const),
    save: vi.fn(async () => {})
  })
)

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children)
  return {
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Switch: host('Switch'),
    Text: host('Text'),
    View: host('View')
  }
})

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (callback: () => void | (() => void)) => React.useEffect(callback, [callback])
  }
})

vi.mock('../storage/preferences', () => ({
  loadMobileHtmlOpenMode: preference.load,
  saveMobileHtmlOpenMode: preference.save
}))

vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({
      visible,
      children,
      onClose,
      onAfterClose
    }: {
      visible: boolean
      children: React.ReactNode
      onClose?: () => void
      onAfterClose?: () => void
    }) => {
      drawer.onClose = onClose
      drawer.onAfterClose = onAfterClose
      return visible ? React.createElement('Drawer', null, children) : null
    }
  }
})

vi.mock('lucide-react-native', () => ({
  Code: () => null,
  Edit3: () => null,
  Eye: () => null,
  Trash2: () => null,
  X: () => null
}))

import { MobileFileOpenModeSheet } from './MobileFileOpenModeSheet'
import { useMobileFileHtmlOpenMode } from './use-mobile-file-html-open-mode'

type OpenPreview = (relativePath: string, name: string, mode?: 'preview' | 'source') => void

const renderers: ReactTestRenderer[] = []

function Harness(props: { openPreview: OpenPreview }) {
  const api = useMobileFileHtmlOpenMode(props.openPreview)
  return createElement(
    'View',
    null,
    createElement(
      'Pressable',
      {
        accessibilityLabel: 'Tap index.html',
        onPress: () => api.previewFile('site/index.html', 'index.html')
      },
      createElement('Text', null, 'index.html')
    ),
    createElement(MobileFileOpenModeSheet, {
      visible: api.pending !== null,
      fileLabel: api.pending?.name,
      onSelect: api.selectMode,
      onClose: api.closeChooser,
      onDismiss: api.dismissChooser
    })
  )
}

async function mount(openPreview: OpenPreview): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(Harness, { openPreview }))
  })
  await flush()
  renderers.push(renderer)
  return renderer
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function pressableWithText(renderer: ReactTestRenderer, label: string) {
  return renderer.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) =>
      node
        .findAll((child) => String(child.type) === 'Text')
        .some((child) => child.props.children === label)
    )
}

function tap(renderer: ReactTestRenderer, label: string): void {
  const node =
    label === 'index.html'
      ? renderer.root
          .findAll((node) => String(node.type) === 'Pressable')
          .find((node) => node.props.accessibilityLabel === 'Tap index.html')
      : pressableWithText(renderer, label)
  if (!node) {
    throw new Error(`Unable to find pressable: ${label}`)
  }
  act(() => node.props.onPress())
}

beforeEach(() => {
  preference.load.mockClear()
  preference.save.mockClear()
  preference.save.mockResolvedValue(undefined)
})

afterEach(() => {
  drawer.onClose = undefined
  drawer.onAfterClose = undefined
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('MobileFileOpenModeSheet close sequence', () => {
  it('navigates with the captured target after the drawer fully closes', async () => {
    const openPreview = vi.fn()
    const renderer = await mount(openPreview)

    tap(renderer, 'index.html')
    expect(drawer.onAfterClose).toBeTypeOf('function')

    const remember = renderer.root.findAll((node) => String(node.type) === 'Switch')[0]
    act(() => remember?.props.onValueChange(true))
    tap(renderer, 'Source')

    // The selection closes the drawer without dispatching; the target must survive the close.
    expect(openPreview).not.toHaveBeenCalled()
    expect(preference.save).not.toHaveBeenCalled()

    act(() => drawer.onAfterClose?.())

    expect(openPreview).toHaveBeenCalledWith('site/index.html', 'index.html', 'source')
    expect(preference.save).toHaveBeenCalledWith('source')
  })

  it('drops the target when the chooser is dismissed without a choice', async () => {
    const openPreview = vi.fn()
    const renderer = await mount(openPreview)

    tap(renderer, 'index.html')
    tap(renderer, 'Cancel')
    act(() => drawer.onAfterClose?.())

    expect(openPreview).not.toHaveBeenCalled()
    expect(preference.save).not.toHaveBeenCalled()
  })
})
