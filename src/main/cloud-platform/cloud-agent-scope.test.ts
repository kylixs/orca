import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUD_AGENT_CREATE_METHODS,
  CLOUD_AGENT_DENIED_METHODS,
  CLOUD_AGENT_PROBE_METHODS,
  CLOUD_AGENT_SESSION_METHODS,
  cloudAgentScopeOf
} from './cloud-agent-scope'
import {
  checkCloudRpcPath,
  isCloudPathGuardedMethod,
  type CloudPathGuardRuntime
} from './cloud-path-guard'

/**
 * `agent` permission alone would let a cloud session launch an agent (which runs
 * commands) in any checkout, read any conversation, and drive any session it can
 * name. These pin the table and the addresses it checks: the worktree a launch or
 * session-create names, and the worktree an existing session runs in.
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-agent-')))
const projectRoot = join(base, 'payment-service')
const workspaceRoot = join(projectRoot, '.orca-worktrees', 'zhangsan')
const otherRoot = join(base, 'other-team')
mkdirSync(workspaceRoot, { recursive: true })
mkdirSync(otherRoot, { recursive: true })

const roots = { projectRoot, workspaceRoot }

const worktrees: Record<string, string> = {
  'workspace-root': workspaceRoot,
  'other-team': otherRoot,
  'shared-checkout': projectRoot
}

/** Session id → worktree. A session missing here is unknown to the host. */
const sessionWorktrees: Record<string, string> = {
  'sess-own': 'workspace-root',
  'sess-teammate': 'other-team'
}

/** Terminal handle → worktree, used by the fallback lookup. */
const terminalWorktrees: Record<string, string> = {
  'term-own': 'workspace-root',
  'term-teammate': 'other-team'
}

