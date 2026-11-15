import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createApp } from '../../apps/api/src/server.ts'
import { saveEvidence } from './harness.ts'

/**
 * U47 / user directive 4: the platform's static listener must hand out cache
 * headers (immutable hashed assets, short-lived HTML), negotiate gzip for text
 * bodies, and answer ETag revalidation with 304.
 */

const EVIDENCE = 'u47-static-cache'

type RawReply = { status: number; headers: IncomingHttpHeaders; body: Buffer }

/** Raw HTTP so the test, not fetch, decides whether the body is decompressed. */
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

function makeWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-static-cache-web-'))
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><script src="/app.js"></script></body></html>\n'
  )
  writeFileSync(join(root, 'app.js'), 'export const cacheFixture = 42 // gzip me\n'.repeat(240))
  writeFileSync(join(root, 'styles.css'), '.cache-fixture { color: #123456; }\n'.repeat(120))
  return root
}

type ReleaseBody = {
  build: string
  assets: Record<string, { path: string; sha256: string }>
}

test('U47 静态资源：不可变缓存头、HTML 短缓存、gzip 协商与 ETag 304（平台伺服）', async () => {
  const webRoot = makeWebRoot()
  const archiveDir = join(mkdtempSync(join(tmpdir(), 'orca-static-cache-archive-')), 'releases')
  mkdirSync(archiveDir, { recursive: true })
  const app = createApp({ port: 0, webRoot, webReleaseArchiveDir: archiveDir })
  try {
    const port = await app.listen()
    const base = `http://127.0.0.1:${port}`
    const release = (await (await fetch(`${base}/v1/web/release`)).json()) as ReleaseBody
    const appPath = release.assets['app.js']?.path ?? ''
    assert.match(appPath, /^\/assets\/[0-9a-f]{6,32}\/app\.js$/)

    // ① Fingerprinted asset: long-lived immutable cache.
    const hashed = await rawGet(`${base}${appPath}`, { 'accept-encoding': 'identity' })
    assert.equal(hashed.status, 200)
    assert.equal(hashed.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.ok((hashed.headers.etag ?? '').length > 2)
    assert.match(String(hashed.headers.vary), /accept-encoding/i)

    // ② HTML entry revalidates every load; ③ unhashed paths get a short TTL.
    const index = await rawGet(`${base}/`, { 'accept-encoding': 'identity' })
    assert.equal(index.headers['cache-control'], 'no-cache')
    const legacy = await rawGet(`${base}/app.js`, { 'accept-encoding': 'identity' })
    assert.equal(legacy.headers['cache-control'], 'max-age=300')

    // ④ Accept-Encoding: gzip compresses a text body on the wire.
    const compressed = await rawGet(`${base}${appPath}`, { 'accept-encoding': 'gzip' })
    assert.equal(compressed.status, 200)
    assert.equal(compressed.headers['content-encoding'], 'gzip')
    assert.equal(gunzipSync(compressed.body).toString('utf8'), hashed.body.toString('utf8'))
    assert.notEqual(compressed.headers['content-length'], hashed.headers['content-length'])
    assert.ok(Number(compressed.headers['content-length']) < hashed.body.length)

    // ⑤ No Accept-Encoding: the identity representation is unchanged.
    const plain = await rawGet(`${base}${appPath}`)
    assert.equal(plain.status, 200)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.body.toString('utf8'), hashed.body.toString('utf8'))

    // ⑥ ETag round-trip: If-None-Match revalidates to 304.
    const etag = String(hashed.headers.etag)
    const notModified = await rawGet(`${base}${appPath}`, { 'if-none-match': etag })
    assert.equal(notModified.status, 304)
    assert.equal(notModified.body.length, 0)
    assert.equal(notModified.headers['cache-control'], 'public, max-age=31536000, immutable')

    saveEvidence(EVIDENCE, 'platform-static.json', {
      build: release.build,
      hashedAsset: {
        path: appPath,
        cacheControl: hashed.headers['cache-control'],
        etag: hashed.headers.etag,
        vary: hashed.headers.vary
      },
      html: { cacheControl: index.headers['cache-control'] },
      unhashed: { cacheControl: legacy.headers['cache-control'] },
      gzip: {
        contentEncoding: compressed.headers['content-encoding'],
        compressedLength: compressed.headers['content-length'],
        identityLength: hashed.headers['content-length'],
        vary: compressed.headers.vary
      },
      identity: { contentEncoding: plain.headers['content-encoding'] ?? null },
      revalidation: {
        status: notModified.status,
        cacheControl: notModified.headers['cache-control']
      }
    })
  } finally {
    await app.close()
  }
})
