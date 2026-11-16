import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabGroup } from '../../../../shared/runtime-types'
import type { TabGroup } from '../../../../shared/tab-types'
import { updateHostSessionGroupIdMappings } from './layout-groups'
import {
  clearWebSessionTabsTrackingForEnvironment,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './tracking-lifecycle'
import { resolveHostSessionGroupIdForWebSessionGroup } from './tracking-mappings'

const ENVIRONMENT_ID = 'environment-1'
const WORKTREE_ID = 'worktree-1'

function localGroup(id: string, tabOrder: string[]): TabGroup {
  return {
    id,
    worktreeId: WORKTREE_ID,
    activeTabId: tabOrder[0] ?? null,
    tabOrder,
    recentTabIds: []
  }
}

function hostGroup(id: string, tabOrder: string[]): RuntimeMobileSessionTabGroup {
  return { id, tabOrder, activeTabId: tabOrder[0] ?? null, recentTabIds: [] }
}

function hostToLocal(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries))
}

function record(
  localGroups: TabGroup[],
  hostGroups: RuntimeMobileSessionTabGroup[],
  mapping: Map<string, string>
): void {
  updateHostSessionGroupIdMappings({
    environmentId: ENVIRONMENT_ID,
    worktreeId: WORKTREE_ID,
    localGroups,
    hostGroups,
    hostToLocalTabId: mapping
  })
}

function resolve(groupId: string): string | null {
  return resolveHostSessionGroupIdForWebSessionGroup({
    environmentId: ENVIRONMENT_ID,
    worktreeId: WORKTREE_ID,
    groupId
  })
}

describe('host session group id mapping', () => {
  beforeEach(() => resetWebSessionTabsSnapshotFreshnessForTests())

  it('maps a client-owned group to the host group with the same host-backed members', () => {
    const sourceGroup = localGroup('local-source', ['local-a', 'local-only'])
    const splitGroup = localGroup('local-split', ['local-b', 'local-c'])
    record(
      [sourceGroup, splitGroup],
      [hostGroup('host-source', ['host-a']), hostGroup('host-split', ['host-b', 'host-c'])],
      hostToLocal({
        'host-a': 'local-a',
        'host-b': 'local-b',
        'host-c': 'local-c'
      })
    )

    // Local-only tabs are ignored: the host never published them, so they cannot identify a group.
    expect(resolve('local-source')).toBe('host-source')
    expect(resolve('local-split')).toBe('host-split')
  })

  it('does not map a group whose host-backed members match no host group', () => {
    record(
      [localGroup('local-pending', ['local-a'])],
      [hostGroup('host-source', ['host-a', 'host-b'])],
      hostToLocal({ 'host-a': 'local-a', 'host-b': 'local-b' })
    )

    expect(resolve('local-pending')).toBeNull()
  })

  it('keeps the first recorded mapping when a later snapshot disagrees', () => {
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-split-v1', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a' })
    )
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-renamed', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a' })
    )

    expect(resolve('local-split')).toBe('host-split-v1')
  })

  it('drops mappings when the environment tracking is torn down', () => {
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-split', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a' })
    )
    expect(resolve('local-split')).toBe('host-split')

    // Pairing revision changes route through this teardown before a new session is tracked.
    clearWebSessionTabsTrackingForEnvironment(ENVIRONMENT_ID)

    expect(resolve('local-split')).toBeNull()
  })
})
