import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { OrcaRuntimeService } from '../orca-runtime'
import type { AuthenticatedMobileSocket } from '../rpc/mobile-socket-wiring'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overridden dispatch never reads the socket; it only proves the fire-and-forget path answers regardless of transport state.
const FAKE_SOCKET = {
  ws: undefined,
  device: { deviceToken: 'fake-token' }
} as unknown as AuthenticatedMobileSocket

function makeServer(): OrcaRuntimeRpcServer {
  return new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-')),
    enableWebSocket: false
  })
}

describe('mobile RPC dispatch failure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('answers an error frame instead of letting the client time out', async () => {
    const server = makeServer()
    server['handleWebSocketMessage'] = vi.fn(async () => {
      throw new TypeError('sessionTabsInventoryWaiters is not a function')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const replies: string[] = []

    await server['dispatchMobileSocketText'](
      FAKE_SOCKET,
      JSON.stringify({ id: 'req_u102', method: 'session.tabs.move' }),
      (response) => replies.push(response),
      () => {}
    )

    expect(replies).toHaveLength(1)
    const reply = JSON.parse(replies[0]!)
    expect(reply).toMatchObject({
      id: 'req_u102',
      ok: false,
      error: { code: 'internal_error' }
    })
    // The remote sees the method and the summary, never the host stack.
    expect(reply.error.message).toContain('session.tabs.move')
    expect(reply.error.message).toContain('sessionTabsInventoryWaiters is not a function')
    expect(reply.error.message).not.toMatch(/\n\s+at /)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('session.tabs.move'),
      expect.any(Error)
    )
  })

  it('stays settled when the transport reply itself throws', async () => {
    const server = makeServer()
    server['handleWebSocketMessage'] = vi.fn(async () => {
      throw new Error('boom')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      server['dispatchMobileSocketText'](
        FAKE_SOCKET,
        JSON.stringify({ id: 'req_reply_throw', method: 'status.get' }),
        () => {
          throw new Error('socket closed')
        },
        () => {}
      )
    ).resolves.toBeUndefined()
  })
})
