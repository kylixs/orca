import { describe, expect, it } from 'vitest'
import {
  isInsideWorkspaceRoot,
  openCloudWorkspaceOverRpc,
  provisionCloudProjectOverRpc,
  type CloudWorkspaceRpc,
  type CloudWorkspaceRpcResult
} from './cloud-workspace-open'

const ROOTS = {
  projectRoot: '/srv/work/payment-service',
  workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan',
  defaultBranch: 'main'
}

type Script = Record<string, (params: Record<string, unknown>) => CloudWorkspaceRpcResult>

function recordingRpc(script: Script): { rpc: CloudWorkspaceRpc; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    rpc: async (method, params) => {
      calls.push(method)
      const reply = script[method]
      return reply ? reply(params) : { ok: false, code: 'method_not_found' }
    }
  }
}

describe('云端工作区打开：项目准备', () => {
  it('旧主机没有 project.provision 时跳过准备并继续打开', async () => {
    const { rpc, calls } = recordingRpc({
      'worktree.list': () => ({
        ok: true,
        result: {
          worktrees: [{ path: `${ROOTS.workspaceRoot}/feature/cloud` }]
        }
      })
    })

    const result = await openCloudWorkspaceOverRpc(rpc, 'proj_1', ROOTS)

    expect(result).toEqual({
      ok: true,
      workspacePath: `${ROOTS.workspaceRoot}/feature/cloud`,
      created: false,
      provisioned: false
    })
    expect(calls).toEqual(['project.provision', 'worktree.list'])
  })

  it('旧主机把未注册方法按云端权限拒绝时同样跳过准备', async () => {
    const { rpc, calls } = recordingRpc({
      'project.provision': () => ({
        ok: false,
        code: 'forbidden',
        message: "Method 'project.provision' is not available to cloud sessions"
      }),
      'worktree.list': () => ({
        ok: true,
        result: { worktrees: [{ path: `${ROOTS.workspaceRoot}/main` }] }
      })
    })

    const result = await openCloudWorkspaceOverRpc(rpc, 'proj_1', ROOTS)

    expect(result.ok && result.provisioned).toBe(false)
    expect(calls).toEqual(['project.provision', 'worktree.list'])
  })

  it('新主机缺少 open 权限时返回 forbidden，而不是当作旧主机跳过', async () => {
    const { rpc, calls } = recordingRpc({
      'project.provision': () => ({
        ok: false,
        code: 'forbidden',
        message:
          "Method 'project.provision' needs the 'open' project permission, which this cloud session was not granted."
      })
    })

    const result = await openCloudWorkspaceOverRpc(rpc, 'proj_1', ROOTS)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(['project.provision'])
  })

  it('主机完成 clone 后照常选择 checkout，并标记 provisioned', async () => {
    const { rpc, calls } = recordingRpc({
      'project.provision': () => ({ ok: true, result: { ok: true, provisioned: true } }),
      'worktree.list': () => ({
        ok: true,
        result: { worktrees: [{ path: `${ROOTS.workspaceRoot}/main` }] }
      })
    })

    const result = await openCloudWorkspaceOverRpc(rpc, 'proj_1', ROOTS)

    expect(result.ok && result.provisioned).toBe(true)
    expect(calls).toEqual(['project.provision', 'worktree.list'])
  })

  it('主机报告未准备时直接返回该错误码，不再发起 worktree 调用', async () => {
    const { rpc, calls } = recordingRpc({
      'project.provision': () => ({
        ok: true,
        result: { ok: false, code: 'PROJECT_NOT_PREPARED', message: 'not ready' }
      })
    })

    const result = await openCloudWorkspaceOverRpc(rpc, 'proj_1', ROOTS)

    expect(result).toEqual({
      ok: false,
      code: 'PROJECT_NOT_PREPARED',
      message: 'not ready'
    })
    expect(calls).toEqual(['project.provision'])
  })

  it('主机 RPC 层拒绝时保留错误码', async () => {
    const { rpc } = recordingRpc({
      'project.provision': () => ({ ok: false, code: 'CLONE_FAILED', message: 'clone failed' })
    })

    expect(await provisionCloudProjectOverRpc(rpc)).toEqual({
      ok: false,
      code: 'CLONE_FAILED',
      message: 'clone failed'
    })
  })
})

describe('工作区根包含判定（workspace.info 与打开流程共用）', () => {
  it('根自身与其下路径算内部，兄弟目录与前缀伪装不算', () => {
    const root = '/srv/work/payment-service/.orca-worktrees/zhangsan'
    expect(isInsideWorkspaceRoot(root, root)).toBe(true)
    expect(isInsideWorkspaceRoot(root, `${root}/main`)).toBe(true)
    expect(isInsideWorkspaceRoot(root, `${root}/feature/cloud`)).toBe(true)
    expect(isInsideWorkspaceRoot(root, `${root}-sibling/main`)).toBe(false)
    expect(isInsideWorkspaceRoot(root, '/srv/work/other/main')).toBe(false)
  })

  it('带尾分隔符的根同样判定', () => {
    expect(isInsideWorkspaceRoot('/srv/root/', '/srv/root/main')).toBe(true)
    expect(isInsideWorkspaceRoot('/srv/root/', '/srv/roo/main')).toBe(false)
  })
})
