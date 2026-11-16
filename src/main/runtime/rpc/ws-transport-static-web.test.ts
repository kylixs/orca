import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketTransport } from './ws-transport'

describe('WebSocketTransport static web client', () => {
  const transports: WebSocketTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.map((t) => t.stop().catch(() => {})))
    transports.length = 0
  })

  function createStaticTransport(staticRoot: string): WebSocketTransport {
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: 0,
      staticRoot
    })
    transports.push(transport)
    return transport
  }

  it('serves the built web client from the same server', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'web-index.html'), '<html>web</html>')
    writeFileSync(join(staticRoot, 'assets', 'app.js'), 'console.log("web")')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const indexResponse = await fetch(`http://127.0.0.1:${transport.resolvedPort}/web-index.html`)
    expect(indexResponse.status).toBe(200)
    expect(indexResponse.headers.get('content-type')).toContain('text/html')
    await expect(indexResponse.text()).resolves.toBe('<html>web</html>')

    const assetResponse = await fetch(`http://127.0.0.1:${transport.resolvedPort}/assets/app.js`)
    expect(assetResponse.status).toBe(200)
    expect(assetResponse.headers.get('cache-control')).toContain('immutable')
    await expect(assetResponse.text()).resolves.toBe('console.log("web")')
  })

  it('serves web assets when a reverse-proxy path prefix is forwarded', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'web-index.html'), '<script src="./assets/app.js"></script>')
    writeFileSync(join(staticRoot, 'assets', 'app.js'), 'console.log("prefixed")')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const indexResponse = await fetch(
      `http://127.0.0.1:${transport.resolvedPort}/orca/web-index.html`
    )
    expect(indexResponse.status).toBe(200)
    await expect(indexResponse.text()).resolves.toBe('<script src="./assets/app.js"></script>')

    const assetResponse = await fetch(
      `http://127.0.0.1:${transport.resolvedPort}/orca/assets/app.js`
    )
    expect(assetResponse.status).toBe(200)
    await expect(assetResponse.text()).resolves.toBe('console.log("prefixed")')
  })

  it('serves the admin session entry without widening the other path rules', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'web-index.html'), '<html>web</html>')
    writeFileSync(join(staticRoot, 'cloud-admin.html'), '<html>admin</html>')
    writeFileSync(join(staticRoot, 'package.json'), '{}')
    const transport = createStaticTransport(staticRoot)

    await transport.start()
    const base = `http://127.0.0.1:${transport.resolvedPort}`

    const admin = await fetch(`${base}/cloud-admin.html`)
    expect(admin.status).toBe(200)
    expect(admin.headers.get('content-type')).toContain('text/html')
    expect(admin.headers.get('referrer-policy')).toBe('no-referrer')
    await expect(admin.text()).resolves.toBe('<html>admin</html>')

    // Same mapping the web client gets when a reverse proxy forwards a prefix.
    const prefixed = await fetch(`${base}/orca/cloud-admin.html`)
    expect(prefixed.status).toBe(200)
    await expect(prefixed.text()).resolves.toBe('<html>admin</html>')

    const web = await fetch(`${base}/web-index.html`)
    expect(web.status).toBe(200)
    await expect(web.text()).resolves.toBe('<html>web</html>')

    const unknown = await fetch(`${base}/admin.html`)
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('referrer-policy')).toBe('no-referrer')

    const traversal = await fetch(`${base}/assets/%2e%2e%2fpackage.json`)
    expect(traversal.status).toBe(400)
    expect(traversal.headers.get('referrer-policy')).toBe('no-referrer')

    const traversalBackslash = await fetch(`${base}/cloud-admin.html%5C..%5Cpackage.json`)
    expect(traversalBackslash.status).toBe(400)
  })

  it('does not expose arbitrary files from the static root', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    writeFileSync(join(staticRoot, 'package.json'), '{}')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const response = await fetch(`http://127.0.0.1:${transport.resolvedPort}/package.json`)
    expect(response.status).toBe(404)
  })

  it('rejects encoded Windows separators in static paths', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'ws-transport-static-'))
    mkdirSync(join(staticRoot, 'assets'))
    writeFileSync(join(staticRoot, 'package.json'), '{}')
    const transport = createStaticTransport(staticRoot)

    await transport.start()

    const response = await fetch(
      `http://127.0.0.1:${transport.resolvedPort}/assets/..%5Cpackage.json`
    )
    expect(response.status).toBe(400)
  })
})
