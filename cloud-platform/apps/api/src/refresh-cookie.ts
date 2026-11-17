/**
 * U197 S1: HttpOnly refresh-token Cookie transport.
 *
 * Inert by default: `auto` without ORCA_CLOUD_PUBLIC_ORIGIN resolves to `never`,
 * so an unconfigured deployment keeps the existing body-token contract.
 */

import { isIP } from 'node:net'

export const REFRESH_COOKIE_NAME = 'orca_refresh'
export const REFRESH_COOKIE_PATH = '/v1/auth'

export type RefreshCookieMode = 'auto' | 'always' | 'never'

export type RefreshCookieParse =
  | { kind: 'absent' }
  | { kind: 'present'; value: string }
  | { kind: 'duplicate' }

export type RefreshCookieConfig = {
  /** Effective mode; `auto` without a configured origin is downgraded to `never`. */
  mode: RefreshCookieMode
  configuredMode: RefreshCookieMode
  /** Normalized platform origin; null unless Cookie mode is active. */
  publicOrigin: string | null
  secure: boolean
  maxAgeSeconds: number
}

const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9_-]*$/

/**
 * RFC 6265: `;`-separated pairs, each split at its first `=`. A browser sends
 * only the most specific Path, so two `orca_refresh` values mean the request is
 * ambiguous (same Path, host-only plus Domain, or two headers); never guess.
 */
export function parseRefreshCookie(header: string | string[] | undefined): RefreshCookieParse {
  if (header === undefined) return { kind: 'absent' }
  const values: string[] = []
  for (const entry of Array.isArray(header) ? header : [header]) {
    for (const segment of entry.split(';')) {
      const part = segment.trim()
      if (part === '') continue
      const equals = part.indexOf('=')
      if (equals === -1) continue
      if (part.slice(0, equals).trim() !== REFRESH_COOKIE_NAME) continue
      values.push(part.slice(equals + 1).trim())
    }
  }
  if (values.length === 0) return { kind: 'absent' }
  if (values.length > 1) return { kind: 'duplicate' }
  const [value] = values
  return { kind: 'present', value: value ?? '' }
}

/**
 * Attributes are fixed by the design: Path=/v1/auth, HttpOnly, SameSite=Lax.
 * Clearing uses the same attributes with `Max-Age=0`, or browsers keep the old.
 */
export function serializeRefreshCookie(input: {
  value: string
  secure: boolean
  maxAgeSeconds: number
}): string {
  if (!COOKIE_VALUE_PATTERN.test(input.value)) {
    throw new Error('refresh cookie value must be base64url or empty')
  }
  if (!Number.isFinite(input.maxAgeSeconds) || input.maxAgeSeconds < 0) {
    throw new Error('refresh cookie Max-Age must be a non-negative number')
  }
  const parts = [
    `${REFRESH_COOKIE_NAME}=${input.value}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    `Max-Age=${Math.floor(input.maxAgeSeconds)}`,
    'HttpOnly',
    'SameSite=Lax'
  ]
  if (input.secure) parts.push('Secure')
  return parts.join('; ')
}

/** IPv4/IPv6 literal, accepting the bracketed form `new URL().hostname` returns. */
function isIpLiteralHostname(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(bare) !== 0
}

/**
 * U218: one clear header is not enough. A cookie can coexist as host-only and
 * `Domain`-scoped on the same Path (browsers send both), and older builds used
 * `Path=/`; deleting all three prevents a permanent duplicate-Cookie lockout.
 */
export function serializeRefreshCookieClear(input: {
  secure: boolean
  /** Platform host for the Domain-scoped deletion; omitted without an origin. */
  domain?: string | null
}): string[] {
  // RFC 6265 requires a host name; an IP literal (IPv6 bracketed) is invalid.
  const domain = input.domain && !isIpLiteralHostname(input.domain) ? input.domain : undefined
  const clear = (path: string, scopedDomain?: string): string => {
    const parts = [`${REFRESH_COOKIE_NAME}=`, `Path=${path}`]
    if (scopedDomain) parts.push(`Domain=${scopedDomain}`)
    parts.push('Max-Age=0', 'HttpOnly', 'SameSite=Lax')
    if (input.secure) parts.push('Secure')
    return parts.join('; ')
  }
  return [
    clear(REFRESH_COOKIE_PATH),
    ...(domain ? [clear(REFRESH_COOKIE_PATH, domain)] : []),
    clear('/')
  ]
}

/** scheme/host lowercase, default port dropped, trailing `/` dropped. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'null') return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  return url.origin
}

/**
 * Same-origin is judged only from the request `Origin` and the configured
 * platform origin — never Host / X-Forwarded-Proto, which page script can forge.
 */
export function sameOrigin(
  origin: string | string[] | undefined,
  publicOrigin: string | null
): boolean {
  if (publicOrigin === null || origin === undefined) return false
  const raw = Array.isArray(origin)
    ? origin.length === 1
      ? origin[0]
      : undefined
    : origin
  if (raw === undefined) return false
  const candidate = raw.trim()
  if (candidate === '' || candidate === 'null' || candidate.includes(',')) return false
  const left = normalizeOrigin(candidate)
  const right = normalizeOrigin(publicOrigin)
  return left !== null && right !== null && left === right
}

const warnedOnce = new Set<string>()

function warnOnce(message: string): void {
  if (warnedOnce.has(message)) return
  warnedOnce.add(message)
  console.warn(`[api] ${message}`)
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

/**
 * `auto` without a valid origin degrades to `never` with one warning; `always`
 * without one refuses startup. Invalid mode values fall back to `auto`.
 */
export function resolveRefreshCookieConfig(input: {
  mode?: string | null
  publicOrigin?: string | null
  refreshTtlMs: number
  warn?: (message: string) => void
}): RefreshCookieConfig {
  const warn = input.warn ?? warnOnce
  const rawMode = (input.mode ?? '').trim().toLowerCase()
  const configuredMode: RefreshCookieMode =
    rawMode === 'always' || rawMode === 'never' ? rawMode : 'auto'
  const maxAgeSeconds = Math.max(0, Math.ceil(input.refreshTtlMs / 1000))
  if (configuredMode === 'never') {
    return { mode: 'never', configuredMode, publicOrigin: null, secure: false, maxAgeSeconds }
  }
  const normalized = normalizeOrigin(input.publicOrigin ?? '')
  if (normalized === null) {
    if (configuredMode === 'always') {
      throw new Error(
        'ORCA_CLOUD_COOKIE_MODE=always requires a valid ORCA_CLOUD_PUBLIC_ORIGIN.'
      )
    }
    warn(
      'ORCA_CLOUD_PUBLIC_ORIGIN is not configured or invalid; ORCA_CLOUD_COOKIE_MODE=auto degraded to never (no refresh cookie is issued).'
    )
    return { mode: 'never', configuredMode, publicOrigin: null, secure: false, maxAgeSeconds }
  }
  let secure = true
  if (configuredMode === 'auto') {
    const origin = new URL(normalized)
    // Secure is unusable on public plain http; keep the cookie and warn instead
    // of silently dropping the whole transport.
    secure = origin.protocol === 'https:' || isLoopbackHostname(origin.hostname)
    if (!secure) {
      warn(
        'ORCA_CLOUD_COOKIE_MODE=auto over non-loopback http omits Secure on the refresh cookie.'
      )
    }
  }
  return { mode: configuredMode, configuredMode, publicOrigin: normalized, secure, maxAgeSeconds }
}
