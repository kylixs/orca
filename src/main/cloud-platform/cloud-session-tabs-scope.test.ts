import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-session-contracts'
import { checkCloudRpcPath, isCloudPathGuardedMethod } from './cloud-path-guard'
import { cloudSessionTabsScopeOf } from './cloud-session-tabs-scope'

/**
 * U96 A-2: `terminal` permission now also reaches `session.tabs.*`. The ticket
 * still owns the worktree selector and the tabId, so both are checked against
 * the same workspace root the inventory projection uses.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-session-tabs-')))
const projectRoot = join(base, 'payment-service')
const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
const teammateRoot = join(projectRoot, '.orca-worktrees', 'lisi')
mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(teammateRoot, { recursive: true })

const roots = { projectRoot, workspaceRoot }

function snapshot(worktree: string, tabId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: tabId,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: tabId,
        title: 'shell',
        parentTabId: tabId,
        leafId: 'leaf-1',
        status: 'ready',
        terminal: 'term-1',
        isActive: true
      }
    ]
  }
}

const worktrees: Record<string, string> = {
  [`path:${workspaceRoot}`]: workspaceRoot,
  [`path:${teammateRoot}`]: teammateRoot
}
const snapshots: Record<string, RuntimeMobileSessionTabsResult> = {
  [`path:${workspaceRoot}`]: snapshot(workspaceRoot, 'tab-own'),
  [`path:${teammateRoot}`]: snapshot(teammateRoot, 'tab-teammate')
}

const runtime = {
  resolveWorktreeRootPath: async (selector: string) => {
    const resolved = worktrees[selector]
    if (resolved === undefined) {
      throw new Error('unknown worktree')
    }
    return resolved
  },
  resolveRepoRootPath: async () => {
    throw new Error('not used here')
  },
  listMobileSessionTabs: async (selector: string) => {
    const found = snapshots[selector]
    if (found === undefined) {
      throw new Error('unknown worktree')
    }
    return found
  }
}

async function check(method: string, params: unknown) {
  return await checkCloudRpcPath({ runtime, roots, method, params })
}

describe('session.tabs 方法分类', () => {
  it('按 worktree 与 tab 两级分类，listAll/subscribeAll 不带选择器', () => {
    for (const method of ['session.tabs.list', 'session.tabs.subscribe']) {
      expect(cloudSessionTabsScopeOf(method), method).toEqual({ kind: 'worktree' })
      expect(isCloudPathGuardedMethod(method), method).toBe(true)
    }
    for (const method of ['session.tabs.activate', 'session.tabs.close', 'session.tabs.move']) {
      expect(cloudSessionTabsScopeOf(method), method).toEqual({ kind: 'tab' })
      expect(isCloudPathGuardedMethod(method), method).toBe(true)
    }
    expect(cloudSessionTabsScopeOf('session.tabs.listAll')).toBeNull()
    expect(cloudSessionTabsScopeOf('session.tabs.subscribeAll')).toBeNull()
  })
})

describe('session.tabs 作用域', () => {
  it('本人工作区放行 list/subscribe', async () => {
    expect(await check('session.tabs.list', { worktree: `path:${workspaceRoot}` })).toEqual({
      ok: true
    })
    expect(await check('session.tabs.subscribe', { worktree: `path:${workspaceRoot}` })).toEqual({
      ok: true
    })
  })

  it('无 selector 拒绝', async () => {
    expect(await check('session.tabs.list', {})).toMatchObject({
      ok: false,
      reason: 'worktree_required'
    })
    expect(await check('session.tabs.activate', { tabId: 'tab-own' })).toMatchObject({
      ok: false,
      reason: 'worktree_required'
    })
  })

  it('未知 selector 拒绝', async () => {
    expect(await check('session.tabs.list', { worktree: 'path:/nope' })).toMatchObject({
      ok: false,
      reason: 'worktree_unknown'
    })
  })

  it('越界 worktree 拒绝所有目标方法', async () => {
    for (const method of [
      'session.tabs.list',
      'session.tabs.subscribe',
      'session.tabs.activate',
      'session.tabs.close',
      'session.tabs.move'
    ]) {
      const decision = await check(method, {
        worktree: `path:${teammateRoot}`,
        tabId: 'tab-teammate'
      })
      expect(decision, method).toMatchObject({ ok: false, reason: 'workspace_scope' })
    }
  })

  it('本人工作区与本人 tab 放行 activate/close/move', async () => {
    for (const method of ['session.tabs.activate', 'session.tabs.close', 'session.tabs.move']) {
      const decision = await check(method, {
        worktree: `path:${workspaceRoot}`,
        tabId: 'tab-own'
      })
      expect(decision, method).toEqual({ ok: true })
    }
  })

  it('tabId 不在该工作区的投影清单里时拒绝', async () => {
    for (const method of ['session.tabs.activate', 'session.tabs.close', 'session.tabs.move']) {
      const decision = await check(method, {
        worktree: `path:${workspaceRoot}`,
        tabId: 'tab-teammate'
      })
      expect(decision, method).toMatchObject({ ok: false, reason: 'tab_unknown' })
    }
  })

  it('无 tabId 拒绝', async () => {
    expect(
      await check('session.tabs.activate', { worktree: `path:${workspaceRoot}` })
    ).toMatchObject({ ok: false, reason: 'tab_required' })
  })

  it('主机无法列出该工作区标签时不放行 tab 方法', async () => {
    const blind = {
      resolveWorktreeRootPath: runtime.resolveWorktreeRootPath,
      resolveRepoRootPath: runtime.resolveRepoRootPath
    }
    expect(
      await checkCloudRpcPath({
        runtime: blind,
        roots,
        method: 'session.tabs.activate',
        params: { worktree: `path:${workspaceRoot}`, tabId: 'tab-own' }
      })
    ).toMatchObject({ ok: false, reason: 'tab_unverifiable' })
  })
})
