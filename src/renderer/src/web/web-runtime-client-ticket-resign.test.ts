import * as http from 'node:http'
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { WebSocket as WsWebSocket } from 'ws'
import { WebRuntimeClient } from './web-runtime-client'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyToBase64
} from '../../../shared/e2ee-crypto'
import { parseJsonText, readString } from '../../../shared/json-fields'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { WebPairingOffer } from './web-pairing'

/**
 * W5c: a cloud ticket is one connection wide, so a stream subscription's child
 * socket must present its own freshly signed ticket. Reusing the parent's would
 * only ever be refused as a replay (the U14 admin terminal failure).
 */

const fakeSockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  send = vi.fn()

  constructor(
    readonly _url: string,
    readonly _protocols?: string[]
  ) {
    fakeSockets.push(this)
  }
}

function offerWith(
  credential: string,
  endpoint: string,
  devicePublicKeyB64: string,
  hostPublicKeyB64: string
): WebPairingOffer {
  return {
    v: 2,
    endpoint,
    deviceToken: `token-for-${credential}`,
    publicKeyB64: hostPublicKeyB64,
    scope: 'runtime',
    cloud: { credential, devicePublicKeyB64 }
  }
}

function legacyOffer(): WebPairingOffer {
  return {
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: Buffer.alloc(32).toString('base64')
  }
}

/** Drives one child socket through the E2EE handshake the transport speaks. */
function completeHandshake(socket: FakeWebSocket, sharedKey: Uint8Array): void {
  socket.readyState = FakeWebSocket.OPEN
  socket.onopen?.()
  socket.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
  const authFrame = socket.send.mock.calls.map((call) => String(call[0])).at(-1)
  if (authFrame === undefined || authFrame.startsWith('{')) {
    throw new Error('expected the encrypted e2ee_auth frame on the child socket')
  }
  socket.onmessage?.({ data: encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey) })
}

