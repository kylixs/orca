// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectSummary,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'
import { CloudApp } from './cloud-app'
import type { CloudBridge } from './use-cloud-session'

/**
 * UI behaviour of the cloud shell.
 *
 * The bridge is scripted here because happy-dom blocks cross-origin fetches to a
 * spawned platform. The real path — platform process, TLS runtime, E2EE socket —
 * is covered by cloud-session-service.test.ts and cloud-connect-client.test.ts;
 * this file pins what the user actually sees.
 */

const projects: CloudProjectSummary[] = [
  {
    id: 'p1',
    key: 'payment-svc',
    name: 'payment-svc',
    hostName: 'dev-001',
    hostStatus: 'online',
    downloadRestricted: true
  },
  {
    id: 'p2',
    key: 'refund-svc',
    name: 'refund-svc',
    hostName: 'dev-002',
    hostStatus: 'offline',
    downloadRestricted: true
  },
  {
    id: 'p3',
    key: 'ops-tools',
    name: 'ops-tools',
    hostName: 'dev-001',
    hostStatus: 'online',
    downloadRestricted: false
  }
]

type Script = { loginError?: string; openResult?: CloudOpenResult }

type TestBridge = CloudBridge & {
  emitClose: (event: CloudConnectionEvent) => void
  signedOut: boolean
}

function makeBridge(script: Script = {}): TestBridge {
  let listener: ((event: CloudConnectionEvent) => void) | null = null
  const bridge: TestBridge = {
    signedOut: false,
    emitClose: (event) => listener?.(event),
    login: async (username: string): Promise<CloudSessionState> => {
      if (script.loginError) {
        throw Object.assign(new Error(script.loginError), { code: script.loginError })
      }
      return { status: 'signed-in', displayName: `${username} 的显示名`, projects }
    },
    logout: async (): Promise<CloudSessionState> => {
      bridge.signedOut = true
      return { status: 'signed-out' }
    },
    getState: async (): Promise<CloudSessionState> => ({ status: 'signed-out' }),
    listProjects: async () => projects,
    openProject: async (projectId: string): Promise<CloudOpenResult> =>
      script.openResult ?? {
        ok: true,
        projectId,
        route: 'direct',
        workspaceRoot: `/srv/work/${projectId}`,
        capabilities: ['pty']
      },
    rpc: async () => ({ ok: true, result: {} }),
    onConnectionChanged: (next) => {
      listener = next
      return () => {
        listener = null
      }
    }
  }
  return bridge
}

async function signIn(bridge: CloudBridge, password = 'Passw0rd!'): Promise<void> {
  render(<CloudApp bridge={bridge} />)
  await waitFor(() => expect(screen.getByLabelText('域账号')).toBeTruthy())
  await userEvent.type(screen.getByLabelText('域账号'), 'zhangsan')
  await userEvent.type(screen.getByLabelText('密码'), password)
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
  })
}

// Why explicit: vitest globals are off, so RTL cannot register its auto-cleanup.
afterEach(cleanup)

describe('云端工作台界面', () => {
  it('未配置平台时显示不可用，而不是一个登不进去的表单', async () => {
    render(<CloudApp bridge={null} />)
    await waitFor(() => expect(screen.getByText(/未配置云端开发平台地址/)).toBeTruthy())
    expect(screen.queryByLabelText('域账号')).toBeNull()
  })

  it('登录失败按平台错误码给出中文提示', async () => {
    await signIn(makeBridge({ loginError: 'INVALID_CREDENTIALS' }), 'wrong')
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('账号或密码不正确'))
    expect(screen.getByLabelText('域账号')).toBeTruthy()
  })

  it('未知错误码回退到原始码，便于排查而不是吞掉', async () => {
    await signIn(makeBridge({ loginError: 'SOME_NEW_CODE' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('SOME_NEW_CODE'))
  })

  it('登录后列出项目：离线标注、下载受限单独标注、可导出项目不标注', async () => {
    await signIn(makeBridge())
    await waitFor(() => expect(screen.getByText('工作台')).toBeTruthy())

    expect(screen.getByText(/zhangsan 的显示名/)).toBeTruthy()
    expect(screen.getByText('主机离线')).toBeTruthy()
    // Two of three projects cannot export; ops-tools may.
    expect(screen.getAllByText('下载受限')).toHaveLength(2)
    // The offline host's project is listed but cannot be opened.
    const openButtons = screen.getAllByRole('button', { name: '打开' }) as HTMLButtonElement[]
    expect(openButtons).toHaveLength(3)
    expect(openButtons.filter((button) => button.disabled)).toHaveLength(1)
  })

  it('打开项目后显示线路', async () => {
    const bridge = makeBridge()
    await signIn(bridge)
    await waitFor(() => expect(screen.getByText('工作台')).toBeTruthy())

    const online = screen
      .getAllByRole('button', { name: '打开' })
      .find((button) => !(button as HTMLButtonElement).disabled)
    await act(async () => {
      await userEvent.click(online!)
    })
    await waitFor(() => expect(screen.getByTestId('cloud-route').textContent).toBe('直连'))
    expect(screen.getByRole('button', { name: '已打开' })).toBeTruthy()
  })

  it('打开失败把错误码摆在界面上，不保留"已打开"', async () => {
    await signIn(
      makeBridge({ openResult: { ok: false, code: 'HOST_OFFLINE', message: '开发机已离线' } })
    )
    await waitFor(() => expect(screen.getByText('工作台')).toBeTruthy())
    const online = screen
      .getAllByRole('button', { name: '打开' })
      .find((button) => !(button as HTMLButtonElement).disabled)
    await act(async () => {
      await userEvent.click(online!)
    })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HOST_OFFLINE'))
    expect(screen.queryByTestId('cloud-route')).toBeNull()
  })

  it('宿主关闭连接（吊销）后提示已被收回，并清除线路', async () => {
    const bridge = makeBridge()
    await signIn(bridge)
    await waitFor(() => expect(screen.getByText('工作台')).toBeTruthy())
    const online = screen
      .getAllByRole('button', { name: '打开' })
      .find((button) => !(button as HTMLButtonElement).disabled)
    await act(async () => {
      await userEvent.click(online!)
    })
    await waitFor(() => expect(screen.getByTestId('cloud-route')).toBeTruthy())

    await act(async () => {
      bridge.emitClose({
        projectId: 'p1',
        route: 'direct',
        closeCode: 4403,
        reason: 'device_revoked'
      })
    })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已被管理员收回'))
    expect(screen.queryByTestId('cloud-route')).toBeNull()
  })

  it('退出登录回到登录页', async () => {
    const bridge = makeBridge()
    await signIn(bridge)
    await waitFor(() => expect(screen.getByText('工作台')).toBeTruthy())
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '退出登录' }))
    })
    await waitFor(() => expect(screen.getByLabelText('域账号')).toBeTruthy())
    expect(bridge.signedOut).toBe(true)
  })
})
