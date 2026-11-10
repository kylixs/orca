import { describe, expect, it } from 'vitest'
import { htmlPreviewNavigationDecision, isAllowedHtmlPreviewScheme } from './html-preview-scheme'

describe('the HTML preview scheme policy', () => {
  it('allows only http, https and mailto out of the preview', () => {
    expect(isAllowedHtmlPreviewScheme('https://example.com/a')).toBe(true)
    expect(isAllowedHtmlPreviewScheme('http://example.com/a')).toBe(true)
    expect(isAllowedHtmlPreviewScheme('mailto:a@example.com')).toBe(true)
    for (const url of [
      'file:///etc/passwd',
      'intent://scan#Intent;scheme=zxing;end',
      'javascript:alert(1)',
      'tel:+15551234',
      'orca://host/route',
      'blob:https://example.com/id'
    ]) {
      expect(isAllowedHtmlPreviewScheme(url), url).toBe(false)
    }
  })

  it('loads the inline document and data URLs in place', () => {
    expect(htmlPreviewNavigationDecision({ url: 'about:blank' })).toBe('allow')
    expect(htmlPreviewNavigationDecision({ url: 'data:text/html,hi' })).toBe('allow')
    expect(htmlPreviewNavigationDecision({ url: 'data:text/html,hi', isTopFrame: false })).toBe(
      'allow'
    )
  })

  it('treats a same-document fragment on about:blank as inline, top or subframe', () => {
    for (const isTopFrame of [true, false, undefined]) {
      expect(
        htmlPreviewNavigationDecision({ url: 'about:blank#section', isTopFrame }),
        String(isTopFrame)
      ).toBe('allow')
    }
    expect(htmlPreviewNavigationDecision({ url: 'ABOUT:BLANK#Section', isTopFrame: true })).toBe(
      'allow'
    )
  })

  it('admits an inline srcdoc subframe, which has no document URL to match', () => {
    expect(htmlPreviewNavigationDecision({ url: 'about:srcdoc', isTopFrame: false })).toBe('allow')
    expect(htmlPreviewNavigationDecision({ url: 'about:srcdoc#x', isTopFrame: false })).toBe(
      'allow'
    )
    // A top frame has no legitimate srcdoc document to navigate to.
    expect(htmlPreviewNavigationDecision({ url: 'about:srcdoc', isTopFrame: true })).toBe('block')
  })

  it('hands allowed top-frame links to the host', () => {
    expect(htmlPreviewNavigationDecision({ url: 'https://example.com', isTopFrame: true })).toBe(
      'external'
    )
    expect(htmlPreviewNavigationDecision({ url: 'mailto:a@example.com', isTopFrame: true })).toBe(
      'external'
    )
  })

  it('rejects every other top-frame scheme', () => {
    for (const url of [
      'file:///etc/passwd',
      'intent://scan#Intent;end',
      'javascript:alert(1)',
      'tel:+15551234',
      'orca://deep/link'
    ]) {
      expect(htmlPreviewNavigationDecision({ url, isTopFrame: true }), url).toBe('block')
    }
  })

  it('keeps top-frame semantics when the frame flag is unreported', () => {
    expect(
      htmlPreviewNavigationDecision({ url: 'https://example.com', isTopFrame: undefined })
    ).toBe('external')
    expect(htmlPreviewNavigationDecision({ url: 'javascript:alert(1)' })).toBe('block')
  })

  it('lets subframes render http(s) without opening anything externally', () => {
    expect(
      htmlPreviewNavigationDecision({ url: 'https://example.com/frame', isTopFrame: false })
    ).toBe('allow')
    expect(
      htmlPreviewNavigationDecision({ url: 'http://example.com/frame', isTopFrame: false })
    ).toBe('allow')
  })

  it('rejects dangerous or external-app schemes in subframes too', () => {
    for (const url of [
      'file:///etc/passwd',
      'intent://scan#Intent;end',
      'javascript:alert(1)',
      'mailto:a@example.com'
    ]) {
      expect(htmlPreviewNavigationDecision({ url, isTopFrame: false }), url).toBe('block')
    }
  })
})
