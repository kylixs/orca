import { useEffect, useRef } from 'react'
import { useAppStore } from '../store'
import type { AppState } from '../store'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '../lib/window-park-visibility'
import { isWebClientLocation } from '../lib/web-client-location'
import { graphState } from '../runtime/sync-runtime-graph/graph-state'
import { isTabDragGestureActive } from '../components/tab-group/tab-drag-gesture-registry'
import {
  decideHostLayoutCatchup,
  type CatchupHostLayout,
  type HostLayoutCatchupDecision
} from '../runtime/local-structured-session-tabs-sync/host-layout-catchup-decision'
import {
  runLocalHostLayoutCatchup,
  type LocalHostLayoutCatchupOutcome,
  type RunLocalHostLayoutCatchupArgs
} from '../runtime/local-structured-session-tabs-sync/run-local-host-layout-catchup'

/** U176: opt-in only — a desktop renderer already adopts host layout on its own. */
export const HOST_LAYOUT_CATCHUP_STORAGE_KEY = 'orca.debug.hostLayoutCatchup'

export function isHostLayoutCatchupEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(HOST_LAYOUT_CATCHUP_STORAGE_KEY) === '1'
  } catch {
    // A blocked storage getter must not break app-shell mounting.
    return false
  }
}

type CatchupStoreState = Pick<AppState, 'activeWorktreeId' | 'workspaceSessionReady'>

/** Pre-fetch probes: the hook only screens C1/C2/C3/C8 before the executor reads the layout. */
const CATCHUP_LAYOUT_PROBE: CatchupHostLayout = { tabGroups: [{ id: 'catchup-probe' }] }

/** C2: any queued or in-flight graph publish must drain before the catch-up fetches. */
function isGraphPublishPending(): boolean {
  return graphState.syncScheduled || graphState.syncInFlight || graphState.syncPendingAfterFlight
}

/**
 * The graph module exposes no "publish settled" event. This is a one-shot settle wait after an
 * explicit defer (never a periodic trigger source), so it only watches the same C2 flags.
 */