const runtime: CloudPathGuardRuntime = {
  resolveWorktreeRootPath: async (selector) => {
    const id = selector.startsWith('id:') ? selector.slice(3) : null
    const path = id !== null ? worktrees[id] : undefined
    if (path !== undefined) {
      return path
    }
    // A folder workspace keeps its own key form, which the host resolves directly.
    if (selector === 'folder:folder-own') {
      return workspaceRoot
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
  },
  resolveAgentSessionContext: (sessionId) => {
    const worktreeId = sessionWorktrees[sessionId]
    return worktreeId === undefined ? null : { worktreeId }
  }
}

async function check(method: string, params: unknown) {
  return await checkCloudRpcPath({ runtime, roots, method, params })
}

describe('agent 方法分类', () => {
  it('三类互斥，且已分类的方法都真的归入其中一类', () => {
    const sets = [
      CLOUD_AGENT_CREATE_METHODS,
      CLOUD_AGENT_SESSION_METHODS,
      CLOUD_AGENT_DENIED_METHODS,
      CLOUD_AGENT_PROBE_METHODS
    ]
    for (const [index, methodSet] of sets.entries()) {
      for (const method of methodSet) {
        for (const [otherIndex, otherSet] of sets.entries()) {
          if (otherIndex !== index) {
            expect(otherSet.has(method), method).toBe(false)
          }
        }
      }
    }
    for (const method of CLOUD_AGENT_CREATE_METHODS) {
      expect(cloudAgentScopeOf(method), method).toEqual({ kind: 'create' })
    }
    for (const method of CLOUD_AGENT_SESSION_METHODS) {
      expect(cloudAgentScopeOf(method), method).toEqual({ kind: 'session' })
    }
    for (const method of CLOUD_AGENT_DENIED_METHODS) {
      expect(cloudAgentScopeOf(method), method).toMatchObject({ kind: 'deny' })
    }
    for (const method of CLOUD_AGENT_PROBE_METHODS) {
      expect(cloudAgentScopeOf(method), method).toEqual({ kind: 'probe' })
    }
  })

  it('未分类的 agent 家族默认拒绝，非 agent 方法不参与', () => {
    for (const method of [
      'agent.futureMethod',
      'agentSession.futureMethod',
      'agentSessionAttachment.futureMethod',
      'agentTeams.futureMethod',
      'agentHooks.futureMethod',
      'agentProvider.futureMethod'
    ]) {
      expect(cloudAgentScopeOf(method), method).toMatchObject({ kind: 'deny' })
    }
    expect(cloudAgentScopeOf('files.read')).toBeNull()
    expect(cloudAgentScopeOf('terminal.create')).toBeNull()
  })

  it('agent 方法都要求经过边界检查', () => {
    expect(isCloudPathGuardedMethod('agent.launch')).toBe(true)
    expect(isCloudPathGuardedMethod('agentSession.subscribe')).toBe(true)
    expect(isCloudPathGuardedMethod('agentSession.subscribeStatus')).toBe(true)
  })
})

describe('创建类：工作区必须在 workspaceRoot 内', () => {
  it('agentSession.create 在本人工作区放行，在共享检出区或队友仓库被拒', async () => {
    expect(await check('agentSession.create', { worktree: `path:${workspaceRoot}` })).toEqual({
      ok: true
    })
    expect(
      await check('agentSession.createSupport', { worktree: `path:${workspaceRoot}` })
    ).toEqual({ ok: true })

    const shared = await check('agentSession.create', { worktree: `path:${projectRoot}` })
    expect(shared).toMatchObject({ ok: false, reason: 'workspace_scope' })

    const teammate = await check('agentSession.create', { worktree: `path:${otherRoot}` })
    expect(teammate).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('attach 形式按 location.workspaceId 判断', async () => {
    expect(
      await check('agentSession.ensure', {
        location: { workspaceId: 'workspace-root', workspaceKind: 'git-worktree' }
      })
    ).toEqual({ ok: true })
    expect(
      await check('agentSession.ensure', {
        location: { workspaceId: 'other-team', workspaceKind: 'git-worktree' }
      })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })
    expect(await check('agentSession.ensure', {})).toMatchObject({
      ok: false,
      reason: 'agent_worktree_required'
    })
  })

  it('agent.launch 只接受已有工作区，且工作区必须在 workspaceRoot 内', async () => {
    const target = (worktree: string) => ({
      agent: 'claude',
      target: { kind: 'existing', worktree }
    })
    expect(await check('agent.launch', target(`path:${workspaceRoot}`))).toEqual({ ok: true })
    expect(await check('agent.launchReplay', target(`path:${workspaceRoot}`))).toEqual({ ok: true })

    expect(await check('agent.launch', target(`path:${projectRoot}`))).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
    expect(await check('agent.launch', target(`path:${otherRoot}`))).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
    expect(await check('agent.launch', { agent: 'claude' })).toMatchObject({
      ok: false,
      reason: 'agent_worktree_required'
    })
  })

  it('agent.launch 新建工作区无法定界，直接拒绝', async () => {
    const created = await check('agent.launch', {
      agent: 'claude',
      target: { kind: 'create-worktree', create: { repo: `path:${projectRoot}` } }
    })
    expect(created).toMatchObject({ ok: false, reason: 'agent_target_unbounded' })
  })

  it('agent.launch 的 cwd 与复用终端也必须在 workspaceRoot 内', async () => {
    const launch = (extra: Record<string, unknown>) => ({
      agent: 'claude',
      target: { kind: 'existing', worktree: `path:${workspaceRoot}` },
      ...extra
    })
    expect(await check('agent.launch', launch({ cwd: join(workspaceRoot, 'src') }))).toEqual({
      ok: true
    })
    expect(await check('agent.launch', launch({ cwd: otherRoot }))).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
    expect(await check('agent.launch', launch({ reuseTerminal: { handle: 'term-own' } }))).toEqual({
      ok: true
    })
    expect(
      await check('agent.launch', launch({ reuseTerminal: { handle: 'term-teammate' } }))
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })
})

describe('会话类：按会话所属工作区判断', () => {
  it('本人会话放行，队友会话被拒', async () => {
    expect(await check('agentSession.history', { sessionId: 'sess-own' })).toEqual({ ok: true })
    expect(
      await check('agentSession.send', { envelope: { sessionId: 'sess-own' }, body: {} })
    ).toEqual({ ok: true })

    expect(await check('agentSession.history', { sessionId: 'sess-teammate' })).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
    expect(
      await check('agentSession.rewind', { envelope: { sessionId: 'sess-teammate' } })
    ).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('终端承载的会话按终端句柄回退解析', async () => {
    expect(await check('agentSession.close', { sessionId: 'term-own' })).toEqual({ ok: true })
    expect(await check('agentSession.close', { sessionId: 'term-teammate' })).toMatchObject({
      ok: false,
      reason: 'workspace_scope'
    })
  })

  it('未知会话与无名会话都拒绝', async () => {
    expect(await check('agentSession.history', { sessionId: 'sess-exited' })).toMatchObject({
      ok: false,
      reason: 'agent_session_unknown'
    })
    expect(await check('agentSession.history', {})).toMatchObject({
      ok: false,
      reason: 'agent_session_unknown'
    })
  })

  it('主机无法回答会话归属时不放行', async () => {
    const blind: CloudPathGuardRuntime = {
      resolveWorktreeRootPath: runtime.resolveWorktreeRootPath,
      resolveRepoRootPath: runtime.resolveRepoRootPath
    }
    expect(
      await checkCloudRpcPath({
        runtime: blind,
        roots,
        method: 'agentSession.history',
        params: { sessionId: 'sess-own' }
      })
    ).toMatchObject({ ok: false, reason: 'agent_session_unknown' })
  })
})

describe('探测类：preflight.detectAgents/refreshAgents 钉在 workspaceRoot 内', () => {
  it('探测方法都要求经过边界检查', () => {
    for (const method of CLOUD_AGENT_PROBE_METHODS) {
      expect(isCloudPathGuardedMethod(method), method).toBe(true)
    }
  })

  it('本人工作区放行（含 folder 形式），并探不出票据根', async () => {
    for (const method of CLOUD_AGENT_PROBE_METHODS) {
      expect(await check(method, { worktreeId: 'workspace-root' }), method).toEqual({ ok: true })
      expect(await check(method, { worktreeId: 'folder:folder-own' }), method).toEqual({ ok: true })
    }

    const shared = await check('preflight.detectAgents', { worktreeId: 'shared-checkout' })
    expect(shared).toMatchObject({ ok: false, reason: 'workspace_scope' })
    const teammate = await check('preflight.refreshAgents', { worktreeId: 'other-team' })
    expect(teammate).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('缺 worktreeId 拒绝：无名探测会让宿主答出全机 PATH', async () => {
    for (const method of CLOUD_AGENT_PROBE_METHODS) {
      expect(await check(method, {}), method).toMatchObject({
        ok: false,
        reason: 'agent_worktree_required'
      })
    }
  })

  it('宿主解析不了的工作区拒绝，而不是退回宿主默认探测', async () => {
    for (const method of CLOUD_AGENT_PROBE_METHODS) {
      expect(await check(method, { worktreeId: 'no-such-workspace' }), method).toMatchObject({
        ok: false,
        reason: 'worktree_unknown'
      })
    }
  })
})

describe('拒绝类：无法定界的 agent 方法整体拒绝', () => {
  it('全车级会话流、重启集合、附件、团队与钩子方法都被拒', async () => {
    for (const method of [
      'agentSession.subscribeStatus',
      'agentSession.subscribeTurnCompletions',
      'agentSession.restartResumable',
      'agentSession.restartResume',
      'agentSession.modelCatalog',
      'agentSession.agents',
      'agentSessionAttachment.read',
      'agentSessionAttachment.uploadStart',
      'agentTeams.tmuxCompat',
      'agentTeams.prepareLaunch',
      'agentHooks.prepareCodexForWslPane',
      'agentProvider.futureMethod'
    ]) {
      const decision = await check(method, {})
      expect(decision, method).toMatchObject({ ok: false, reason: 'agent_scope' })
    }
  })
})
