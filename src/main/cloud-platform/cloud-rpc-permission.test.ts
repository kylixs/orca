import { describe, expect, it } from 'vitest'
import { cloudMethodAccess } from './cloud-rpc-permission'
import { denyRpcMethodForCaller } from '../runtime/rpc/rpc-caller-scope'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../runtime/runtime-rpc/runtime-rpc-mobile-method-allowlist'

/**
 * Design §7.3: the platform signs the caller's project permissions into the
 * ticket and the host executes that set. These pin the mapping itself, including
 * the deny-by-default edge that keeps newly added RPCs out of cloud sessions.
 */

/** Every permission the platform can sign, so a refusal names the rule, not a missing grant. */
const ALL_PERMISSIONS = [
  'open',
  'terminal',
  'agent',
  'file:read',
  'file:write',
  'browser',
  'download'
] as const

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

  it('会话标签清单/恢复归 terminal，创建与改属性仍在云表外', () => {
    for (const method of [
      'session.tabs.list',
      'session.tabs.listAll',
      'session.tabs.subscribe',
      'session.tabs.subscribeAll',
      'session.tabs.activate',
      'session.tabs.close',
      'session.tabs.move'
    ]) {
      expect(cloudMethodAccess(method), method).toBe('terminal')
    }
    for (const method of [
      'session.tabs.createTerminal',
      'session.tabs.setTabProps',
      'session.tabs.updatePaneLayout',
      'session.tabs.unsubscribe',
      'session.tabs.unsubscribeAll'
    ]) {
      expect(cloudMethodAccess(method), method).toBeNull()
    }
  })

  it('agent 家族归 agent', () => {
    for (const method of ['agent.launch', 'agentSession.send', 'agentProvider.list']) {
      expect(cloudMethodAccess(method), method).toBe('agent')
    }
  })

  it('宿主 agent 探测归 agent 权限：composer 的 agent 选择器靠它点亮', () => {
    expect(cloudMethodAccess('preflight.detectAgents')).toBe('agent')
    expect(cloudMethodAccess('preflight.refreshAgents')).toBe('agent')
  })

  it('宿主全域诊断不在云表内：check/detectRemoteAgents 是主机渠道事实', () => {
    for (const method of [
      'preflight.check',
      'preflight.detectRemoteAgents',
      'preflight.detectRemoteWindowsTerminalCapabilities'
    ]) {
      expect(cloudMethodAccess(method), method).toBeNull()
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

  it('会话标签恢复受票据 terminal 位约束', () => {
    expect(denyRpcMethodForCaller(cloud(['open']), 'session.tabs.listAll', 'workspace')).toContain(
      "needs the 'terminal' project permission"
    )
    expect(
      denyRpcMethodForCaller(cloud(['terminal']), 'session.tabs.listAll', 'workspace')
    ).toBeNull()
    expect(
      denyRpcMethodForCaller(cloud(['terminal']), 'session.tabs.createTerminal', 'workspace')
    ).toContain('not available to cloud sessions')
  })

  it('agent 探测需要 agent 权限位，拒绝文案指明缺哪一个', () => {
    expect(
      denyRpcMethodForCaller(cloud(['open']), 'preflight.detectAgents', 'workspace')
    ).toContain("needs the 'agent' project permission")
    expect(
      denyRpcMethodForCaller(cloud(['agent']), 'preflight.refreshAgents', 'workspace')
    ).toBeNull()
  })

  it('宿主全域诊断逐字拒绝：文案是云层的，不是 mobile 允许清单的', () => {
    // Verbatim: a cloud session demoted to a mobile row would answer the
    // allowlist's wording instead, so pinning the sentence pins the layer.
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('preflight.refreshAgents')).toBe(false)
    for (const method of ['preflight.check', 'preflight.detectRemoteAgents']) {
      expect(denyRpcMethodForCaller(cloud([...ALL_PERMISSIONS]), method, 'workspace'), method).toBe(
        `Method '${method}' is not available to cloud sessions`
      )
    }
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
