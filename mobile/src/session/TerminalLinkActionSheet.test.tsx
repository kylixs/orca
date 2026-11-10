import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

const hosts = vi.hoisted(() => {
  const make = (name: string) => {
    const Host = (props: { children?: ReactNode }): ReactNode => props.children ?? null
    Host.displayName = name
    return Host
  }
  return {
    View: make('View'),
    Text: make('Text'),
    Pressable: make('Pressable'),
    Switch: make('Switch')
  }
})

vi.mock('react-native', () => ({
  View: hosts.View,
  Text: hosts.Text,
  Pressable: hosts.Pressable,
  Switch: hosts.Switch,
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  Check: hosts.View,
  ChevronDown: hosts.View,
  ChevronUp: hosts.View,
  Copy: hosts.View,
  Monitor: hosts.View,
  Smartphone: hosts.View,
  X: hosts.View
}))
vi.mock('../components/BottomDrawer', () => ({
  BottomDrawer: (props: { visible: boolean; children: ReactNode }) =>
    props.visible ? props.children : null
}))

import { TerminalLinkActionSheet } from './TerminalLinkActionSheet'
import type { TerminalLinkRemoteAvailability } from './terminal-link-open-policy'

const available: TerminalLinkRemoteAvailability = {
  available: true,
  hidden: false,
  reason: null,
  hint: null
}

function renderSheet(overrides: Record<string, unknown> = {}) {
  const handlers = {
    onOpenOnPhone: vi.fn(),
    onOpenOnDesktop: vi.fn(),
    onCopy: vi.fn(),
    onCancel: vi.fn()
  }
  const element = (extra: Record<string, unknown> = {}) =>
    createElement(TerminalLinkActionSheet, {
      visible: true,
      url: 'https://example.com/path',
      preselect: null,
      remote: available,
      ...handlers,
      ...overrides,
      ...extra
    })
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(element())
  })
  return { tree: tree!, element, ...handlers }
}

function textOf(node: { props: { children?: unknown } }): string {
  const parts: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value)
    } else if (Array.isArray(value)) {
      value.forEach(walk)
    } else if (value && typeof value === 'object' && 'props' in value) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the walker only reads props from the React elements this test created.
      walk((value as { props: { children?: unknown } }).props.children)
    }
  }
  walk(node.props.children)
  return parts.join(' ')
}

function press(tree: ReactTestRenderer, label: string): void {
  act(() => tree.root.findByProps({ accessibilityLabel: label }).props.onPress())
}

