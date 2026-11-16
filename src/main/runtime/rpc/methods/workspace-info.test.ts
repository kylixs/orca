import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { CloudRpcSession, RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { CloudDenialDetails } from '../../../cloud-platform/cloud-denial-details'
import {
  readField,
  readObjectValue,
  readString,
  readStringArray
} from '../../../../shared/json-fields'
import type { RuntimeWorktreeListResult } from '../../../../shared/runtime-worktree-contracts'
import { WORKSPACE_INFO_METHODS } from './workspace-info'
import type { RpcCallerScope } from '../rpc-caller-scope'

/**
 * W13 §3.2/§3.3: the answer is derived from the ticket plus one workspaceRoot
 * -scoped checkout query, and the field set is the information boundary. A
 * structural whitelist pins every key, because an extra field on a
 * self-introspection method is a boundary incident, not a convenience.
 */

const CLOUD = {
  projectId: 'proj_payment',
  projectRoot: '/srv/work/payment-service',
  workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan',
  repoUrl: 'https://git.example.com/pay/service.git',
  defaultBranch: 'main',
  perms: ['open', 'terminal', 'file:read'] as const
}

function worktree(path: string, branch: string) {
  return {
    id: `repo-project::${path}`,
    repoId: 'repo-project',
    displayName: 'checkout',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path,
    head: 'abc123',
    branch,
    isBare: false,
    isMainWorktree: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path, head: 'abc123', branch, isBare: false, isMainWorktree: false }
  }
}

function makeRuntime(listed: RuntimeWorktreeListResult | Error): {
  runtime: OrcaRuntimeService
  listManagedWorktrees: ReturnType<typeof vi.fn>
} {
  const listManagedWorktrees = vi
    .fn()
    .mockImplementation(() =>
      listed instanceof Error ? Promise.reject(listed) : Promise.resolve(listed)
    )
  const partial = {
    getRuntimeId: () => 'test-runtime',
    listManagedWorktrees
  }
  return {
    listManagedWorktrees,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime supplies the one method the workspace.info handler invokes.
    runtime: partial as unknown as OrcaRuntimeService
  }
}

type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }

function call(
  runtime: OrcaRuntimeService,
  cloud: CloudRpcSession | undefined,
  onCloudDenial?: (details: CloudDenialDetails, method: string) => void,
  callerScope?: RpcCallerScope
): Promise<Reply> {
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_INFO_METHODS })
  const request: RpcRequest = { id: 'req-1', authToken: 'tok', method: 'workspace.info' }
  return dispatcher
    .dispatch(request, {
      callerScope:
        callerScope ??
        (cloud === undefined
          ? { kind: 'owner' }
          : { kind: 'cloud', permissions: [...CLOUD.perms], downloadAllowed: true }),
      ...(cloud === undefined ? {} : { cloud }),
      ...(onCloudDenial ? { onCloudDenial } : {})
    })
    .then((response) =>
      response.ok ? { ok: true, result: response.result } : { ok: false, error: response.error }
    )
}

function resultOf(reply: Reply): unknown {
  if (!reply.ok) {
    throw new Error(`workspace.info failed: ${JSON.stringify(reply.error)}`)
  }
  return reply.result
}

function workspaceOf(result: unknown): {
  root: string | null
  path: string | null
  branch: string | null
} {
  const workspace = readObjectValue(readField(result, 'workspace'))
  return {
    root: readString(workspace, 'root'),
    path: readString(workspace, 'path'),
    branch: readString(workspace, 'branch')
  }
}

const EMPTY_LISTING: RuntimeWorktreeListResult = {
  worktrees: [],
  totalCount: 0,
  truncated: false
}

