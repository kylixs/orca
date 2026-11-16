import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import { Badge } from '@/components/ui/badge'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { getTerminalWebglAddonConstructor } from '@/lib/pane-manager/terminal-webgl-addon-loader'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import {
  formatTerminalEchoBadge,
  formatTerminalEchoTooltip,
  TerminalEchoLatencyMeter,
  type TerminalEchoStats
} from './cloud-terminal-echo-latency'
import { CloudTerminalFitOverlay } from './cloud-terminal-fit-overlay'
import {
  CloudTerminalEndedNotice,
  CloudTerminalReplayNotice,
  useCloudTerminalReopen,
  type CloudScrollbackBoundary
} from './cloud-terminal-replay-boundary'
import { useCloudTerminalFitControl } from './use-cloud-terminal-fit-control'
import { useCloudTerminalStreamSession } from './use-cloud-terminal-stream-session'
import type { CloudPanelState } from './cloud-terminal-stream-contracts'
import type { CloudSubscribeOutcome, CloudSubscriptionCallbacks } from './use-cloud-session'

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
  /** Host session-tab id; a reopen recreates the PTY under this same tab. */
  tabId?: string
  /** Host leaf id; absent for the admin page's standalone terminal. */
  leafId?: string
  /**
   * Host projection handle. A string attaches to the host's PTY instead of
   * creating one; null means the host row is still restoring its PTY.
   */
  hostTerminal?: string | null
  /** The host action layer owns PTY creation, so a pane must never create one. */
  hostOwnsPty?: boolean
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

function describePanelState(state: CloudPanelState): string {
  switch (state.kind) {
    case 'booting':
      return '正在连接…'
    case 'live':
      return '实时'
    case 'reconnecting':
      return `已断开，正在重连…${state.code ? `（${state.code}）` : ''}`
    case 'failed':
      return `连接失败（${state.code}）`
    case 'pending':
      return '等待宿主恢复终端…'
    case 'ended':
      return `会话已结束${state.code ? `（${state.code}）` : ''}`
  }
}

export function CloudTerminalPanel({
  rpc,
  subscribe,
  workspacePath,
  title = 'cloud-admin',
  tabId,
  leafId,
  hostTerminal,
  hostOwnsPty = false,
  active = true,
  detachPolicy = 'close-on-unmount',
  detachPolicyResolver
}: CloudTerminalPanelProps): React.JSX.Element {
  // U84a observation: one meter per panel (one PTY); it only timestamps keys
  // and the write callbacks xterm already runs, never the data path itself.
  const echoMeter = React.useMemo(() => new TerminalEchoLatencyMeter({ label: title }), [title])
  const [echoStats, setEchoStats] = React.useState<TerminalEchoStats>(() => echoMeter.stats())
  const [state, setState] = React.useState<CloudPanelState>({
    kind: 'booting'
  })
  const [replayBoundary, setReplayBoundary] = React.useState<CloudScrollbackBoundary | null>(null)
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
  // U96 B-令6 / U98: observe the host's fit floor; takeover is a user gesture.
  const fitControl = useCloudTerminalFitControl({
    rpc,
    active,
    live: state.kind === 'live',
    clientId,
    handleRef,
    termRef
  })
  const { onFitOverrideEvent } = fitControl

  // A-7: an ended session reopens only on a user gesture; the new handle then
  // re-subscribes through the same retry path instead of a blind reconnect.
  const onReopened = React.useCallback((handle: string | null): void => {
    if (handle === null) {
      setState({ kind: 'failed', code: 'terminal_reopen_failed' })
      return
    }
    handleRef.current = handle
    retryRef.current?.()
  }, [])
  const { reopen, pending: reopenPending } = useCloudTerminalReopen({
    rpc,
    workspacePath,
    title,
    tabId,
    leafId,
    onReopened
  })

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

  useCloudTerminalStreamSession({
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
  })

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
      className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2 rounded border border-border bg-card p-3"
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
            {describePanelState(state)}
          </span>
        </div>
      </div>
      {state.kind === 'pending' ? (
        <p data-testid="cloud-terminal-pending" className="text-xs text-muted-foreground">
          正在等待宿主恢复终端…
        </p>
      ) : null}
      <div
        ref={hostRef}
        data-testid="cloud-terminal-host"
        className="min-h-0 flex-1 overflow-hidden rounded bg-background"
      />
      {replayBoundary !== null ? <CloudTerminalReplayNotice boundary={replayBoundary} /> : null}
      {state.kind === 'ended' ? (
        <CloudTerminalEndedNotice pending={reopenPending} onReopen={() => void reopen()} />
      ) : null}
      {fitControl.overlayConflict !== null ? (
        <CloudTerminalFitOverlay
          conflict={fitControl.overlayConflict}
          autoRestoreText={fitControl.autoRestoreText}
          pending={fitControl.pending}
          onTakeOver={fitControl.onTakeOver}
          onKeep={fitControl.onKeep}
        />
      ) : null}
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
