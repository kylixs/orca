import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TabGroupLayoutNode } from '../../shared/tab-types'

type MobileSessionTabGroupLayout = Pick<
  RuntimeMobileSessionTabsSnapshot,
  'tabGroups' | 'tabGroupLayout'
>

// Why: a stale renderer still holds the pre-split tree, while a host-side
// headless move only reshuffles tabs between existing groups. Comparing group
// ids + tree shape catches exactly the "collapsed back to one group" case and
// ignores preserved-tab membership, tab order, active state, and versions.
export function getMobileSessionTabGroupLayoutSignature(
  layout: MobileSessionTabGroupLayout
): string {
  const groupIds = (layout.tabGroups ?? []).map((group) => group.id).sort()
  return `${groupIds.join('\u0001')}|${serializeTabGroupLayout(layout.tabGroupLayout)}`
}

// Why: tell "the renderer authored this layout" apart from "the renderer's
// content changed". Includes group ids, ordered tabOrder (parent/unified ids —
// stable across terminal leaf rebuilds), and the tree shape; excludes focus
// fields and recentTabIds so a click never looks like a layout takeover.
export function getMobileSessionAuthoredLayoutDigest(layout: MobileSessionTabGroupLayout): string {
  const groups = [...(layout.tabGroups ?? [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((group) => `${group.id}\u0001${group.tabOrder.join('\u0002')}`)
  return `${groups.join('\u0003')}|${serializeTabGroupLayout(layout.tabGroupLayout)}`
}

function serializeTabGroupLayout(node: TabGroupLayoutNode | null | undefined): string {
  if (!node) {
    return ''
  }
  if (node.type === 'leaf') {
    return `leaf:${node.groupId}`
  }
  return `split:${node.direction}(${serializeTabGroupLayout(node.first)},${serializeTabGroupLayout(node.second)})`
}
