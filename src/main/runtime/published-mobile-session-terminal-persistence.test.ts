import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { persistPublishedMobileSessionTerminalTab } from './published-mobile-session-terminal-persistence'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const REPO_ID = 'repo-1'
const WORKTREE_ID = `${REPO_ID}::/tmp/wt-cloud`
const TAB_ID = 'cloud-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = `${WORKTREE_ID}@@a1b2c3d4`
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

function layout(leafId: string, ptyId: string) {
  return {
    root: { type: 'leaf' as const, leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function baseSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE_ID]: [] },
    terminalLayoutsByTabId: {}
  }
}

describe('persistPublishedMobileSessionTerminalTab', () => {
  it('appends the terminal row, layout and incarnation into the session', () => {
    const next = persistPublishedMobileSessionTerminalTab({
      session: baseSession(),
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID,
      title: 'Terminal',
      parentLayout: layout(LEAF_ID, PTY_ID),
      incarnationId: 'inc-1'
    })
    expect(next?.tabsByWorktree[WORKTREE_ID]).toMatchObject([
      {
        id: TAB_ID,
        ptyId: PTY_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        customTitle: null,
        sortOrder: 0
      }
    ])
    expect(next?.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: PTY_ID })
    expect(next?.terminalPtyIncarnationsByPaneKey?.[`${TAB_ID}:${LEAF_ID}`]).toBe('inc-1')
  })

  it('is idempotent and preserves a user-customized title on republish', () => {
    const first = persistPublishedMobileSessionTerminalTab({
      session: baseSession(),
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID,
      title: 'Terminal',
      parentLayout: layout(LEAF_ID, PTY_ID),
      incarnationId: 'inc-1'
    })!
    const renamed: WorkspaceSessionState = {
      ...first,
      tabsByWorktree: {
        ...first.tabsByWorktree,
        [WORKTREE_ID]: first.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
          ...tab,
          customTitle: 'My shell'
        }))
      }
    }
    const again = persistPublishedMobileSessionTerminalTab({
      session: renamed,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID,
      title: 'Terminal',
      parentLayout: layout(LEAF_ID, PTY_ID),
      incarnationId: 'inc-1'
    })
    expect(again).toBeNull()
  })

  it('adopts a republished split topology the persisted row has not seen', () => {
    const first = persistPublishedMobileSessionTerminalTab({
      session: baseSession(),
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID,
      title: 'Terminal',
      parentLayout: layout(LEAF_ID, PTY_ID)
    })!
    const splitLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: LEAF_ID },
        second: { type: 'leaf' as const, leafId: OTHER_LEAF_ID }
      },
      activeLeafId: OTHER_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: PTY_ID, [OTHER_LEAF_ID]: `${PTY_ID}-2` }
    }
    const next = persistPublishedMobileSessionTerminalTab({
      session: first,
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: OTHER_LEAF_ID,
      ptyId: `${PTY_ID}-2`,
      title: 'Terminal',
      parentLayout: splitLayout
    })
    expect(next?.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: PTY_ID,
      [OTHER_LEAF_ID]: `${PTY_ID}-2`
    })
  })
})

type RuntimeInternals = {
  publishPtyBackedMobileSessionTerminal: (
    worktreeId: string,
    pty: RuntimePtyWorktreeRecord,
    args: { tabId: string; leafId: string; title: string | null; activate: boolean }
  ) => void
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession: (worktreeId?: string) => Set<string>
  mobileSessionTabsByWorktree: Map<
    string,
    { tabs: readonly { type: string; parentTabId?: string; leafId?: string; ptyId?: string }[] }
  >
  ptysById: Map<string, unknown>
}

function makePty(): RuntimePtyWorktreeRecord {
  // SAFETY: publish only reads ptyId/incarnationId/launchAgent/foregroundAgent off this record.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above; the record is never persisted.
  return {
    ptyId: PTY_ID,
    incarnationId: 'inc-1',
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    paneKey: `${TAB_ID}:${LEAF_ID}`,
    connected: true,
    launchAgent: null,
    foregroundAgent: null
  } as RuntimePtyWorktreeRecord
}

async function createHarness(session: WorkspaceSessionState) {
  const { OrcaRuntimeService } = await import('./orca-runtime')
  const repo = {
    id: REPO_ID,
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getFolderWorkspaces: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    getWorkspaceSessionHostIds: () => ['local'],
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    flushOrThrow: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the store surface this test exercises.
  const runtime = new OrcaRuntimeService(store as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: drives protected runtime methods on the concrete service.
  const internals = runtime as unknown as RuntimeInternals
  const view = makePty()
  internals.ptysById.set(PTY_ID, view)
  return {
    internals,
    session: () => session,
    onSnapshot: (listener: (snapshot: RuntimeMobileSessionTabsResult) => void) =>
      runtime.onMobileSessionTabsChanged(listener)
  }
}

describe('headless publish persistence', () => {
  it('persists the cloud-created tab and restores its inventory after a host restart', async () => {
    const harness = await createHarness(baseSession())
    const pty = makePty()
    harness.internals.publishPtyBackedMobileSessionTerminal(WORKTREE_ID, pty, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      title: 'Terminal',
      activate: true
    })

    const persisted = harness.session()
    expect(persisted.tabsByWorktree[WORKTREE_ID]).toMatchObject([
      { id: TAB_ID, ptyId: PTY_ID, worktreeId: WORKTREE_ID }
    ])
    expect(persisted.terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId).toEqual({ [LEAF_ID]: PTY_ID })

    // A fresh runtime instance over the same durable session models a host restart.
    const restarted = await createHarness(persisted)
    restarted.internals.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE_ID)
    const restored = restarted.internals.mobileSessionTabsByWorktree.get(WORKTREE_ID)
    expect(restored?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'terminal',
          parentTabId: TAB_ID,
          leafId: LEAF_ID,
          ptyId: PTY_ID
        })
      ])
    )
  })
})
