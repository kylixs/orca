import * as React from 'react'
import type { Terminal } from '@xterm/xterm'
import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import {
  errorCodeOf,
  readField,
  readNumber,
  readObjectValue,
  readString,
  readStringArray
} from '../../../shared/json-fields'
import { RELEASE_SYNCHRONIZED_OUTPUT } from '../../../shared/terminal-mode-reset-profiles'
import type { TerminalEchoLatencyMeter, TerminalEchoStats } from './cloud-terminal-echo-latency'
import type {
  CloudSubscribeOutcome,
  CloudSubscription,
  CloudSubscriptionCallbacks
} from './use-cloud-session'

/**
 * The stream half of `CloudTerminalPanel` (U96 B-令6 extraction): create the
 * PTY, subscribe passively, reconnect with backoff, and release the shell on
 * unmount according to the detach policy. Kept out of the component so the
 * panel keeps its xterm/fit/overlay concerns below the file-size budget.
 */

export type CloudPanelState =
  | { kind: 'booting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; code: string | null }
  | { kind: 'failed'; code: string }

export type CloudStreamSubscribe = (
  method: string,
  params: Record<string, unknown>,
  callbacks: CloudSubscriptionCallbacks
) => Promise<CloudSubscribeOutcome>

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000]

/** The handle field `terminal.create` answers with (M102 e2e contract). */
function terminalHandleOf(result: unknown): string | null {
  return readString(readField(readObjectValue(result), 'terminal'), 'handle')
}

/** The grid the host serialized the frame at; absent or absurd means "keep ours". */
function frameSizeOf(event: unknown): { cols: number; rows: number } | null {
  const cols = readNumber(event, 'cols')
  const rows = readNumber(event, 'rows')
  return cols !== null && rows !== null && cols > 0 && rows > 0 ? { cols, rows } : null
}

/** The ANSI image of the buffer; `lines` is the text fallback for older hosts. */
function framePayloadOf(event: unknown): string | null {
  const serialized = readString(event, 'serialized')
  if (serialized !== null) {
    return serialized
  }
  const lines = readStringArray(event, 'lines')
  return lines === null ? null : `${lines.join('\r\n')}\r\n`
}

type Ref<T> = { current: T }

