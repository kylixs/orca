import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { extname, isAbsolute, posix, relative, resolve } from 'node:path'
import { createGzip } from 'node:zlib'
import {
  acceptsGzip,
  ifNoneMatchMatches,
  isCompressibleStaticPath,
  staticCacheControl,
  weakStaticEtag
} from './static-web-response'

const STATIC_WEB_ALLOWED_PATHS = new Set(['/web-index.html', '/cloud-admin.html'])
/** Top-level HTML entries a reverse proxy may forward under an added path prefix. */
const STATIC_WEB_ENTRY_HTML = ['web-index.html', 'cloud-admin.html'] as const
const STATIC_WEB_ALLOWED_PREFIXES = ['/assets/', '/cmaps/', '/standard_fonts/', '/wasm/']
const STATIC_WEB_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2']
])

export function createStaticWebClientHandler(staticRoot: string): RequestListener {
  const resolvedRoot = resolve(staticRoot)
  return (request, response) => {
    void handleStaticRequest(resolvedRoot, request, response)
  }
}

async function handleStaticRequest(
  staticRoot: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (response.destroyed) {
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    writeHttpStatus(response, 405)
    return
  }

  const pathname = parseStaticPathname(request.url)
  if (!pathname) {
    writeHttpStatus(response, 400)
    return
  }
  if (!isAllowedStaticWebPath(pathname)) {
    writeHttpStatus(response, 404)
    return
  }

  const absolutePath = resolve(staticRoot, pathname.slice(1))
  const relativePath = relative(staticRoot, absolutePath)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    writeHttpStatus(response, 404)
    return
  }

  let fileStat
  try {
    fileStat = await stat(absolutePath)
  } catch {
    writeHttpStatus(response, 404)
    return
  }
  if (response.destroyed) {
    return
  }
  if (!fileStat.isFile()) {
    writeHttpStatus(response, 404)
    return
  }

  const requestHeaders = request.headers ?? {}
  const etag = weakStaticEtag(fileStat.size, fileStat.mtimeMs)
  const compressible = isCompressibleStaticPath(absolutePath)
  response.statusCode = 200
  response.setHeader(
    'Content-Type',
    STATIC_WEB_CONTENT_TYPES.get(extname(absolutePath)) ?? 'application/octet-stream'
  )
  response.setHeader('Cache-Control', staticCacheControl(pathname))
  response.setHeader('ETag', etag)
  if (compressible) {
    response.setHeader('Vary', 'Accept-Encoding')
  }
  if (ifNoneMatchMatches(requestHeaders['if-none-match'], etag)) {
    response.statusCode = 304
    response.end()
    return
  }
  // HEAD advertises the identity representation; only GET has a body to negotiate.
  const gzip =
    compressible && request.method === 'GET' && acceptsGzip(requestHeaders['accept-encoding'])
  if (gzip) {
    response.setHeader('Content-Encoding', 'gzip')
  } else {
    response.setHeader('Content-Length', fileStat.size)
  }
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const source = createReadStream(absolutePath)
  const compressor = gzip ? createGzip() : null
  const stopReading = (): void => {
    source.destroy()
    compressor?.destroy()
  }
  response.once('close', stopReading)
  response.once('error', stopReading)
  const onError = (): void => {
    source.destroy()
    compressor?.destroy()
    if (response.destroyed) {
      return
    }
    if (!response.headersSent) {
      response.setHeader('Content-Length', 0)
      response.setHeader('Cache-Control', 'no-store')
      writeHttpStatus(response, 500)
      return
    }
    response.destroy()
  }
  source.on('error', onError)
  compressor?.on('error', onError)
  const terminal = compressor ?? source
  terminal.once('close', () => {
    response.off('close', stopReading)
    response.off('error', stopReading)
  })
  if (compressor) {
    source.pipe(compressor).pipe(response)
  } else {
    source.pipe(response)
  }
}

function parseStaticPathname(rawUrl: string | undefined): string | null {
  if (!rawUrl) {
    return '/web-index.html'
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname)
  } catch {
    return null
  }
  if (pathname === '/' || pathname === '/index.html') {
    return '/web-index.html'
  }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
    return null
  }
  if (posix.normalize(pathname) !== pathname) {
    return null
  }
  return mapProxyPrefixedStaticPathname(pathname)
}

function mapProxyPrefixedStaticPathname(pathname: string): string {
  for (const entry of STATIC_WEB_ENTRY_HTML) {
    if (pathname === `/${entry}` || pathname.endsWith(`/${entry}`)) {
      return `/${entry}`
    }
  }
  const prefixIndex = STATIC_WEB_ALLOWED_PREFIXES.reduce(
    (deepest, prefix) => Math.max(deepest, pathname.indexOf(prefix)),
    -1
  )
  if (prefixIndex !== -1) {
    // Why: reverse proxies may forward the external path prefix through to
    // Orca. Only the bundled /assets subtree is served after the prefix.
    return pathname.slice(prefixIndex)
  }
  return pathname
}

function isAllowedStaticWebPath(pathname: string): boolean {
  return (
    STATIC_WEB_ALLOWED_PATHS.has(pathname) ||
    STATIC_WEB_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
}

function writeHttpStatus(response: ServerResponse, statusCode: number): void {
  if (response.destroyed) {
    return
  }
  response.statusCode = statusCode
  response.end()
}
