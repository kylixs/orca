import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabGroup } from '../../../../shared/runtime-types'
import type { TabGroup } from '../../../../shared/tab-types'
import {
  buildMirroredHostGroups,
  resolveUniqueHostGroupIdByMemberSet,
  updateHostSessionGroupIdMappings
} from './layout-groups'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './tracking-lifecycle'
import {
  resetHostSessionGroupIdMappingsForTests,
  resolveHostSessionGroupIdForWebSessionGroup,
  setHostSessionGroupIdMapping
} from './tracking-mappings'
import { resetWebSessionReorderIntentForTests } from '../web-session-reorder-intent'

const ENVIRONMENT_ID = 'env-u163'
const WORKTREE_ID = 'wt-u163'
const SCOPE = { environmentId: ENVIRONMENT_ID, worktreeId: WORKTREE_ID }

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

function build(
  currentGroups: TabGroup[],
  hostGroups: RuntimeMobileSessionTabGroup[],
  mapping: Map<string, string>,
  validTabIds: readonly string[]
): TabGroup[] | null {
  return buildMirroredHostGroups({
    currentGroups,
    hostGroups,
    hostToLocalTabId: mapping,
    mirroredUnifiedIds: new Set(),
    nextActiveUnifiedTabId: null,
    now: 0,
    validUnifiedTabIds: new Set(validTabIds),
    environmentId: ENVIRONMENT_ID,
    worktreeId: WORKTREE_ID,
    clientGroupIdByLocalTabId: new Map()
  })
}

function resolve(groupId: string): string | null {
  return resolveHostSessionGroupIdForWebSessionGroup({ ...SCOPE, groupId })
}

// Host `h*` tabs mirror to local `t*` tabs; the group ids deliberately never match.
const B4_HOST_GROUPS = [hostGroup('H1', ['h1', 'h2']), hostGroup('H2', ['h3'])]
const B4_HOST_TO_LOCAL = hostToLocal({ h1: 't1', h2: 't2', h3: 't3' })
const B4_VALID_TAB_IDS = ['t1', 't2', 't3'] as const

