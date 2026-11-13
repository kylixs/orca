// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectEnvironment,
  CloudProjectSummary,
  CloudRpcOutcome,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'
import { CloudWorkspaceEntry } from './cloud-workspace-entry'
import type { CloudBridge } from './use-cloud-session'

const PROJECTS: CloudProjectSummary[] = [
  {
    id: 'proj_1',
    key: 'payment-service',
    name: 'Payment Service',
    hostName: 'dev-001',
    hostStatus: 'online',
    downloadRestricted: true
  }
]

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeBridge(registerProjects: Promise<CloudProjectEnvironment[]>): CloudBridge {
  return {
    login: async (): Promise<CloudSessionState> => ({
      status: 'signed-in',
      displayName: '张伟',
      projects: PROJECTS
    }),
    openWorkspace: async (projectId: string): Promise<CloudOpenResult> => ({
      ok: true,
      projectId,
      route: 'direct',
      workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan',
      capabilities: []
    }),
    registerProjects: async () => registerProjects,
    closeProject: async () => ({ ok: true }),
    logout: async (): Promise<CloudSessionState> => ({ status: 'signed-out' }),
    getState: async (): Promise<CloudSessionState> => ({
      status: 'signed-in',
      displayName: '张伟',
      projects: PROJECTS
    }),
    listProjects: async () => PROJECTS,
    openProject: async (projectId: string): Promise<CloudOpenResult> => ({
      ok: true,
      projectId,
      route: 'direct',
      workspaceRoot: '/srv/work/payment-service/.orca-worktrees/zhangsan',
      capabilities: []
    }),
    rpc: async (): Promise<CloudRpcOutcome> => ({ ok: true, result: {} }),
    onConnectionChanged: (_listener: (event: CloudConnectionEvent) => void) => () => undefined
  }
}

afterEach(() => {
  cleanup()
  Object.assign(window, { api: undefined })
})

describe('云端原生入口', () => {
  it('签到后显示准备中提示，准备完成后提示消失且工作区不被隐藏', async () => {
    const gate = deferred<CloudProjectEnvironment[]>()
    const bridge = makeBridge(gate.promise)
    Object.assign(window, {
      api: {
        cloud: bridge,
        runtimeEnvironments: { list: async () => [] }
      }
    })

    render(
      <CloudWorkspaceEntry>
        <div data-testid="workspace-shell" />
      </CloudWorkspaceEntry>
    )

    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('正在准备云端项目…')
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()

    await act(async () => {
      gate.resolve([])
    })

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })
})
