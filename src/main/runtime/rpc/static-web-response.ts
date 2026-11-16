import { extname } from 'node:path'

/**
 * Static-resource delivery policy (user directive 4). The platform serves the
 * same standard in cloud-platform/apps/api/src/static-delivery.ts — keep both aligned.
 */
export const STATIC_HASHED_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const STATIC_HTML_CACHE_CONTROL = 'no-cache'
export const STATIC_UNHASHED_CACHE_CONTROL = 'max-age=300'
/** Console URLs carry project ids in query/hash; no outbound referrer is needed. */
export const STATIC_REFERRER_POLICY = 'no-referrer'

const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.css', '.html', '.svg', '.json', '.map'])

export function staticCacheControl(pathname: string): string {
  if (pathname.startsWith('/assets/')) {
    return STATIC_HASHED_CACHE_CONTROL
  }
  return extname(pathname).toLowerCase() === '.html'
    ? STATIC_HTML_CACHE_CONTROL
    : STATIC_UNHASHED_CACHE_CONTROL
}

export function isCompressibleStaticPath(path: string): boolean {
  return COMPRESSIBLE_EXTENSIONS.has(extname(path).toLowerCase())
}

/** Weak validator: the bytes are identified by size and modification time. */
export function weakStaticEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`
}

export function ifNoneMatchMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) {
    return false
  }
  const offered = Array.isArray(header) ? header.join(',') : header
  const target = stripWeakPrefix(etag)
  return offered.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === '*' || stripWeakPrefix(value) === target
  })
}

function stripWeakPrefix(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag
}

/** q-values matter: `gzip;q=0` or `*;q=0` must not win. */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  if (!header) {
    return false
  }
  const value = Array.isArray(header) ? header.join(',') : header
  let gzipQ = -1
  let wildcardQ = -1
  for (const part of value.split(',')) {
    const [rawToken, ...params] = part.trim().toLowerCase().split(';')
    const token = rawToken.trim()
    let q = 1
    for (const param of params) {
      const [key, rawValue] = param.trim().split('=')
      if (key === 'q') {
        q = Number(rawValue)
      }
    }
    if (Number.isNaN(q)) {
      continue
    }
    if (token === 'gzip') {
      gzipQ = q
    } else if (token === '*') {
      wildcardQ = q
    }
  }
  return gzipQ >= 0 ? gzipQ > 0 : wildcardQ > 0
}
