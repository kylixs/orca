// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import type {
  CloudProjectPermission,
  CloudProjectSummary,
  CloudRpcOutcome
} from '../../../shared/cloud-platform-ipc'
import { CloudProjectWorkspace } from './cloud-project-workspace'
import type { CloudSessionView } from './use-cloud-session'

/**
 * The workspace's terminal slot (M118/W5a): the pane is lazy (its chunk must not
 * load for pages that never stream), permission-less projects get a placeholder
 * card instead of an error, and the file pane beside it keeps its own behavior.
 */

const panelModule = vi.hoisted(() => ({ evaluations: 0 }))

vi.mock('./cloud-terminal-panel', () => {
  panelModule.evaluations += 1
  return {
    CloudTerminalPanel: () =>
      React.createElement('div', { 'data-testid': 'cloud-terminal-panel-lazy' })
  }
})

const PROJECT: CloudProjectSummary = {
  id: 'proj_1',
  key: 'payment-service',
  name: 'Payment Service',
  hostName: 'dev-001',
  hostStatus: 'online',
  downloadRestricted: true,
  status: 'ready',
  provisioningError: null
}

function session(permissions: CloudProjectPermission[]): CloudSessionView {
  return {
    status: 'signed-in',
    displayName: '张三',
    loginContext: null,
    projects: [PROJECT],
    openProjectId: PROJECT.id,
    opened: {
      projectId: PROJECT.id,
      workspaceRoot: '/srv/checkout',
      workspacePath: '/srv/checkout',
      capabilities: ['pty', 'files'],
      permissions,
      route: 'direct'
    },
    route: 'direct',
    notice: null,
    error: null,
    hostKeyMismatch: null,
    connectFailure: null,
    retryConnect: async () => null,
    dismissConnectFailure: () => undefined,
    confirmHostKey: async () => null,
    dismissHostKeyMismatch: () => undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    openProject: async () => null,
    closeProject: async () => undefined
  }
}

function recordingRpc(replies: Record<string, CloudRpcOutcome>) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const rpc = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<CloudRpcOutcome> => {
    calls.push({ method, params })
    return replies[method] ?? { ok: false, code: 'method_not_found' }
  }
  return { rpc, calls }
}

const streamSeam = () => vi.fn(async () => ({ ok: false as const, code: 'NOT_USED_HERE' }))

afterEach(() => {
  cleanup()
  panelModule.evaluations = 0
})

describe('工作区终端区（M118）', () => {
  it('W5a-1 有订阅能力且授予 terminal 时懒加载面板，旁边的文件面板照常工作', async () => {
    const host = recordingRpc({
      'status.get': { ok: true, result: { runtimeId: 'rt-1' } },
      'files.readDir': {
        ok: true,
        result: [{ name: 'README.md', isDirectory: false, isSymlink: false }]
      }
    })
    const subscribe = streamSeam()

    render(
      <CloudProjectWorkspace
        session={session(['open', 'terminal', 'file:read'])}
        project={PROJECT}
        rpc={host.rpc}
        subscribe={subscribe}
      />
    )

    expect(await screen.findByTestId('cloud-terminal-panel-lazy')).toBeTruthy()
    expect(panelModule.evaluations).toBe(1)
    expect(screen.getByTestId('cloud-file-entry-README.md')).toBeTruthy()
    expect(screen.queryByTestId('cloud-terminal-placeholder')).toBeNull()
  })

  it('W5a-2 无 terminal 授权显示占位卡，不发出终端类 rpc，也不加载终端模块', async () => {
    const host = recordingRpc({
      'status.get': { ok: true, result: { runtimeId: 'rt-1' } },
      'files.readDir': {
        ok: true,
        result: [{ name: 'README.md', isDirectory: false, isSymlink: false }]
      }
    })

    render(
      <CloudProjectWorkspace
        session={session(['open', 'file:read'])}
        project={PROJECT}
        rpc={host.rpc}
        subscribe={streamSeam()}
      />
    )

    expect(await screen.findByTestId('cloud-terminal-placeholder')).toBeTruthy()
    expect(screen.getByTestId('cloud-terminal-placeholder').textContent).toContain('终端权限')
    expect(panelModule.evaluations).toBe(0)
    expect(screen.queryByTestId('cloud-terminal-panel-lazy')).toBeNull()
    const methods = host.calls.map((call) => call.method)
    expect(methods.filter((method) => method.startsWith('terminal.'))).toEqual([])
    expect(methods).toContain('files.readDir')
  })

  it('W5a-3 没有订阅能力的客户端不出现终端区，页面与其余面板零回归', async () => {
    const host = recordingRpc({
      'status.get': { ok: true, result: { runtimeId: 'rt-1' } },
      'files.readDir': {
        ok: true,
        result: [{ name: 'README.md', isDirectory: false, isSymlink: false }]
      }
    })

    render(
      <CloudProjectWorkspace
        session={session(['open', 'terminal', 'file:read'])}
        project={PROJECT}
        rpc={host.rpc}
      />
    )

    expect(await screen.findByTestId('cloud-file-entry-README.md')).toBeTruthy()
    expect(screen.queryByTestId('cloud-terminal-panel-lazy')).toBeNull()
    expect(screen.queryByTestId('cloud-terminal-placeholder')).toBeNull()
    expect(panelModule.evaluations).toBe(0)
  })
})
