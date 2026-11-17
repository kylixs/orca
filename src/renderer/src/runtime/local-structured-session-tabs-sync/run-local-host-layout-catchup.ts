import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { WorktreeRuntimeOwnerState } from '../../lib/worktree-runtime-owner'
import { getExecutionHostIdForWorktree } from '../../lib/worktree-runtime-owner'
import { useAppStore } from '../../store'
import { applyWebSessionTabsSnapshot } from '../web-session-tabs-sync/snapshot-api'
import { applyWebSessionTabsStorePatch } from '../web-session-tabs-sync/store-patch'
import type { WebSessionTabsSyncState } from '../web-session-tabs-sync/state'
import {
  consumeHostLayoutAdoption,
  requestHostLayoutAdoption
} from '../web-session-tabs-sync/host-layout-adoption'
import { resolveUniqueHostGroupIdByMemberSet } from '../web-session-tabs-sync/host-group-claim'
import {
  resolveHostSessionGroupIdForWebSessionGroup,
  setHostSessionGroupIdMapping
} from '../web-session-tabs-sync/tracking-mappings'
import { admitRetiredValueUnderAuthority } from '../web-session-tabs-sync/publisher-identity-fences'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
import {
  catchupFreshnessVerdict,
  createCatchupSingleFlight,
  decideHostLayoutCatchup,
  type CatchupFreshnessReason,
  type CatchupHostLayout,
  type CatchupSingleFlight,
  type HostLayoutCatchupReason
} from './host-layout-catchup-decision'
import {
  localStructuredSessionEpochHistoryByWorktree,
  localStructuredSessionVersionByWorktree
} from './inventory-generation-fence'
import { recordAppliedSessionPublication } from './snapshot-apply'

type CatchupState = WebSessionTabsSyncState & WorktreeRuntimeOwnerState

/** Only the request/response envelope fields the executor reads; tests pass a fake here. */
export type LocalHostLayoutCatchupCall = (request: {
  method: string
  params?: unknown
}) => Promise<{ ok: boolean; result?: unknown }>

export type LocalHostLayoutCatchupOutcome =
  | { status: 'applied'; groupCount: number }
  | {
      status: 'skipped'
      reason:
        | HostLayoutCatchupReason
        | 'catchup:unmapped-group'
        | `catchup:freshness:${CatchupFreshnessReason}`
    }
  | { status: 'deferred'; reason: HostLayoutCatchupReason }
  | { status: 'failed'; reason: 'catchup:failed'; error: unknown }

export type RunLocalHostLayoutCatchupArgs = {
  worktreeId: string
  /** Live store read at run time; V5 omits it. Tests pass a fixture and a commit spy. */
  state?: CatchupState
  commit?: (patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>) => void
  /** Trigger guards from V5 (C1–C8); omitted values are treated as permissive. */
  windowFocusedVisible?: boolean
  pendingPublish?: boolean
  gestureActive?: boolean
  executionHostIsLocal?: boolean
  isWebClient?: boolean
  workspaceSessionReady?: boolean
  coalesceWindowMs?: number
  now?: number
  call?: LocalHostLayoutCatchupCall
}

const DEFAULT_COALESCE_WINDOW_MS = 500
const lastCatchupAtByWorktree = new Map<string, number>()
const latchesByWorktree = new Map<string, CatchupSingleFlight<LocalHostLayoutCatchupOutcome>>()

/** Only pre-fetch guards run before the list, so the layout is still unknown; a probe keeps
 *  `decideHostLayoutCatchup` from returning `host-layout-unreported` for that pass. */
const CATCHUP_LAYOUT_PROBE: CatchupHostLayout = { tabGroups: [{ id: 'catchup-probe' }] }

export function resetLocalHostLayoutCatchupForTests(): void {
  lastCatchupAtByWorktree.clear()
  latchesByWorktree.clear()
}

function latchFor(worktreeId: string) {
  let latch = latchesByWorktree.get(worktreeId)
  if (!latch) {
    latch = createCatchupSingleFlight<LocalHostLayoutCatchupOutcome>()
    latchesByWorktree.set(worktreeId, latch)
  }
  return latch
}

