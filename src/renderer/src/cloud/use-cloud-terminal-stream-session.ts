import * as React from 'react'
import type { Terminal } from '@xterm/xterm'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import { errorCodeOf, readField, readObjectValue, readString } from '../../../shared/json-fields'
import { RELEASE_SYNCHRONIZED_OUTPUT } from '../../../shared/terminal-mode-reset-profiles'
import { planCloudTerminalBoot } from './cloud-terminal-attach'
import type { TerminalEchoLatencyMeter, TerminalEchoStats } from './cloud-terminal-echo-latency'
import {
  buildCloudTerminalReopenParams,
  isTerminalSessionGone,
  type CloudScrollbackBoundary
} from './cloud-terminal-replay-boundary'
import type { CloudPanelState, CloudStreamSubscribe } from './cloud-terminal-stream-contracts'
import { readCloudTerminalStreamFrame } from './cloud-terminal-stream-frame'
import type { CloudSubscription } from './use-cloud-session'

/**
 * The stream half of `CloudTerminalPanel` (U96 B-令6 extraction, B-令3 attach):
 * attach to a host-projected handle or create a legacy PTY, subscribe
 * passively, reconnect with backoff, and release the shell on unmount
 * according to the detach policy.
 */

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000]

/**
 * §2.4: a projection row whose PTY the host never restores (restart, failed
 * create) must stop saying "waiting" and offer the same-tab reopen instead.
 */
export const PENDING_HANDLE_TIMEOUT_MS = 10_000

/** The handle field `terminal.create` answers with (M102 e2e contract). */
function terminalHandleOf(result: unknown): string | null {
  return readString(readField(readObjectValue(result), 'terminal'), 'handle')
}

type Ref<T> = { current: T }

export function useCloudTerminalStreamSession(args: {
  rpc: CloudRpc
  subscribe: CloudStreamSubscribe
  workspacePath: string
  title: string
  /** Host projection handle; undefined = never projected, null = host row pending. */
  hostTerminal?: string | null
  /** The host action layer creates this tab's PTY, so never create a second one. */
  hostOwnsPty: boolean
  tabId?: string
  leafId?: string
  clientId: string
  pushViewport: () => void
  setReplayBoundary: React.Dispatch<React.SetStateAction<CloudScrollbackBoundary | null>>
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
    hostTerminal,
    hostOwnsPty,
    tabId,
    leafId,
    clientId,
    pushViewport,
    setReplayBoundary,
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

  // Mount-time snapshot: the capability probe can flip this after mount, and a
  // rerun would close a legacy-created PTY before its host row could arrive.
  const hostOwnsPtyRef = React.useRef(hostOwnsPty)
  hostOwnsPtyRef.current = hostOwnsPty

  // oxlint-disable-next-line react-doctor/effect-needs-cleanup -- Why: the reconnect timer is armed from stream-drop callbacks, stored, and cleared by this effect's unmount cleanup.
  React.useEffect(() => {
    let disposed = false
    let epoch = 0
    let subscription: CloudSubscription | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    // Whether this effect owns the PTY (it created it); an attached handle
    // belongs to the host tab inventory and its close action releases it.
    let createdHere = false

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
      const frame = readCloudTerminalStreamFrame(event)
      if (frame.kind === 'replay') {
        // The buffer is kept across a drop; the snapshot is the host's
        // authoritative image of it (it carries the history too), so clear the
        // screen and scrollback and repaint, as the web client's replay does,
        // rather than append a second copy of the history.
        termRef.current?.write(`${RELEASE_SYNCHRONIZED_OUTPUT}\x1b[2J\x1b[3J\x1b[H`)
        paint(frame.payload ?? '', frame.size)
        setReplayBoundary(frame.boundary)
        pushViewport()
        return
      }
      if (frame.kind === 'data') {
        const term = termRef.current
        if (frame.chunk !== '' && term) {
          if (echoMeter.hasPendingKeys()) {
            // The callback rides the same write and fires once xterm has parsed
            // the echo into the buffer; with no key pending the call keeps its
            // original single-argument shape.
            term.write(frame.chunk, () => {
              const sample = echoMeter.recordEcho()
              if (sample !== null) {
                setEchoStats(echoMeter.stats())
              }
            })
          } else {
            term.write(frame.chunk)
          }
        }
        return
      }
      if (frame.kind === 'fit-override') {
        onFitOverrideEvent(frame.event)
      }
    }

    /** True when the error means the PTY is gone, so a retry would replay a dead handle. */
    const failStream = (code: string | null, message?: string): boolean => {
      if (!isTerminalSessionGone(code, message)) {
        return false
      }
      subscription = null
      setState({ kind: 'ended', code: code ?? 'terminal_exited' })
      return true
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
          // The PTY is gone (host restart/exit), not the link: an automatic
          // reconnect would replay a dead handle, so end the session explicitly.
          if (failStream(error.code, error.message)) {
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
            if (!failStream(outcome.code, outcome.message)) {
              scheduleReconnect(outcome.code)
            }
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
      const plan = planCloudTerminalBoot(hostTerminal, hostOwnsPtyRef.current)
      if (plan.kind === 'pending') {
        setState({ kind: 'pending' })
        timer = setTimeout(() => {
          timer = undefined
          // `pending_timeout` is our own verdict, not a host error: the row may
          // still recover later, and a projection frame reruns this effect.
          setState({ kind: 'ended', code: 'pending_timeout' })
        }, PENDING_HANDLE_TIMEOUT_MS)
        return
      }
      if (plan.kind === 'attach') {
        // The host already owns this PTY (projection row); subscribing is the
        // whole mount — creating here is what produced two shells per tab.
        handleRef.current = plan.handle
        connect()
        return
      }
      void (async () => {
        const created = await rpc(
          'terminal.create',
          buildCloudTerminalReopenParams({ workspacePath, title, tabId, leafId })
        )
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
        createdHere = true
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
      if (createdHere && handleRef.current !== null && policy === 'close-on-unmount') {
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
    hostTerminal,
    tabId,
    leafId,
    clientId,
    pushViewport,
    setReplayBoundary,
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