describe('U163 V2b: claimed local groups', () => {
  beforeEach(() => {
    resetHostSessionGroupIdMappingsForTests()
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebSessionReorderIntentForTests()
  })

  it('B4-a: an already seeded mapping merges the local group into its host group (1→2)', () => {
    setHostSessionGroupIdMapping({ ...SCOPE, groupId: 'local-left' }, 'H1')

    const groups = build(
      [localGroup('local-left', ['t1', 't2'])],
      B4_HOST_GROUPS,
      B4_HOST_TO_LOCAL,
      B4_VALID_TAB_IDS
    )

    expect(groups?.map((group) => group.id)).toEqual(['H1', 'H2'])
    expect(groups?.[0]?.tabOrder).toEqual(['t1', 't2'])
    expect(groups?.[1]?.tabOrder).toEqual(['t3'])
    // The claimed group must not be re-added by the leftover pass.
    expect(groups?.some((group) => group.id === 'local-left')).toBe(false)
    expect(resolve('local-left')).toBe('H1')
  })

  it('B4-b: a unique exact member set is preseeded, then merges (1→2)', () => {
    const localGroups = [localGroup('local-left', ['t1', 't2'])]

    const seeded = resolveUniqueHostGroupIdByMemberSet({
      localGroup: localGroups[0],
      hostGroups: B4_HOST_GROUPS,
      hostToLocalTabId: B4_HOST_TO_LOCAL
    })
    expect(seeded).toBe('H1')
    setHostSessionGroupIdMapping({ ...SCOPE, groupId: 'local-left' }, seeded!)

    const groups = build(localGroups, B4_HOST_GROUPS, B4_HOST_TO_LOCAL, B4_VALID_TAB_IDS)

    expect(groups?.map((group) => group.id)).toEqual(['H1', 'H2'])
    expect(groups?.some((group) => group.id === 'local-left')).toBe(false)
    expect(resolve('local-left')).toBe('H1')
  })

  it('B4-b negative control (unit only): without preseed the same frame yields 1→3', () => {
    // Why: proves the preseed is load-bearing; product paths must never publish this shape.
    const groups = build(
      [localGroup('local-left', ['t1', 't2'])],
      B4_HOST_GROUPS,
      B4_HOST_TO_LOCAL,
      B4_VALID_TAB_IDS
    )

    expect(groups?.map((group) => group.id)).toEqual(['H1', 'H2', 'local-left'])
  })

  it('drops a claimed local group whose host group is absent from the frame', () => {
    setHostSessionGroupIdMapping({ ...SCOPE, groupId: 'local-left' }, 'H-gone')

    const groups = build(
      [localGroup('local-left', ['t1', 't2'])],
      [hostGroup('H2', ['h3'])],
      B4_HOST_TO_LOCAL,
      B4_VALID_TAB_IDS
    )

    // Why: an absent mapped group means the host deleted it; reviving it would duplicate a group.
    expect(groups?.map((group) => group.id)).toEqual(['H2'])
  })

  it('keeps the first local group when two claim the same host group', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    setHostSessionGroupIdMapping({ ...SCOPE, groupId: 'local-first' }, 'H1')
    setHostSessionGroupIdMapping({ ...SCOPE, groupId: 'local-second' }, 'H1')

    const groups = build(
      [localGroup('local-first', ['t1', 't2']), localGroup('local-second', ['t3'])],
      [hostGroup('H1', ['h1', 'h2'])],
      B4_HOST_TO_LOCAL,
      B4_VALID_TAB_IDS
    )

    expect(groups?.map((group) => group.id)).toEqual(['H1'])
    expect(groups?.[0]?.tabOrder).toEqual(['t1', 't2'])
    expect(groups?.some((group) => group.id === 'local-second')).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('catchup:ambiguous-group-claim'))
    warn.mockRestore()
  })

  it('keeps a mapping when the host group still has unresolved members', () => {
    setHostSessionGroupIdMapping({ ...SCOPE, groupId: 'local-left' }, 'H1')

    updateHostSessionGroupIdMappings({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      localGroups: [localGroup('local-left', ['t1', 't2'])],
      hostGroups: [hostGroup('H1', ['h1', 'h2']), hostGroup('H2', ['h9'])],
      // h2 is not mirrored locally yet; dropping it would make the sets look unequal and clear
      // a mapping the next frame may still confirm.
      hostToLocalTabId: hostToLocal({ h1: 't1', h9: 't2' })
    })

    expect(resolve('local-left')).toBe('H1')
  })

  it('still clears a mapping once every host member resolves and the members differ', () => {
    setHostSessionGroupIdMapping({ ...SCOPE, groupId: 'local-left' }, 'H1')

    updateHostSessionGroupIdMappings({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      localGroups: [localGroup('local-left', ['t1'])],
      hostGroups: [hostGroup('H1', ['h1', 'h2'])],
      hostToLocalTabId: B4_HOST_TO_LOCAL
    })

    expect(resolve('local-left')).toBeNull()
  })
})

describe('U163 V2b: resolveUniqueHostGroupIdByMemberSet', () => {
  it('returns the only host group with the same exact member set', () => {
    expect(
      resolveUniqueHostGroupIdByMemberSet({
        localGroup: localGroup('local-left', ['t1', 't2']),
        hostGroups: B4_HOST_GROUPS,
        hostToLocalTabId: B4_HOST_TO_LOCAL
      })
    ).toBe('H1')
  })

  it('refuses an ambiguous member set', () => {
    expect(
      resolveUniqueHostGroupIdByMemberSet({
        localGroup: localGroup('local-left', ['t1', 't2']),
        hostGroups: [hostGroup('H1', ['h1', 'h2']), hostGroup('H2', ['h1', 'h2'])],
        hostToLocalTabId: B4_HOST_TO_LOCAL
      })
    ).toBeUndefined()
  })

  it('refuses when host groups only cover a subset of the local members', () => {
    expect(
      resolveUniqueHostGroupIdByMemberSet({
        localGroup: localGroup('local-left', ['t1', 't2']),
        hostGroups: [hostGroup('H1', ['h1']), hostGroup('H2', ['h2'])],
        hostToLocalTabId: B4_HOST_TO_LOCAL
      })
    ).toBeUndefined()
  })

  it('ignores a local group with no host-backed members', () => {
    expect(
      resolveUniqueHostGroupIdByMemberSet({
        localGroup: localGroup('local-only', ['local-1']),
        hostGroups: [hostGroup('H1', ['h1'])],
        hostToLocalTabId: B4_HOST_TO_LOCAL
      })
    ).toBeUndefined()
  })
})
