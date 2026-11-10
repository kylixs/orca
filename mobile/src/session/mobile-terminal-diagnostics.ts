import {
  getMobileTerminalDiagnosticErrorName,
  logMobileTerminalDiagnostic,
  shortenMobileTerminalDiagnosticId,
  type MobileTerminalDiagnosticDetails
} from './mobile-terminal-diagnostic-log'
import { MobileTerminalLoadTiming } from './mobile-terminal-load-timing'

// Re-exported for existing importers. Named (not `export *`) because the
// RPC-recording loader's CommonJS emit cannot enumerate its module proxy.
export {
  getMobileTerminalDiagnosticErrorName,
  logMobileTerminalDiagnostic,
  shortenMobileTerminalDiagnosticId,
  type MobileTerminalDiagnosticDetails
} from './mobile-terminal-diagnostic-log'

type DiagnosticTab = {
  readonly id: string
  readonly type: string
  readonly isActive: boolean
  readonly terminal?: string | null
}

type DiagnosticTabsSnapshot = {
  readonly publicationEpoch?: string
  readonly snapshotVersion: number
  readonly tabs: readonly DiagnosticTab[]
}

type DiagnosticDimensions = { readonly cols: number; readonly rows: number } | null | undefined

export class MobileTerminalDiagnostics {
  private readonly streamGateByHandle = new Map<string, string>()
  private readonly firstStreamEventSeqByHandle = new Map<string, number>()
  private readonly loadTiming = new MobileTerminalLoadTiming()
  private lastFetchedTabsSignature: string | null = null
  private lastAppliedTabsSignature: string | null = null
  private lastTabsFetchStartAt = 0
  private tabsFetchSkipLogged = false

  clearTerminalCache(): void {
    this.streamGateByHandle.clear()
    this.firstStreamEventSeqByHandle.clear()
    this.loadTiming.clear()
  }

  resetRoute(): void {
    this.clearTerminalCache()
    this.lastFetchedTabsSignature = null
    this.lastAppliedTabsSignature = null
    this.lastTabsFetchStartAt = 0
    this.tabsFetchSkipLogged = false
  }

  terminalUnsubscribed(handle: string): void {
    this.streamGateByHandle.delete(handle)
    this.firstStreamEventSeqByHandle.delete(handle)
    this.loadTiming.forget(handle)
  }

