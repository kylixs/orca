import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { describe, expect, it, vi } from 'vitest'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'

describe('terminal rename before renderer graph hydration', () => {
  it.each(['Media Engine Orch', null])(
    'persists and forwards title %s across PTY replacement',
    async (title) => {
      const session = makeWorkspaceSessionWithHeadlessTerminal()
      session.tabsByWorktree[TEST_WORKTREE_ID][0].customTitle = 'Previous name'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
      const checkedStore = runtimeStore as RuntimeStore
      const runtime = new OrcaRuntimeService(checkedStore)
      const renameTerminal = vi.fn()
      runtime.setPtyController({
        spawn: vi.fn(async () => ({ id: 'omp-initial-pty' })),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        splitTerminal: vi.fn(),
        renameTerminal,
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })

      await runtime.renameTerminal(created.handle, title)

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle).toBe(title)
      expect(renameTerminal).toHaveBeenCalledWith('host-tab', title)
      // Why: a headless host restart has no PTY exit event. Simulating the replacement with
      // onPtyExit would retire the durable row (a different lifecycle; see the certified-exit
      // test below), so a new runtime re-attaches the same tab and spawns the replacement PTY.
      const restored = new OrcaRuntimeService(checkedStore)
      restored.setPtyController({
        spawn: vi.fn(async () => ({ id: 'omp-replacement-pty' })),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      await restored.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle).toBe(title)
    }
  )
  it('retires the durable row when a certified PTY exit is observed', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    session.tabsByWorktree[TEST_WORKTREE_ID][0].customTitle = 'Retired name'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
    const checkedStore = runtimeStore as RuntimeStore
    const runtime = new OrcaRuntimeService(checkedStore)
    runtime.setNotifier(createMobileCreateTestNotifier(vi.fn()))
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'omp-initial-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    await runtime.renameTerminal(created.handle, 'Retired name')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle).toBe('Retired name')

    await runtime.onPtyExit('omp-initial-pty', 0)

    // Why: a certified exit is absence, not a PTY replacement. The durable row must be retired
    // instead of surviving as a ghost that carries the manual title into a later process.
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
  })
  it('does not recreate a closed persisted tab from a surviving PTY record', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Shared fixture implements RuntimeStore; its legacy Mock typing loses callable signatures.
    const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
    const notifier = createMobileCreateTestNotifier(vi.fn())
    runtime.setNotifier(notifier)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'surviving-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    setSession({ ...getSession(), tabsByWorktree: { [TEST_WORKTREE_ID]: [] } })
    runtimeStore.setWorkspaceSession.mockClear()

    await runtime.renameTerminal(created.handle, 'Late rename')

    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(runtimeStore.setWorkspaceSession).not.toHaveBeenCalled()
  })
})
