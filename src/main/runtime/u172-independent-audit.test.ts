/**
 * U172 v2 independent audit probes (auditor-authored, not the fix author's file).
 *
 * Replays the three user scenarios end-to-end against the public runtime surface,
 * then probes the pending state machine and the move-forwarding gate.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import {
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'
import {
  makeThreeTabHeadlessSession,
  syncRendererSnapshots,
  terminalSnapshotTabs
} from './mobile-session-tab-routing-fixtures.spec'
import {
  getMobileSessionAuthoredLayoutDigest,
  getMobileSessionTabGroupLayoutSignature
} from './mobile-session-tab-group-layout-signature'

const HOST_GROUP_LEFT = 'host-group-left'
const HOST_GROUP_RIGHT = 'host-group-right'

type AcceptedEntry = {
  publicationEpoch: string
  rendererVersion: number
  rendererTabGroupLayoutSignature: string
  rendererAuthoredLayoutDigest?: string
  rendererRawLayoutSignature?: string
  rendererRawLayoutDigest?: string
  hostLayoutAuthorityPending?: boolean
}

type RuntimeInternals = {
  acceptedRendererMobileSnapshotByWorktree: Map<string, AcceptedEntry>
  acceptedRendererMobileSessionLayoutMatchesHost(
    worktreeId: string,
    hostSnapshot: RuntimeMobileSessionTabsSnapshot
  ): boolean
}

function internalsOf(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function makeHostSplitSession() {
  const session = makeThreeTabHeadlessSession()
  session.tabGroups = {
    [TEST_WORKTREE_ID]: [
      { id: HOST_GROUP_LEFT, worktreeId: TEST_WORKTREE_ID, activeTabId: 'host-tab', tabOrder: ['host-tab'] },
      {
        id: HOST_GROUP_RIGHT,
        worktreeId: TEST_WORKTREE_ID,
        activeTabId: 'host-tab-2',
        tabOrder: ['host-tab-2', 'host-tab-3']
      }
    ]
  }
  session.tabGroupLayouts = {
    [TEST_WORKTREE_ID]: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: HOST_GROUP_LEFT },
      second: { type: 'leaf', groupId: HOST_GROUP_RIGHT }
    }
  }
  session.activeGroupIdByWorktree = { [TEST_WORKTREE_ID]: HOST_GROUP_LEFT }
  return session
}

const THREE_TABS = ['host-tab', 'host-tab-2', 'host-tab-3']

function staleOneGroupFrame(
  overrides: Partial<RuntimeMobileSessionTabsSnapshot> = {}
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer-epoch',
    snapshotVersion: 1,
    activeGroupId: 'renderer-group',
    activeTabId: 'host-tab::leaf',
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'renderer-group', activeTabId: 'host-tab', tabOrder: [...THREE_TABS] }
    ],
    tabs: terminalSnapshotTabs(THREE_TABS),
    ...overrides
  }
}

function hostLayoutFrame(version: number): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree: TEST_WORKTREE_ID,
    publicationEpoch: 'renderer-epoch',
    snapshotVersion: version,
    activeGroupId: HOST_GROUP_LEFT,
    activeTabId: 'host-tab::leaf',
    activeTabType: 'terminal',
    tabGroups: [
      { id: HOST_GROUP_LEFT, activeTabId: 'host-tab', tabOrder: ['host-tab'] },
      {
        id: HOST_GROUP_RIGHT,
        activeTabId: 'host-tab-2',
        tabOrder: ['host-tab-2', 'host-tab-3']
      }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: HOST_GROUP_LEFT },
      second: { type: 'leaf', groupId: HOST_GROUP_RIGHT }
    },
    tabs: terminalSnapshotTabs(THREE_TABS)
  }
}

async function groupIds(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  return (listed.tabGroups ?? []).map((group) => group.id)
}

async function makeColdStartRuntime() {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(makeHostSplitSession())
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  return runtime
}

describe('U172 v2 scenario a: cold start, persisted 2 groups, stale first frame', () => {
  it('lists the persisted split and keeps it after the stale 1-group frame', async () => {
    const runtime = await makeColdStartRuntime()

    expect(await groupIds(runtime)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])

    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(after.tabGroups?.map((group) => group.id)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
    expect(after.tabGroups?.map((group) => group.tabOrder)).toEqual([
      ['host-tab'],
      ['host-tab-2', 'host-tab-3']
    ])
    expect(after.tabGroupLayout).toMatchObject({ type: 'split', direction: 'horizontal' })
  })
})

describe('U172 v2 scenario b: content-only and focus-only frames after first open', () => {
  it('keeps the host split across a renamed-tab content frame', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const renamed = terminalSnapshotTabs(THREE_TABS)
    renamed[0] = { ...renamed[0]!, title: 'renamed-tab-1' }
    syncRendererSnapshots(runtime, [staleOneGroupFrame({ snapshotVersion: 2, tabs: renamed })])

    expect(await groupIds(runtime)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
  })

  it('keeps the host split across a focus-only frame (active tab moves)', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    syncRendererSnapshots(runtime, [
      staleOneGroupFrame({
        snapshotVersion: 2,
        activeGroupId: 'renderer-group',
        activeTabId: 'host-tab-3::leaf'
      })
    ])

    expect(await groupIds(runtime)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
  })

  it('keeps the host split across content and focus frames sent back to back', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    syncRendererSnapshots(runtime, [
      staleOneGroupFrame({
        snapshotVersion: 2,
        tabs: terminalSnapshotTabs(THREE_TABS).map((tab, index) =>
          index === 0 ? { ...tab, title: 'renamed-later' } : tab
        )
      })
    ])
    syncRendererSnapshots(runtime, [
      staleOneGroupFrame({ snapshotVersion: 3, activeTabId: 'host-tab-2::leaf' })
    ])

    expect(await groupIds(runtime)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
  })
})

describe('U172 v2 scenario c: genuinely new renderer layout must take over', () => {
  it('hands layout authority back when the renderer authors a different tree', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    syncRendererSnapshots(runtime, [
      {
        worktree: TEST_WORKTREE_ID,
        publicationEpoch: 'renderer-epoch',
        snapshotVersion: 2,
        activeGroupId: 'renderer-left',
        activeTabId: 'host-tab::leaf',
        activeTabType: 'terminal',
        tabGroups: [
          { id: 'renderer-left', activeTabId: 'host-tab', tabOrder: ['host-tab', 'host-tab-2'] },
          { id: 'renderer-right', activeTabId: 'host-tab-3', tabOrder: ['host-tab-3'] }
        ],
        tabGroupLayout: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'renderer-left' },
          second: { type: 'leaf', groupId: 'renderer-right' }
        },
        tabs: terminalSnapshotTabs(THREE_TABS)
      }
    ])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(after.tabGroups?.map((group) => group.id)).toEqual(['renderer-left', 'renderer-right'])
    expect(after.tabGroupLayout).toMatchObject({ type: 'split', direction: 'vertical' })
  })

  it('hands layout authority back when only group membership changes', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    // Same group ids/tree as the host, but a different tab order inside a group.
    syncRendererSnapshots(runtime, [
      {
        ...hostLayoutFrame(2),
        tabGroups: [
          { id: HOST_GROUP_LEFT, activeTabId: 'host-tab', tabOrder: ['host-tab', 'host-tab-3'] },
          { id: HOST_GROUP_RIGHT, activeTabId: 'host-tab-2', tabOrder: ['host-tab-2'] }
        ]
      }
    ])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const right = after.tabGroups?.find((group) => group.id === HOST_GROUP_RIGHT)
    expect(right?.tabOrder).toEqual(['host-tab-2'])
    expect(after.tabGroups?.find((group) => group.id === HOST_GROUP_LEFT)?.tabOrder).toEqual([
      'host-tab',
      'host-tab-3'
    ])
  })
})

describe('U172 v2 pending state machine: release conditions', () => {
  it('marks pending on first-open preservation and records the raw renderer frame', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const accepted = internalsOf(runtime).acceptedRendererMobileSnapshotByWorktree.get(
      TEST_WORKTREE_ID
    )
    expect(accepted?.hostLayoutAuthorityPending).toBe(true)
    expect(accepted?.rendererRawLayoutSignature).toBe(
      getMobileSessionTabGroupLayoutSignature(staleOneGroupFrame())
    )
    expect(accepted?.rendererRawLayoutDigest).toBe(
      getMobileSessionAuthoredLayoutDigest(staleOneGroupFrame())
    )
    // The host-seeded baseline stays the host layout, not the renderer frame.
    expect(accepted?.rendererTabGroupLayoutSignature).toBe(
      getMobileSessionTabGroupLayoutSignature({
        tabGroups: hostLayoutFrame(1).tabGroups,
        tabGroupLayout: hostLayoutFrame(1).tabGroupLayout
      })
    )
  })

  it('stays pending across repeated content/focus-only frames (never self-releases)', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    for (let version = 2; version <= 12; version += 1) {
      const tabs = terminalSnapshotTabs(THREE_TABS)
      tabs[0] = { ...tabs[0]!, title: `title-${version}` }
      syncRendererSnapshots(runtime, [
        staleOneGroupFrame({
          snapshotVersion: version,
          tabs,
          activeTabId: version % 2 === 0 ? 'host-tab::leaf' : 'host-tab-2::leaf'
        })
      ])
    }

    const accepted = internalsOf(runtime).acceptedRendererMobileSnapshotByWorktree.get(
      TEST_WORKTREE_ID
    )
    expect(accepted?.hostLayoutAuthorityPending).toBe(true)
    expect(accepted?.rendererVersion).toBe(12)
    expect(await groupIds(runtime)).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
  })

  it('releases pending once the renderer republishes the host layout itself', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const hostSnapshot = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(internalsOf(runtime).acceptedRendererMobileSessionLayoutMatchesHost(TEST_WORKTREE_ID, hostSnapshot)).toBe(false)

    syncRendererSnapshots(runtime, [hostLayoutFrame(2)])

    const accepted = internalsOf(runtime).acceptedRendererMobileSnapshotByWorktree.get(
      TEST_WORKTREE_ID
    )
    expect(accepted?.hostLayoutAuthorityPending).toBeUndefined()
    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(internalsOf(runtime).acceptedRendererMobileSessionLayoutMatchesHost(TEST_WORKTREE_ID, after)).toBe(true)
  })
})

describe('U172 v2 pending + host-side change during pending', () => {
  it('keeps the host-side layout change and pending baseline across a stale content resend', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    // A web/mobile client changes the host layout while desktop is still stale.
    const moveResult = await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: 'host-tab-3',
      targetGroupId: HOST_GROUP_RIGHT,
      splitDirection: 'right'
    })
    expect(moveResult).toEqual({ moved: true })
    const hostAfterMove = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(hostAfterMove.tabGroups?.length).toBe(3)

    // The stale renderer keeps publishing its old 1-group content.
    syncRendererSnapshots(runtime, [staleOneGroupFrame({ snapshotVersion: 2 })])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(after.tabGroups?.map((group) => group.id)).toEqual(
      hostAfterMove.tabGroups?.map((group) => group.id)
    )
    const accepted = internalsOf(runtime).acceptedRendererMobileSnapshotByWorktree.get(
      TEST_WORKTREE_ID
    )
    expect(accepted?.hostLayoutAuthorityPending).toBe(true)
    // The raw baseline is still the renderer's first frame, not the host's new layout.
    expect(accepted?.rendererRawLayoutDigest).toBe(
      getMobileSessionAuthoredLayoutDigest(staleOneGroupFrame())
    )
  })

  it('releases pending when the renderer adopts the changed host layout', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'split',
      tabId: 'host-tab-3',
      targetGroupId: HOST_GROUP_RIGHT,
      splitDirection: 'right'
    })
    const adopted = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    syncRendererSnapshots(runtime, [
      {
        ...staleOneGroupFrame({ snapshotVersion: 2 }),
        tabGroups: adopted.tabGroups,
        tabGroupLayout: adopted.tabGroupLayout,
        activeGroupId: adopted.activeGroupId,
        activeTabId: adopted.activeTabId ?? null,
        activeTabType: adopted.activeTabType ?? null
      }
    ])

    const accepted = internalsOf(runtime).acceptedRendererMobileSnapshotByWorktree.get(
      TEST_WORKTREE_ID
    )
    expect(accepted?.hostLayoutAuthorityPending).toBeUndefined()
    expect(await groupIds(runtime)).toEqual(adopted.tabGroups?.map((group) => group.id))
  })
})

describe('U172 v2 cold-frame-before-hydrate focus consistency', () => {
  it('does not point activeGroupId at a group the retained host layout lacks', async () => {
    const runtime = await makeColdStartRuntime()
    // First publication beats the first list/hydrate.
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const ids = (after.tabGroups ?? []).map((group) => group.id)
    expect(ids).toEqual([HOST_GROUP_LEFT, HOST_GROUP_RIGHT])
    // Invariant: the active group must exist in the returned tree.
    if (after.activeGroupId !== undefined && after.activeGroupId !== null) {
      expect(ids).toContain(after.activeGroupId)
    }
  })
})

describe('U172 v2 move forwarding gate while pending', () => {
  it('blocks renderer forwarding on a stale frame but still applies the move headlessly', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])

    const moveSessionTab = vi.fn().mockResolvedValue(false)
    runtime.setNotifier({ moveSessionTab } as never)

    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(
      internalsOf(runtime).acceptedRendererMobileSessionLayoutMatchesHost(TEST_WORKTREE_ID, before)
    ).toBe(false)

    const result = await runtime.moveMobileSessionTab(`id:${TEST_WORKTREE_ID}`, {
      kind: 'move-to-group',
      tabId: 'host-tab-3',
      targetGroupId: HOST_GROUP_LEFT
    })
    expect(result).toEqual({ moved: true })
    expect(moveSessionTab).not.toHaveBeenCalled()
  })

  it('passes the gate only when the raw renderer signature equals the host signature', async () => {
    const runtime = await makeColdStartRuntime()
    await groupIds(runtime)
    syncRendererSnapshots(runtime, [staleOneGroupFrame()])
    const host = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const gate = internalsOf(runtime).acceptedRendererMobileSessionLayoutMatchesHost.bind(
      internalsOf(runtime)
    )
    expect(gate(TEST_WORKTREE_ID, host)).toBe(false)

    syncRendererSnapshots(runtime, [hostLayoutFrame(2)])
    const after = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(gate(TEST_WORKTREE_ID, after)).toBe(true)
  })
})
