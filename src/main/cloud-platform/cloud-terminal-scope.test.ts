import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUD_TERMINAL_HANDLE_METHODS,
  CLOUD_TERMINAL_DENIED_METHODS,
  CLOUD_TERMINAL_MULTIPLEX_METHODS,
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
/** A second directory inside the same workspace root: still in bound, wrong worktree. */
const nestedRoot = join(workspaceRoot, 'nested')
const otherRoot = join(base, 'other-team')
mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(nestedRoot, { recursive: true })
mkdirSync(otherRoot, { recursive: true })

const roots = { projectRoot, workspaceRoot }

/** Handle → worktree. A handle the map does not know is a terminal that exited. */
const terminalWorktrees: Record<string, string> = {
  'term-own': workspaceRoot,
  'term-nested': nestedRoot,
  'term-teammate': otherRoot
}

const runtime: CloudPathGuardRuntime = {
  resolveWorktreeRootPath: async (selector) => {
    // Handle-owned worktrees are addressed by id in the guard, which is the
    // selector the runtime resolves a pty's worktree with.
    const idTarget = selector.startsWith('id:') ? selector.slice(3) : null
    if (
      idTarget !== null &&
      [projectRoot, workspaceRoot, nestedRoot, otherRoot].includes(idTarget)
    ) {
      return idTarget
    }
    if (selector === `path:${projectRoot}`) {
      return projectRoot
    }
    if (selector === `path:${workspaceRoot}`) {
      return workspaceRoot
    }
    if (selector === `path:${nestedRoot}`) {
      return nestedRoot
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
  it('各类互斥，且已分类的方法都真的归入其中一类', () => {
    for (const method of CLOUD_TERMINAL_HANDLE_METHODS) {
      expect(CLOUD_TERMINAL_DENIED_METHODS.has(method), method).toBe(false)
      expect(CLOUD_TERMINAL_MULTIPLEX_METHODS.has(method), method).toBe(false)
      expect(cloudTerminalScopeOf(method), method).toEqual({ kind: 'handle' })
    }
    for (const method of CLOUD_TERMINAL_DENIED_METHODS) {
      expect(cloudTerminalScopeOf(method), method).toMatchObject({ kind: 'deny' })
    }
    for (const method of CLOUD_TERMINAL_MULTIPLEX_METHODS) {
      expect(CLOUD_TERMINAL_DENIED_METHODS.has(method), method).toBe(false)
      expect(cloudTerminalScopeOf(method), method).toEqual({ kind: 'multiplex' })
    }
  })

  it('未分类的 terminal.* 方法默认拒绝，非终端方法不参与', () => {
    expect(cloudTerminalScopeOf('terminal.futureMethod')).toMatchObject({ kind: 'deny' })
    expect(cloudTerminalScopeOf('files.read')).toBeNull()
  })

  it('清单与孤儿认领受控放行，离开整体拒绝表', () => {
    expect(cloudTerminalScopeOf('terminal.list')).toEqual({ kind: 'list' })
    expect(cloudTerminalScopeOf('terminal.adoptOrphans')).toEqual({ kind: 'adopt' })
    expect(CLOUD_TERMINAL_DENIED_METHODS.has('terminal.list')).toBe(false)
    expect(CLOUD_TERMINAL_DENIED_METHODS.has('terminal.adoptOrphans')).toBe(false)
  })

  it('终端方法都要求经过边界检查', () => {
    expect(isCloudPathGuardedMethod('terminal.create')).toBe(true)
    expect(isCloudPathGuardedMethod('terminal.subscribe')).toBe(true)
    expect(isCloudPathGuardedMethod('terminal.list')).toBe(true)
    expect(isCloudPathGuardedMethod('terminal.adoptOrphans')).toBe(true)
    expect(isCloudPathGuardedMethod('terminal.multiplex')).toBe(true)
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
      'terminal.closeAll',
      'terminal.closeTab',
      'terminal.focus',
      'terminal.show',
      'terminal.split'
    ]) {
      const decision = await check(method, {})
      expect(decision, method).toMatchObject({ ok: false, reason: 'terminal_host_scope' })
    }
  })

  it('U96 T-B6：autoRestoreFit 读取放行，写入必须绑定本人在范围的终端', async () => {
    expect(await check('terminal.getAutoRestoreFit', {})).toEqual({ ok: true })

    // No handle: the host-global preference is never writable through a ticket.
    expect(await check('terminal.setAutoRestoreFit', { ms: 5000 })).toMatchObject({
      ok: false,
      reason: 'terminal_unknown'
    })
    expect(await check('terminal.setAutoRestoreFit', { ms: 5000, terminal: 'term-own' })).toEqual({
      ok: true
    })
    expect(
      await check('terminal.setAutoRestoreFit', { ms: 5000, terminal: 'term-teammate' })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })
    expect(
      await check('terminal.setAutoRestoreFit', { ms: 5000, terminal: 'term-exited' })
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
  })

  it('multiplex 信封不带地址，按帧检查：信封放行，逐帧边界在订阅时执行', async () => {
    expect(await check('terminal.multiplex', {})).toEqual({ ok: true })
  })
})

function claim(terminal: string, tabId = 'tab-1', leafId = 'leaf-1') {
  return { terminal, ptyId: `pty-${terminal}`, incarnationId: 'inc-1', tabId, leafId }
}

type TestTopologyTab = {
  tabId: string
  root: unknown
  activeLeafId: string
  expandedLeafId: string | null
}

