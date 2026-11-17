import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeOrigin,
  parseRefreshCookie,
  resolveRefreshCookieConfig,
  sameOrigin,
  serializeRefreshCookie
} from '../apps/api/src/refresh-cookie.ts'

describe('U197 S1 refresh cookie parsing', () => {
  test('absent when the header is missing, empty, or carries other names', () => {
    assert.deepEqual(parseRefreshCookie(undefined), { kind: 'absent' })
    assert.deepEqual(parseRefreshCookie(''), { kind: 'absent' })
    assert.deepEqual(parseRefreshCookie('  ;  '), { kind: 'absent' })
    assert.deepEqual(parseRefreshCookie('orca_access=a; other=b'), { kind: 'absent' })
  })

  test('a single orca_refresh keeps its exact value', () => {
    assert.deepEqual(parseRefreshCookie('orca_refresh=abcDEF_-123'), {
      kind: 'present',
      value: 'abcDEF_-123'
    })
    assert.deepEqual(parseRefreshCookie('a=b; orca_refresh=token; c=d'), {
      kind: 'present',
      value: 'token'
    })
  })

  test('splits at the first equals only and trims surrounding spaces', () => {
    assert.deepEqual(parseRefreshCookie('orca_refresh= a=b '), {
      kind: 'present',
      value: 'a=b'
    })
  })

  test('an empty value is present-but-empty, not a duplicate', () => {
    assert.deepEqual(parseRefreshCookie('orca_refresh='), { kind: 'present', value: '' })
  })

  test('two same-name cookies are ambiguous', () => {
    assert.deepEqual(parseRefreshCookie('orca_refresh=a; orca_refresh=b'), { kind: 'duplicate' })
    assert.deepEqual(parseRefreshCookie('orca_refresh=a; orca_refresh=a'), { kind: 'duplicate' })
  })

  test('two Cookie header fields are ambiguous too', () => {
    assert.deepEqual(parseRefreshCookie(['orca_refresh=a', 'orca_refresh=b']), {
      kind: 'duplicate'
    })
    assert.deepEqual(parseRefreshCookie(['other=1; orca_refresh=a']), {
      kind: 'present',
      value: 'a'
    })
  })
})

describe('U197 S1 refresh cookie serialization', () => {
  test('fixed attributes plus conditional Secure', () => {
    const serialized = serializeRefreshCookie({
      value: 'tok_1',
      secure: true,
      maxAgeSeconds: 43200
    })
    assert.equal(
      serialized,
      'orca_refresh=tok_1; Path=/v1/auth; Max-Age=43200; HttpOnly; SameSite=Lax; Secure'
    )
    assert.equal(
      serializeRefreshCookie({ value: 'tok_1', secure: false, maxAgeSeconds: 43200 }),
      'orca_refresh=tok_1; Path=/v1/auth; Max-Age=43200; HttpOnly; SameSite=Lax'
    )
  })

  test('Max-Age floors fractional seconds and clearing is Max-Age=0 with the same attributes', () => {
    assert.match(
      serializeRefreshCookie({ value: 'tok', secure: false, maxAgeSeconds: 12.9 }),
      /Max-Age=12(;|$)/
    )
    assert.equal(
      serializeRefreshCookie({ value: '', secure: true, maxAgeSeconds: 0 }),
      'orca_refresh=; Path=/v1/auth; Max-Age=0; HttpOnly; SameSite=Lax; Secure'
    )
  })

  test('rejects values that could split the header', () => {
    for (const value of ['a;b', 'a b', 'a\r\nSet-Cookie: x', 'a,b']) {
      assert.throws(() => serializeRefreshCookie({ value, secure: false, maxAgeSeconds: 1 }))
    }
  })
})

