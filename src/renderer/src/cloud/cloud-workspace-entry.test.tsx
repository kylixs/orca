// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectRegistration,
  CloudProjectSummary,
  CloudRetryPrepareResult,
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
    downloadRestricted: true,
    status: 'failed',
    provisioningError: 'CLONE_FAILED'
  }
]

const EMPTY_REGISTRATION: CloudProjectRegistration = { environments: [], failures: [] }

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function makeBridge(
  registerProjects: Promise<CloudProjectRegistration>,
  retryPrepare: (projectId: string) => Promise<CloudRetryPrepareResult> = async () => ({
    ok: false,
    code: 'CLONE_FAILED'
  })
): CloudBridge {
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
    retryPrepare,
    createProject: async () => ({ ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }),
    listProvisionableHosts: async () => [],
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

function renderEntry(bridge: CloudBridge): void {
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
}

afterEach(() => {
  cleanup()
  Object.assign(window, { api: undefined })
})

describe('云端原生入口', () => {
  it('签到后显示准备中提示，准备完成后提示消失且工作区不被隐藏', async () => {
    const gate = deferred<CloudProjectRegistration>()
    const bridge = makeBridge(gate.promise)
    renderEntry(bridge)

    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('正在准备云端项目…')
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()

    await act(async () => {
      gate.resolve(EMPTY_REGISTRATION)
    })

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })

  it('登记失败时显示项目名与错误码，且不阻塞工作区', async () => {
    const bridge = makeBridge(
      Promise.resolve({
        environments: [],
        failures: [
          {
            projectId: 'proj_1',
            projectKey: 'payment-service',
            projectName: 'Payment Service',
            code: 'CLONE_FAILED',
            message: '项目准备失败'
          }
        ]
      })
    )
    renderEntry(bridge)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('部分云端项目准备失败')
    expect(alert.textContent).toContain('Payment Service')
    expect(alert.textContent).toContain('CLONE_FAILED')
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })

  it('已登录显示新建云端项目按钮，且与失败横幅共存', async () => {
    const bridge = makeBridge(
      Promise.resolve({
        environments: [],
        failures: [
          {
            projectId: 'proj_1',
            projectKey: 'payment-service',
            projectName: 'Payment Service',
            code: 'CLONE_FAILED'
          }
        ]
      })
    )
    renderEntry(bridge)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('CLONE_FAILED')
    expect(screen.getByRole('button', { name: '新建云端项目' })).toBeTruthy()
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })

  it('重试成功后失败提示消失；重试失败则更新错误码', async () => {
    const environment = {
      projectId: 'proj_1',
      projectName: 'Payment Service',
      projectRoot: '/srv/work/payment-service',
      environmentId: 'env-1'
    }
    let retried = false
    const bridge = makeBridge(
      Promise.resolve({
        environments: [],
        failures: [
          {
            projectId: 'proj_1',
            projectKey: 'payment-service',
            projectName: 'Payment Service',
            code: 'CLONE_FAILED'
          }
        ]
      }),
      async () => {
        if (!retried) {
          retried = true
          return { ok: false, code: 'HOST_UNREACHABLE' }
        }
        return { ok: true, environment }
      }
    )
    renderEntry(bridge)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('CLONE_FAILED')

    await act(async () => {
      screen.getByRole('button', { name: '重试' }).click()
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HOST_UNREACHABLE'))

    await act(async () => {
      screen.getByRole('button', { name: '重试' }).click()
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })
})
