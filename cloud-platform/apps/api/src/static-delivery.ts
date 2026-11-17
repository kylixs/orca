import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { gzipSync } from 'node:zlib'

/**
 * Static-resource delivery policy (user directive 4). The host serves the same
 * standard in src/main/runtime/rpc/static-web-response.ts — keep both aligned.
 */
export const STATIC_HASHED_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const STATIC_HTML_CACHE_CONTROL = 'no-cache'
export const STATIC_UNHASHED_CACHE_CONTROL = 'max-age=300'
/** Console URLs carry project ids in query/hash; no outbound referrer is needed. */
export const STATIC_REFERRER_POLICY = 'no-referrer'
/** Hits and misses share these: a static 404 is still a static response. */
export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'referrer-policy': STATIC_REFERRER_POLICY
}

const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.css', '.html', '.svg', '.json', '.map'])
const GZIP_CACHE_LIMIT = 128
const gzipCache = new Map<string, Buffer>()

export type StaticAssetResponse = {
  name: string
  contentType: string
  cacheControl: string
  etag: string
  body: Buffer
}

export function isCompressibleStaticName(name: string): boolean {
  return COMPRESSIBLE_EXTENSIONS.has(extname(name).toLowerCase())
}

/** HTML revalidates every load; anything unhashed gets a short TTL. */
export function cacheControlForStaticName(name: string): string {
  return extname(name).toLowerCase() === '.html'
    ? STATIC_HTML_CACHE_CONTROL
    : STATIC_UNHASHED_CACHE_CONTROL
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

function gzipCached(etag: string, body: Buffer): Buffer {
  const cached = gzipCache.get(etag)
  if (cached) {
    return cached
  }
  const compressed = gzipSync(body)
  if (gzipCache.size >= GZIP_CACHE_LIMIT) {
    gzipCache.clear()
  }
  gzipCache.set(etag, compressed)
  return compressed
}

/** Adds to the existing Vary (a CORS Origin may already be present) instead of replacing it. */
function appendVary(res: ServerResponse, value: string): void {
  const existing = res.getHeader('vary')
  const current = Array.isArray(existing) ? existing.join(', ') : existing ? String(existing) : ''
  if (
    current
      .toLowerCase()
      .split(',')
      .some((entry) => entry.trim() === value.toLowerCase())
  ) {
    return
  }
  res.setHeader('vary', current ? `${current}, ${value}` : value)
}

export function sendStaticAsset(
  req: IncomingMessage,
  res: ServerResponse,
  asset: StaticAssetResponse
): void {
  const compressible = isCompressibleStaticName(asset.name)
  const headers: Record<string, string | number> = {
    ...STATIC_SECURITY_HEADERS,
    'content-type': asset.contentType,
    'cache-control': asset.cacheControl,
    etag: asset.etag
  }
  if (compressible) {
    appendVary(res, 'Accept-Encoding')
  }
  if (ifNoneMatchMatches(req.headers['if-none-match'], asset.etag)) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  if (compressible && acceptsGzip(req.headers['accept-encoding'])) {
    const compressed = gzipCached(asset.etag, asset.body)
    headers['content-encoding'] = 'gzip'
    headers['content-length'] = compressed.length
    res.writeHead(200, headers)
    res.end(compressed)
    return
  }
  headers['content-length'] = asset.body.length
  res.writeHead(200, headers)
  res.end(asset.body)
}

/** Unknown web path: same security headers as a hit, and no cacheable body. */
export function sendStaticNotFound(res: ServerResponse): void {
  res.writeHead(404, {
    ...STATIC_SECURITY_HEADERS,
    'content-type': 'text/plain; charset=utf-8'
  })
  res.end('not found')
}