describe('U197 S1 origin normalization', () => {
  test('lowercases, drops the default port and the trailing slash', () => {
    assert.equal(normalizeOrigin('HTTPS://Console.Example.COM:443/'), 'https://console.example.com')
    assert.equal(normalizeOrigin('http://Console.Example.COM:80'), 'http://console.example.com')
    assert.equal(normalizeOrigin('https://console.example.com:8443'), 'https://console.example.com:8443')
  })

  test('rejects non-http, credentials, paths, queries and the literal null', () => {
    assert.equal(normalizeOrigin(''), null)
    assert.equal(normalizeOrigin('null'), null)
    assert.equal(normalizeOrigin('ftp://console.example.com'), null)
    assert.equal(normalizeOrigin('https://user:pass@console.example.com'), null)
    assert.equal(normalizeOrigin('https://console.example.com/v1'), null)
    assert.equal(normalizeOrigin('https://console.example.com/?a=1'), null)
  })

  test('sameOrigin compares normalized values exactly', () => {
    const configured = 'https://console.example.com'
    assert.equal(sameOrigin('HTTPS://CONSOLE.EXAMPLE.COM:443/', configured), true)
    assert.equal(sameOrigin('https://console.example.com:8443', configured), false)
    assert.equal(sameOrigin('https://evil.example', configured), false)
    assert.equal(sameOrigin(undefined, configured), false)
    assert.equal(sameOrigin('null', configured), false)
    assert.equal(sameOrigin('', configured), false)
    assert.equal(sameOrigin('https://console.example.com', null), false)
    assert.equal(sameOrigin(['https://console.example.com'], configured), true)
    assert.equal(
      sameOrigin(['https://console.example.com', 'https://evil.example'], configured),
      false
    )
  })
})

describe('U197 S1 mode resolution', () => {
  test('auto without an origin degrades to never with one warning', () => {
    const warnings: string[] = []
    const config = resolveRefreshCookieConfig({
      mode: 'auto',
      refreshTtlMs: 43_200_000,
      warn: (message) => warnings.push(message)
    })
    assert.equal(config.mode, 'never')
    assert.equal(config.configuredMode, 'auto')
    assert.equal(config.publicOrigin, null)
    assert.equal(config.maxAgeSeconds, 43_200)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /ORCA_CLOUD_PUBLIC_ORIGIN/)
  })

  test('the default mode is auto, so an unconfigured app is inert', () => {
    const warnings: string[] = []
    const config = resolveRefreshCookieConfig({
      refreshTtlMs: 60_000,
      warn: (message) => warnings.push(message)
    })
    assert.equal(config.mode, 'never')
    assert.equal(warnings.length, 1)
  })

  test('always without an origin refuses startup', () => {
    assert.throws(
      () => resolveRefreshCookieConfig({ mode: 'always', refreshTtlMs: 60_000 }),
      /requires a valid ORCA_CLOUD_PUBLIC_ORIGIN/
    )
  })

  test('never stays inert even with an origin', () => {
    const warnings: string[] = []
    const config = resolveRefreshCookieConfig({
      mode: 'never',
      publicOrigin: 'https://console.example.com',
      refreshTtlMs: 60_000,
      warn: (message) => warnings.push(message)
    })
    assert.equal(config.mode, 'never')
    assert.equal(config.publicOrigin, null)
    assert.equal(config.secure, false)
    assert.deepEqual(warnings, [])
  })

  test('an invalid mode falls back to auto', () => {
    const config = resolveRefreshCookieConfig({
      mode: 'someday',
      publicOrigin: 'https://console.example.com',
      refreshTtlMs: 60_000
    })
    assert.equal(config.configuredMode, 'auto')
    assert.equal(config.mode, 'auto')
  })

  test('auto marks https and loopback http as Secure', () => {
    const https = resolveRefreshCookieConfig({
      mode: 'auto',
      publicOrigin: 'https://console.example.com',
      refreshTtlMs: 60_000
    })
    assert.equal(https.secure, true)
    const loopback = resolveRefreshCookieConfig({
      mode: 'auto',
      publicOrigin: 'http://127.0.0.1:18787',
      refreshTtlMs: 60_000
    })
    assert.equal(loopback.secure, true)
    const localhost = resolveRefreshCookieConfig({
      mode: 'auto',
      publicOrigin: 'http://localhost:18787',
      refreshTtlMs: 60_000
    })
    assert.equal(localhost.secure, true)
  })

  test('auto over non-loopback http keeps the cookie without Secure and warns', () => {
    const warnings: string[] = []
    const config = resolveRefreshCookieConfig({
      mode: 'auto',
      publicOrigin: 'http://console.example.com',
      refreshTtlMs: 60_000,
      warn: (message) => warnings.push(message)
    })
    assert.equal(config.mode, 'auto')
    assert.equal(config.secure, false)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /omits Secure/)
  })

  test('always forces Secure and normalizes the origin', () => {
    const config = resolveRefreshCookieConfig({
      mode: 'always',
      publicOrigin: 'HTTP://Console.Example.COM:80/',
      refreshTtlMs: 60_000
    })
    assert.equal(config.mode, 'always')
    assert.equal(config.publicOrigin, 'http://console.example.com')
    assert.equal(config.secure, true)
  })
})
