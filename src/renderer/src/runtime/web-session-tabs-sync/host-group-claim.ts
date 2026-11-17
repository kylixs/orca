import type { RuntimeMobileSessionTabGroup } from '../../../../shared/runtime-types'
import type { TabGroup } from '../../../../shared/tab-types'
import { resolveHostSessionGroupIdForWebSessionGroup } from './tracking-mappings'

export function memberSetKey(tabIds: Iterable<string>): string {
  return [...new Set(tabIds)].sort().join('\u0000')
}

// Why: local-only tabs have no host row, so only the host-backed subset can identify a group.
function localHostBackedMemberSetKey(
  tabOrder: readonly string[],
  hostToLocalTabId: ReadonlyMap<string, string>
): string | null {
  const hostBackedLocalTabIds = new Set(hostToLocalTabId.values())
  const members = tabOrder.filter((tabId) => hostBackedLocalTabIds.has(tabId))
  return members.length > 0 ? memberSetKey(members) : null
}

function hostMemberSetKey(
  tabOrder: readonly string[],
  hostToLocalTabId: ReadonlyMap<string, string>
): string | null {
  const members = tabOrder
    .map((tabId) => hostToLocalTabId.get(tabId))
    .filter((tabId): tabId is string => tabId !== undefined)
  return members.length > 0 ? memberSetKey(members) : null
}

/**
 * U163 B4: the only host group whose host-backed member set exactly equals the local group's,
 * or undefined when none/several match. Pure; V4 preseed and mapping upkeep share it.
 */
export function resolveUniqueHostGroupIdByMemberSet(args: {
  localGroup: Pick<TabGroup, 'tabOrder'>
  hostGroups: readonly RuntimeMobileSessionTabGroup[]
  hostToLocalTabId: ReadonlyMap<string, string>
}): string | undefined {
  const key = localHostBackedMemberSetKey(args.localGroup.tabOrder, args.hostToLocalTabId)
  if (key === null) {
    return undefined
  }
  const idsByMemberSet = new Map<string, string[]>()
  for (const hostGroup of args.hostGroups) {
    const hostKey = hostMemberSetKey(hostGroup.tabOrder, args.hostToLocalTabId)
    if (hostKey !== null) {
      idsByMemberSet.set(hostKey, [...(idsByMemberSet.get(hostKey) ?? []), hostGroup.id])
    }
  }
  // Why: two host groups with the same members are ambiguous; guessing could target the wrong one.
  const matches = idsByMemberSet.get(key)
  return matches?.length === 1 ? matches[0] : undefined
}

/**
 * U163 §6.2: mapped local groups stand for their host group, so they must not be re-added as
 * leftovers. The first local group per host group wins; a mapped host group absent from the
 * frame was deleted by the host and stays out.
 */
export function resolveClaimedLocalGroups(args: {
  environmentId: string
  worktreeId: string
  localGroups: readonly TabGroup[]
  hostGroups: readonly RuntimeMobileSessionTabGroup[]
}): { localGroupByHostGroupId: Map<string, TabGroup>; mappedLocalGroupIds: Set<string> } {
  const scope = { environmentId: args.environmentId, worktreeId: args.worktreeId }
  const frameHostGroupIds = new Set(args.hostGroups.map((group) => group.id))
  const localGroupByHostGroupId = new Map<string, TabGroup>()
  const mappedLocalGroupIds = new Set<string>()
  for (const group of args.localGroups) {
    const hostGroupId = resolveHostSessionGroupIdForWebSessionGroup({ ...scope, groupId: group.id })
    if (hostGroupId === null) {
      continue
    }
    mappedLocalGroupIds.add(group.id)
    if (!frameHostGroupIds.has(hostGroupId)) {
      continue
    }
    const firstClaim = localGroupByHostGroupId.get(hostGroupId)
    if (firstClaim) {
      console.warn(
        `[web-session-tabs-sync] catchup:ambiguous-group-claim: host group ${hostGroupId} is claimed by multiple local groups; keeping ${firstClaim.id}`
      )
      continue
    }
    localGroupByHostGroupId.set(hostGroupId, group)
  }
  return { localGroupByHostGroupId, mappedLocalGroupIds }
}
