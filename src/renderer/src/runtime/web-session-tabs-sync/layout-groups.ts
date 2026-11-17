import type { RuntimeMobileSessionTabGroup } from '../../../../shared/runtime-types'
import type { TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  MirroredAgentTab,
  MirroredBrowserTab,
  MirroredEditorTab,
  TerminalSurface
} from './state'
import { toWebTerminalSurfaceTabId } from '../web-runtime-session'
import {
  clearHostSessionGroupIdMapping,
  clearHostSessionTabIdMappings,
  hostSessionGroupMappingsForWorktree,
  resolveHostSessionGroupIdForWebSessionGroup,
  setHostSessionGroupIdMapping,
  setHostSessionTabIdMapping,
  setKnownHostSessionGroupIds
} from './tracking-mappings'
import { isWebSessionBrowserPlacementGroupReserved } from '../web-session-browser-placement'
import { resolveWebSessionReorderedOrder } from '../web-session-reorder-intent'
import { mapHostRecentTabIds } from './tab-group-layout-tree'
import { pushRecentTabId, sanitizeRecentTabIds } from './state-equality-core'
import {
  memberSetKey,
  resolveClaimedLocalGroups,
  resolveUniqueHostGroupIdByMemberSet
} from './host-group-claim'

export { resolveUniqueHostGroupIdByMemberSet }

