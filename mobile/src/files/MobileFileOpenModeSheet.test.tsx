import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

const drawer = vi.hoisted((): { onAfterClose?: () => void } => ({}))

vi.mock('../components/BottomDrawer', async () => {
  const React = await import('react')
  return {
    BottomDrawer: ({
      visible,
      children,
      onAfterClose
    }: {
      visible: boolean
      children: React.ReactNode
      onAfterClose?: () => void
    }) => {
      drawer.onAfterClose = onAfterClose
      return visible ? React.createElement('Drawer', null, children) : null
    }
  }
})

vi.mock('lucide-react-native', () => ({
  Code: () => null,
  Eye: () => null,
  X: () => null
}))

import { MobileFileOpenModeSheet } from './MobileFileOpenModeSheet'

const renderers: ReactTestRenderer[] = []

function mount(overrides: Record<string, unknown> = {}) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(MobileFileOpenModeSheet, {
        visible: true,
        onSelect: () => {},
        onClose: () => {},
        ...overrides
      })
    )
  })
  renderers.push(renderer)
  return renderer
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

afterEach(() => {
  drawer.onAfterClose = undefined
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('MobileFileOpenModeSheet', () => {
  it('lists only the two modes and Cancel', () => {
    const renderer = mount()
    const text = renderer.root
      .findAll((node) => String(node.type) === 'Text')
      .flatMap((node) => node.props.children)
      .join(' ')

    expect(text).toContain('Preview')
    expect(text).toContain('Source')
    expect(text).toContain('Cancel')
    expect(text).toContain('Remember my choice')
    expect(text).not.toContain('Save to phone')
    expect(text).not.toContain('Open with')
    expect(text).not.toContain('Copy content')
  })

  it('reports the chosen mode and whether it should be remembered', () => {
    const onSelect = vi.fn()
    const renderer = mount({ onSelect })

    act(() => pressableWithText(renderer, 'Source')?.props.onPress())
    expect(onSelect).not.toHaveBeenCalled()
    act(() => drawer.onAfterClose?.())
    expect(onSelect).toHaveBeenLastCalledWith('source', false)

    const remember = renderer.root.findAll((node) => String(node.type) === 'Switch')[0]
    act(() => remember?.props.onValueChange(true))
    act(() => pressableWithText(renderer, 'Preview')?.props.onPress())
    act(() => drawer.onAfterClose?.())
    expect(onSelect).toHaveBeenLastCalledWith('preview', true)
  })

  it('runs the choice only after the drawer has closed', () => {
    const onSelect = vi.fn()
    const renderer = mount({ onSelect })

    act(() => pressableWithText(renderer, 'Preview')?.props.onPress())
    expect(onSelect).not.toHaveBeenCalled()

    act(() => drawer.onAfterClose?.())
    expect(onSelect).toHaveBeenCalledWith('preview', false)
  })

  it('disables Preview for a truncated file but leaves Source available', () => {
    const onSelect = vi.fn()
    const renderer = mount({ onSelect, previewDisabled: true })

    const preview = pressableWithText(renderer, 'Preview')
    expect(preview?.props.disabled).toBe(true)
    act(() => preview?.props.onPress())
    expect(onSelect).not.toHaveBeenCalled()

    act(() => pressableWithText(renderer, 'Source')?.props.onPress())
    expect(onSelect).not.toHaveBeenCalled()
    act(() => drawer.onAfterClose?.())
    expect(onSelect).toHaveBeenCalledWith('source', false)
  })
})
