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
    ScrollView: host('ScrollView'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text')
  }
})

import { MobileFileFilterChips } from './MobileFileFilterChips'
import { MOBILE_FILE_CATEGORIES } from './file-category'

const renderers: ReactTestRenderer[] = []

/** The `StyleSheet.create` mock returns plain objects, so array styles flatten literally. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.map(flatten))
  }
  return style !== null && typeof style === 'object' ? { ...style } : {}
}

function mount(selected = MOBILE_FILE_CATEGORIES[0]) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(MobileFileFilterChips, { selected, onSelect: () => {} }))
  })
  renderers.push(renderer)
  return renderer
}

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('the file filter chips', () => {
  it('keeps the horizontal row content-sized inside the Files column', () => {
    const renderer = mount()
    const scroll = renderer.root.find((node) => String(node.type) === 'ScrollView')

    expect(scroll.props.horizontal).toBe(true)
    // This is a contract test, not a layout measurement: react-test-renderer has no layout engine,
    // so it pins the cause (RN's horizontal-ScrollView defaults) rather than a rendered height. The
    // real layout evidence is the on-device bounds in device-evidence/fix-02 (40 dp row, 32 dp chip).
    const scrollStyle = flatten(scroll.props.style)
    expect(scrollStyle).toMatchObject({ flexGrow: 0, flexShrink: 0 })
    expect(scrollStyle.flex).toBeUndefined()
    // 32dp chip + 4dp vertical padding on each side: one compact line, not a full-height column.
    const chipProps = renderer.root.findAll((node) => String(node.type) === 'Pressable')
    expect(chipProps).toHaveLength(MOBILE_FILE_CATEGORIES.length)
    for (const chip of chipProps) {
      expect(flatten(chip.props.style)).toMatchObject({ minHeight: 32 })
    }
  })

  it('keeps every chip reachable, selectable and labelled', () => {
    const selected = MOBILE_FILE_CATEGORIES[1]
    const renderer = mount(selected)
    const chips = renderer.root.findAll((node) => String(node.type) === 'Pressable')

    for (const chip of chips) {
      expect(chip.props.accessibilityRole).toBe('button')
      expect(chip.props.hitSlop).toMatchObject({ top: 6, bottom: 6 })
      expect(typeof chip.props.accessibilityLabel).toBe('string')
    }
    const selectedChips = chips.filter((chip) => chip.props.accessibilityState?.selected === true)
    expect(selectedChips).toHaveLength(1)
    expect(selectedChips[0]?.props.accessibilityLabel).toContain('Code')
  })
})