export function buildHostToLocalTabIdMap({
  terminalSurfaces,
  terminalTabs,
  browserTabs,
  editorTabs,
  agentTabs
}: {
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
  agentTabs: readonly MirroredAgentTab[]
}): Map<string, string> {
  const hostToLocal = new Map<string, string>()
  const terminalIds = new Set(terminalTabs.map((tab) => tab.id))
  for (const surface of terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (terminalIds.has(localId)) {
      hostToLocal.set(surface.parentTabId, localId)
      hostToLocal.set(surface.id, localId)
    }
  }
  for (const entry of browserTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
    hostToLocal.set(entry.unifiedTab.id, entry.unifiedTab.id)
  }
  for (const entry of editorTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  for (const entry of agentTabs) {
    hostToLocal.set(entry.hostTabId, entry.unifiedTab.id)
  }
  return hostToLocal
}

export function updateHostSessionTabIdMappings(args: {
  environmentId: string
  worktreeId: string
  terminalSurfaces: readonly TerminalSurface[]
  terminalTabs: readonly TerminalTab[]
  browserTabs: readonly MirroredBrowserTab[]
  editorTabs: readonly MirroredEditorTab[]
  agentTabs: readonly MirroredAgentTab[]
}): void {
  clearHostSessionTabIdMappings(args.environmentId, args.worktreeId)

  const mirroredTerminalIds = new Set(args.terminalTabs.map((tab) => tab.id))
  for (const surface of args.terminalSurfaces) {
    const localId = toWebTerminalSurfaceTabId(surface.parentTabId)
    if (mirroredTerminalIds.has(localId)) {
      setHostSessionTabIdMapping({ ...args, tabId: localId }, surface.parentTabId)
    }
  }
  for (const entry of args.browserTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
  for (const entry of args.editorTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
  for (const entry of args.agentTabs) {
    setHostSessionTabIdMapping({ ...args, tabId: entry.unifiedTab.id }, entry.hostTabId)
  }
}

// Why: match a client-owned group to the host group it became by host-backed membership,
// so a later mirrored move targets a group the host can actually apply. Mappings are
// re-validated every frame: a group the host deleted or reshaped must not stay pinned.
export function updateHostSessionGroupIdMappings(args: {
  environmentId: string
  worktreeId: string
  localGroups: readonly TabGroup[]
  hostGroups: readonly RuntimeMobileSessionTabGroup[] | undefined
  hostToLocalTabId: ReadonlyMap<string, string>
}): void {
  const scope = { environmentId: args.environmentId, worktreeId: args.worktreeId }
  // Why: an undefined frame means "host layout not reported", not "no host groups" — keep the last known set.
  if (args.hostGroups) {
    setKnownHostSessionGroupIds(
      scope,
      args.hostGroups.map((group) => group.id)
    )
  }
  const hostBackedLocalTabIds = new Set(args.hostToLocalTabId.values())
  const localMemberSet = (tabIds: readonly string[]): Set<string> =>
    new Set(tabIds.filter((tabId) => hostBackedLocalTabIds.has(tabId)))
  const hostGroupById = args.hostGroups
    ? new Map(args.hostGroups.map((group) => [group.id, group]))
    : null
  const localGroupsById = new Map(args.localGroups.map((group) => [group.id, group]))

  for (const [localGroupId, hostGroupId] of hostSessionGroupMappingsForWorktree(
    args.environmentId,
    args.worktreeId
  )) {
    const localGroup = localGroupsById.get(localGroupId)
    if (!localGroup) {
      // Why: the local group is gone (split closed, last tab moved); the mapping is garbage.
      clearHostSessionGroupIdMapping({ ...scope, groupId: localGroupId })
      continue
    }
    if (!hostGroupById) {
      continue
    }
    const hostGroup = hostGroupById.get(hostGroupId)
    const hostMembers = hostGroup
      ? localMemberSet(
          hostGroup.tabOrder
            .map((tabId) => args.hostToLocalTabId.get(tabId))
            .filter((tabId): tabId is string => tabId !== undefined)
        )
      : null
    // Why: same rule as the create side below — a host group with no host-backed members identifies nothing.
    if (!hostMembers || hostMembers.size === 0) {
      clearHostSessionGroupIdMapping({ ...scope, groupId: localGroupId })
      continue
    }
    // Why: P1-6 — an unmirrored host member may arrive next frame; dropping it would fabricate a mismatch.
    if (hostGroup?.tabOrder.some((tabId) => !args.hostToLocalTabId.has(tabId))) {
      continue
    }
    if (memberSetKey(hostMembers) !== memberSetKey(localMemberSet(localGroup.tabOrder))) {
      clearHostSessionGroupIdMapping({ ...scope, groupId: localGroupId })
    }
  }

  if (!args.hostGroups || args.hostGroups.length === 0) {
    return
  }
  for (const localGroup of args.localGroups) {
    if (resolveHostSessionGroupIdForWebSessionGroup({ ...scope, groupId: localGroup.id })) {
      continue
    }
    const hostGroupId = resolveUniqueHostGroupIdByMemberSet({
      localGroup,
      hostGroups: args.hostGroups,
      hostToLocalTabId: args.hostToLocalTabId
    })
    if (hostGroupId !== undefined) {
      setHostSessionGroupIdMapping({ ...scope, groupId: localGroup.id }, hostGroupId)
    }
  }
}

export function retainClientPlacedMirroredTabs(args: {
  groups: readonly TabGroup[]
  mirroredUnifiedIds: ReadonlySet<string>
  validUnifiedTabIds: ReadonlySet<string>
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
  nextActiveUnifiedTabId: string | null
}): TabGroup[] {
  return args.groups.map((group) => {
    const retainedTabOrder = group.tabOrder.filter(
      (tabId) =>
        args.validUnifiedTabIds.has(tabId) &&
        (!args.mirroredUnifiedIds.has(tabId) ||
          args.clientGroupIdByLocalTabId.get(tabId) === group.id)
    )
    const placedTabIds = [...args.clientGroupIdByLocalTabId]
      .filter(
        ([tabId, groupId]) =>
          groupId === group.id &&
          args.validUnifiedTabIds.has(tabId) &&
          !retainedTabOrder.includes(tabId)
      )
      .map(([tabId]) => tabId)
    const tabOrder = [...retainedTabOrder, ...placedTabIds]
    const activeTabId =
      args.nextActiveUnifiedTabId && tabOrder.includes(args.nextActiveUnifiedTabId)
        ? args.nextActiveUnifiedTabId
        : group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
    return {
      ...group,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, tabOrder), activeTabId)
        : []
    }
  })
}

export function buildMirroredHostGroups({
  currentGroups,
  hostGroups,
  hostToLocalTabId,
  mirroredUnifiedIds,
  nextActiveUnifiedTabId,
  now,
  validUnifiedTabIds,
  environmentId,
  worktreeId,
  clientGroupIdByLocalTabId
}: {
  currentGroups: readonly TabGroup[]
  hostGroups: readonly RuntimeMobileSessionTabGroup[]
  hostToLocalTabId: ReadonlyMap<string, string>
  mirroredUnifiedIds: ReadonlySet<string>
  nextActiveUnifiedTabId: string | null
  now: number
  validUnifiedTabIds: ReadonlySet<string>
  environmentId: string
  worktreeId: string
  clientGroupIdByLocalTabId: ReadonlyMap<string, string>
}): TabGroup[] | null {
  const strippedGroups = retainClientPlacedMirroredTabs({
    groups: currentGroups,
    mirroredUnifiedIds,
    validUnifiedTabIds,
    clientGroupIdByLocalTabId,
    nextActiveUnifiedTabId
  })
  const groupsById = new Map(strippedGroups.map((group) => [group.id, group]))
  const orderedGroups: TabGroup[] = []
  const seen = new Set<string>()

  // Why: U163 — a mapped local group already stands for its host group; treating it as leftover duplicates the group.
  const { localGroupByHostGroupId: claimedLocalGroupByHostGroupId, mappedLocalGroupIds } =
    resolveClaimedLocalGroups({
      environmentId,
      worktreeId,
      localGroups: strippedGroups,
      hostGroups
    })

  for (const hostGroup of hostGroups) {
    const existing =
      groupsById.get(hostGroup.id) ?? claimedLocalGroupByHostGroupId.get(hostGroup.id)
    const localHostOrder = hostGroup.tabOrder
      .map((tabId) => hostToLocalTabId.get(tabId))
      .filter(
        (tabId): tabId is string =>
          tabId !== undefined &&
          validUnifiedTabIds.has(tabId) &&
          !clientGroupIdByLocalTabId.has(tabId)
      )
    const localHostOrderIds = new Set(localHostOrder)
    const hostTabOrder = [
      ...(existing?.tabOrder.filter((tabId) => !localHostOrderIds.has(tabId)) ?? []),
      ...localHostOrder
    ]
    // Why: a pending client reorder wins over a stale pre-move host order until the host echoes the move (or membership changes).
    const tabOrder = resolveWebSessionReorderedOrder(
      { environmentId },
      worktreeId,
      hostGroup.id,
      hostTabOrder,
      now
    )
    if (tabOrder.length === 0) {
      continue
    }
    const activeFromHost =
      hostGroup.activeTabId !== null ? (hostToLocalTabId.get(hostGroup.activeTabId) ?? null) : null
    const activeTabId =
      nextActiveUnifiedTabId && tabOrder.includes(nextActiveUnifiedTabId)
        ? nextActiveUnifiedTabId
        : activeFromHost && tabOrder.includes(activeFromHost)
          ? activeFromHost
          : existing?.activeTabId && tabOrder.includes(existing.activeTabId)
            ? existing.activeTabId
            : (tabOrder[0] ?? null)
    orderedGroups.push({
      id: hostGroup.id,
      worktreeId,
      tabOrder,
      activeTabId,
      recentTabIds: activeTabId
        ? pushRecentTabId(
            mapHostRecentTabIds(hostGroup.recentTabIds, hostToLocalTabId, tabOrder),
            activeTabId
          )
        : []
    })
    seen.add(hostGroup.id)
  }

  for (const group of strippedGroups) {
    if (
      !seen.has(group.id) &&
      // Why: claimed groups (present or host-deleted) already have their host group's fate.
      !mappedLocalGroupIds.has(group.id) &&
      (group.tabOrder.length > 0 ||
        isWebSessionBrowserPlacementGroupReserved({ worktreeId, groupId: group.id }))
    ) {
      orderedGroups.push(group)
    }
  }

  return orderedGroups.length > 0 ? orderedGroups : null
}