describe('TerminalLinkActionSheet', () => {
  it('offers phone, desktop, copy and cancel actions', () => {
    const sheet = renderSheet()

    press(sheet.tree, 'Open on this phone')
    press(sheet.tree, 'Open in Orca on desktop')
    press(sheet.tree, 'Copy link')
    press(sheet.tree, 'Cancel')

    // Remember is off for every action until its switch is turned on.
    expect(sheet.onOpenOnPhone).toHaveBeenCalledWith(false)
    expect(sheet.onOpenOnDesktop).toHaveBeenCalledWith(false)
    expect(sheet.onCopy).toHaveBeenCalledTimes(1)
    expect(sheet.onCancel).toHaveBeenCalledTimes(1)
  })

  it('passes the Remember switch state to the chosen action', () => {
    const sheet = renderSheet()
    const toggle = sheet.tree.root.findByProps({ accessibilityLabel: 'Remember my choice' })
    act(() => toggle.props.onPress())
    press(sheet.tree, 'Open on this phone')

    expect(sheet.onOpenOnPhone).toHaveBeenCalledWith(true)
    expect(toggle.props.accessibilityState).toEqual({ checked: true })
  })

  it('shows the URL summary, expands to the full URL, and exposes state', () => {
    const sheet = renderSheet({
      url: 'https://user:secret@example.com:8443/deep/path'
    })
    const textBefore = sheet.tree.root
      .findAllByType(hosts.Text)
      .map((node) => textOf(node))
      .join(' ')
    expect(textBefore).toContain('https://example.com:8443')
    expect(textBefore).not.toContain('secret')
    expect(textBefore).not.toContain('/deep/path')
    expect(
      sheet.tree.root.findByProps({ accessibilityLabel: 'Show full URL' }).props.accessibilityState
    ).toEqual({ expanded: false })

    act(() => sheet.tree.root.findByProps({ accessibilityLabel: 'Show full URL' }).props.onPress())
    const textAfter = sheet.tree.root
      .findAllByType(hosts.Text)
      .map((node) => textOf(node))
      .join(' ')
    expect(textAfter).toContain('https://user:secret@example.com:8443/deep/path')
    expect(
      sheet.tree.root.findByProps({ accessibilityLabel: 'Show URL summary' }).props
        .accessibilityState
    ).toEqual({ expanded: true })
  })

  it('warns about plaintext HTTP and loopback addresses', () => {
    const sheet = renderSheet({ url: 'http://127.0.0.1:3000/' })
    const text = sheet.tree.root
      .findAllByType(hosts.Text)
      .map((node) => textOf(node))
      .join(' ')

    expect(text).toContain('unencrypted HTTP')
    expect(text).toContain('SSH session')
  })

  it('disables the desktop action with the host update hint', () => {
    const disabled = {
      available: false,
      hidden: false,
      reason: 'unsupported',
      hint: 'Update Orca on the host to open links here.'
    } as const
    const sheet = renderSheet({ remote: disabled })
    const action = sheet.tree.root.findByProps({ accessibilityLabel: 'Open in Orca on desktop' })

    expect(action.props.accessibilityState).toEqual({ disabled: true, selected: false })
    expect(textOf(action)).toContain('Update Orca on the host to open links here.')
    expect(action.props.onPress).toBeTypeOf('function')
  })

  it('hides the desktop action in folder and floating workspaces', () => {
    const sheet = renderSheet({
      remote: { available: false, hidden: true, reason: 'workspace', hint: null }
    })

    expect(
      sheet.tree.root.findAllByProps({ accessibilityLabel: 'Open in Orca on desktop' })
    ).toHaveLength(0)
  })

  it('hides userinfo in the summary of an unparseable URL', () => {
    const sheet = renderSheet({ url: 'https://user:pass@[bad/path' })
    const readText = (): string =>
      sheet.tree.root
        .findAllByType(hosts.Text)
        .map((node) => textOf(node))
        .join(' ')

    expect(readText()).toContain('https:…')
    expect(readText()).not.toContain('user')
    expect(readText()).not.toContain('pass')

    act(() => sheet.tree.root.findByProps({ accessibilityLabel: 'Show full URL' }).props.onPress())
    expect(readText()).toContain('https://user:pass@[bad/path')
  })

  it('resets expansion and Remember for the next link without a post-paint reset', () => {
    const sheet = renderSheet()
    act(() => sheet.tree.root.findByProps({ accessibilityLabel: 'Show full URL' }).props.onPress())
    act(() =>
      sheet.tree.root.findByProps({ accessibilityLabel: 'Remember my choice' }).props.onPress()
    )
    expect(
      sheet.tree.root.findByProps({ accessibilityLabel: 'Remember my choice' }).props
        .accessibilityState
    ).toEqual({ checked: true })

    act(() => sheet.tree.update(sheet.element({ url: 'https://other.example/' })))

    expect(
      sheet.tree.root.findByProps({ accessibilityLabel: 'Show full URL' }).props.accessibilityState
    ).toEqual({ expanded: false })
    expect(
      sheet.tree.root.findByProps({ accessibilityLabel: 'Remember my choice' }).props
        .accessibilityState
    ).toEqual({ checked: false })
  })

  it('marks the legacy preference as selected without changing the default focus', () => {
    const sheet = renderSheet({ preselect: 'orca-browser' })
    expect(
      sheet.tree.root.findByProps({ accessibilityLabel: 'Open in Orca on desktop' }).props
        .accessibilityState
    ).toEqual({ disabled: false, selected: true })
    expect(
      sheet.tree.root.findByProps({ accessibilityLabel: 'Open on this phone' }).props
        .accessibilityState
    ).toEqual({ disabled: false, selected: false })
  })
})