  viewportMeasured(handle: string, dims: DiagnosticDimensions, frameHeight: number): void {
    logMobileTerminalDiagnostic('viewport-measure', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      ok: dims != null,
      cols: dims?.cols,
      rows: dims?.rows,
      frameHeight: Math.round(frameHeight)
    })
  }

  streamSkipped(handle: string, reason: string, isActive: boolean): void {
    if (this.streamGateByHandle.get(handle) === reason) {
      return
    }
    this.streamGateByHandle.set(handle, reason)
    logMobileTerminalDiagnostic('stream-skipped', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      reason,
      isActive
    })
  }

  streamArmed(handle: string, seq: number, viewport: DiagnosticDimensions): void {
    this.streamGateByHandle.delete(handle)
    // T0 for the load cycle: every later phase reports its offset from here.
    this.loadTiming.arm(handle, seq)
    logMobileTerminalDiagnostic('stream-armed', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      hasViewport: viewport != null,
      viewportCols: viewport?.cols,
      viewportRows: viewport?.rows
    })
  }

  firstStreamEvent(handle: string, seq: number, type: unknown): void {
    if (this.firstStreamEventSeqByHandle.get(handle) === seq) {
      return
    }
    this.firstStreamEventSeqByHandle.set(handle, seq)
    this.loadTiming.firstStreamEvent(handle, seq, type)
  }

  scrollbackReceived(handle: string, seq: number, serializedLength: number): void {
    this.loadTiming.scrollbackReceived(handle, seq, serializedLength)
  }

  scrollbackApplied(handle: string, seq: number): void {
    this.loadTiming.scrollbackApplied(handle, seq)
  }

  firstDataAfterHydration(handle: string, seq: number): void {
    this.loadTiming.firstDataAfterHydration(handle, seq)
  }

  streamScrollback(
    handle: string,
    seq: number,
    eventSeq: number | null,
    data: Readonly<Record<string, unknown>>
  ): void {
    logMobileTerminalDiagnostic('stream-scrollback', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      eventSeq,
      cols: typeof data.cols === 'number' ? data.cols : null,
      rows: typeof data.rows === 'number' ? data.rows : null,
      serializedLength: typeof data.serialized === 'string' ? data.serialized.length : 0,
      displayMode: typeof data.displayMode === 'string' ? data.displayMode : null,
      source: typeof data.source === 'string' ? data.source : null,
      scrollbackRows: typeof data.scrollbackRows === 'number' ? data.scrollbackRows : null,
      truncated: data.truncated === true || data.truncatedByByteBudget === true
    })
  }

  streamResubscribing(
    handle: string,
    seq: number,
    dims: { cols: number; rows: number },
    attempt: number,
    delayMs: number
  ): void {
    logMobileTerminalDiagnostic('stream-resubscribe-for-viewport', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      cols: dims.cols,
      rows: dims.rows,
      attempt,
      delayMs
    })
  }

  streamResubscribeHeld(handle: string, seq: number): void {
    logMobileTerminalDiagnostic('stream-resubscribe-held-absent-dims', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq
    })
  }

  streamResubscribeExhausted(handle: string, seq: number, attempts: number): void {
    logMobileTerminalDiagnostic('stream-resubscribe-exhausted', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      attempts
    })
  }

  streamResized(
    handle: string,
    seq: number,
    eventSeq: number | null,
    data: Readonly<Record<string, unknown>>,
    hasRef: boolean
  ): void {
    logMobileTerminalDiagnostic('stream-resized', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      eventSeq,
      cols: typeof data.cols === 'number' ? data.cols : null,
      rows: typeof data.rows === 'number' ? data.rows : null,
      serializedLength: typeof data.serialized === 'string' ? data.serialized.length : 0,
      hasRef
    })
  }

  tabsApplied(
    snapshot: DiagnosticTabsSnapshot,
    tabs: readonly DiagnosticTab[],
    activeTab: DiagnosticTab | null,
    selectionSource: string
  ): void {
    const activeHandle =
      activeTab?.type === 'terminal' && typeof activeTab.terminal === 'string'
        ? activeTab.terminal
        : null
    const appliedSnapshot = { ...snapshot, tabs }
    const signature = [
      appliedSnapshot.publicationEpoch ?? '',
      appliedSnapshot.snapshotVersion,
      activeTab?.id ?? '',
      activeHandle ?? '',
      selectionSource
    ].join(':')
    if (this.lastAppliedTabsSignature === signature) {
      return
    }
    this.lastAppliedTabsSignature = signature
    this.logTabs('tabs-applied', appliedSnapshot, activeTab, activeHandle, { selectionSource })
  }

  tabsFetchSkipped(reason: string): void {
    if (reason === 'already-in-flight' && this.tabsFetchSkipLogged) {
      return
    }
    this.tabsFetchSkipLogged = reason === 'already-in-flight'
    logMobileTerminalDiagnostic('tabs-fetch-skipped', { reason })
  }

  tabsFetchStarted(worktreeId: string): void {
    this.tabsFetchSkipLogged = false
    const now = Date.now()
    if (this.lastFetchedTabsSignature != null && now - this.lastTabsFetchStartAt < 10_000) {
      return
    }
    this.lastTabsFetchStartAt = now
    logMobileTerminalDiagnostic('tabs-fetch-start', {
      worktree: shortenMobileTerminalDiagnosticId(worktreeId)
    })
  }

  tabsFetchFailed(rpcCode: string): void {
    logMobileTerminalDiagnostic('tabs-fetch-rpc-failure', { rpcCode })
  }

  tabsFetchErrored(error: unknown): void {
    logMobileTerminalDiagnostic('tabs-fetch-error', {
      errorName: getMobileTerminalDiagnosticErrorName(error)
    })
  }

  tabsFetchSucceeded(snapshot: DiagnosticTabsSnapshot): void {
    const activeTab = snapshot.tabs.find((tab) => tab.isActive) ?? null
    const signature = [
      snapshot.publicationEpoch ?? '',
      snapshot.snapshotVersion,
      snapshot.tabs.length,
      activeTab?.id ?? '',
      activeTab?.type ?? ''
    ].join(':')
    if (this.lastFetchedTabsSignature === signature) {
      return
    }
    this.lastFetchedTabsSignature = signature
    const activeHandle =
      activeTab?.type === 'terminal' && typeof activeTab.terminal === 'string'
        ? activeTab.terminal
        : null
    this.logTabs('tabs-fetch-success', snapshot, activeTab, activeHandle)
  }

  tabSwitch(tabType: string, tabId: string, pending: boolean, handle?: string): void {
    logMobileTerminalDiagnostic('tab-switch', {
      tabType,
      tab: shortenMobileTerminalDiagnosticId(tabId),
      handle: shortenMobileTerminalDiagnosticId(handle),
      pending
    })
  }

  webViewRef(handle: string, attached: boolean): void {
    logMobileTerminalDiagnostic('webview-ref', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      attached
    })
  }

  webViewReady(handle: string, reload: boolean, isActive: boolean): void {
    logMobileTerminalDiagnostic('webview-ready', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      reload,
      isActive
    })
  }

  private logTabs(
    event: 'tabs-applied' | 'tabs-fetch-success',
    snapshot: DiagnosticTabsSnapshot,
    activeTab: DiagnosticTab | null,
    activeHandle: string | null,
    extra: MobileTerminalDiagnosticDetails = {}
  ): void {
    logMobileTerminalDiagnostic(event, {
      publication: shortenMobileTerminalDiagnosticId(snapshot.publicationEpoch),
      snapshotVersion: snapshot.snapshotVersion,
      tabCount: snapshot.tabs.length,
      terminalTabCount: snapshot.tabs.filter((tab) => tab.type === 'terminal').length,
      pendingTerminalCount: snapshot.tabs.filter(
        (tab) => tab.type === 'terminal' && typeof tab.terminal !== 'string'
      ).length,
      activeTab: shortenMobileTerminalDiagnosticId(activeTab?.id),
      activeType: activeTab?.type ?? null,
      activeHandle: shortenMobileTerminalDiagnosticId(activeHandle),
      ...extra
    })
  }
}
