// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
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
import { CloudLoginStatusSegment } from './cloud-login-entry'
import type { CloudBridge } from './use-cloud-session'

/** Why mocked: the sign-out failure path must be observable without a Toaster. */
const toastError = vi.hoisted(() => vi.fn())
const toastInfo = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: toastInfo }
}))

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

const EMPTY_REGISTRATION: CloudProjectRegistration = {
  environments: [],
  failures: [],
  removedEnvironmentIds: []
}

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
  }),
  overrides: Partial<CloudBridge> = {}
): CloudBridge {
  return {
    trustHostKey: async () => ({ ok: true as const }),
    login: async (): Promise<CloudSessionState> => ({
      status: 'signed-in',
      displayName: '张伟',
      projects: PROJECTS
    }),
    getLoginContext: async () => null,
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
    archiveProject: async () => ({ ok: false, code: 'ADMIN_SESSION_UNSUPPORTED' }),
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
    onConnectionChanged: (_listener: (event: CloudConnectionEvent) => void) => () => undefined,
    ...overrides
  }
}

function renderEntry(bridge: CloudBridge): void {
  Object.assign(window, {
    api: {
      cloud: bridge,
      runtimeEnvironments: { list: async () => [] }
    }
  })
  // Why the real segment: the sign-in/new-project controls live in the status
  // bar's cloud segment (W11), which is a child of this entry's provider.
  render(
    <CloudWorkspaceEntry>
      <div data-testid="workspace-shell" />
      <CloudLoginStatusSegment />
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

  it('登记返回已消失的环境 id 时清理对应侧栏行', async () => {
    const purge = vi.spyOn(useAppStore.getState(), 'purgeStaleRuntimeHostState')
    const bridge = makeBridge(
      Promise.resolve({
        environments: [],
        failures: [],
        removedEnvironmentIds: ['env-gone']
      })
    )
    renderEntry(bridge)

    await waitFor(() => expect(purge).toHaveBeenCalledWith(['env-gone']))
    purge.mockRestore()
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
        ],
        removedEnvironmentIds: []
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
        ],
        removedEnvironmentIds: []
      })
    )
    renderEntry(bridge)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('CLONE_FAILED')
    expect(screen.getByRole('button', { name: '新建云端项目' })).toBeTruthy()
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })

  it('创建后准备失败的项目进入失败横幅，重试成功后消失', async () => {
    const createdProject: CloudProjectSummary = {
      id: 'proj_new',
      key: 'broken-source',
      name: 'Broken Source',
      hostName: 'dev-001',
      hostStatus: 'online',
      downloadRestricted: false,
      status: 'failed',
      provisioningError: 'CLONE_FAILED'
    }
    const environment = {
      projectId: 'proj_new',
      projectName: 'Broken Source',
      projectRoot: '/srv/projects/broken-source',
      environmentId: 'env-new'
    }
    const bridge = makeBridge(
      Promise.resolve(EMPTY_REGISTRATION),
      async () => ({
        ok: true,
        environment
      }),
      {
        listProvisionableHosts: async () => [
          {
            id: 'host_1',
            name: 'dev-001',
            online: true,
            provisionable: true,
            projectDirs: []
          }
        ],
        createProject: async () => ({
          ok: false,
          code: 'CLONE_FAILED',
          projectId: 'proj_new',
          project: createdProject
        })
      }
    )
    renderEntry(bridge)

    fireEvent.click(await screen.findByRole('button', { name: '新建云端项目' }))
    // 主机未上报目录清单，对话框自动切到「新建目录」。
    await screen.findByText('dev-001')
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Broken Source' } })
    fireEvent.change(screen.getByLabelText('目录'), { target: { value: 'broken-source' } })
    fireEvent.change(screen.getByLabelText('仓库地址'), {
      target: { value: '/srv/missing.git' }
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Broken Source')
    expect(alert.textContent).toContain('CLONE_FAILED')
    await waitFor(() => expect(screen.queryByLabelText('名称')).toBeNull())

    await act(async () => {
      screen.getByRole('button', { name: '重试' }).click()
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('workspace-shell')).toBeTruthy()
  })

  it('U44 创建后仍在准备：显示准备中文案，不挂失败横幅', async () => {
    const preparingProject: CloudProjectSummary = {
      id: 'proj_new',
      key: 'payment-service',
      name: 'Payment Service',
      hostName: 'dev-001',
      hostStatus: 'online',
      downloadRestricted: false,
      status: 'provisioning',
      provisioningError: null
    }
    toastInfo.mockClear()
    const bridge = makeBridge(Promise.resolve(EMPTY_REGISTRATION), undefined, {
      listProvisionableHosts: async () => [
        {
          id: 'host_1',
          name: 'dev-001',
          online: true,
          provisionable: true,
          projectDirs: []
        }
      ],
      createProject: async () => ({
        ok: true,
        preparing: true,
        projectId: 'proj_new',
        project: preparingProject
      })
    })
    renderEntry(bridge)

    fireEvent.click(await screen.findByRole('button', { name: '新建云端项目' }))
    await screen.findByText('dev-001')
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Payment Service' } })
    fireEvent.change(screen.getByLabelText('目录'), { target: { value: 'payment-service' } })
    fireEvent.change(screen.getByLabelText('仓库地址'), { target: { value: '/srv/payment.git' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '创建' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith('宿主正在准备环境，就绪后可打开', expect.anything())
    )
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(screen.queryByLabelText('名称')).toBeNull())
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
        ],
        removedEnvironmentIds: []
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

  it('登出一轮完成：main 登出一次、侧栏行清理、入口回到登录态', async () => {
    const purge = vi.spyOn(useAppStore.getState(), 'purgeStaleRuntimeHostState')
    const hydrate = vi
      .spyOn(useAppStore.getState(), 'hydrateRuntimeEnvironmentStatuses')
      .mockResolvedValue(undefined)
    const logout = vi.fn(async (): Promise<CloudSessionState> => ({ status: 'signed-out' }))
    const environment = {
      projectId: 'proj_1',
      projectName: 'Payment Service',
      projectRoot: '/srv/projects/payment-service',
      environmentId: 'env-1'
    }
    const bridge = makeBridge(
      Promise.resolve({
        environments: [environment],
        failures: [],
        removedEnvironmentIds: []
      }),
      async () => ({ ok: true, environment }),
      { logout }
    )
    renderEntry(bridge)
    await waitFor(() => expect(screen.getByRole('button', { name: '登出' })).toBeTruthy())

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登出' }))
    })

    await waitFor(() => expect(screen.getByRole('button', { name: '登录云端平台' })).toBeTruthy())
    // One logout round: the repo-sync chain reuses the session's sign-out.
    expect(logout).toHaveBeenCalledOnce()
    expect(purge).toHaveBeenCalledWith(['env-1'])
    expect(hydrate).toHaveBeenCalled()
    purge.mockRestore()
    hydrate.mockRestore()
  })

  it('登出失败有可见提示，且不把会话伪装成已登出', async () => {
    const logout = vi.fn(async (): Promise<CloudSessionState> => {
      throw new Error('LOGOUT_FAILED')
    })
    const environment = {
      projectId: 'proj_1',
      projectName: 'Payment Service',
      projectRoot: '/srv/projects/payment-service',
      environmentId: 'env-1'
    }
    const bridge = makeBridge(
      Promise.resolve({
        environments: [environment],
        failures: [],
        removedEnvironmentIds: []
      }),
      async () => ({ ok: true, environment }),
      { logout }
    )
    renderEntry(bridge)
    await waitFor(() => expect(screen.getByRole('button', { name: '登出' })).toBeTruthy())

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登出' }))
    })

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('登出失败，请重试。', expect.anything())
    )
    expect(screen.getByRole('button', { name: '登出' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登录云端平台' })).toBeNull()
  })
})
