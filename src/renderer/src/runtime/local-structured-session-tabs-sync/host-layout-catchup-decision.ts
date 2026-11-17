import {
  admitRetiredValueUnderAuthority,
  sameSessionTabsPublicationLineage
} from '../web-session-tabs-sync/publisher-identity-fences'
import type { RetiredValueHistory } from '../web-session-tabs-sync/state'

/**
 * Collapses trigger sources that fire together (focus + visibility resume) into one catch-up.
 * This is not polling: a later lone trigger still runs after the window.
 */
export const DEFAULT_CATCHUP_COALESCE_MS = 500

export type HostLayoutCatchupAction = 'apply' | 'skip' | 'defer'

export type HostLayoutCatchupReason =
  | 'ready'
  | 'web-client'
  | 'workspace-session-not-ready'
  | 'not-local-execution-host'
  | 'window-not-focused-or-visible'
  | 'gesture-active'
  | 'catchup-in-flight'
  | 'pending-publish'
  | 'host-layout-unreported'
  | 'host-layout-empty'
  | 'recently-caught-up'

/**
 * The host layout fields the catch-up reads. `hostLayout === undefined` means the host never
 * answered; an explicit `{ tabGroups: [] }` is an answer and must not be conflated with silence.
 */
export type CatchupHostLayout = {
  tabGroups?: readonly unknown[]
  tabGroupLayout?: unknown
}

export type HostLayoutCatchupDecisionInput = {
  /** True only when this trigger may rearrange: focused, or the single visibility-resume run. */
  windowFocusedVisible: boolean
  hostLayout: CatchupHostLayout | undefined
  pendingPublish: boolean
  gestureActive: boolean
  lastCatchupAt?: number | null
  now: number
  inFlight: boolean
  /** C1; defaults to local because the hook only mounts in the desktop main window. */
  executionHostIsLocal?: boolean
  /** C8; the browser client never adopts the desktop host's layout. */
  isWebClient?: boolean
  /** C8; queue one catch-up from the ready false→true edge. */
  workspaceSessionReady?: boolean
  coalesceWindowMs?: number
}

export type HostLayoutCatchupDecision = {
  action: HostLayoutCatchupAction
  reason: HostLayoutCatchupReason
}

function hasAdoptableHostLayout(layout: CatchupHostLayout): boolean {
  const groups = layout.tabGroups
  const hasGroups = groups !== undefined && groups.length > 0
  return hasGroups || layout.tabGroupLayout !== undefined
}

/**
 * C1–C8 decision only. C4 (multi-window authority) is structural: the hook mounts only on the
 * main app-shell, so it is not an input here.
 */
export function decideHostLayoutCatchup(
  input: HostLayoutCatchupDecisionInput
): HostLayoutCatchupDecision {
  if (input.isWebClient === true) {
    return { action: 'skip', reason: 'web-client' }
  }
  if (input.workspaceSessionReady === false) {
    return { action: 'skip', reason: 'workspace-session-not-ready' }
  }
  if (input.executionHostIsLocal === false) {
    return { action: 'skip', reason: 'not-local-execution-host' }
  }
  if (!input.windowFocusedVisible) {
    return { action: 'skip', reason: 'window-not-focused-or-visible' }
  }
  // Why before defer: a gesture is user intent, and a queued rerun could land mid-drag.
  if (input.gestureActive) {
    return { action: 'skip', reason: 'gesture-active' }
  }
  if (input.pendingPublish) {
    return { action: 'defer', reason: 'pending-publish' }
  }
  if (input.inFlight) {
    return { action: 'defer', reason: 'catchup-in-flight' }
  }
  if (input.hostLayout === undefined) {
    return { action: 'skip', reason: 'host-layout-unreported' }
  }
  // Why two reasons: silence (undefined above) is not an answer, while an explicit empty layout
  // means the host has nothing to adopt — and must not be mistaken for "unreported".
  if (!hasAdoptableHostLayout(input.hostLayout)) {
    return { action: 'skip', reason: 'host-layout-empty' }
  }
  const lastCatchupAt = input.lastCatchupAt
  const coalesceWindowMs = input.coalesceWindowMs ?? DEFAULT_CATCHUP_COALESCE_MS
  if (lastCatchupAt != null && input.now - lastCatchupAt < coalesceWindowMs) {
    return { action: 'skip', reason: 'recently-caught-up' }
  }
  return { action: 'apply', reason: 'ready' }
}