export function useCloudTerminalStreamSession(args: {
  rpc: CloudRpc
  subscribe: CloudStreamSubscribe
  workspacePath: string
  title: string
  clientId: string
  pushViewport: () => void
  echoMeter: TerminalEchoLatencyMeter
  detachPolicy: 'close-on-unmount' | 'leave-running'
  detachPolicyResolver?: () => 'close-on-unmount' | 'leave-running'
  onFitOverrideEvent: (event: unknown) => void
  handleRef: Ref<string | null>
  termRef: Ref<Terminal | null>
  retryRef: Ref<(() => void) | null>
  setState: React.Dispatch<React.SetStateAction<CloudPanelState>>
  setEchoStats: React.Dispatch<React.SetStateAction<TerminalEchoStats>>
}): void {
  const {
    rpc,
    subscribe,
    workspacePath,
    title,
    clientId,
    pushViewport,
    echoMeter,
    detachPolicy,
    detachPolicyResolver,
    onFitOverrideEvent,
    handleRef,
    termRef,
    retryRef,
    setState,
    setEchoStats
  } = args

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Why: the reconnect timer is armed from stream-drop callbacks, stored, and cleared by this effect's unmount cleanup.
  React.useEffect(() => {
    let disposed = false
    let epoch = 0
    let subscription: CloudSubscription | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    const paint = (payload: string, snapshot: { cols: number; rows: number } | null): void => {
      const term = termRef.current
      if (!term) {
        return
      }
      // Why resize to the source grid first: the frame's wraps and cursor moves
      // are relative to the grid the host serialized it at; parsing it at another
      // grid clips or re-wraps lines an idle shell never repaints.
      if (snapshot && (term.cols !== snapshot.cols || term.rows !== snapshot.rows)) {
        try {
          term.resize(snapshot.cols, snapshot.rows)
        } catch {
          /* a refused resize still leaves the payload writable */
        }
      }
      term.write(payload)
    }

    const onEvent = (event: unknown): void => {
      const type = readString(event, 'type')
      if (type === 'scrollback') {
        // The buffer is kept across a drop; the snapshot is the host's
        // authoritative image of it (it carries the history too), so clear the
        // screen and scrollback and repaint, as the web client's replay does,
        // rather than append a second copy of the history.
        termRef.current?.write(`${RELEASE_SYNCHRONIZED_OUTPUT}\x1b[2J\x1b[3J\x1b[H`)
        paint(framePayloadOf(event) ?? '', frameSizeOf(event))
        pushViewport()
        return
      }
      if (type === 'data') {
        const chunk = readString(event, 'chunk')
        const term = termRef.current
        if (chunk !== null && chunk !== '' && term) {
          if (echoMeter.hasPendingKeys()) {
            // The callback rides the same write and fires once xterm has parsed
            // the echo into the buffer; with no key pending the call keeps its
            // original single-argument shape.
            term.write(chunk, () => {
              const sample = echoMeter.recordEcho()
              if (sample !== null) {
                setEchoStats(echoMeter.stats())
              }
            })
          } else {
            term.write(chunk)
          }
        }
        return
      }
      if (type === 'fit-override-changed') {
        onFitOverrideEvent(event)
      }
    }

    const connect = (): void => {
      const handle = handleRef.current
      if (disposed || handle === null) {
        return
      }
      const currentEpoch = ++epoch
      const params = {
        terminal: handle,
        client: { id: clientId, type: 'desktop' },
        // U98 fix: declare the desktop viewport-claims capability so attaching is
        // passive. Without it the host would claim the size floor on subscribe and
        // steal the grid from Orca Web (design §3.3).
        capabilities: { desktopViewportClaims: 1 },
        // Why: the stream owns the desktop viewport floor; without it the PTY
        // keeps the host's default grid and the later updateViewport rpc (a
        // refresh) has no floor to update.
        viewport: {
          cols: termRef.current?.cols ?? 80,
          rows: termRef.current?.rows ?? 24
        }
      }
      void subscribe('terminal.subscribe', params, {
        onEvent,
        onClose: () => {
          if (disposed || currentEpoch !== epoch) {
            return
          }
          subscription = null
          scheduleReconnect(null)
        },
        onError: (error) => {
          if (disposed || currentEpoch !== epoch) {
            return
          }
          subscription = null
          scheduleReconnect(error.code)
        }
      })
        .then((outcome) => {
          if (currentEpoch !== epoch) {
            // A superseded stream must still release its child socket.
            if (outcome.ok) {
              outcome.subscription.unsubscribe()
            }
            return
          }
          if (disposed) {
            if (outcome.ok) {
              outcome.subscription.unsubscribe()
            }
            return
          }
          if (!outcome.ok) {
            scheduleReconnect(outcome.code)
            return
          }
          subscription = outcome.subscription
          // A drop loses the echoes in flight; those keys must not match the
          // first chunk after the reconnect.
          echoMeter.clearPending()
          setState({ kind: 'live' })
        })
        .catch((error: unknown) => {
          // A transport that throws instead of answering an outcome must land in
          // the same reconnect path, never in the render tree.
          if (disposed || currentEpoch !== epoch) {
            return
          }
          scheduleReconnect(errorCodeOf(error) ?? 'STREAM_FAILED')
        })
    }

    const scheduleReconnect = (code: string | null): void => {
      // Why one timer: onError and onClose can both report one drop, and a
      // second timer would supersede the epoch of the stream the first retry
      // opened, leaking its live subscription.
      if (disposed || timer !== undefined) {
        return
      }
      const attempt = attempts
      attempts += 1
      if (attempt >= RECONNECT_DELAYS_MS.length) {
        setState({ kind: 'failed', code: code ?? 'CONNECTION_CLOSED' })
        return
      }
      setState({ kind: 'reconnecting', code })
      timer = setTimeout(() => {
        timer = undefined
        connect()
      }, RECONNECT_DELAYS_MS[attempt])
    }

    const boot = (): void => {
      void (async () => {
        const created = await rpc('terminal.create', {
          worktree: cloudWorktreeSelector(workspacePath),
          title
        })
        if (disposed) {
          // Unmount raced this rpc: the cleanup saw no handle yet, so the shell
          // the host already built is closed here instead of leaking.
          if (created.ok) {
            const orphaned = terminalHandleOf(created.result)
            if (orphaned !== null) {
              void rpc('terminal.close', { terminal: orphaned })
            }
          }
          return
        }
        if (!created.ok) {
          setState({ kind: 'failed', code: created.code })
          return
        }
        const handle = terminalHandleOf(created.result)
        if (handle === null) {
          setState({ kind: 'failed', code: 'terminal_handle_missing' })
          return
        }
        handleRef.current = handle
        connect()
      })()
    }

    // The escape hatch once the automatic budget is spent. A live PTY keeps its
    // shell — only a create that never landed tries the whole boot again.
    retryRef.current = (): void => {
      if (disposed) {
        return
      }
      attempts = 0
      epoch += 1
      subscription?.unsubscribe()
      subscription = null
      clearTimeout(timer)
      timer = undefined
      setState({ kind: 'booting' })
      if (handleRef.current === null) {
        boot()
        return
      }
      connect()
    }

    boot()

    return () => {
      disposed = true
      retryRef.current = null
      epoch += 1
      // Why unconditional: clearing an unset timer is a no-op, and the cleanup
      // must own the last armed timer without a guard that hides it.
      clearTimeout(timer)
      subscription?.unsubscribe()
      const policy = detachPolicyResolver ? detachPolicyResolver() : detachPolicy
      if (handleRef.current !== null && policy === 'close-on-unmount') {
        // Why not awaited: an unmount must not hold the tree on the network.
        void rpc('terminal.close', { terminal: handleRef.current })
      }
      handleRef.current = null
    }
    // One PTY per workspace path; a different path belongs to a different panel.
    // The title is the create-time name of that PTY, never a live relabel.
  }, [
    rpc,
    subscribe,
    workspacePath,
    title,
    clientId,
    pushViewport,
    echoMeter,
    detachPolicy,
    detachPolicyResolver,
    onFitOverrideEvent,
    handleRef,
    termRef,
    retryRef,
    setState,
    setEchoStats
  ])
}
