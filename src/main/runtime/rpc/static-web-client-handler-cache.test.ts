import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { createStaticWebClientHandler } from './static-web-client-handler'

/**
 * U47 / user directive 4: the host's TLS static listener follows the same
 * standard as the platform — immutable hashed assets, short-lived HTML, gzip
 * for text bodies, and ETag revalidation.
 */

type RawReply = { status: number; headers: IncomingHttpHeaders; body: Buffer }

function rawGet(url: string, headers: Record<string, string> = {}): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks)
        })
      )
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

const EVIDENCE_DIR = new URL(
  '../../../../cloud-platform/evidence/u47-static-cache/',
  import.meta.url
).pathname
const observed: Record<string, unknown> = {}

afterAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, 'host-static.json'), JSON.stringify(observed, null, 2))
})

let root: string
let server: Server | null = null
let base = ''

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-static-web-cache-'))
  mkdirSync(join(root, 'assets'))
  mkdirSync(join(root, 'cmaps'))
  writeFileSync(
    join(root, 'web-index.html'),
    '<!doctype html><script src="./assets/app.9f86d081.js"></script>'
  )
  writeFileSync(
    join(root, 'assets', 'app.9f86d081.js'),
    'console.log("cache fixture") // gzip me\n'.repeat(240)
  )
  writeFileSync(join(root, 'cmaps', 'font.bcmap'), Buffer.alloc(64, 7))
  server = createServer(createStaticWebClientHandler(root))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing HTTP address')
  }
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.closeAllConnections()
    server.close(() => resolve())
  })
  server = null
  rmSync(root, { recursive: true, force: true })
})

it('gives hashed assets immutable caching and HTML no-cache', async () => {
  const asset = await rawGet(`${base}/assets/app.9f86d081.js`, {
    'accept-encoding': 'identity'
  })
  expect(asset.status).toBe(200)
  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(asset.headers['referrer-policy']).toBe('no-referrer')
  expect(asset.headers.etag).toBeTruthy()
  expect(asset.headers.vary).toMatch(/accept-encoding/i)

  const index = await rawGet(`${base}/web-index.html`, { 'accept-encoding': 'identity' })
  expect(index.status).toBe(200)
  expect(index.headers['cache-control']).toBe('no-cache')
  expect(index.headers['referrer-policy']).toBe('no-referrer')

  const unhashed = await rawGet(`${base}/cmaps/font.bcmap`, { 'accept-encoding': 'identity' })
  expect(unhashed.status).toBe(200)
  expect(unhashed.headers['cache-control']).toBe('max-age=300')
  expect(unhashed.headers['referrer-policy']).toBe('no-referrer')

  observed.cacheHeaders = {
    hashed: {
      cacheControl: asset.headers['cache-control'],
      etag: asset.headers.etag,
      vary: asset.headers.vary
    },
    html: { cacheControl: index.headers['cache-control'] },
    unhashed: { cacheControl: unhashed.headers['cache-control'] },
    referrerPolicy: asset.headers['referrer-policy']
  }
})

it('gzips text responses when negotiated and leaves identity requests untouched', async () => {
  const identity = await rawGet(`${base}/assets/app.9f86d081.js`, {
    'accept-encoding': 'identity'
  })
  expect(identity.headers['content-encoding']).toBeUndefined()

  const compressed = await rawGet(`${base}/assets/app.9f86d081.js`, {
    'accept-encoding': 'gzip'
  })
  expect(compressed.status).toBe(200)
  expect(compressed.headers['content-encoding']).toBe('gzip')
  expect(compressed.headers.vary).toMatch(/accept-encoding/i)
  expect(gunzipSync(compressed.body).toString('utf8')).toBe(identity.body.toString('utf8'))
  expect(compressed.body.length).toBeLessThan(identity.body.length)

  const plain = await rawGet(`${base}/assets/app.9f86d081.js`)
  expect(plain.headers['content-encoding']).toBeUndefined()
  expect(plain.body.toString('utf8')).toBe(identity.body.toString('utf8'))

  observed.gzip = {
    contentEncoding: compressed.headers['content-encoding'],
    compressedLength: compressed.body.length,
    identityLength: identity.body.length,
    vary: compressed.headers.vary,
    identityContentEncoding: plain.headers['content-encoding'] ?? null
  }
})

it('answers If-None-Match with a 304 and no body', async () => {
  const first = await rawGet(`${base}/assets/app.9f86d081.js`, {
    'accept-encoding': 'identity'
  })
  const etag = String(first.headers.etag)
  const revalidated = await rawGet(`${base}/assets/app.9f86d081.js`, {
    'if-none-match': etag
  })
  expect(revalidated.status).toBe(304)
  expect(revalidated.body).toHaveLength(0)
  expect(revalidated.headers.etag).toBe(etag)
  expect(revalidated.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(revalidated.headers['referrer-policy']).toBe('no-referrer')

  observed.revalidation = {
    status: revalidated.status,
    etag: revalidated.headers.etag,
    cacheControl: revalidated.headers['cache-control'],
    bodyLength: revalidated.body.length
  }
})
