import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve('config/scripts/verify-web-build.mjs')
const temporaryRoots = []
const ROUTE_PREFIX = '/h/route-key'

function createBuildFixture({ absoluteAssets = false, sharedImportsEntry = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-web-build-'))
  temporaryRoots.push(root)
  const assetBase = absoluteAssets ? '/assets/' : './assets/'
  const html = `<script type="module" src="${assetBase}app.js"></script><link rel="stylesheet" href="${assetBase}app.css">`
  for (const entry of ['web-index.html', 'cloud-admin.html']) {
    writeFixtureFile(
      root,
      `out/web/${entry}`,
      `<!doctype html><html><head></head><body>${html}</body></html>`
    )
  }
  writeFixtureFile(root, 'out/web/assets/app.js', 'export const app = true;')
  writeFixtureFile(root, 'out/web/assets/app.css', '.app { color: red; }')
  if (sharedImportsEntry) {
    writeFixtureFile(
      root,
      'out/web/assets/shared.js',
      'import "./app.js"; export const shared = true;'
    )
  }
  return root
}

function writeFixtureFile(root, relativePath, contents) {
  const targetPath = join(root, relativePath)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, contents)
}

function verifyFixture(root) {
  return runProcess({
    program: process.execPath,
    args: [scriptPath],
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30000
  })
}

/** Serves the build root directly and under a relay-style `/h/<routeKey>/` mount. */
function startStaticServer(staticRoot) {
  const files = new Map([
    ['/web-index.html', 'text/html'],
    ['/cloud-admin.html', 'text/html'],
    ['/assets/app.js', 'text/javascript'],
    ['/assets/app.css', 'text/css']
  ])
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname.startsWith(`${ROUTE_PREFIX}/`)
      ? url.pathname.slice(ROUTE_PREFIX.length)
      : url.pathname
    const contentType = files.get(pathname)
    if (!contentType) {
      response.writeHead(404, { connection: 'close' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': contentType })
    response.end(readFileSync(join(staticRoot, pathname.slice(1))))
  })
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

async function fetchAssets(pageUrl) {
  const html = await (await fetch(pageUrl)).text()
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  expect(references.length).toBeGreaterThan(0)
  return references.map((reference) => new URL(reference, pageUrl).toString())
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('web build base', () => {
  it('accepts the relative base Vite emits for both entries', async () => {
    const result = await verifyFixture(createBuildFixture())
    expect(result.code, result.stderr).toBe(0)
  })

  it('rejects an absolute /assets reference', async () => {
    const result = await verifyFixture(createBuildFixture({ absoluteAssets: true }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Web build must use relative asset URLs')
  })

  it('rejects a shared chunk that statically imports an entry chunk', async () => {
    const result = await verifyFixture(createBuildFixture({ sharedImportsEntry: true }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is statically imported by shared.js')
  })
})

describe('prefixed page loading', () => {
  it('serves the build output under /h/<routeKey>/ and directly with zero 404s', async () => {
    const root = createBuildFixture()
    const server = await startStaticServer(join(root, 'out/web'))
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      for (const pageUrl of [
        `${origin}${ROUTE_PREFIX}/web-index.html`,
        `${origin}/web-index.html`
      ]) {
        const assetUrls = await fetchAssets(pageUrl)
        expect(assetUrls.every((url) => url.includes(`${ROUTE_PREFIX}/assets/`))).toBe(
          pageUrl.includes(ROUTE_PREFIX)
        )
        for (const assetUrl of assetUrls) {
          const response = await fetch(assetUrl)
          expect(response.status, assetUrl).toBe(200)
        }
      }
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  })
})
