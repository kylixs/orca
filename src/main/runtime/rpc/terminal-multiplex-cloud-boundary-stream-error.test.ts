import './unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

/**
 * W9A-7 audit MIN-2: a cloud boundary that cannot answer (a throwing runtime
 * resolver) must fold into a stream error, not escape as an unhandled rejection
 * that strands the subscriber with no echo.
 */

const cloudSession = {
  projectId: 'proj_1',
  projectRoot: '/tmp/payment-service',
  workspaceRoot: '/tmp/payment-service/.orca-worktrees/zhangsan',
  repoUrl: '',
  defaultBranch: '',
  perms: ['open', 'terminal'] as const
}

function startCloudMultiplex(runtimeOverrides: NonNullable<Parameters<typeof stubRuntime>[0]>) {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const denials: { denial: string; method: string }[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const registry = {
    registerOwnedSubscriptionCleanup: vi.fn(),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionIfOwnedByConnection: vi.fn(),
    cleanupSubscriptionsForConnection: vi.fn()
  }
  const runtime = stubRuntime({
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snap', cols: 120, rows: 40 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    cleanupSubscriptionIfOwnedByConnection: vi.fn(registry.cleanupSubscriptionIfOwnedByConnection),
    cleanupSubscriptionsForConnection: vi.fn(registry.cleanupSubscriptionsForConnection),
    ...runtimeOverrides,
    waitForTerminal:
      runtimeOverrides.waitForTerminal ?? vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  })
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  void dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (msg) => messages.push(msg),
    {
      connectionId: 'conn-cloud-boundary',
      cloud: cloudSession,
      onCloudDenial: (details, method) => denials.push({ denial: details.denial, method }),
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  return { messages, binaryFrames, denials, handlers, runtime }
}

function sendSubscribe(
  handlers: Map<number, (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void>,
  terminal: string
): void {
  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 7,
          terminal,
          client: { id: 'desktop-1', type: 'desktop' },
          viewport: { cols: 120, rows: 40 }
        })
      })
    )!
  )
}

describe('terminal multiplex RPC · cloud boundary', () => {
  it('a throwing boundary resolver ends the stream with terminal_handle_stale, not an unhandled rejection', async () => {
    const { messages, binaryFrames, denials, handlers } = startCloudMultiplex({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      // Why: the guard calls this outside its own try — a hostile-to-failure
      // runtime must still produce a client echo through the rejection fold.
      resolveTerminalContext: vi.fn(() => {
        throw new Error('resolver exploded')
      })
    })
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendSubscribe(handlers, 'terminal-1')
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'end')).toBe(true)
    )
    const errorText = binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Error)
      .map((frame) => decodeTerminalStreamText(frame!.payload))
      .join('')
    expect(errorText).toBe('terminal_handle_stale')
    expect(
      binaryFrames.some(
        (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.SnapshotStart
      )
    ).toBe(false)
    // An internal failure is not a proven boundary violation: no audit row.
    expect(denials).toEqual([])
  })
})
