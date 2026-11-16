import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { NODE_RUNTIME_INCLUDE } from './vitest-node-runtime-files.mjs'

/**
 * Why: Bun's ws cannot complete a throwaway-certificate TLS handshake even with
 * rejectUnauthorized:false, so any suite that dials a real WSS endpoint must run
 * in the node pool or it turns red as "TLS handshake failed" (U31 -> U87 -> U93).
 * This static guard makes the next unregistered WSS-client suite fail here, next
 * to the manifest, instead of as an unrelated handshake error in CI.
 */
function wssClientSignals(source: string): string[] {
  const signals: string[] = []
  // The shared fixture that serves the runtime with a throwaway certificate.
  if (/makeSelfSignedTls\s*\(/.test(source)) {
    signals.push('makeSelfSignedTls()')
  }
  // A runtime started with TLS means its endpoint is wss://.
  if (/webSocketTls\s*:/.test(source)) {
    signals.push('webSocketTls:')
  }
  // The relay-stack fixture always serves TLS and connects a CloudConnectClient.
  if (/startRelayStack\s*\(/.test(source)) {
    signals.push('startRelayStack()')
  }
  // A literal wss:// endpoint handed to a real client constructor.
  if (
    /wss:\/\//.test(source) &&
    /new WebSocket\(|new WebSocketClient\(|WebSocketImpl/.test(source)
  ) {
    signals.push('wss:// + WebSocket client')
  }
  // A locally hosted TLS WebSocket server plus a client dialing it.
  if (
    /new WebSocketServer\(/.test(source) &&
    /\bcert\s*:/.test(source) &&
    /new WebSocket\(/.test(source)
  ) {
    signals.push('TLS WebSocketServer + client')
  }
  return signals
}

it('routes every real-WSS-client suite to the node runtime pool', () => {
  const root = process.cwd()
  const nodeFiles = new Set(globSync(NODE_RUNTIME_INCLUDE).map((file) => resolve(root, file)))
  const missing: string[] = []
  for (const file of discoverUnitFiles(root)) {
    const signals = wssClientSignals(readFileSync(resolve(root, file), 'utf8'))
    if (signals.length > 0 && !nodeFiles.has(resolve(root, file))) {
      missing.push(`${file} [${signals.join(', ')}]`)
    }
  }
  expect(missing).toEqual([])
})
