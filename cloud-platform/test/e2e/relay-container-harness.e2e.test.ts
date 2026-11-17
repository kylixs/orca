import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  startContainerHarness,
  type ContainerHarness
} from './helpers/relay-container-harness.ts'

/**
 * U183 R13a self-test: prove the harness degrades to a skip when Docker or the
 * local image is missing, and — when available — that a clean container can run
 * bash and reach a host platform through the forwarder URL. No product logic.
 */

let harness: ContainerHarness | undefined
let stub: Server | undefined

before(async () => {
  stub = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"status":"ok"}')
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', () => resolve()))
  const port = (stub.address() as AddressInfo).port
  harness = await startContainerHarness({ platformPort: port })
})

after(async () => {
  await harness?.stop()
  if (stub) {
    await new Promise<void>((resolve) => stub!.close(() => resolve()))
  }
})

function requireHarness(): ContainerHarness {
  assert.ok(harness, 'harness was not created')
  return harness
}

test('missing Docker or image degrades to skipReason', () => {
  const gate = requireHarness()
  if (gate.available) {
    assert.equal(gate.skipReason, undefined)
    assert.match(gate.getContainerPlatformUrl(), /^http:\/\/host\.docker\.internal:\d+$/)
    assert.ok(gate.containerName?.startsWith('relay-e2e-'))
    assert.equal(gate.capabilities.bash, true)
    assert.equal(gate.capabilities.curl, true)
    assert.equal(gate.capabilities.openssl, true)
    return
  }
  assert.equal(typeof gate.skipReason, 'string')
  assert.ok(gate.skipReason && gate.skipReason.length > 0)
  assert.equal(gate.platformUrl, null)
})

test('missing image returns skipReason instead of throwing', async () => {
  const missing = await startContainerHarness({
    platformPort: 1,
    image: 'orca-e2e-missing-image:never'
  })
  assert.equal(missing.available, false)
  assert.match(missing.skipReason ?? '', /not present locally/)
  assert.equal(missing.platformUrl, null)
  await missing.stop()
})

test('container runs bash in a temporary HOME', async (t) => {
  const gate = requireHarness()
  if (!gate.available) {
    t.skip(gate.skipReason)
    return
  }
  const echo = await gate.execInContainer('bash -c "echo ok"')
  assert.equal(echo.exitCode, 0)
  assert.equal(echo.stdout.trim(), 'ok')

  const home = await gate.execInContainer('printf "%s" "$HOME"')
  assert.equal(home.exitCode, 0)
  assert.equal(home.stdout, gate.homeDir)
  assert.notEqual(gate.homeDir, '/root')
})

test('container reaches the host platform through host.docker.internal', async (t) => {
  const gate = requireHarness()
  if (!gate.available) {
    t.skip(gate.skipReason)
    return
  }
  assert.equal(await gate.checkPlatformReachable('/health'), true)

  const direct = await gate.execInContainer(
    `curl -fsS --max-time 5 ${gate.getContainerPlatformUrl()}/health`
  )
  assert.equal(direct.exitCode, 0)
  assert.match(direct.stdout, /"status":"ok"/)
})

test('node presence is recorded, not treated as a failure', async (t) => {
  const gate = requireHarness()
  if (!gate.available) {
    t.skip(gate.skipReason)
    return
  }
  assert.equal(typeof gate.capabilities.node, 'boolean')
  if (gate.capabilities.node) {
    assert.match(gate.capabilities.nodeVersion ?? '', /^v\d+\./)
  } else {
    assert.equal(gate.capabilities.nodeVersion, null)
  }
})
