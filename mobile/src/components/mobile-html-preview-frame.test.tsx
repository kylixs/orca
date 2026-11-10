import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const webViewProps = vi.hoisted((): { current: Record<string, unknown> | null } => ({
  current: null
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(name, props, children)
  return {
    Platform: { OS: 'ios' },
    Pressable: host('Pressable'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    View: host('View')
  }
})

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  return {
    WebView: (props: Record<string, unknown>) => {
      webViewProps.current = props
      return React.createElement('WebView', props)
    }
  }
})

vi.mock('lucide-react-native', () => ({
  Code: () => null,
  Eye: () => null
}))

import { MobileHtmlPreviewFrame } from './MobileHtmlPreview'
import { Platform } from 'react-native'
import {
  HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE,
  HTML_PREVIEW_INTERCEPTION_SCRIPT,
  isHtmlPreviewBlockedMessage
} from './html-preview-interception'

const renderers: ReactTestRenderer[] = []

function mount(overrides: Record<string, unknown> = {}) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(
      createElement(MobileHtmlPreviewFrame, {
        html: '<h1>Hi</h1>',
        mode: 'preview',
        onExternalLink: () => {},
        ...overrides
      })
    )
  })
  renderers.push(renderer)
  return renderer
}

function load(url: string, isTopFrame = true): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked WebView receives this exact callback shape from the component under test.
  const shouldStart = webViewProps.current?.onShouldStartLoadWithRequest as
    | ((request: { url: string; isTopFrame?: boolean }) => boolean)
    | undefined
  if (!shouldStart) {
    throw new Error('the WebView did not receive a navigation policy')
  }
  return shouldStart({ url, isTopFrame })
}

afterEach(() => {
  Platform.OS = 'ios'
  webViewProps.current = null
  vi.useRealTimers()
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
})

describe('the native HTML preview frame navigation policy', () => {
  it('hands allowed top-frame URLs to the host and keeps the WebView in place', () => {
    const onExternalLink = vi.fn()
    mount({ onExternalLink })

    expect(load('https://example.com/a', true)).toBe(false)
    expect(load('mailto:a@example.com', true)).toBe(false)
    expect(onExternalLink.mock.calls).toEqual([['https://example.com/a'], ['mailto:a@example.com']])
  })

  it('loads inline documents in place', () => {
    mount()
    expect(load('about:blank')).toBe(true)
    expect(load('data:text/html,hi')).toBe(true)
  })

  it('does not toast for in-page anchors or inline srcdoc frames', () => {
    const blocked = vi.fn()
    const renderer = mount({ onBlockedScheme: blocked })

    expect(load('about:blank#section', true)).toBe(true)
    expect(load('about:blank#section', false)).toBe(true)
    expect(load('about:srcdoc', false)).toBe(true)

    expect(blocked).not.toHaveBeenCalled()
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => node.props.children === "This link type isn't supported in preview")
    ).toBe(false)
  })

  it('refuses dangerous top-frame schemes and shows the in-frame toast', () => {
    const onExternalLink = vi.fn()
    const onBlockedScheme = vi.fn()
    const renderer = mount({ onExternalLink, onBlockedScheme })

    for (const url of [
      'file:///etc/passwd',
      'intent://scan#Intent;end',
      'javascript:alert(1)',
      'orca://deep/link'
    ]) {
      act(() => {
        expect(load(url, true), url).toBe(false)
      })
    }

    expect(onExternalLink).not.toHaveBeenCalled()
    expect(onBlockedScheme).toHaveBeenCalledTimes(4)
    expect(
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => node.props.children === "This link type isn't supported in preview")
    ).toBe(true)
  })

  it('allows http(s) subframes without opening anything externally', () => {
    const onExternalLink = vi.fn()
    const onBlockedScheme = vi.fn()
    mount({ onExternalLink, onBlockedScheme })

    expect(load('https://example.com/frame', false)).toBe(true)
    expect(load('http://example.com/frame', false)).toBe(true)
    expect(load('javascript:alert(1)', false)).toBe(false)
    expect(load('file:///etc/passwd', false)).toBe(false)
    expect(onExternalLink).not.toHaveBeenCalled()
    expect(onBlockedScheme).toHaveBeenCalledTimes(2)
  })

  it('injects the DOM scheme fence before content and accepts only its sentinel', () => {
    mount()
    // Why these two and not the navigation callback alone: Android executes javascript: taps
    // without calling that callback, so this is the property the fix actually depends on.
    expect(webViewProps.current?.injectedJavaScriptBeforeContentLoaded).toBe(
      HTML_PREVIEW_INTERCEPTION_SCRIPT
    )
    expect(webViewProps.current?.injectedJavaScript).toBe(HTML_PREVIEW_INTERCEPTION_SCRIPT)
    // Frames run the fence as well: an iframe's javascript: link is script too, and the native
    // message patch drops the subframe's sentinel so it cannot raise a host toast.
    expect(webViewProps.current?.injectedJavaScriptForMainFrameOnly).toBe(false)
    expect(webViewProps.current?.injectedJavaScriptBeforeContentLoadedForMainFrameOnly).toBe(false)
    expect(typeof webViewProps.current?.onMessage).toBe('function')
    // No object bridge: page script can only forge the fixed sentinel, which raises the toast.
    expect(webViewProps.current?.injectedJavaScriptObject).toBeUndefined()
  })

  it('shows the toast for the fixed sentinel and ignores every other message', () => {
    const renderer = mount()
    const onMessage = webViewProps.current?.onMessage
    if (typeof onMessage !== 'function') {
      throw new Error('the WebView did not receive a message handler')
    }
    const toastShown = () =>
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => node.props.children === "This link type isn't supported in preview")

    act(() => {
      onMessage({ nativeEvent: { data: 'https://example.com' } })
    })
    expect(toastShown()).toBe(false)

    act(() => {
      onMessage({ nativeEvent: { data: JSON.stringify({ url: 'file:///etc/passwd' }) } })
    })
    expect(toastShown()).toBe(false)

    act(() => {
      onMessage({ nativeEvent: { data: HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE } })
    })
    expect(toastShown()).toBe(true)
  })

  it('ignores sentinels while the toast is visible instead of restarting its timer', () => {
    vi.useFakeTimers()
    const renderer = mount()
    const onMessage = webViewProps.current?.onMessage
    if (typeof onMessage !== 'function') {
      throw new Error('the WebView did not receive a message handler')
    }
    const toastShown = () =>
      renderer.root
        .findAll((node) => String(node.type) === 'Text')
        .some((node) => node.props.children === "This link type isn't supported in preview")

    act(() => {
      onMessage({ nativeEvent: { data: HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE } })
    })
    expect(toastShown()).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2000)
      onMessage({ nativeEvent: { data: HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE } })
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(toastShown()).toBe(false)
  })

  it('accepts exactly one sentinel value', () => {
    expect(isHtmlPreviewBlockedMessage(HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE)).toBe(true)
    for (const payload of [
      `${HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE} `,
      `${HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE}\n`,
      HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE.toUpperCase(),
      '',
      null,
      undefined,
      1,
      { type: HTML_PREVIEW_BLOCKED_SCHEME_MESSAGE }
    ]) {
      expect(isHtmlPreviewBlockedMessage(payload), String(payload)).toBe(false)
    }
  })

  it('enables text selection only on iOS and leaves Android on its default', () => {
    mount()
    expect(webViewProps.current?.textInteractionEnabled).toBe(true)

    Platform.OS = 'android'
    mount()
    expect(webViewProps.current?.textInteractionEnabled).toBeUndefined()
  })
})
