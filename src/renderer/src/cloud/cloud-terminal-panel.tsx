import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import { Badge } from '@/components/ui/badge'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { getTerminalWebglAddonConstructor } from '@/lib/pane-manager/terminal-webgl-addon-loader'
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
import {
  formatTerminalEchoBadge,
  formatTerminalEchoTooltip,
  TerminalEchoLatencyMeter,
  type TerminalEchoStats
} from './cloud-terminal-echo-latency'
import type {
  CloudSubscribeOutcome,
  CloudSubscription,
  CloudSubscriptionCallbacks
} from './use-cloud-session'

/**
 * The live terminal of the admin session page (FR-3.9, prototype P3 center pane).
 *
 * One PTY per mounted panel, created inside the user's own checkout; keystrokes,
 * resizes and output travel the cloud link — `terminal.create/send/updateViewport/
 * close` over the rpc and `terminal.subscribe` over the bridge's stream. The
 * xterm instance outlives a dropped stream, so a reconnect repaints the host's
 * snapshot into the kept buffer instead of starting a new shell.
 */

export type CloudTerminalSubscribe = (
  method: string,
  params: Record<string, unknown>,
  callbacks: CloudSubscriptionCallbacks
) => Promise<CloudSubscribeOutcome>

export type CloudTerminalPanelProps = {
  rpc: CloudRpc
  subscribe: CloudTerminalSubscribe
  /** The user's checkout, as returned by `cloud:openWorkspace`. */
  workspacePath: string
  /** `terminal.create` title; one PTY per mounted tab (design §4.5). */
  title?: string
  /**
   * False while an inactive tab keeps the pane mounted but hidden. Fit and
   * viewport updates are skipped until activation (design §4.5).
   */
  active?: boolean
  /**
   * §4.3: `leave-running` unmounts the xterm and stream but keeps the host PTY
   * (overlay suspend); the default closes it, as a tab close does.
   */
  detachPolicy?: 'close-on-unmount' | 'leave-running'
  /** Consulted at unmount; the suspend intent lands after the last render. */
  detachPolicyResolver?: () => 'close-on-unmount' | 'leave-running'
}

type PanelState =
  | { kind: 'booting' }
  | { kind: 'live' }
  | { kind: 'reconnecting'; code: string | null }
  | { kind: 'failed'; code: string }

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

