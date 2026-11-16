import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabGroup } from '../../../../shared/runtime-types'
import type { TabGroup } from '../../../../shared/tab-types'
import { updateHostSessionGroupIdMappings } from './layout-groups'
import {
  clearWebSessionTabsTrackingForEnvironment,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './tracking-lifecycle'
import {
  resolveHostSessionGroupIdForWebSessionGroup,
  isKnownHostSessionGroupId
} from './tracking-mappings'

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

  it('does not map when two host groups share the same member set', () => {
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-split-a', ['host-a']), hostGroup('host-split-b', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a' })
    )

    // Ambiguous membership is not evidence; picking either group could land the move wrong.
    expect(resolve('local-split')).toBeNull()
  })

  it('re-points a mapping whose host group disappeared to the replacement group', () => {
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-source', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a' })
    )
    expect(resolve('local-split')).toBe('host-source')

    // The host applied the split: the source group is deleted, the split group carries the tab.
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-split-new', ['host-a']), hostGroup('host-other', ['host-b'])],
      hostToLocal({ 'host-a': 'local-a', 'host-b': 'local-b' })
    )

    expect(resolve('local-split')).toBe('host-split-new')
  })

  it('drops a mapping whose host-backed members changed and re-matches', () => {
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-old', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a', 'host-b': 'local-b' })
    )
    record(
      [localGroup('local-split', ['local-a', 'local-b'])],
      [hostGroup('host-old', ['host-a']), hostGroup('host-new', ['host-a', 'host-b'])],
      hostToLocal({ 'host-a': 'local-a', 'host-b': 'local-b' })
    )

    expect(resolve('local-split')).toBe('host-new')
  })

  it('recycles mappings for local groups that disappeared', () => {
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-split', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a', 'host-b': 'local-b' })
    )
    expect(resolve('local-split')).toBe('host-split')

    record(
      [localGroup('local-other', ['local-b'])],
      [hostGroup('host-split', ['host-a']), hostGroup('host-other', ['host-b'])],
      hostToLocal({ 'host-a': 'local-a', 'host-b': 'local-b' })
    )

    expect(resolve('local-split')).toBeNull()
    expect(resolve('local-other')).toBe('host-other')
  })

  it('exposes the last frame’s host group ids and forgets them at teardown', () => {
    record(
      [localGroup('local-split', ['local-a'])],
      [hostGroup('host-split', ['host-a'])],
      hostToLocal({ 'host-a': 'local-a' })
    )

    expect(
      isKnownHostSessionGroupId({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        groupId: 'host-split'
      })
    ).toBe(true)
    expect(
      isKnownHostSessionGroupId({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        groupId: 'local-split'
      })
    ).toBe(false)

    clearWebSessionTabsTrackingForEnvironment(ENVIRONMENT_ID)

    expect(
      isKnownHostSessionGroupId({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        groupId: 'host-split'
      })
    ).toBe(false)
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