export type CatchupLocalCursor = {
  publicationEpoch: string
  snapshotVersion: number
}

export type CatchupFreshnessInput = {
  /** `localStructuredSessionEpochHistoryByWorktree` for the worktree; never mutated here. */
  history: RetiredValueHistory | undefined
  /** The locally applied publication cursor, if any. */
  version: CatchupLocalCursor | undefined
  /** The `session.tabs.list` reply's publication epoch. */
  epoch: string
  /** The reply's snapshot version. */
  replySnapshotVersion: number
  /** `session.tabs.list` is an authoritative host read; callers may opt out for tests. */
  authoritative?: boolean
}

export type CatchupFreshnessReason =
  | 'no-local-cursor'
  | 'cross-lineage'
  | 'same-lineage-newer'
  | 'same-lineage-not-newer'
  | 'retired-epoch'

export type CatchupFreshnessVerdict = {
  action: 'apply' | 'skip'
  reason: CatchupFreshnessReason
  /**
   * True when applying must un-retire `epoch` in the shared history. This function is pure, so
   * the caller performs that write with `admitRetiredValueUnderAuthority(history, epoch, true)`.
   */
  revivesEpoch: boolean
}

function cloneHistory(history: RetiredValueHistory): RetiredValueHistory {
  return { current: history.current, retired: [...history.retired] }
}

/**
 * C7 frozen semantics: same lineage compares versions; a new lineage is always admitted because
 * epochs are opaque and have no total order. A retired epoch is admitted only by authority.
 */
export function catchupFreshnessVerdict(input: CatchupFreshnessInput): CatchupFreshnessVerdict {
  const { history, version, epoch, replySnapshotVersion } = input
  const authoritative = input.authoritative ?? true
  if (version && sameSessionTabsPublicationLineage(version.publicationEpoch, epoch)) {
    return replySnapshotVersion <= version.snapshotVersion
      ? { action: 'skip', reason: 'same-lineage-not-newer', revivesEpoch: false }
      : { action: 'apply', reason: 'same-lineage-newer', revivesEpoch: false }
  }
  const wasRetired = history?.retired.includes(epoch) ?? false
  // Run the shared fence on a copy so `authoritative` reproduces the un-retire decision without
  // mutating the history table the caller owns.
  const admitted =
    !wasRetired || history === undefined
      ? true
      : admitRetiredValueUnderAuthority(cloneHistory(history), epoch, authoritative)
  if (!admitted) {
    return { action: 'skip', reason: 'retired-epoch', revivesEpoch: false }
  }
  return {
    action: 'apply',
    reason: version ? 'cross-lineage' : 'no-local-cursor',
    revivesEpoch: wasRetired && authoritative
  }
}

export type CatchupSingleFlightRun<T> = {
  status: 'ran' | 'merged'
  completion: Promise<T>
}

export type CatchupSingleFlight<T> = {
  readonly inFlight: boolean
  readonly trailingScheduled: boolean
  /**
   * Runs `task` now, or merges the trigger into one trailing run. Merged calls keep only the
   * latest task; there is no queue and no polling. Failures clear the latch for the next trigger.
   */
  run(task: () => Promise<T>): CatchupSingleFlightRun<T>
}

export function createCatchupSingleFlight<T = unknown>(): CatchupSingleFlight<T> {
  let inFlight = false
  let trailingTask: (() => Promise<T>) | undefined
  let trailingCompletion:
    | { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
    | undefined

  const execute = async (task: () => Promise<T>): Promise<T> => {
    inFlight = true
    try {
      return await task()
    } finally {
      inFlight = false
      const pending = trailingTask
      const completion = trailingCompletion
      trailingTask = undefined
      trailingCompletion = undefined
      if (pending && completion) {
        void execute(pending).then(completion.resolve, completion.reject)
      }
    }
  }

  return {
    get inFlight() {
      return inFlight
    },
    get trailingScheduled() {
      return trailingTask !== undefined
    },
    run(task) {
      if (!inFlight) {
        return { status: 'ran', completion: execute(task) }
      }
      if (!trailingCompletion) {
        let resolve!: (value: T) => void
        let reject!: (error: unknown) => void
        const promise = new Promise<T>((res, rej) => {
          resolve = res
          reject = rej
        })
        trailingCompletion = { promise, resolve, reject }
      }
      trailingTask = task
      return { status: 'merged', completion: trailingCompletion.promise }
    }
  }
}
