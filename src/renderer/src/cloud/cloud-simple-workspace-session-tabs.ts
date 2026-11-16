/**
 * Host session-tab inventory → simple-workspace tab model (U96 B1, design §2.3).
 *
 * Pure projection/merge: no React, no RPC, no store. The simple workspace is the
 * host session's second client, so its terminal tabs are the host inventory's
 * terminal rows — this module only reshapes them for the existing tabs reducer.
 */

import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-mobile-session-tab-contracts'
import { readArrayValue, readField, readObjectValue, readString } from '../../../shared/json-fields'
import type {
  CloudSimpleWorkspaceTab,
  CloudSimpleWorkspaceTabsState
} from './cloud-simple-workspace-tabs'

export type CloudSimpleHostTerminalTab = {
  /** Host parent tab id; also the simple-workspace tab id. */
  tabId: string
  /** Rendered leaf: active leaf, else the isActive row, else the first row. */
  leafId: string
  /** Host handle when that leaf is ready; null while the host is still restoring a PTY. */
  terminal: string | null
  ptyId: string | null
  title: string
  /** >1 means the host tab is a split; the simple workspace renders only the active leaf. */
  leafCount: number
  order: number
}

/** The notice a refused `session.tabs.close` leaves next to the tab strip. */
export function hostTabCloseRefusalNotice(reason: string | null): string {
  switch (reason) {
    case 'live-host-pty':
      return '桌面端正在使用该终端，无法从云端关闭。'
    case 'retirement-owner':
      return '该终端正由桌面端结束，请稍后重试。'
    case 'stale-terminal':
    case 'stale-publication':
      return '终端状态已变化，请刷新后重试。'
    case 'unknown-liveness':
      return '暂时无法确认终端状态，标签已保留。'
    case null:
    default:
      return '云端无法关闭该终端，标签已保留。'
  }
}

type TerminalRow = RuntimeMobileSessionTerminalClientTab

/** The projection's structural input: a full host snapshot satisfies it. */
export type CloudSimpleHostTabsSnapshot = {
  tabs: readonly RuntimeMobileSessionClientTab[]
  tabGroups?: readonly { tabOrder: readonly string[] }[]
}

function hostTabOrder(snapshot: CloudSimpleHostTabsSnapshot): Map<string, number> {
  const order = new Map<string, number>()
  for (const group of snapshot.tabGroups ?? []) {
    for (const tabId of group.tabOrder) {
      if (!order.has(tabId)) {
        order.set(tabId, order.size)
      }
    }
  }
  return order
}

function pickLeaf(rows: readonly TerminalRow[]): TerminalRow {
  const activeLeafId = rows[0]?.parentLayout?.activeLeafId
  return (
    rows.find((row) => row.leafId === activeLeafId) ?? rows.find((row) => row.isActive) ?? rows[0]
  )
}

/** Project terminal rows into one simple-workspace tab per host parent tab. */
export function hostTerminalTabsFromSnapshot(
  snapshot: CloudSimpleHostTabsSnapshot
): CloudSimpleHostTerminalTab[] {
  const groupOrder = hostTabOrder(snapshot)
  const groups = new Map<string, TerminalRow[]>()
  for (const row of snapshot.tabs) {
    if (row.type !== 'terminal') {
      continue
    }
    const rows = groups.get(row.parentTabId)
    if (rows) {
      rows.push(row)
    } else {
      groups.set(row.parentTabId, [row])
    }
  }

  const projected: CloudSimpleHostTerminalTab[] = []
  let unlisted = groupOrder.size
  for (const [tabId, rows] of groups) {
    const leaf = pickLeaf(rows)
    projected.push({
      tabId,
      leafId: leaf.leafId,
      terminal: leaf.status === 'ready' ? leaf.terminal : null,
      ptyId: leaf.ptyId ?? null,
      title: leaf.title,
      leafCount: rows.length,
      order: groupOrder.get(tabId) ?? unlisted++
    })
  }
  return projected.toSorted((left, right) => left.order - right.order)
}

function toSimpleTab(hostTab: CloudSimpleHostTerminalTab): CloudSimpleWorkspaceTab {
  return {
    id: hostTab.tabId,
    kind: 'terminal',
    title: hostTab.title,
    host: {
      leafId: hostTab.leafId,
      terminal: hostTab.terminal,
      ptyId: hostTab.ptyId,
      leafCount: hostTab.leafCount
    }
  }
}

function sameSimpleTab(left: CloudSimpleWorkspaceTab, right: CloudSimpleWorkspaceTab): boolean {
  if (left.id !== right.id || left.kind !== right.kind || left.title !== right.title) {
    return false
  }
  if (left.kind !== 'terminal' || right.kind !== 'terminal') {
    return true
  }
  if (!left.host || !right.host) {
    return left.host === right.host
  }
  return (
    left.host.leafId === right.host.leafId &&
    left.host.terminal === right.host.terminal &&
    left.host.ptyId === right.host.ptyId &&
    left.host.leafCount === right.host.leafCount
  )
}

