import { describe, expect, it } from 'vitest'
import { readCloudWorkspaceInfo } from './cloud-workspace-info'

/**
 * W13 §3.2: the response field set is the information boundary, so the
 * three-party reader accepts exactly the documented shape and nothing else.
 */

const REPLY = {
  project: {
    id: 'proj_payment',
    root: '/srv/work/payment-service',
    repoUrl: 'https://git.example.com/pay/service.git',
    defaultBranch: 'main'
  },
  workspace: {
    root: '/srv/work/payment-service/.orca-worktrees/zhangsan',
    path: null,
    branch: null
  },
  perms: ['open', 'terminal', 'file:read', 'mystery-permission']
}

describe('云端工作区信息读取器', () => {
  it('读出完整应答，并丢弃未知权限值而不是整单作废', () => {
    expect(readCloudWorkspaceInfo(REPLY)).toEqual({
      project: REPLY.project,
      workspace: REPLY.workspace,
      perms: ['open', 'terminal', 'file:read']
    })
  })

  it('读出已 ensure 的检出路径与分支', () => {
    expect(
      readCloudWorkspaceInfo({
        ...REPLY,
        workspace: {
          root: REPLY.workspace.root,
          path: `${REPLY.workspace.root}/main`,
          branch: 'main'
        }
      })
    ).toMatchObject({
      workspace: { path: `${REPLY.workspace.root}/main`, branch: 'main' }
    })
  })

  it.each([
    ['顶层不是对象', 'nope'],
    ['缺 project', { workspace: REPLY.workspace, perms: [] }],
    ['缺 workspace', { project: REPLY.project, perms: [] }],
    ['缺 perms', { project: REPLY.project, workspace: REPLY.workspace }],
    ['project 字段缺失', { project: { id: 'p' }, workspace: REPLY.workspace, perms: [] }],
    ['workspace.path 类型错误', { ...REPLY, workspace: { ...REPLY.workspace, path: 5 } }],
    ['workspace.branch 缺失', { ...REPLY, workspace: { root: REPLY.workspace.root, path: null } }],
    ['perms 不是数组', { ...REPLY, perms: 'open' }]
  ])('%s 时返回 null', (_label, value) => {
    expect(readCloudWorkspaceInfo(value)).toBeNull()
  })

  it('拒绝应答（CLOUD_SESSION_REQUIRED）不是工作区信息', () => {
    expect(
      readCloudWorkspaceInfo({ ok: false, code: 'CLOUD_SESSION_REQUIRED', message: '...' })
    ).toBeNull()
  })
})