function waitForGraphPublishSettled(isPending: () => boolean, onSettled: () => void): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const check = (): void => {
    timer = null
    if (cancelled) {
      return
    }
    if (isPending()) {
      timer = setTimeout(check, 50)
      return
    }
    onSettled()
  }
  timer = setTimeout(check, 0)
  return () => {
    cancelled = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

export type LocalHostLayoutCatchupOptions = {
  getState?: () => CatchupStoreState
  isWindowFocused?: () => boolean
  getVisible?: () => boolean
  subscribeVisibility?: (onChange: () => void) => () => void
  isPublishPending?: () => boolean
  isGestureActive?: () => boolean
  subscribePublishSettled?: (onSettled: () => void) => () => void
  subscribeSystemResumed?: (callback: () => void) => () => void
  /** Wired by `useAppShellServices` to the structured sync's one-shot reconnect signal. */
  subscribeStructuredReconnect?: (callback: () => void) => () => void
  isWebClient?: () => boolean
  decide?: (input: Parameters<typeof decideHostLayoutCatchup>[0]) => HostLayoutCatchupDecision
  runCatchup?: (args: RunLocalHostLayoutCatchupArgs) => Promise<LocalHostLayoutCatchupOutcome>
}

/**
 * U163 V5 trigger hook: focus, visibility resume, online and system resume each run at most one
 * catch-up for the active worktree. Mounted only by `useAppShellServices`; popout windows use a
 * separate root (`popout.tsx` -> DashboardPopoutRoot) and must not adopt the main window's layout.
 *
 * U176: off by default (`orca.debug.hostLayoutCatchup=1` opts in). True-stack runs showed the
 * desktop renderer already adopts the host layout before focus, so the catch-up only paid one
 * `session.tabs.list` per focus with no benefit. Disabled means no listeners, no subscriptions,
 * no store subscription and no executor call; the effect's first line returns.
 */
export function useLocalHostLayoutCatchup(options: LocalHostLayoutCatchupOptions = {}): void {
  const optionsRef = useRef(options)
  optionsRef.current = options
  useEffect(() => {
    if (!isHostLayoutCatchupEnabled()) {
      return
    }
    const options = optionsRef.current
    const isWebClient = options.isWebClient ?? isWebClientLocation
    if (isWebClient()) {
      return
    }

    const getState = options.getState ?? ((): CatchupStoreState => useAppStore.getState())
    const isWindowFocused =
      options.isWindowFocused ??
      ((): boolean => typeof document !== 'undefined' && document.hasFocus())
    const getVisible = options.getVisible ?? getWindowParkVisible
    const subscribeVisibility = options.subscribeVisibility ?? subscribeWindowParkVisibility
    const isPublishPending = options.isPublishPending ?? isGraphPublishPending
    const isGestureActive = options.isGestureActive ?? isTabDragGestureActive
    const subscribePublishSettled =
      options.subscribePublishSettled ??
      ((onSettled: () => void) => waitForGraphPublishSettled(isPublishPending, onSettled))
    const decide = options.decide ?? decideHostLayoutCatchup
    const runCatchup = options.runCatchup ?? runLocalHostLayoutCatchup

    let disposed = false
    let lastVisible = getVisible()
    let unsubscribeSettled: (() => void) | null = null

    const clearSettledWait = (): void => {
      unsubscribeSettled?.()
      unsubscribeSettled = null
    }

    const scheduleSettledRetry = (): void => {
      if (disposed || unsubscribeSettled) {
        return
      }
      unsubscribeSettled = subscribePublishSettled(() => {
        clearSettledWait()
        if (!disposed) {
          void run(isWindowFocused() && getVisible())
        }
      })
    }

    const run = async (windowFocusedVisible: boolean): Promise<void> => {
      const state = getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        return
      }
      const pendingPublish = isPublishPending()
      const gestureActive = isGestureActive()
      const decision = decide({
        windowFocusedVisible,
        hostLayout: CATCHUP_LAYOUT_PROBE,
        pendingPublish,
        gestureActive,
        lastCatchupAt: null,
        now: Date.now(),
        inFlight: false,
        isWebClient: false,
        workspaceSessionReady: state.workspaceSessionReady
      })
      if (decision.action === 'skip') {
        return
      }
      const outcome = await runCatchup({
        worktreeId,
        windowFocusedVisible,
        pendingPublish,
        gestureActive,
        isWebClient: false,
        workspaceSessionReady: state.workspaceSessionReady
      })
      if (!disposed && outcome.status === 'deferred') {
        scheduleSettledRetry()
      }
    }

    const onFocus = (): void => {
      lastVisible = getVisible()
      void run(isWindowFocused() && lastVisible)
    }
    const onVisibilityChange = (): void => {
      const visible = getVisible()
      // Only the false -> true edge: a visible-but-unfocused window must not rearrange.
      if (visible && !lastVisible) {
        // This single visibility-resume run is the one unfocused case allowed to adopt.
        void run(visible)
      }
      lastVisible = visible
    }
    const onRecovery = (): void => {
      void run(isWindowFocused() && getVisible())
    }

    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onRecovery)
    const unsubscribeVisibility = subscribeVisibility(onVisibilityChange)
    const subscribeSystemResumed =
      options.subscribeSystemResumed ??
      ((callback: () => void): (() => void) =>
        typeof window.api?.ui?.onSystemResumed === 'function'
          ? window.api.ui.onSystemResumed(callback)
          : (): void => {})
    const unsubscribeSystemResumed = subscribeSystemResumed(onRecovery)
    const unsubscribeStructuredReconnect =
      options.subscribeStructuredReconnect?.(onRecovery) ?? ((): void => {})

    let wasReady = getState().workspaceSessionReady
    const unsubscribeStore = useAppStore.subscribe((state) => {
      const ready = state.workspaceSessionReady
      if (!wasReady && ready) {
        void run(isWindowFocused() && getVisible())
      }
      wasReady = ready
    })

    return () => {
      disposed = true
      clearSettledWait()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onRecovery)
      unsubscribeVisibility()
      unsubscribeSystemResumed()
      unsubscribeStructuredReconnect()
      unsubscribeStore()
    }
  }, [])
}
