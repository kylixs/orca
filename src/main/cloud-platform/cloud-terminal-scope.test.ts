import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUD_TERMINAL_HANDLE_METHODS,
  CLOUD_TERMINAL_DENIED_METHODS,
  cloudTerminalScopeOf
} from './cloud-terminal-scope'
import {
  checkCloudRpcPath,
  isCloudPathGuardedMethod,
  type CloudPathGuardRuntime
} from './cloud-path-guard'

/**
 * `terminal` permission alone would let a cloud session open a shell in any
 * checkout on the host and drive any terminal it can name. These pin the table
 * and the two addresses it checks: the worktree a PTY is created in, and the
 * worktree a live handle belongs to.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-terminal-')))
const projectRoot = join(base, 'payment-service')
const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
const otherRoot = join(base, 'other-team')
mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(otherRoot, { recursive: true })

const roots = { projectRoot, workspaceRoot }

/** Handle → worktree. A handle the map does not know is a terminal that exited. */
const terminalWorktrees: Record<string, string> = {
  'term-own': workspaceRoot,
  'term-teammate': otherRoot
}

const runtime: CloudPathGuardRuntime = {
  resolveWorktreeRootPath: async (selector) => {
    // Handle-owned worktrees are addressed by id in the guard, which is the
    // selector the runtime resolves a pty's worktree with.
    const idTarget = selector.startsWith('id:') ? selector.slice(3) : null
    if (idTarget !== null && [projectRoot, workspaceRoot, otherRoot].includes(idTarget)) {
      return idTarget
    }
    if (selector === `path:${projectRoot}`) {
      return projectRoot
    }
    if (selector === `path:${workspaceRoot}`) {
      return workspaceRoot
    }
    if (selector === `path:${otherRoot}`) {
      return otherRoot
    }
    throw new Error('unknown worktree')
  },
  resolveRepoRootPath: async () => {
    throw new Error('not used here')
  },
  resolveTerminalContext: (handle) => {
    const worktreeId = terminalWorktrees[handle]
    return worktreeId === undefined ? null : { worktreeId, connectionId: null }
  }
}

async function check(method: string, params: unknown) {
  return await checkCloudRpcPath({ runtime, roots, method, params })
}

describe('终端方法分类', () => {
  it('三类互斥，且已分类的方法都真的归入其中一类', () => {
    for (const method of CLOUD_TERMINAL_HANDLE_METHODS) {
      expect(CLOUD_TERMINAL_DENIED_METHODS.has(method), method).toBe(false)
      expect(cloudTerminalScopeOf(method), method).toEqual({ kind: 'handle' })
    }
    for (const method of CLOUD_TERMINAL_DENIED_METHODS) {
      expect(cloudTerminalScopeOf(method), method).toMatchObject({ kind: 'deny' })
    }
  })

  it('未分类的 terminal.* 方法默认拒绝，非终端方法不参与', () => {
    expect(cloudTerminalScopeOf('terminal.futureMethod')).toMatchObject({ kind: 'deny' })
    expect(cloudTerminalScopeOf('files.read')).toBeNull()
  })

  it('终端方法都要求经过边界检查', () => {
    expect(isCloudPathGuardedMethod('terminal.create')).toBe(true)
    expect(isCloudPathGuardedMethod('terminal.subscribe')).toBe(true)
    expect(isCloudPathGuardedMethod('terminal.list')).toBe(true)
  })
})

describe('终端地址边界', () => {
  it('在本人工作区创建放行，在他人检出区或共享检出区创建被拒', async () => {
    expect(await check('terminal.create', { worktree: `path:${workspaceRoot}` })).toEqual({
      ok: true
    })

    const teammate = await check('terminal.create', { worktree: `path:${otherRoot}` })
    expect(teammate).toMatchObject({ ok: false, reason: 'workspace_scope' })

    const shared = await check('terminal.create', { worktree: `path:${projectRoot}` })
    expect(shared).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('不指定工作区、或工作区无法解析时拒绝，而不是落到 handler', async () => {
    expect(await check('terminal.create', {})).toMatchObject({
      ok: false,
      reason: 'terminal_worktree_required'
    })
    expect(await check('terminal.create', { worktree: 'path:/nowhere' })).toMatchObject({
      ok: false,
      reason: 'worktree_unknown'
    })
  })

  it('驱动终端按其所属工作区判断：本人的放行，队友的拒绝', async () => {
    expect(await check('terminal.subscribe', { terminal: 'term-own' })).toEqual({ ok: true })
    expect(await check('terminal.send', { terminal: 'term-own', text: 'ls\n' })).toEqual({
      ok: true
    })

    const teammate = await check('terminal.send', { terminal: 'term-teammate', text: 'rm -rf .\n' })
    expect(teammate).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('退订按其 subscriptionId 判断，客户端作用域的复合 id 取终端部分', async () => {
    expect(await check('terminal.unsubscribe', { subscriptionId: 'term-own' })).toEqual({
      ok: true
    })
    expect(await check('terminal.unsubscribe', { subscriptionId: 'term-own:client-1' })).toEqual({
      ok: true
    })
    expect(
      await check('terminal.unsubscribe', { subscriptionId: 'term-teammate:client-1' })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('未知句柄与无名句柄都拒绝', async () => {
    expect(await check('terminal.send', { terminal: 'term-exited' })).toMatchObject({
      ok: false,
      reason: 'terminal_unknown'
    })
    expect(await check('terminal.send', {})).toMatchObject({
      ok: false,
      reason: 'terminal_unknown'
    })
  })

  it('主机无法回答句柄归属时不放行', async () => {
    const blind: CloudPathGuardRuntime = {
      resolveWorktreeRootPath: runtime.resolveWorktreeRootPath,
      resolveRepoRootPath: runtime.resolveRepoRootPath
    }
    expect(
      await checkCloudRpcPath({
        runtime: blind,
        roots,
        method: 'terminal.subscribe',
        params: { terminal: 'term-own' }
      })
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
  })

  it('主机窗口与全车级方法整体拒绝', async () => {
    for (const method of [
      'terminal.list',
      'terminal.closeAll',
      'terminal.focus',
      'terminal.split'
    ]) {
      const decision = await check(method, {})
      expect(decision, method).toMatchObject({ ok: false, reason: 'terminal_host_scope' })
    }
  })
})
