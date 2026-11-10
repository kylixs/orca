import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(
  (): {
    saveHtmlOpenMode: ReturnType<typeof vi.fn>
    pickers: {
      title: string
      visible: boolean
      selected: string
      options: { value: string; label: string }[]
      onSelect: (value: string) => void
    }[]
  } => ({ saveHtmlOpenMode: vi.fn(async () => {}), pickers: [] })
)

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children)
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View')
  }
})

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn() })
}))

vi.mock('../components/PickerModal', async () => {
  const React = await import('react')
  return {
    PickerModal: (props: {
      title: string
      visible: boolean
      selected: string
      options: { value: string; label: string }[]
      onSelect: (value: string) => void
    }) => {
      mocks.pickers.push(props)
      return React.createElement('PickerModal', props)
    }
  }
})

vi.mock('../storage/preferences', () => ({
  loadTerminalLinkOpenMode: async () => 'ask',
  saveTerminalLinkOpenMode: async () => {},
  loadMobileHtmlOpenMode: async () => 'ask',
  saveMobileHtmlOpenMode: mocks.saveHtmlOpenMode
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: () => null,
  ChevronRight: () => null,
  FileCode2: () => null,
  Globe: () => null
}))

import BrowserSettingsScreen from './browser-settings-screen'

const renderers: ReactTestRenderer[] = []

async function render(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(BrowserSettingsScreen))
  })
  if (!renderer) {
    throw new Error('the settings screen did not render')
  }
  renderers.push(renderer)
  return renderer
}

function htmlRow(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll((node) => String(node.type) === 'Pressable')
    .find((node) =>
      String(node.props.accessibilityLabel ?? '').startsWith('HTML open mode, current value')
    )
}

function htmlPicker() {
  return mocks.pickers.findLast((picker) => picker.title === 'HTML open mode')
}

afterEach(() => {
  mocks.pickers.length = 0
  mocks.saveHtmlOpenMode.mockReset()
  mocks.saveHtmlOpenMode.mockResolvedValue(undefined)
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('the Browser HTML open mode setting', () => {
  it('shows the current value and offers Ask, Preview and Source', async () => {
    const renderer = await render()

    expect(htmlRow(renderer)?.props.accessibilityLabel).toBe('HTML open mode, current value Ask')
    act(() => htmlRow(renderer)?.props.onPress())

    expect(htmlPicker()?.visible).toBe(true)
    expect(htmlPicker()?.options.map((option) => option.label)).toEqual([
      'Ask',
      'Preview',
      'Source'
    ])
  })

  it('persists a selected mode', async () => {
    const renderer = await render()

    await act(async () => {
      htmlPicker()?.onSelect('source')
    })

    expect(mocks.saveHtmlOpenMode).toHaveBeenCalledWith('source')
    expect(htmlRow(renderer)?.props.accessibilityLabel).toBe('HTML open mode, current value Source')
  })

  it('rolls the row back and reports a refused write', async () => {
    mocks.saveHtmlOpenMode.mockRejectedValueOnce(new Error('storage unavailable'))
    const renderer = await render()

    await act(async () => {
      htmlPicker()?.onSelect('preview')
    })

    expect(htmlRow(renderer)?.props.accessibilityLabel).toBe('HTML open mode, current value Ask')
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => node.props.children === 'Could not save HTML open mode. Try again.')
    ).toBe(true)
  })
})
