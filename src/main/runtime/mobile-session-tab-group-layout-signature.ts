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

function serializeTabGroupLayout(node: TabGroupLayoutNode | null | undefined): string {
  if (!node) {
    return ''
  }
  if (node.type === 'leaf') {
    return `leaf:${node.groupId}`
  }
  return `split:${node.direction}(${serializeTabGroupLayout(node.first)},${serializeTabGroupLayout(node.second)})`
}