export function CloudTerminalPanel({
  rpc,
  subscribe,
  workspacePath,
  title = 'cloud-admin',
  active = true,
  detachPolicy = 'close-on-unmount',
  detachPolicyResolver
}: CloudTerminalPanelProps): React.JSX.Element {
  // U84a observation: one meter per panel (one PTY); it only timestamps keys
  // and the write callbacks xterm already runs, never the data path itself.
  const echoMeter = React.useMemo(() => new TerminalEchoLatencyMeter({ label: title }), [title])
  const [echoStats, setEchoStats] = React.useState<TerminalEchoStats>(() => echoMeter.stats())
  const [state, setState] = React.useState<PanelState>({ kind: 'booting' })
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const handleRef = React.useRef<string | null>(null)
  const retryRef = React.useRef<(() => void) | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const activeRef = React.useRef(active)
  // Whether the pane has been hidden at least once since mount; the initial fit
  // belongs to the creation effect, not to an activation transition.
  const wasHiddenRef = React.useRef(!active)
  const clientId = React.useMemo(() => createBrowserUuid(), [])

  const pushViewport = React.useCallback(() => {
    const term = termRef.current
    const handle = handleRef.current
    // A hidden pane's grid is stale; the activation effect refits and republishes.
    if (!activeRef.current || !term || handle === null || !document.contains(hostRef.current)) {
      return
    }
    void rpc('terminal.updateViewport', {
      terminal: handle,
      client: { id: clientId, type: 'desktop' },
      viewport: { cols: term.cols, rows: term.rows }
    })
  }, [rpc, clientId])

  // Why here and not in the creation effect: fit/viewport must follow visibility
  // without rebuilding the xterm instance or its PTY.
  React.useEffect(() => {
    activeRef.current = active
    if (!active) {
      wasHiddenRef.current = true
      return
    }
    if (!wasHiddenRef.current) {
      return
    }
    wasHiddenRef.current = false
    try {
      fitRef.current?.fit()
    } catch {
      /* the pane can be mid-teardown while an observation lands */
    }
    pushViewport()
  }, [active, pushViewport])

  // The terminal is created once per mount; the session effect only writes into it.
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const term = new Terminal(buildDefaultTerminalOptions())
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term

    // Primed by the entry point (web/main.tsx does the same); an unresolved or
    // failing load falls back to the DOM renderer, never an error path.
    const WebglAddonConstructor = getTerminalWebglAddonConstructor()
    let webgl: WebglAddon | null = null
    if (WebglAddonConstructor) {
      try {
        webgl = new WebglAddonConstructor()
        term.loadAddon(webgl)
        webgl.onContextLoss(() => disposeWebgl())
      } catch {
        disposeWebgl()
      }
    }
    function disposeWebgl(): void {
      const attached = webgl
      webgl = null
      try {
        attached?.dispose()
      } catch {
        /* ignore — the DOM renderer takes over */
      }
    }

    const refit = (): void => {
      // Hidden panes report a 0×0 grid; fitting would collapse the PTY.
      if (!activeRef.current) {
        return
      }
      try {
        fit.fit()
      } catch {
        /* the pane can be mid-teardown while an observation lands */
      }
    }
    refit()
    // Why one frame: a drag-resize fires the observer many times a second, and
    // each fit already redraws; the host only needs the settled grid.
    let viewportFrame: number | null = null
    const observer = new ResizeObserver(() => {
      refit()
      if (typeof requestAnimationFrame !== 'function') {
        return
      }
      if (viewportFrame !== null) {
        cancelAnimationFrame(viewportFrame)
      }
      viewportFrame = requestAnimationFrame(() => {
        viewportFrame = null
        pushViewport()
      })
    })
    observer.observe(host)
    return () => {
      observer.disconnect()
      if (viewportFrame !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(viewportFrame)
      }
      disposeWebgl()
      fitRef.current = null
      term.dispose()
      termRef.current = null
    }
  }, [pushViewport])

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
    detachPolicyResolver
  ])

  // Keystrokes name the live handle; a dropping link shows its state instead of
  // throwing into the tree.
  React.useEffect(() => {
    const term = termRef.current
    if (!term) {
      return
    }
    const input = term.onData((data) => {
      const handle = handleRef.current
      if (handle !== null) {
        echoMeter.recordKey()
        void rpc('terminal.send', { terminal: handle, text: data })
      }
    })
    return () => input.dispose()
  }, [rpc, echoMeter])

  const echoBadge = formatTerminalEchoBadge(echoStats)

  return (
    <section
      data-testid="cloud-terminal-panel"
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded border border-border bg-card p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">终端</h2>
        <div className="flex items-center gap-2">
          {echoBadge !== null ? (
            <Badge
              variant="hostContext"
              data-testid="cloud-terminal-echo-latency"
              title={formatTerminalEchoTooltip(echoStats)}
            >
              {echoBadge}
            </Badge>
          ) : null}
          <span className="text-xs text-muted-foreground" data-testid="cloud-terminal-state">
            {state.kind === 'booting'
              ? '正在连接…'
              : state.kind === 'live'
                ? '实时'
                : state.kind === 'reconnecting'
                  ? `已断开，正在重连…${state.code ? `（${state.code}）` : ''}`
                  : `连接失败（${state.code}）`}
          </span>
        </div>
      </div>
      <div
        ref={hostRef}
        data-testid="cloud-terminal-host"
        className="min-h-0 flex-1 overflow-hidden rounded bg-background"
      />
      {state.kind === 'failed' ? (
        <button
          type="button"
          data-testid="cloud-terminal-retry"
          className="self-start rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
          onClick={() => retryRef.current?.()}
        >
          重试
        </button>
      ) : null}
    </section>
  )
}
