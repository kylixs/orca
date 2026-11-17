import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  clearWebSessionReorderIntent,
  recordWebSessionReorderIntent
} from './web-session-reorder-intent'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from './web-terminal-surface-id'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'

export async function moveWebRuntimeSessionTab(
  args: RuntimeMobileSessionTabMove & {
    worktreeId: string
    environmentId?: string | null
  }
): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  if (args.kind === 'reorder') {
    // Why: record local order synchronously before async host resolution, so a pre-move snapshot can't snap the tab back.
    recordWebSessionReorderIntent(
      intentOwner,
      args.worktreeId,
      args.targetGroupId,
      args.tabOrder,
      Date.now()
    )
  }

  try {
    const {
      hasKnownHostSessionGroups,
      isKnownHostSessionGroupId,
      resolveHostSessionGroupIdForWebSessionGroup,
      resolveHostSessionTabIdForWebSessionTab
    } = await import('./web-session-tabs-sync')
    const state = useAppStore.getState()
    // Why: a paired desktop window owns a native session; it never applies web-session
    // layout frames, so its group ids are client-minted and need resolving against the
    // host inventory by membership before the move can name a group the host knows.
    const tracksHostSessionGroups = hasKnownHostSessionGroups({
      environmentId,
      worktreeId: args.worktreeId
    })
    const resolveHostBackedTabId = (tabId: string): string | null =>
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId,
        worktreeId: args.worktreeId,
        tabId
      }) ??
      (isWebTerminalSurfaceTabId(tabId)
        ? toHostSessionTabId(tabId)
        : tracksHostSessionGroups
          ? null
          : tabId)
    const toHostTabId = (tabId: string): string => resolveHostBackedTabId(tabId) ?? tabId
    const movedHostTabId =
      args.kind === 'reorder' ? resolveHostBackedTabId(args.tabId) : toHostTabId(args.tabId)
    if (!movedHostTabId) {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
      return false
    }
    const reorderedHostTabOrder =
      args.kind === 'reorder'
        ? args.tabOrder
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId))
        : null
    if (reorderedHostTabOrder && !reorderedHostTabOrder.includes(movedHostTabId)) {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
      return false
    }
    const targetHostIndex =
      args.kind === 'move-to-group' && typeof args.index === 'number'
        ? (state.groupsByWorktree?.[args.worktreeId]
            ?.find((group) => group.id === args.targetGroupId)
            ?.tabOrder.slice(0, args.index)
            .map(resolveHostBackedTabId)
            .filter((tabId): tabId is string => Boolean(tabId)).length ?? args.index)
        : args.kind === 'move-to-group'
          ? args.index
          : undefined
    // Why: a client-owned split mints a local group id the host never saw; only a recorded
    // mapping (or a target that is already a host group id) can name a group the host applies.
    // Reorder takes the same path — a reorder inside a client-owned split used to ship the
    // local UUID and fail every time.
    const mappedHostGroupId = resolveHostSessionGroupIdForWebSessionGroup({
      environmentId,
      worktreeId: args.worktreeId,
      groupId: args.targetGroupId
    })
    let hostTargetGroupId =
      mappedHostGroupId ??
      (isKnownHostSessionGroupId({
        environmentId,
        worktreeId: args.worktreeId,
        groupId: args.targetGroupId
      })
        ? args.targetGroupId
        : null)
    if (hostTargetGroupId === null && !tracksHostSessionGroups) {
      hostTargetGroupId = await resolveDesktopHostTargetGroupId({
        kind: args.kind,
        call: callEnvironment,
        worktreeSelector: toRuntimeWorktreeSelector(args.worktreeId),
        movedHostTabId,
        localTargetTabOrder:
          state.groupsByWorktree?.[args.worktreeId]?.find(
            (group) => group.id === args.targetGroupId
          )?.tabOrder ?? null,
        resolveHostTabId: resolveHostBackedTabId
      })
    }
    if (hostTargetGroupId === null) {
      // Why: no verified counterpart means the drop cannot land; mirror reports the refusal.
      if (args.kind === 'reorder') {
        clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
      }
      return false
    }
    const base = {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      tabId: movedHostTabId,
      targetGroupId: hostTargetGroupId
    }
    const move =
      args.kind === 'reorder'
        ? {
            ...base,
            kind: 'reorder' as const,
            // Why: the host reorder API only accepts host tab ids, so local-only tabs must be omitted from the mirrored order.
            tabOrder: reorderedHostTabOrder
          }
        : args.kind === 'split'
          ? {
              ...base,
              kind: 'split' as const,
              splitDirection: args.splitDirection
            }
          : {
              ...base,
              kind: 'move-to-group' as const,
              // Why: web groups can contain local-only tabs, so host insertion indexes count only the filtered host-backed order.
              index: targetHostIndex
            }
    const response = await callEnvironment({
      method: 'session.tabs.move',
      params: move,
      timeoutMs: 15_000
    })
    const result = unwrapRuntimeRpcResult(
      response as RuntimeRpcResponse<RuntimeMobileSessionTabMoveResult>
    )
    if (result.moved === false && args.kind === 'reorder') {
      // Why: a refused reorder must not keep the local order pinned over the host's snapshot.
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
    }
    return result.moved
  } catch (error) {
    if (args.kind === 'reorder') {
      clearWebSessionReorderIntent(intentOwner, args.worktreeId, args.targetGroupId)
    }
    console.warn(
      '[web-runtime-session] failed to move tab:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}

/** Resolve a desktop window's client-minted group id to the host group it mirrors.
 *  A paired desktop never applies web-session frames, so membership in the host
 *  inventory is the only verifiable counterpart. */
async function resolveDesktopHostTargetGroupId(args: {
  kind: RuntimeMobileSessionTabMove['kind']
  call: (callArgs: {
    method: string
    params?: unknown
    timeoutMs?: number
  }) => Promise<RuntimeRpcResponse<unknown>>
  worktreeSelector: string
  movedHostTabId: string
  localTargetTabOrder: readonly string[] | null
  resolveHostTabId: (tabId: string) => string | null
}): Promise<string | null> {
  const response = await args.call({
    method: 'session.tabs.list',
    params: { worktree: args.worktreeSelector },
    timeoutMs: 15_000
  })
  const inventory = unwrapRuntimeRpcResult(
    response as RuntimeRpcResponse<RuntimeMobileSessionTabsResult>
  )
  const groups = inventory.tabGroups ?? []
  if (args.kind !== 'move-to-group') {
    // Why: split/reorder target the group the tab currently occupies on the host;
    // a tab belongs to at most one host group.
    return groups.find((group) => group.tabOrder.includes(args.movedHostTabId))?.id ?? null
  }
  // Why: the local store already moved the tab, but its peers still identify the host
  // group it is being dropped into (the source group excludes them).
  const hostTabIds = new Set(groups.flatMap((group) => group.tabOrder))
  const peers = (args.localTargetTabOrder ?? [])
    .map((tabId) => args.resolveHostTabId(tabId) ?? tabId)
    .filter((tabId) => tabId !== args.movedHostTabId && hostTabIds.has(tabId))
  if (peers.length === 0) {
    return null
  }
  const matches = groups.filter((group) => peers.every((tabId) => group.tabOrder.includes(tabId)))
  return matches.length === 1 ? matches[0].id : null
}