describe('workspace.info（云会话工作区自省）', () => {
  it('按票据直出项目与工作区字段，键集恰为白名单', async () => {
    const { runtime, listManagedWorktrees } = makeRuntime(EMPTY_LISTING)

    const reply = await call(runtime, CLOUD)

    expect(reply).toEqual({
      ok: true,
      result: {
        project: {
          id: CLOUD.projectId,
          root: CLOUD.projectRoot,
          repoUrl: CLOUD.repoUrl,
          defaultBranch: CLOUD.defaultBranch
        },
        workspace: {
          root: CLOUD.workspaceRoot,
          path: null,
          branch: null
        },
        perms: ['open', 'terminal', 'file:read'],
        capabilities: ['cloud.session-tabs-restore.v1']
      }
    })
    const result = resultOf(reply)
    expect(Object.keys(readObjectValue(result) ?? {}).sort()).toEqual([
      'capabilities',
      'perms',
      'project',
      'workspace'
    ])
    expect(Object.keys(readObjectValue(readField(result, 'project')) ?? {}).sort()).toEqual([
      'defaultBranch',
      'id',
      'repoUrl',
      'root'
    ])
    expect(Object.keys(readObjectValue(readField(result, 'workspace')) ?? {}).sort()).toEqual([
      'branch',
      'path',
      'root'
    ])
    expect(readStringArray(result, 'perms')).toEqual(['open', 'terminal', 'file:read'])
    expect(listManagedWorktrees).toHaveBeenCalledWith(`path:${CLOUD.projectRoot}`)
  })

  it('声明标签恢复能力：只有能力名，不带主机事实（U96 A，wire-additive）', async () => {
    const { runtime } = makeRuntime(EMPTY_LISTING)

    const result = resultOf(await call(runtime, CLOUD))

    expect(readStringArray(result, 'capabilities')).toEqual([
      'cloud.session-tabs-restore.v1'
    ])
  })

  it('未 ensure 时 path/branch 为 null 是正常应答', async () => {
    const { runtime } = makeRuntime(EMPTY_LISTING)

    const workspace = workspaceOf(resultOf(await call(runtime, CLOUD)))

    expect(workspace.path).toBeNull()
    expect(workspace.branch).toBeNull()
  })

  it('返回 workspaceRoot 内既有检出与其当前分支', async () => {
    const { runtime } = makeRuntime({
      worktrees: [
        worktree('/srv/work/payment-service', 'refs/heads/main'),
        worktree(`${CLOUD.workspaceRoot}/feature-cloud`, 'refs/heads/feature/cloud')
      ],
      totalCount: 2,
      truncated: false
    })

    const workspace = workspaceOf(resultOf(await call(runtime, CLOUD)))

    expect(workspace.path).toBe(`${CLOUD.workspaceRoot}/feature-cloud`)
    expect(workspace.branch).toBe('feature/cloud')
  })

  it('workspaceRoot 之外的检出（队友目录、其他路径）不返回', async () => {
    const { runtime } = makeRuntime({
      worktrees: [
        worktree('/srv/work/payment-service/.orca-worktrees/lisi/main', 'refs/heads/main'),
        worktree('/srv/elsewhere/checkout', 'refs/heads/other')
      ],
      totalCount: 2,
      truncated: false
    })

    const workspace = workspaceOf(resultOf(await call(runtime, CLOUD)))

    expect(workspace.path).toBeNull()
    expect(workspace.branch).toBeNull()
  })

  it('repo 未注册或扫描失败按未 ensure 应答，不使调用失败', async () => {
    const { runtime } = makeRuntime(new Error('repo_not_found'))

    const reply = await call(runtime, CLOUD)

    expect(reply).toEqual({
      ok: true,
      result: {
        project: {
          id: CLOUD.projectId,
          root: CLOUD.projectRoot,
          repoUrl: CLOUD.repoUrl,
          defaultBranch: CLOUD.defaultBranch
        },
        workspace: { root: CLOUD.workspaceRoot, path: null, branch: null },
        perms: ['open', 'terminal', 'file:read'],
        capabilities: ['cloud.session-tabs-restore.v1']
      }
    })
  })

  it('repo 未注册（repo_not_found）是预期形态：按未 ensure 应答且不留告警日志', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = makeRuntime(new Error('repo_not_found'))

    try {
      const workspace = workspaceOf(resultOf(await call(runtime, CLOUD)))

      expect(workspace.path).toBeNull()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['selector_ambiguous', new Error('selector_ambiguous')],
    ['存储错误', new Error('SQLite disk I/O error')]
  ])('意外扫描失败（%s）仍按未 ensure 应答，但宿主侧 warn 一行', async (_label, error) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = makeRuntime(error)

    try {
      const workspace = workspaceOf(resultOf(await call(runtime, CLOUD)))

      expect(workspace.path).toBeNull()
      expect(workspace.branch).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toBe(
        '[cloud] workspace.info checkout scan failed unexpectedly:'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('detached HEAD（porcelain 无分支行）返回 branch=null', async () => {
    const { runtime } = makeRuntime({
      worktrees: [worktree(`${CLOUD.workspaceRoot}/main`, '')],
      totalCount: 1,
      truncated: false
    })

    const workspace = workspaceOf(resultOf(await call(runtime, CLOUD)))

    expect(workspace.path).toBe(`${CLOUD.workspaceRoot}/main`)
    expect(workspace.branch).toBeNull()
  })

  it('重复调用幂等：只读、无副作用，两次应答一致', async () => {
    const { runtime, listManagedWorktrees } = makeRuntime(EMPTY_LISTING)

    const first = await call(runtime, CLOUD)
    const second = await call(runtime, CLOUD)

    expect(second).toEqual(first)
    expect(listManagedWorktrees).toHaveBeenCalledTimes(2)
  })

  it('非云调用方得到 CLOUD_SESSION_REQUIRED 应答（与 project.provision 同形态），且不入云拒绝审计', async () => {
    const { runtime } = makeRuntime(EMPTY_LISTING)
    const onCloudDenial = vi.fn()

    const reply = await call(runtime, undefined, onCloudDenial)

    // The refusal is in-band in the result payload, not an RPC envelope error.
    expect(reply).toEqual({
      ok: true,
      result: {
        ok: false,
        code: 'CLOUD_SESSION_REQUIRED',
        message: 'This method is only available to a cloud session.'
      }
    })
    expect(onCloudDenial).not.toHaveBeenCalled()
  })

  it('mobile 调用被 allowlist 拒绝为 forbidden，handler 不执行也不入云拒绝审计', async () => {
    const { runtime, listManagedWorktrees } = makeRuntime(EMPTY_LISTING)
    const onCloudDenial = vi.fn()

    const reply = await call(runtime, undefined, onCloudDenial, { kind: 'mobile' })

    expect(reply).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(listManagedWorktrees).not.toHaveBeenCalled()
    expect(onCloudDenial).not.toHaveBeenCalled()
  })

  it('runtime-paired 配对桌面通过准入后得到 in-band CLOUD_SESSION_REQUIRED，不入云拒绝审计', async () => {
    const { runtime, listManagedWorktrees } = makeRuntime(EMPTY_LISTING)
    const onCloudDenial = vi.fn()

    const reply = await call(runtime, undefined, onCloudDenial, {
      kind: 'runtime-paired',
      grants: []
    })

    expect(reply).toEqual({
      ok: true,
      result: {
        ok: false,
        code: 'CLOUD_SESSION_REQUIRED',
        message: 'This method is only available to a cloud session.'
      }
    })
    expect(listManagedWorktrees).not.toHaveBeenCalled()
    expect(onCloudDenial).not.toHaveBeenCalled()
  })

  it('ssh-bridge 上的 orca CLI：开 remoteCliControl 得 in-band 拒绝，未开得 forbidden', async () => {
    const opted = makeRuntime(EMPTY_LISTING)
    const optedReply = await call(opted.runtime, undefined, vi.fn(), {
      kind: 'ssh-bridge',
      targetId: 'ssh-1',
      remoteCliControl: true
    })
    expect(optedReply).toEqual({
      ok: true,
      result: {
        ok: false,
        code: 'CLOUD_SESSION_REQUIRED',
        message: 'This method is only available to a cloud session.'
      }
    })
    expect(opted.listManagedWorktrees).not.toHaveBeenCalled()

    const unopted = makeRuntime(EMPTY_LISTING)
    const unoptedReply = await call(unopted.runtime, undefined, vi.fn(), {
      kind: 'ssh-bridge',
      targetId: 'ssh-1',
      remoteCliControl: false
    })
    expect(unoptedReply).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(unopted.listManagedWorktrees).not.toHaveBeenCalled()
  })

  it('云会话的成功应答同样不产生云拒绝审计', async () => {
    const { runtime } = makeRuntime(EMPTY_LISTING)
    const onCloudDenial = vi.fn()

    const reply = await call(runtime, CLOUD, onCloudDenial)

    expect(reply).toMatchObject({ ok: true })
    expect(onCloudDenial).not.toHaveBeenCalled()
  })

  it('无参数方法：params schema 为 null，请求参数不影响应答', async () => {
    const { runtime } = makeRuntime(EMPTY_LISTING)
    const dispatcher = new RpcDispatcher({ runtime, methods: WORKSPACE_INFO_METHODS })

    expect(WORKSPACE_INFO_METHODS.map((method) => method.params)).toEqual([null])

    const response = await dispatcher.dispatch(
      {
        id: 'req-1',
        authToken: 'tok',
        method: 'workspace.info',
        // A client-supplied address is ignored: the ticket is the only source.
        params: { projectRoot: '/etc', workspaceRoot: '/' }
      },
      {
        callerScope: { kind: 'cloud', permissions: [...CLOUD.perms], downloadAllowed: true },
        cloud: CLOUD
      }
    )

    if (!response.ok) {
      throw new Error(`workspace.info failed: ${JSON.stringify(response.error)}`)
    }
    const workspace = readObjectValue(readField(response.result, 'workspace'))
    expect(readString(workspace, 'root')).toBe(CLOUD.workspaceRoot)
    expect(readString(workspace, 'path')).toBeNull()
  })
})
