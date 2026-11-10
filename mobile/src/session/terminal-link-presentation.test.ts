import { describe, expect, it } from 'vitest'
import {
  isLoopbackOrPrivateHost,
  presentTerminalLink,
  sanitizeTerminalLinkText,
  terminalLinkWarnings
} from './terminal-link-presentation'

describe('terminal link presentation', () => {
  it('summarises scheme, host and port without userinfo or path', () => {
    const link = presentTerminalLink('https://alice:secret@example.com:8443/private/path?q=1')

    expect(link.summary).toBe('https://example.com:8443')
    expect(link.full).toBe('https://alice:secret@example.com:8443/private/path?q=1')
  })

  it('keeps userinfo in the expanded form but removes bidi and control characters', () => {
    const override = String.fromCharCode(0x202e)
    const mark = String.fromCharCode(0x200e)
    const isolate = String.fromCharCode(0x2066)
    const nul = String.fromCharCode(0)
    const link = presentTerminalLink(
      `https://user:pass@example.com/${override}gnp.exe${nul}${isolate}tail`
    )

    expect(link.summary).toBe('https://example.com')
    expect(link.full).toBe('https://user:pass@example.com/gnp.exetail')
    expect(sanitizeTerminalLinkText(`a${mark}b${override}c${nul}d`)).toBe('abcd')
  })

  it('flags unencrypted HTTP', () => {
    const link = presentTerminalLink('http://example.com/a')

    expect(link.http).toBe(true)
    expect(terminalLinkWarnings(link)).toContain('This link uses unencrypted HTTP.')
  })

  it('detects loopback and private addresses with a phone/SSH hint', () => {
    const link = presentTerminalLink('http://127.0.0.1:3000/')

    expect(link.loopbackOrPrivate).toBe(true)
    expect(terminalLinkWarnings(link).join(' ')).toContain('SSH session')
    for (const host of [
      'localhost',
      'app.local',
      '10.1.2.3',
      '192.168.1.4',
      '172.16.0.1',
      '172.31.255.255',
      '::1',
      'fd00::1',
      'fe80::2'
    ]) {
      expect(isLoopbackOrPrivateHost(host), host).toBe(true)
    }
    for (const host of ['example.com', '172.32.0.1', '8.8.8.8', '203.0.113.9']) {
      expect(isLoopbackOrPrivateHost(host), host).toBe(false)
    }
  })

  it('uses a generic summary for an unparseable URL without a scheme', () => {
    const link = presentTerminalLink('not a url')

    expect(link.summary).toBe('Unparseable URL')
    expect(link.full).toBe('not a url')
  })

  it('never puts userinfo in the summary of an unparseable URL', () => {
    const link = presentTerminalLink('https://user:pass@[bad/path')

    expect(link.summary).toBe('https:…')
    expect(link.summary).not.toContain('user')
    expect(link.summary).not.toContain('pass')
    expect(link.summary).not.toContain('bad')
    // The user asked for the full URL, so the expanded view is where it lives.
    expect(link.full).toBe('https://user:pass@[bad/path')
  })

  it('removes zero-width format characters from both views', () => {
    const formatCharacters = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((code) =>
      String.fromCharCode(code)
    )
    const hidden = formatCharacters.map((character, index) => `a${character}${index}`).join('')

    expect(sanitizeTerminalLinkText(hidden)).toBe('a0a1a2a3a4')
    const link = presentTerminalLink(`https://example.com/${formatCharacters.join('')}path`)
    expect(link.full).toBe('https://example.com/path')
  })
})
