import type { TabGroup } from '../../../../shared/tab-types'
import { pickNextActiveTab } from '../../store/slices/tab-group-state'

/** Local focus a layout catch-up must keep. */
export type LocalFocusPin = {
  /** Whether the caller asked to keep local focus. */
  active: boolean
  /** Local unified tab id to keep; null when no local target survives this frame. */
  tabId: string | null
}

/**
 * U163 V3: `preserveLocalFocus` keeps the local active tab, falling back inside its local
 * group by MRU when the host layout dropped it — never to the host's active tab.
 */
export function resolveLocalFocusPin(args: {
  enabled: boolean
  worktreeId: string
  state: {
    activeTabIdByWorktree: Readonly<Record<string, string | null | undefined>>
    activeGroupIdByWorktree: Readonly<Record<string, string | null | undefined>>
    groupsByWorktree: Readonly<Record<string, readonly TabGroup[] | undefined>>
  }
  nextGroups: readonly TabGroup[] | null | undefined
}): LocalFocusPin {
  if (!args.enabled) {
    return { active: false, tabId: null }
  }
  const localTabId = args.state.activeTabIdByWorktree[args.worktreeId] ?? null
  const localGroupId = args.state.activeGroupIdByWorktree[args.worktreeId] ?? null
  const localGroup = localGroupId
    ? args.state.groupsByWorktree[args.worktreeId]?.find((group) => group.id === localGroupId)
    : null
  const inNextGroups = (tabId: string): boolean =>
    args.nextGroups?.some((group) => group.tabOrder.includes(tabId)) ?? false
  const tabId =
    localTabId !== null && inNextGroups(localTabId)
      ? localTabId
      : localGroup
        ? pickNextActiveTab(
            localGroup.tabOrder.filter(inNextGroups),
            localGroup.recentTabIds,
            localTabId ?? ''
          )
        : null
  return { active: true, tabId }
}

/** Group that renders the pinned tab, else the surviving local group, else the first group. */
export function resolveActiveGroupId(args: {
  focusPin: LocalFocusPin
  clientOwnedGroupId: string | null | undefined
  localActiveGroupId: string | null | undefined
  nextGroups: readonly TabGroup[] | null | undefined
  nextActiveUnifiedTabId: string | null
  snapshotActiveGroupId: string | null | undefined
}): string | null {
  if (!args.focusPin.active) {
    if (args.clientOwnedGroupId !== undefined) {
      return args.clientOwnedGroupId
    }
    return (
      args.nextGroups?.find((group) => group.activeTabId === args.nextActiveUnifiedTabId)?.id ??
      args.nextGroups?.find((group) => group.id === args.snapshotActiveGroupId)?.id ??
      args.nextGroups?.[0]?.id ??
      null
    )
  }
  const { tabId } = args.focusPin
  const pinnedGroupId = tabId
    ? args.nextGroups?.find((group) => group.tabOrder.includes(tabId))?.id
    : null
  if (pinnedGroupId) {
    return pinnedGroupId
  }
  if (
    args.localActiveGroupId &&
    args.nextGroups?.some((group) => group.id === args.localActiveGroupId)
  ) {
    return args.localActiveGroupId
  }
  return args.nextGroups?.[0]?.id ?? null
}