function defaultCall(request: {
  method: string
  params?: unknown
}): Promise<{ ok: boolean; result?: unknown }> {
  return window.api.runtime.call(request)
}

function isSessionTabsResult(value: unknown): value is RuntimeMobileSessionTabsResult {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return (
    'tabs' in value &&
    Array.isArray(value.tabs) &&
    'worktree' in value &&
    typeof value.worktree === 'string'
  )
}

/** Desktop local host publishes the renderer's own tab ids, so group members map to themselves. */
function buildLocalHostTabIdIdentityMap(
  state: CatchupState,
  worktreeId: string,
  hostGroups: RuntimeMobileSessionTabsResult['tabGroups']
): Map<string, string> {
  const localTabIds = new Set((state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  const hostToLocalTabId = new Map<string, string>()
  for (const group of hostGroups ?? []) {
    for (const tabId of group.tabOrder) {
      if (localTabIds.has(tabId)) {
        hostToLocalTabId.set(tabId, tabId)
      }
    }
  }
  return hostToLocalTabId
}

function seedHostSessionGroupIdMappings(args: {
  environmentId: string
  worktreeId: string
  state: CatchupState
  hostGroups: RuntimeMobileSessionTabsResult['tabGroups']
  hostToLocalTabId: ReadonlyMap<string, string>
}): boolean {
  const scope = { environmentId: args.environmentId, worktreeId: args.worktreeId }
  const localGroups = args.state.groupsByWorktree[args.worktreeId] ?? []
  const hostGroups = args.hostGroups ?? []
  for (const localGroup of localGroups) {
    if (
      resolveHostSessionGroupIdForWebSessionGroup({ ...scope, groupId: localGroup.id }) !== null
    ) {
      continue
    }
    // Literal id hits need no mapping: the apply path indexes local groups by id.
    if (hostGroups.some((hostGroup) => hostGroup.id === localGroup.id)) {
      continue
    }
    const hostGroupId = resolveUniqueHostGroupIdByMemberSet({
      localGroup,
      hostGroups,
      hostToLocalTabId: args.hostToLocalTabId
    })
    if (hostGroupId !== undefined) {
      setHostSessionGroupIdMapping({ ...scope, groupId: localGroup.id }, hostGroupId)
    }
  }
  // Why: an unresolved host-backed group would be republished as a duplicate, so defer this frame.
  const hostBackedLocalTabIds = new Set(args.hostToLocalTabId.values())
  return localGroups.some(
    (group) =>
      resolveHostSessionGroupIdForWebSessionGroup({ ...scope, groupId: group.id }) === null &&
      group.tabOrder.some((tabId) => hostBackedLocalTabIds.has(tabId))
  )
}

async function runCatchupOnce(
  args: RunLocalHostLayoutCatchupArgs
): Promise<LocalHostLayoutCatchupOutcome> {
  const state = args.state ?? useAppStore.getState()
  const worktreeId = args.worktreeId
  const now = args.now ?? Date.now()
  const guards = {
    windowFocusedVisible: args.windowFocusedVisible ?? true,
    pendingPublish: args.pendingPublish ?? false,
    gestureActive: args.gestureActive ?? false,
    executionHostIsLocal:
      args.executionHostIsLocal ?? getExecutionHostIdForWorktree(state, worktreeId) === 'local',
    isWebClient: args.isWebClient,
    workspaceSessionReady: args.workspaceSessionReady,
    coalesceWindowMs: args.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS,
    now,
    lastCatchupAt: lastCatchupAtByWorktree.get(worktreeId) ?? null
  }

  const preDecision = decideHostLayoutCatchup({
    ...guards,
    hostLayout: CATCHUP_LAYOUT_PROBE,
    inFlight: false
  })
  if (preDecision.action !== 'apply') {
    return preDecision.action === 'skip'
      ? { status: 'skipped', reason: preDecision.reason }
      : { status: 'deferred', reason: preDecision.reason }
  }

  const call = args.call ?? defaultCall
  let reply: RuntimeMobileSessionTabsResult
  try {
    const response = await call({ method: 'session.tabs.list', params: { worktree: worktreeId } })
    if (!response.ok || !isSessionTabsResult(response.result)) {
      throw new Error('session.tabs.list did not return a session-tabs snapshot')
    }
    reply = response.result
  } catch (error) {
    console.warn('[local-host-layout-catchup] catchup:failed', error)
    return { status: 'failed', reason: 'catchup:failed', error }
  }

  const hostLayout: CatchupHostLayout | undefined =
    reply.tabGroups === undefined && reply.tabGroupLayout === undefined
      ? undefined
      : { tabGroups: reply.tabGroups, tabGroupLayout: reply.tabGroupLayout }
  const decision = decideHostLayoutCatchup({ ...guards, hostLayout, inFlight: false })
  if (decision.action !== 'apply') {
    return decision.action === 'skip'
      ? { status: 'skipped', reason: decision.reason }
      : { status: 'deferred', reason: decision.reason }
  }

  try {
    const history = localStructuredSessionEpochHistoryByWorktree.get(worktreeId)
    const verdict = catchupFreshnessVerdict({
      history,
      version: localStructuredSessionVersionByWorktree.get(worktreeId),
      epoch: reply.publicationEpoch,
      replySnapshotVersion: reply.snapshotVersion
    })
    if (verdict.action === 'skip') {
      return { status: 'skipped', reason: `catchup:freshness:${verdict.reason}` }
    }
    // An authoritative read is the only thing that may un-retire a dead generation's epoch.
    if (verdict.revivesEpoch && history) {
      admitRetiredValueUnderAuthority(history, reply.publicationEpoch, true)
    }

    const environmentId = LOCAL_STRUCTURED_SESSION_OWNER
    const hostToLocalTabId = buildLocalHostTabIdIdentityMap(state, worktreeId, reply.tabGroups)
    const hasUnmappedGroup = seedHostSessionGroupIdMappings({
      environmentId,
      worktreeId,
      state,
      hostGroups: reply.tabGroups,
      hostToLocalTabId
    })
    if (hasUnmappedGroup) {
      return { status: 'skipped', reason: 'catchup:unmapped-group' }
    }

    const applyOptions = {
      adoptHostLayout: true,
      layoutOnly: true,
      preserveLocalFocus: true,
      hostTabIdsAreLocalTabIds: true,
      contentScope: 'agent-session' as const
    }
    let nextState: CatchupState = state
    requestHostLayoutAdoption(worktreeId)
    try {
      if (args.commit) {
        const patch = applyWebSessionTabsSnapshot(state, reply, environmentId, now, applyOptions)
        if (patch !== state) {
          args.commit(patch)
          nextState = { ...state, ...patch }
        }
      } else {
        const settle = applyWebSessionTabsStorePatch(
          (current) =>
            applyWebSessionTabsSnapshot(current, reply, environmentId, now, applyOptions),
          { frames: [] }
        )
        settle()
      }
    } finally {
      consumeHostLayoutAdoption(worktreeId)
    }

    recordAppliedSessionPublication(worktreeId, reply)
    lastCatchupAtByWorktree.set(worktreeId, now)
    return {
      status: 'applied',
      groupCount: nextState.groupsByWorktree[worktreeId]?.length ?? 0
    }
  } catch (error) {
    console.warn('[local-host-layout-catchup] catchup:failed', error)
    return { status: 'failed', reason: 'catchup:failed', error }
  }
}

/**
 * One catch-up pass for `worktreeId` (U163 V4): a single authoritative `session.tabs.list`,
 * freshness/version fence, exact-member-set preseed, then the existing layout apply path.
 * Triggers coalesce through one single-flight latch per worktree; failures never throw.
 */
export function runLocalHostLayoutCatchup(
  args: RunLocalHostLayoutCatchupArgs
): Promise<LocalHostLayoutCatchupOutcome> {
  return latchFor(args.worktreeId).run(() => runCatchupOnce(args)).completion
}
