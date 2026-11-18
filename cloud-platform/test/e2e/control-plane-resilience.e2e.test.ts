import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { startRelay } from '../../apps/relay/src/relay.ts'
import { makeTlsCerts, makeTempWorkspace, saveEvidence, spawnService } from './harness.ts'

const EVIDENCE = 'm12-control-plane-resilience'

type Hanging = {
  url: string
  connections: () => number
  active: () => number
  close: () => Promise<void>
}

/**
 * `no-response`: accepts the request but never answers — the review-06 M2/N3 shape.
 * `stall-body`: sends headers immediately, then never ends the body.
 */
async function startHangingControlPlane(
  mode: 'no-response' | 'stall-body' = 'no-response'
): Promise<Hanging> {
  let total = 0
  let active = 0
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((_req, res) => {
    if (mode === 'stall-body') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{')
      // Intentionally never res.end().
    }
    // no-response: intentionally no response at all.
  })
  server.on('connection', (socket) => {
    total += 1
    active += 1
    sockets.add(socket)
    socket.on('close', () => {
      active -= 1
      sockets.delete(socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => total,
    active: () => active,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

describe('M12 控制面挂起：请求可中止，连接不堆积', () => {
  test('Runtime 在挂起的控制面前不线性堆积 socket', { timeout: 30000 }, async () => {
    const hanging = await startHangingControlPlane()
    const workspace = makeTempWorkspace()
    const tls = makeTlsCerts()
    const runtime = await spawnService(
      'apps/runtime/src/runtime-sim.ts',
      {
        PORT: '0',
        API_URL: hanging.url,
        PUBLIC_API_URL: hanging.url,
        CONTROL_TIMEOUT_MS: '300',
        HOST_ID: 'host_dev001',
        HOST_NAME: 'dev-001',
        SANDBOX_ROOT: workspace.root,
        TLS_KEY: tls.key,
        TLS_CERT: tls.cert
      },
      /\[runtime-sim\] dev-001 listening on :(\d+)/,
      'runtime-hanging-control'
    )
    try {
      await new Promise((r) => setTimeout(r, 3500))
      const active = hanging.active()
      const total = hanging.connections()
      assert.ok(total >= 3, `polling must have happened, total=${total}`)
      // Before the fix every poll left three sockets open forever (3, 6, 9, ...).
      assert.ok(active <= 4, `sockets must be aborted, active=${active} total=${total}`)
      assert.equal(runtime.proc.exitCode, null)
      saveEvidence(EVIDENCE, 'runtime-aborts-hung-requests.json', { total, active })
    } finally {
      await runtime.stop()
      await hanging.close()
    }
  })

  test(
    '响应头已到但响应体挂起时，轮询仍能继续（中止必须 settle Promise）',
    { timeout: 30000 },
    async () => {
      const hanging = await startHangingControlPlane('stall-body')
      const workspace = makeTempWorkspace()
      const tls = makeTlsCerts()
      const runtime = await spawnService(
        'apps/runtime/src/runtime-sim.ts',
        {
          PORT: '0',
          API_URL: hanging.url,
          PUBLIC_API_URL: hanging.url,
          CONTROL_TIMEOUT_MS: '300',
          HOST_ID: 'host_dev001',
          HOST_NAME: 'dev-001',
          SANDBOX_ROOT: workspace.root,
          TLS_KEY: tls.key,
          TLS_CERT: tls.cert
        },
        /\[runtime-sim\] dev-001 listening on :(\d+)/,
        'runtime-stalled-body'
      )
      try {
        await new Promise((r) => setTimeout(r, 3500))
        const total = hanging.connections()
        const active = hanging.active()
        // If a mid-body abort left the promise pending, single-flight would freeze
        // after the first cycle and `total` would stop at 3.
        assert.ok(total >= 6, `polling must keep cycling, total=${total}`)
        assert.ok(active <= 4, `sockets must be aborted, active=${active} total=${total}`)
        assert.equal(runtime.proc.exitCode, null)
        saveEvidence(EVIDENCE, 'runtime-aborts-stalled-body.json', { total, active })
      } finally {
        await runtime.stop()
        await hanging.close()
      }
    }
  )

  test('Relay 在挂起的控制面前仍能启动，且不堆积 socket', { timeout: 30000 }, async () => {
    const hanging = await startHangingControlPlane()
    const started = Date.now()
    const relay = await startRelay({
      port: 0,
      apiUrl: hanging.url,
      internalToken: 'internal-test-token',
      controlTimeoutMs: 300
    })
    const startMs = Date.now() - started
    try {
      // N9: the first sync used to block `listen()` forever.
      assert.ok(relay.port > 0, 'relay must listen even when the platform hangs')
      assert.ok(startMs < 5000, `relay start must be bounded, took ${startMs}ms`)
      await new Promise((r) => setTimeout(r, 5000))
      const active = hanging.active()
      const total = hanging.connections()
      assert.ok(total >= 2, `route polling must have happened, total=${total}`)
      assert.ok(active <= 2, `sockets must be aborted, active=${active} total=${total}`)
      saveEvidence(EVIDENCE, 'relay-starts-while-control-hangs.json', { startMs, total, active })
    } finally {
      await relay.close()
      await hanging.close()
    }
  })
})