describe('WebRuntimeClient ticket re-signing (W5c)', () => {
  beforeEach(() => {
    fakeSockets.length = 0
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
    })
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('signs one fresh ticket per child subscription socket and never reuses one', async () => {
    const device = generateKeyPair()
    const host = generateKeyPair()
    const deviceKeyB64 = publicKeyToBase64(device.publicKey)
    const hostKeyB64 = publicKeyToBase64(host.publicKey)
    // The same derivation the child performs against the offer's host key.
    const sharedKey = deriveSharedKey(device.secretKey, host.publicKey)
    const signedCredentials: string[] = []
    let issue = 0
    const reSigner = vi.fn(async (): Promise<WebPairingOffer> => {
      issue += 1
      signedCredentials.push(`ticket-${issue}`)
      return offerWith(`ticket-${issue}`, 'ws://127.0.0.1:6768', deviceKeyB64, hostKeyB64)
    })
    const client = new WebRuntimeClient(
      offerWith('parent-ticket', 'ws://127.0.0.1:6768', deviceKeyB64, hostKeyB64),
      {
        deviceSecretKeyB64: Buffer.from(device.secretKey).toString('base64'),
        ticketReSigner: reSigner
      }
    )

    const firstPending = client.subscribe(
      'terminal.subscribe',
      { terminal: 't1' },
      { onResponse: vi.fn() }
    )
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2))
    completeHandshake(fakeSockets[1]!, sharedKey)
    const first = await firstPending
    const secondPending = client.subscribe(
      'terminal.subscribe',
      { terminal: 't2' },
      { onResponse: vi.fn() }
    )
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(3))
    completeHandshake(fakeSockets[2]!, sharedKey)
    const second = await secondPending

    // Two child sockets, two distinct freshly signed credentials: the parent's
    // own ticket is never offered again.
    expect(reSigner).toHaveBeenCalledTimes(2)
    expect(signedCredentials).toEqual(['ticket-1', 'ticket-2'])
    const childProtocols = fakeSockets.slice(1).map((socket) => socket._protocols ?? [])
    expect(childProtocols).toHaveLength(2)
    expect(childProtocols[0]).toContain('orca-cred.ticket-1')
    expect(childProtocols[1]).toContain('orca-cred.ticket-2')
    // Each child dials with its own ticket, and the parent's is nowhere on them.
    expect(childProtocols.flat().filter((value) => value.startsWith('orca-cred.'))).toEqual([
      'orca-cred.ticket-1',
      'orca-cred.ticket-2'
    ])

    first.unsubscribe()
    second.unsubscribe()
    client.close()
  })

  it('fails the subscription when the fresh ticket cannot be signed, opening no socket', async () => {
    const device = generateKeyPair()
    const reSigner = vi.fn(async (): Promise<WebPairingOffer> => {
      throw new Error('platform session expired')
    })
    const client = new WebRuntimeClient(
      offerWith(
        'parent-ticket',
        'ws://127.0.0.1:6768',
        publicKeyToBase64(device.publicKey),
        Buffer.alloc(32).toString('base64')
      ),
      {
        deviceSecretKeyB64: Buffer.from(device.secretKey).toString('base64'),
        ticketReSigner: reSigner
      }
    )
    const socketsBefore = fakeSockets.length

    const error = await client
      .subscribe('terminal.subscribe', { terminal: 't1' }, { onResponse: vi.fn() })
      .then(
        () => null,
        (reason: unknown) => reason
      )

    // The signer's own failure is the subscription's failure — the caller's
    // onError/reconnect path sees the platform reason, not a socket hang.
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('platform session expired')
    expect(reSigner).toHaveBeenCalledTimes(1)
    // No child socket dialled the host with a spent ticket.
    expect(fakeSockets).toHaveLength(socketsBefore)
    client.close()
  })

  it('refuses a cloud subscription up front when no platform session can sign a ticket', async () => {
    const device = generateKeyPair()
    const client = new WebRuntimeClient(
      offerWith(
        'parent-ticket',
        'ws://127.0.0.1:6768',
        publicKeyToBase64(device.publicKey),
        Buffer.alloc(32).toString('base64')
      ),
      { deviceSecretKeyB64: Buffer.from(device.secretKey).toString('base64') }
    )
    const socketsBefore = fakeSockets.length

    const error = await client
      .subscribe('terminal.subscribe', { terminal: 't1' }, { onResponse: vi.fn() })
      .then(
        () => null,
        (reason: unknown) => reason
      )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('one-time ticket')
    expect(fakeSockets).toHaveLength(socketsBefore)
    client.close()
  })

  it('keeps the legacy (ticketless) offer behaviour and signs nothing', async () => {
    const reSigner = vi.fn(async (): Promise<WebPairingOffer> => legacyOffer())
    const client = new WebRuntimeClient(legacyOffer(), { ticketReSigner: reSigner })

    const pending = client.subscribe('terminal.subscribe', {}, { onResponse: vi.fn() })
    await vi.waitFor(() => expect(fakeSockets).toHaveLength(2))
    expect(reSigner).not.toHaveBeenCalled()

    client.close()
    await expect(pending).rejects.toThrow()
  })

  describe('against a host that admits each upgrade ticket once', () => {
    let server: http.Server
    let wss: WebSocketServer
    let port = 0
    let hostKeyB64 = ''
    let admitted: string[]
    let refused: string[]

    beforeEach(async () => {
      vi.stubGlobal('WebSocket', WebSocket)
      admitted = []
      refused = []
      const hostKeys = generateKeyPair()
      hostKeyB64 = publicKeyToBase64(hostKeys.publicKey)
      wss = new WebSocketServer({ noServer: true })
      const handshake = (ws: WsWebSocket): void => {
        let sharedKey: Uint8Array | null = null
        ws.on('message', (data, isBinary) => {
          if (isBinary || !sharedKey) {
            const helloKeyB64 = readString(parseJsonText(String(data)), 'publicKeyB64')
            if (helloKeyB64 === null) {
              return
            }
            sharedKey = deriveSharedKey(
              hostKeys.secretKey,
              Uint8Array.from(Buffer.from(helloKeyB64, 'base64'))
            )
            ws.send(JSON.stringify({ type: 'e2ee_ready' }))
            return
          }
          const plaintext = decrypt(String(data), sharedKey)
          if (!plaintext) {
            return
          }
          const frame = parseJsonText(plaintext)
          if (readString(frame, 'type') === 'e2ee_auth') {
            ws.send(encrypt(JSON.stringify({ type: 'e2ee_authenticated' }), sharedKey))
            return
          }
          const id = readString(frame, 'id')
          if (id === null) {
            return
          }
          const reply: RuntimeRpcResponse<unknown> & { streaming: true } = {
            id,
            ok: true,
            streaming: true,
            result: { type: 'ready' },
            _meta: { runtimeId: 'runtime-web-test' }
          }
          ws.send(encrypt(JSON.stringify(reply), sharedKey))
        })
      }
      server = http.createServer()
      server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const header = String(request.headers['sec-websocket-protocol'] ?? '')
        const credential =
          header
            .split(',')
            .map((value) => value.trim())
            .find((value) => value.startsWith('orca-cred.'))
            ?.slice('orca-cred.'.length) ?? null
        if (credential === null || admitted.includes(credential)) {
          refused.push(credential ?? '<missing>')
          socket.write('HTTP/1.1 401 Unauthorized\r\nx-orca-reject: replayed\r\n\r\n')
          socket.destroy()
          return
        }
        admitted.push(credential)
        wss.handleUpgrade(request, socket, head, handshake)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address !== 'object') {
        throw new Error('expected a local test server address')
      }
      port = address.port
    })

    afterEach(async () => {
      for (const socket of wss.clients) {
        socket.terminate()
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    })

    it('streams two subscriptions on two fresh tickets with zero replayed refusals', async () => {
      const device = generateKeyPair()
      const deviceKeyB64 = publicKeyToBase64(device.publicKey)
      const endpoint = `ws://127.0.0.1:${port}`
      let issue = 0
      const client = new WebRuntimeClient(
        offerWith('parent-ticket', endpoint, deviceKeyB64, hostKeyB64),
        {
          deviceSecretKeyB64: Buffer.from(device.secretKey).toString('base64'),
          ticketReSigner: async () => {
            issue += 1
            return offerWith(`ticket-${issue}`, endpoint, deviceKeyB64, hostKeyB64)
          }
        }
      )
      try {
        const first = await client.subscribe(
          'terminal.subscribe',
          { terminal: 't1' },
          { onResponse: vi.fn() },
          { timeoutMs: 10_000 }
        )
        first.unsubscribe()
        const second = await client.subscribe(
          'terminal.subscribe',
          { terminal: 't2' },
          { onResponse: vi.fn() },
          { timeoutMs: 10_000 }
        )
        second.unsubscribe()

        expect(admitted).toEqual(['parent-ticket', 'ticket-1', 'ticket-2'])
        expect(refused).toEqual([])
      } finally {
        client.close()
      }
    }, 30_000)

    it('still refuses a replayed ticket: the host one-time semantics are unchanged', async () => {
      const device = generateKeyPair()
      const deviceKeyB64 = publicKeyToBase64(device.publicKey)
      const endpoint = `ws://127.0.0.1:${port}`
      // A re-signer that hands back the already-spent parent ticket stands in for
      // the pre-fix behaviour the U14 evidence captured.
      const client = new WebRuntimeClient(
        offerWith('parent-ticket', endpoint, deviceKeyB64, hostKeyB64),
        {
          deviceSecretKeyB64: Buffer.from(device.secretKey).toString('base64'),
          ticketReSigner: async () => offerWith('parent-ticket', endpoint, deviceKeyB64, hostKeyB64)
        }
      )
      try {
        const error = await client
          .subscribe(
            'terminal.subscribe',
            { terminal: 't1' },
            { onResponse: vi.fn() },
            {
              timeoutMs: 1_500
            }
          )
          .then(
            () => null,
            (reason: unknown) => reason
          )
        expect(error).toBeInstanceOf(Error)
        expect(refused).toEqual(['parent-ticket'])
      } finally {
        client.close()
      }
    }, 30_000)
  })
})
