import { describe, expect, it } from 'vitest'
import { cloudWorktreeAccessOf } from './cloud-worktree-scope'
import { checkCloudRpcPath, cloudPathAccessOf, isCloudPathGuardedMethod } from './cloud-path-guard'

/**
 * Design §8.3 / T301a. Plain `worktree.create` derives its path from host
 * settings and takes no target, so it cannot be bounded — it is refused, and the
 * remaining worktree calls are deny-by-default rather than open.
 */

describe('worktree 方法分类', () => {
  it('创建一律拒绝并指向托管创建', () => {
    const access = cloudWorktreeAccessOf('worktree.create')
    expect(access).toMatchObject({ kind: 'deny' })
    if (access?.kind === 'deny') {
      expect(access.message).toContain('managed creation')
    }
  })

  it('只有展示是只读；删除是写；其余一律拒绝', () => {
    expect(cloudWorktreeAccessOf('worktree.show')).toEqual({ kind: 'read' })
    expect(cloudWorktreeAccessOf('worktree.rm')).toEqual({ kind: 'write' })
    expect(cloudWorktreeAccessOf('worktree.forceDeleteBranch')).toEqual({ kind: 'write' })
    // Managed creation is a write: the root it names is the write boundary.
    expect(cloudWorktreeAccessOf('worktree.createManaged')).toEqual({ kind: 'write' })
    for (const method of [
      'worktree.list',
      'worktree.detectedList',
      'worktree.ps',
      'worktree.lineageList',
      'worktree.activate',
      'worktree.sleep',
      'worktree.set',
      'worktree.persistSortOrder',
      'worktree.teardownMissingTerminals',
      'worktree.prefetchCreateBase',
      'worktree.resolvePrBase',
      'worktree.listRetiredNames'
    ]) {
      expect(cloudWorktreeAccessOf(method), method).toMatchObject({ kind: 'deny' })
    }
  })

  it('非 worktree 方法不参与', () => {
    expect(cloudWorktreeAccessOf('git.status')).toBeNull()
    expect(cloudWorktreeAccessOf('files.read')).toBeNull()
  })

  it('路径检查把 worktree 与文件/git 统一起来', () => {
    expect(isCloudPathGuardedMethod('worktree.create')).toBe(true)
    expect(isCloudPathGuardedMethod('worktree.list')).toBe(true)
    expect(cloudPathAccessOf('worktree.show')).toBe('read')
    expect(cloudPathAccessOf('worktree.rm')).toBe('write')
  })
})

describe('worktree RPC 边界', () => {
  const runtime = {
    resolveWorktreeRootPath: async (selector: string) => selector.slice(5),
    resolveRepoRootPath: async (selector: string) => selector.slice(5)
  }
  const roots = { projectRoot: '/srv/work/svc', workspaceRoot: '/srv/work/svc/.orca-worktrees/me' }

  it('被拒绝的方法在任何选择器下都不会到达 handler', async () => {
    const decision = await checkCloudRpcPath({
      runtime,
      roots,
      method: 'worktree.list',
      params: {}
    })
    expect(decision).toMatchObject({ ok: false, reason: 'worktree_scope' })
  })

  it('删除必须落在本人工作区根内', async () => {
    const own = await checkCloudRpcPath({
      runtime,
      roots,
      method: 'worktree.rm',
      params: { worktree: 'path:/srv/work/svc/.orca-worktrees/me' }
    })
    expect(own).toEqual({ ok: true })

    const shared = await checkCloudRpcPath({
      runtime,
      roots,
      method: 'worktree.rm',
      params: { worktree: 'path:/srv/work/svc' }
    })
    expect(shared).toMatchObject({ ok: false, reason: 'workspace_scope' })
  })

  it('托管创建：仓库须在本项目内，目标根须在本工作区内', async () => {
    const base = {
      runtime: {
        resolveWorktreeRootPath: async (selector: string) => selector.slice(5),
        resolveRepoRootPath: async (selector: string) => selector.slice(5)
      },
      roots
    }
    const created = await checkCloudRpcPath({
      ...base,
      method: 'worktree.createManaged',
      params: {
        repo: 'path:/srv/work/svc',
        workspaceRoot: '/srv/work/svc/.orca-worktrees/me'
      }
    })
    expect(created).toEqual({ ok: true })

    const foreignRepo = await checkCloudRpcPath({
      ...base,
      method: 'worktree.createManaged',
      params: { repo: 'path:/srv/other-team', workspaceRoot: '/srv/work/svc/.orca-worktrees/me' }
    })
    expect(foreignRepo).toMatchObject({ ok: false, reason: 'project_scope' })

    const outsideRoot = await checkCloudRpcPath({
      ...base,
      method: 'worktree.createManaged',
      params: { repo: 'path:/srv/work/svc', workspaceRoot: '/srv/work/svc/src' }
    })
    expect(outsideRoot).toMatchObject({ ok: false, reason: 'workspace_scope' })

    const incomplete = await checkCloudRpcPath({
      ...base,
      method: 'worktree.createManaged',
      params: { repo: 'path:/srv/work/svc' }
    })
    expect(incomplete).toMatchObject({ ok: false, reason: 'managed_create_incomplete' })
  })

  it('展示限项目根', async () => {
    const inside = await checkCloudRpcPath({
      runtime,
      roots,
      method: 'worktree.show',
      params: { worktree: 'path:/srv/work/svc' }
    })
    expect(inside).toEqual({ ok: true })

    const outside = await checkCloudRpcPath({
      runtime,
      roots,
      method: 'worktree.show',
      params: { worktree: 'path:/srv/other-team' }
    })
    expect(outside).toMatchObject({ ok: false, reason: 'project_scope' })
  })
})