function topologyTab(tabId: string, leafIds: readonly string[]): TestTopologyTab {
  const first = leafIds[0] ?? ''
  let root: unknown = { type: 'leaf', leafId: first }
  for (const leafId of leafIds.slice(1)) {
    root = { type: 'split', direction: 'vertical', first: root, second: { type: 'leaf', leafId } }
  }
  return { tabId, root, activeLeafId: first, expandedLeafId: null }
}

function topologyOf(tabs: TestTopologyTab[]) {
  return {
    tabs,
    groups: tabs.map((tab) => ({
      id: `group-${tab.tabId}`,
      activeTabId: tab.tabId,
      tabOrder: [tab.tabId]
    }))
  }
}

describe('终端清单边界', () => {
  it('无 selector 时拒绝，不会落到主机的全量清单', async () => {
    expect(await check('terminal.list', {})).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('本人工作区放行，共享检出区与他人检出区越界拒绝', async () => {
    expect(await check('terminal.list', { worktree: `path:${workspaceRoot}` })).toEqual({
      ok: true
    })
    expect(await check('terminal.list', { worktree: `path:${projectRoot}` })).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
    expect(await check('terminal.list', { worktree: `path:${otherRoot}` })).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
  })

  it('无法解析的工作区拒绝', async () => {
    expect(await check('terminal.list', { worktree: 'path:/nowhere' })).toMatchObject({
      ok: false,
      reason: 'worktree_unknown'
    })
  })
})

describe('孤儿认领三重 scope', () => {
  const worktree = `path:${workspaceRoot}`
  const baseParams = {
    worktree,
    expectedTopologyRevision: 0,
    claims: [claim('term-own')]
  }

  it('工作区、句柄与拓扑一致时放行，拓扑可省略', async () => {
    expect(await check('terminal.adoptOrphans', baseParams)).toEqual({ ok: true })
    expect(
      await check('terminal.adoptOrphans', {
        ...baseParams,
        topology: topologyOf([topologyTab('tab-1', ['leaf-1'])])
      })
    ).toEqual({ ok: true })
  })

  it('多标签各自认领自己的叶子时放行', async () => {
    const decision = await check('terminal.adoptOrphans', {
      worktree,
      expectedTopologyRevision: 0,
      claims: [claim('term-own', 'tab-1', 'leaf-1'), claim('term-own', 'tab-2', 'leaf-2')],
      topology: topologyOf([topologyTab('tab-1', ['leaf-1']), topologyTab('tab-2', ['leaf-2'])])
    })
    expect(decision).toEqual({ ok: true })
  })

  it('无 selector 或工作区越界拒绝', async () => {
    expect(await check('terminal.adoptOrphans', { claims: [claim('term-own')] })).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
    expect(
      await check('terminal.adoptOrphans', { ...baseParams, worktree: `path:${otherRoot}` })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('claims 缺失、为空或缺少地址时拒绝', async () => {
    expect(
      await check('terminal.adoptOrphans', { worktree, expectedTopologyRevision: 0 })
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
    expect(
      await check('terminal.adoptOrphans', {
        worktree,
        expectedTopologyRevision: 0,
        claims: []
      })
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
    expect(
      await check('terminal.adoptOrphans', {
        worktree,
        expectedTopologyRevision: 0,
        claims: [{ terminal: 'term-own', tabId: 'tab-1' }]
      })
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
  })

  it('句柄必须可解析且与命名工作区一致', async () => {
    expect(
      await check('terminal.adoptOrphans', { ...baseParams, claims: [claim('term-exited')] })
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })

    // Same workspace root, different worktree: the boundary alone would admit it.
    expect(
      await check('terminal.adoptOrphans', { ...baseParams, claims: [claim('term-nested')] })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })

    expect(
      await check('terminal.adoptOrphans', { ...baseParams, claims: [claim('term-teammate')] })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })

    expect(
      await check('terminal.adoptOrphans', {
        ...baseParams,
        claims: [claim('term-own'), claim('term-nested')]
      })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('拓扑的 tabId/leafId 必须与 claims 一致', async () => {
    const adopt = async (topology: unknown) =>
      await check('terminal.adoptOrphans', { ...baseParams, topology })

    expect(await adopt(topologyOf([]))).toMatchObject({ ok: false, reason: 'terminal_unknown' })
    expect(
      await adopt(topologyOf([topologyTab('tab-1', ['leaf-1']), topologyTab('tab-2', ['leaf-2'])]))
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
    expect(await adopt(topologyOf([topologyTab('tab-other', ['leaf-1'])]))).toMatchObject({
      ok: false,
      reason: 'terminal_unknown'
    })
    expect(await adopt(topologyOf([topologyTab('tab-1', ['leaf-other'])]))).toMatchObject({
      ok: false,
      reason: 'terminal_unknown'
    })
    expect(await adopt(topologyOf([topologyTab('tab-1', ['leaf-1', 'leaf-2'])]))).toMatchObject({
      ok: false,
      reason: 'terminal_unknown'
    })
    expect(
      await adopt({ tabs: [{ tabId: 'tab-1', root: null, activeLeafId: 'leaf-1' }] })
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
    expect(
      await adopt(topologyOf([{ ...topologyTab('tab-1', ['leaf-1']), activeLeafId: 'leaf-other' }]))
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
    expect(
      await adopt(
        topologyOf([{ ...topologyTab('tab-1', ['leaf-1']), expandedLeafId: 'leaf-other' }])
      )
    ).toMatchObject({ ok: false, reason: 'terminal_unknown' })
  })
})
