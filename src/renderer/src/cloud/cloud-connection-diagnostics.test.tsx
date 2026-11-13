// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudProjectSummary, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CloudProjectWorkspace } from './cloud-project-workspace'
import type { CloudSessionView } from './use-cloud-session'

/**
 * FR-5.7: a workspace that is working says which line it is on, what the probe
 * cost, and opens a panel listing every address that was tried — the same
 * evidence that used to appear only after a failure.
 */

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

const DIAGNOSTICS = {
  probes: [
    { route: 'direct' as const, endpoint: '10.0.0.5:4433', ok: false, elapsedMs: 1002 },
    { route: 'relay' as const, endpoint: '10.0.0.9:4433', ok: true, elapsedMs: 24 }
  ]
}

function session(overrides: Partial<CloudSessionView> = {}): CloudSessionView {
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
      permissions: ['open', 'file:read'],
      route: 'relay',
      connectDiagnostics: DIAGNOSTICS
    },
    route: 'relay',
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
    closeProject: async () => undefined,
    ...overrides
  }
}

function rpc(): (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome> {
  return async (method) => {
    if (method === 'status.get') {
      return { ok: true, result: { runtimeId: 'rt-1' } }
    }
    if (method === 'files.readDir') {
      return { ok: true, result: [] }
    }
    return { ok: false, code: 'method_not_found' }
  }
}

const noop = (): void => undefined

afterEach(cleanup)

describe('工作区连接诊断（FR-5.7）', () => {
  it('M101-1 顶部显示线路与选中线路的延迟，可打开诊断面板查看逐地址结果', async () => {
    render(<CloudProjectWorkspace session={session()} project={PROJECT} rpc={rpc()} />)

    expect(screen.getByTestId('cloud-route').textContent).toBe('中继')
    expect(screen.getByTestId('cloud-route-latency').textContent).toBe('24ms')

    await userEvent.click(screen.getByTestId('cloud-open-diagnostics'))
    const steps = await screen.findByTestId('cloud-diagnostics-steps')
    expect(steps.textContent).toContain('直连 10.0.0.5:4433（1002ms）')
    expect(steps.textContent).toContain('中继 10.0.0.9:4433（24ms）')
    expect(steps.textContent).toContain('无响应')
    expect(steps.textContent).toContain('已连通')
    expect(screen.getByTestId('cloud-diagnostics-route').textContent).toBe('中继')
    expect(screen.getByTestId('cloud-diagnostics-endpoint').textContent).toBe('10.0.0.9:4433')
    expect(screen.getByTestId('cloud-diagnostics-latency').textContent).toBe('24ms')
  })

  it('M101-2 没有诊断数据时不显示延迟与诊断入口（旧回复不假装知道）', async () => {
    const opened = session().opened
    if (!opened) {
      throw new Error('fixture must open a project')
    }
    const { connectDiagnostics: _dropped, ...withoutDiagnostics } = opened
    render(
      <CloudProjectWorkspace
        session={session({ opened: withoutDiagnostics })}
        project={PROJECT}
        rpc={rpc()}
      />
    )
    await waitFor(() => expect(screen.getByTestId('cloud-route')).toBeTruthy())
    expect(screen.queryByTestId('cloud-route-latency')).toBeNull()
    expect(screen.queryByTestId('cloud-open-diagnostics')).toBeNull()
    void noop
  })
})
