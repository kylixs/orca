import { describe, expect, it } from 'vitest'
import { isMobileHtmlOpenMode, resolveMobileHtmlPreviewMode } from './mobile-html-open-mode'

const base = {
  source: 'worktree' as const,
  hasLineTarget: false,
  truncated: false,
  readFailed: false,
  preference: 'ask' as const
}

describe('resolveMobileHtmlPreviewMode', () => {
  it('asks when nothing else decides', () => {
    expect(resolveMobileHtmlPreviewMode(base)).toBe('ask')
  })

  it('honours a stored preview or source choice', () => {
    expect(resolveMobileHtmlPreviewMode({ ...base, preference: 'preview' })).toBe('preview')
    expect(resolveMobileHtmlPreviewMode({ ...base, preference: 'source' })).toBe('source')
  })

  it('uses a line target before the stored preference', () => {
    expect(
      resolveMobileHtmlPreviewMode({ ...base, hasLineTarget: true, preference: 'preview' })
    ).toBe('source')
  })

  it('lets an explicit route mode beat a line target', () => {
    expect(
      resolveMobileHtmlPreviewMode({ ...base, routeMode: 'preview', hasLineTarget: true })
    ).toBe('preview')
    expect(resolveMobileHtmlPreviewMode({ ...base, routeMode: 'source' })).toBe('source')
  })

  it('forces source when the content was truncated, even with a route mode', () => {
    expect(
      resolveMobileHtmlPreviewMode({
        ...base,
        routeMode: 'preview',
        preference: 'preview',
        truncated: true
      })
    ).toBe('source')
  })

  it('forces source when the read failed, even with a route mode', () => {
    expect(
      resolveMobileHtmlPreviewMode({
        ...base,
        routeMode: 'preview',
        preference: 'preview',
        readFailed: true
      })
    ).toBe('source')
  })

  it('keeps terminal artifacts source-only ahead of every route choice', () => {
    expect(
      resolveMobileHtmlPreviewMode({
        ...base,
        source: 'terminalArtifact',
        routeMode: 'preview',
        preference: 'preview'
      })
    ).toBe('source')
  })

  it('accepts only the three stored values', () => {
    expect(isMobileHtmlOpenMode('ask')).toBe(true)
    expect(isMobileHtmlOpenMode('preview')).toBe(true)
    expect(isMobileHtmlOpenMode('source')).toBe(true)
    expect(isMobileHtmlOpenMode('render')).toBe(false)
    expect(isMobileHtmlOpenMode(null)).toBe(false)
  })
})
