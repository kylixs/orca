import type WebSocket from 'ws'
import { readField, readString } from '../../shared/json-fields'
import type { CloudRpcResult } from './cloud-connect-client'
import { decrypt, encrypt } from '../runtime/rpc/e2ee-crypto'

/**
 * Request/response and streaming multiplexing over one admitted cloud socket.
 *
 * The host answers every call with `id`-keyed envelopes on the same E2EE socket;
 * a streaming method sends many `{streaming: true}` replies and then `{type:'end'}`
 * (terminal.subscribe). One router owns the socket so a reply never has to be
 * re-parsed by every outstanding caller, and so a timed-out call leaves nothing
 * behind.
 */

export type CloudStreamEvent = unknown

export type CloudSubscription = {
  /** The frame id the stream was opened with; `terminal.unsubscribe` names it. */
  requestId: string
  /** Resolves when the host ends the stream, the socket closes, or the call fails. */
  done: Promise<CloudRpcResult>
}

type PendingCall = {
  settle: (result: CloudRpcResult) => void
  onEvent?: (event: CloudStreamEvent) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** The `end` frame every stream finishes with; it carries no more output. */
function isEndFrame(result: unknown): boolean {
  return readString(result, 'type') === 'end'
}

export class CloudRpcMultiplexer {
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0
  private closed = false

  constructor(
    private readonly socket: WebSocket,
    private readonly sharedKey: Uint8Array
  ) {
    socket.on('message', (raw: WebSocket.RawData) => this.onFrame(raw))
    socket.on('close', () => this.failAll({ ok: false, code: 'CONNECTION_CLOSED' }))
  }

  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<CloudRpcResult> {
    return this.open(method, params, undefined, timeoutMs).done
  }

  subscribe(
    method: string,
    params: Record<string, unknown>,
    onEvent: (event: CloudStreamEvent) => void,
    timeoutMs = 10_000
  ): CloudSubscription {
    // Why a longer default: a stream's first frame is the host's scrollback read,
    // not a protocol round trip, and a busy host may take seconds to answer.
    const { requestId, done } = this.open(method, params, onEvent, timeoutMs)
    return { requestId, done }
  }

  /** Drops the local handler without a reply; the host ends the stream separately. */
  forget(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) {
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    this.pending.delete(requestId)
    entry.settle({ ok: false, code: 'CANCELLED' })
  }

  close(): void {
    this.closed = true
    this.failAll({ ok: false, code: 'NOT_CONNECTED' })
  }

  private open(
    method: string,
    params: Record<string, unknown>,
    onEvent: ((event: CloudStreamEvent) => void) | undefined,
    timeoutMs: number
  ): { requestId: string; done: Promise<CloudRpcResult> } {
    const requestId = `cloud-${++this.seq}`
    if (this.closed) {
      return { requestId, done: Promise.resolve({ ok: false, code: 'NOT_CONNECTED' }) }
    }
    const done = new Promise<CloudRpcResult>((settle) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        settle({ ok: false, code: 'RPC_TIMEOUT' })
      }, timeoutMs)
      this.pending.set(requestId, { settle, timer, ...(onEvent ? { onEvent } : {}) })
    })
    this.socket.send(encrypt(JSON.stringify({ id: requestId, method, params }), this.sharedKey))
    return { requestId, done }
  }

  private onFrame(raw: WebSocket.RawData): void {
    const plaintext = decrypt(raw.toString(), this.sharedKey)
    if (plaintext === null) {
      return
    }
    let message: unknown
    try {
      message = JSON.parse(plaintext)
    } catch {
      return
    }
    const id = readString(message, 'id')
    const entry = id === null ? undefined : this.pending.get(id)
    if (id === null || !entry) {
      // An event for a stream the caller already dropped is expected, not an error.
      return
    }
    const failure = readField(message, 'error')
    if (readField(message, 'ok') === false) {
      const data = readField(failure, 'data')
      this.finish(id, entry, {
        ok: false,
        code: readString(failure, 'code') ?? 'unknown',
        message: readString(failure, 'message') ?? '',
        ...(data === null ? {} : { data })
      })
      return
    }
    const result = readField(message, 'result')
    if (readField(message, 'streaming') === true) {
      entry.onEvent?.(result)
      if (isEndFrame(result)) {
        this.finish(id, entry, { ok: true, result })
      }
      return
    }
    // A non-streaming reply ends the call whether or not it streamed first.
    this.finish(id, entry, { ok: true, result })
  }

  private finish(id: string, entry: PendingCall, result: CloudRpcResult): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    this.pending.delete(id)
    entry.settle(result)
  }

  private failAll(result: CloudRpcResult): void {
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [, entry] of entries) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.settle(result)
    }
  }
}
