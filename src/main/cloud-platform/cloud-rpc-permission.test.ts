import { describe, expect, it } from 'vitest'
import { cloudMethodAccess } from './cloud-rpc-permission'
import { denyRpcMethodForCaller } from '../runtime/rpc/rpc-caller-scope'

/**
 * Design §7.3: the platform signs the caller's project permissions into the
 * ticket and the host executes that set. These pin the mapping itself, including
 * the deny-by-default edge that keeps newly added RPCs out of cloud sessions.
 */

describe('云端方法 → 项目权限映射', () => {
  it('终端与 git/worktree 归 terminal', () => {
    for (const method of [
      'terminal.create',
      'terminal.list',
      'terminal.send',
      'git.status',
      'git.commit',
      'worktree.create',
      'worktree.createManaged',
      'worktree.rm'
    ]) {
      expect(cloudMethodAccess(method), method).toBe('terminal')
    }
  })

  it('agent 家族归 agent', () => {
    for (const method of ['agent.launch', 'agentSession.send', 'agentProvider.list']) {
      expect(cloudMethodAccess(method), method).toBe('agent')
    }
  })

  it('文件读写分开：读方法不因写权限而放行，反之亦然', () => {
    expect(cloudMethodAccess('files.read')).toBe('file:read')
    expect(cloudMethodAccess('files.readDir')).toBe('file:read')
    // Panel actions only reveal a file the caller could already read.
    expect(cloudMethodAccess('files.open')).toBe('file:read')
    expect(cloudMethodAccess('files.openDiff')).toBe('file:read')
    expect(cloudMethodAccess('files.write')).toBe('file:write')
    expect(cloudMethodAccess('files.delete')).toBe('file:write')
  })

  it('下载优先级高于其所属家族：browser.download 需要 download，导航不需要', () => {
    expect(cloudMethodAccess('browser.download')).toBe('download')
    expect(cloudMethodAccess('browser.savePage')).toBe('download')
    expect(cloudMethodAccess('browser.goto')).toBe('browser')
    expect(cloudMethodAccess('browser.screenshot')).toBe('browser')
  })

  it('自省方法任何已准入会话可用', () => {
    expect(cloudMethodAccess('status.get')).toBe('session')
  })

  it('未登记方法默认拒绝（新增 RPC 不会自动获得权限）', () => {
    expect(cloudMethodAccess('settings.update')).toBeNull()
    expect(cloudMethodAccess('accounts.list')).toBeNull()
    expect(cloudMethodAccess('pairing.getEndpoints')).toBeNull()
    expect(cloudMethodAccess('host.wsl.listDistros')).toBeNull()
    expect(cloudMethodAccess('agentSessionAttachment.read')).toBeNull()
  })
})

describe('云端调用方作用域', () => {
  const cloud = (
    permissions: (
      | 'open'
      | 'terminal'
      | 'agent'
      | 'file:read'
      | 'file:write'
      | 'browser'
      | 'download'
    )[]
  ) => ({ kind: 'cloud' as const, permissions, downloadAllowed: true })

  it('票据权限集是上限：没有的权限一律拒绝，并指明缺哪一个', () => {
    const scope = cloud(['open', 'file:read'])
    expect(denyRpcMethodForCaller(scope, 'files.read', 'workspace')).toBeNull()
    const denied = denyRpcMethodForCaller(scope, 'terminal.create', 'workspace')
    expect(denied).toContain("needs the 'terminal' project permission")
    expect(denyRpcMethodForCaller(scope, 'files.write', 'workspace')).toContain("'file:write'")
  })

  it('自省方法不受权限集限制', () => {
    expect(denyRpcMethodForCaller(cloud([]), 'status.get', 'workspace')).toBeNull()
  })

  it('repo.add 只注册票据里的项目根，归 open 权限', () => {
    expect(cloudMethodAccess('repo.add')).toBe('open')
    expect(denyRpcMethodForCaller(cloud(['open']), 'repo.add', 'workspace')).toBeNull()
    expect(denyRpcMethodForCaller(cloud([]), 'repo.add', 'workspace')).toContain(
      "needs the 'open' project permission"
    )
  })

  it('未登记方法与不存在的权限集都拒绝，而不是退化为放行', () => {
    expect(denyRpcMethodForCaller(cloud(['open']), 'settings.update', 'workspace')).toContain(
      'not available to cloud sessions'
    )
    expect(denyRpcMethodForCaller(cloud([]), 'files.read', 'workspace')).not.toBeNull()
  })

  it('本机未注册的方法仍报 method_not_found，而不是权限错误', () => {
    expect(denyRpcMethodForCaller(cloud(['open']), 'future.method', undefined)).toBeNull()
  })

  it('非云会话不受影响：配对的 runtime 客户端仍是 runtime-paired 规则', () => {
    const paired = { kind: 'runtime-paired' as const, grants: [] }
    expect(denyRpcMethodForCaller(paired, 'files.read', 'workspace')).toBeNull()
    expect(denyRpcMethodForCaller(paired, 'pairing.getEndpoints', 'pairing-admin')).toContain(
      'which this paired client was not granted'
    )
  })
})