/** True for a terminal tab the host inventory has not acknowledged yet. */
function isLocalOnlyTerminal(tab: CloudSimpleWorkspaceTab): boolean {
  return tab.kind === 'terminal' && tab.host === undefined
}

function neighborFallback(
  previousTabs: readonly CloudSimpleWorkspaceTab[],
  activeId: string | null,
  survivingIds: ReadonlySet<string>
): string | null {
  const index = previousTabs.findIndex((tab) => tab.id === activeId)
  if (index === -1) {
    return null
  }
  const right = previousTabs.slice(index + 1).find((tab) => survivingIds.has(tab.id))
  const left = previousTabs
    .slice(0, index)
    .toReversed()
    .find((tab) => survivingIds.has(tab.id))
  return right?.id ?? left?.id ?? null
}

/**
 * Replace host-owned terminal tabs with a fresh projection.
 *
 * Local file/preview/diff tabs always survive; a locally created terminal stays
 * until a snapshot either confirms it (same id, now with `host`) or the caller
 * closes it. Active-tab policy: first snapshot adopts the host active tab, later
 * snapshots keep the local choice unless it vanished (right, then left, then host).
 */
export function mergeHostTabsIntoState(
  state: CloudSimpleWorkspaceTabsState,
  hostTabs: readonly CloudSimpleHostTerminalTab[],
  hostActiveTabId: string | null
): CloudSimpleWorkspaceTabsState {
  const previousById = new Map(state.tabs.map((tab) => [tab.id, tab]))
  const tabs: CloudSimpleWorkspaceTab[] = hostTabs.map((hostTab) => {
    const next = toSimpleTab(hostTab)
    const previous = previousById.get(next.id)
    return previous && sameSimpleTab(previous, next) ? previous : next
  })
  // A local-only terminal whose id the projection now carries is that same tab,
  // confirmed — keeping it would render the shell and its host row twice.
  const projectedIds = new Set(tabs.map((tab) => tab.id))
  tabs.push(
    ...state.tabs.filter(
      (tab) => tab.kind !== 'terminal' || (isLocalOnlyTerminal(tab) && !projectedIds.has(tab.id))
    )
  )

  const survivingIds = new Set(tabs.map((tab) => tab.id))
  let activeId: string | null
  if (!state.hostSynced) {
    activeId =
      (hostActiveTabId && survivingIds.has(hostActiveTabId) ? hostActiveTabId : null) ??
      (state.activeId && survivingIds.has(state.activeId) ? state.activeId : null) ??
      tabs[0]?.id ??
      null
  } else if (state.activeId && survivingIds.has(state.activeId)) {
    activeId = state.activeId
  } else {
    activeId =
      neighborFallback(state.tabs, state.activeId, survivingIds) ??
      (hostActiveTabId && survivingIds.has(hostActiveTabId) ? hostActiveTabId : null) ??
      tabs[0]?.id ??
      null
  }

  const unchanged =
    state.hostSynced === true &&
    activeId === state.activeId &&
    tabs.length === state.tabs.length &&
    tabs.every((tab, index) => sameSimpleTab(tab, state.tabs[index]) && tab === state.tabs[index])
  if (unchanged) {
    return state
  }

  const dirty = Object.fromEntries(
    Object.entries(state.dirty).filter(([id, value]) => value && survivingIds.has(id))
  )
  return { tabs, activeId, dirty, hostSynced: true }
}

/** A `session.tabs.list` reply or stream frame, shape-checked at the wire boundary. */
export type CloudSimpleHostTabsFrame = CloudSimpleHostTabsSnapshot & {
  activeTabId: string | null
}

/**
 * Terminal rows are read-only projections, so entries only need to be objects —
 * the host owns the row schema (the same trust the web mirror applies).
 */
export function readCloudSimpleHostTabsFrame(value: unknown): CloudSimpleHostTabsFrame | null {
  const frame = readObjectValue(value)
  if (frame === null) {
    return null
  }
  const tabs = readArrayValue(readField(frame, 'tabs'))
  if (tabs === null || tabs.some((row) => readObjectValue(row) === null)) {
    return null
  }
  const groups = readArrayValue(readField(frame, 'tabGroups'))
  const tabGroups =
    groups === null
      ? undefined
      : groups.flatMap((group) => {
          const order = readArrayValue(readField(group, 'tabOrder'))
          return order === null
            ? []
            : [{ tabOrder: order.filter((id): id is string => typeof id === 'string') }]
        })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: entries are verified non-null objects above; the host owns the terminal-row field set.
  const rows = tabs as RuntimeMobileSessionClientTab[]
  return {
    tabs: rows,
    ...(tabGroups === undefined ? {} : { tabGroups }),
    activeTabId: readString(frame, 'activeTabId')
  }
}
