// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloudConnectionEvent,
  CloudLoginContext,
  CloudOpenResult,
  CloudProjectSummary,
  CloudProjectRegistration,
  CloudRetryPrepareResult,
  CloudRpcOutcome,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'
import { CloudApp } from './cloud-app'
import { takeCloudAdminEmbedEntry } from './cloud-admin-embed'
import type { CloudBridge } from './use-cloud-session'
import { cloudWorktreeSelector } from '../../../shared/cloud-file-browser'
import { CLOUD_SESSION_TABS_RESTORE_CAPABILITY } from '../../../shared/cloud-workspace-info'

/**
 * U46-4: the admin page as the console's embedded workspace (§4.2/§6.2 C1–C5).
 * The bridge is scripted; the real exchange + persistence is covered in
 * cloud-browser-bridge.test.ts, and the real stack in cloud-admin-session.e2e.
 */

const PROJECT: CloudProjectSummary = {
  id: 'p1',
  key: 'payment-svc',
  name: 'payment-svc',
  hostName: 'dev-001',
  hostStatus: 'online',
  downloadRestricted: true,
  status: 'ready',
  provisioningError: null
}

const SIGNED_IN: CloudSessionState = {
  status: 'signed-in',
  displayName: '张伟',
  projects: [PROJECT]
}

const OPENED: Extract<CloudOpenResult, { ok: true }> = {
  ok: true,
  projectId: 'p1',
  route: 'relay',
  workspaceRoot: '/srv/work/payment-svc/.orca-worktrees/zhangsan',
  workspacePath: '/srv/work/payment-svc/.orca-worktrees/zhangsan',
  capabilities: ['pty'],
  permissions: ['open', 'terminal', 'file:read']
}

const WORKTREE = cloudWorktreeSelector(OPENED.workspacePath ?? '')

type Script = {
  state?: CloudSessionState
  /** The error code `loginWithHandoff` rejects with (C3). */
  handoffError?: string
  /** The platform url the login context reports (F-07 origin fallback). */
  platformUrl?: string
  /** The error code `openWorkspace` fails with (F-03 degraded page). */
  openError?: string
}

type TestBridge = CloudBridge & {
  handoffCalls: string[]
  openCalls: string[]
  closeCalls: string[]
  logoutCalls: number
}

function makeBridge(script: Script = {}): TestBridge {
  const bridge: TestBridge = {
    handoffCalls: [],
    openCalls: [],
    closeCalls: [],
    logoutCalls: 0,
    login: async (): Promise<CloudSessionState> => script.state ?? SIGNED_IN,
    loginWithHandoff: async (code: string): Promise<CloudSessionState> => {
      bridge.handoffCalls.push(code)
      if (script.handoffError) {
        throw Object.assign(new Error(script.handoffError), { code: script.handoffError })
      }
      return SIGNED_IN
    },
    getLoginContext: async (): Promise<CloudLoginContext | null> =>
      script.platformUrl === undefined
        ? null
        : { platformUrl: script.platformUrl, username: 'zhangsan', locked: true },
    logout: async (): Promise<CloudSessionState> => {
      bridge.logoutCalls += 1
      return { status: 'signed-out' }
    },
    getState: async (): Promise<CloudSessionState> => script.state ?? { status: 'signed-out' },
    listProjects: async () => [PROJECT],
    openProject: async (projectId: string): Promise<CloudOpenResult> => ({ ...OPENED, projectId }),
    openWorkspace: async (projectId: string): Promise<CloudOpenResult> => {
      bridge.openCalls.push(projectId)
      if (script.openError) {
        return { ok: false, code: script.openError }
      }
      return { ...OPENED, projectId }
    },
    registerProjects: async (): Promise<CloudProjectRegistration> => ({
      environments: [],
      failures: [],
      removedEnvironmentIds: []
    }),
    retryPrepare: async (): Promise<CloudRetryPrepareResult> => ({ ok: false, code: 'UNUSED' }),
    createProject: async () => ({ ok: false, code: 'UNUSED' }),
    archiveProject: async () => ({ ok: false, code: 'UNUSED' }),
    listProvisionableHosts: async () => [],
    closeProject: async (projectId: string) => {
      bridge.closeCalls.push(projectId)
      return { ok: true }
    },
    rpc: async (): Promise<CloudRpcOutcome> => ({ ok: true, result: { runtimeId: 'rt-1' } }),
    onConnectionChanged: (_listener: (event: CloudConnectionEvent) => void) => () => undefined
  }
  return bridge
}

/** happy-dom does not always set MessageEvent.source from the init dict. */
function dispatchParentMessage(
  data: Record<string, unknown>,
  origin = 'https://console.example'
): void {
  const event = new MessageEvent('message', { data, origin })
  Object.defineProperty(event, 'source', { value: window.parent })
  window.dispatchEvent(event)
}

afterEach(cleanup)

describe('U46-4 embed 入口', () => {
  it('C1 handoff code 在兑换前从 hash 清除；非 embed URL 不进入 embed', () => {
    const cleared: string[] = []
    const entry = takeCloudAdminEmbedEntry(
      { hash: '#handoff=code-1&project=p1', search: '?embed=1' },
      () => cleared.push('clear')
    )
    expect(entry).toEqual({ projectId: 'p1', handoffCode: 'code-1' })
    expect(cleared).toEqual(['clear'])

    // Reload: query still names the project, hash is already gone.
    const reload = takeCloudAdminEmbedEntry({ hash: '', search: '?embed=1&project=p1' }, () =>
      cleared.push('clear')
    )
    expect(reload).toEqual({ projectId: 'p1', handoffCode: null })
    expect(cleared).toEqual(['clear'])

    // C5: the standalone page is not embed mode.
    expect(
      takeCloudAdminEmbedEntry({ hash: '#handoff=c&project=p1', search: '?api=x' }, () => undefined)
    ).toBeNull()
  })

  it('C2 兑换成功 → 自动打开项目 → ready + dirty 上报，并渲染内嵌工作区', async () => {
    const bridge = makeBridge()
    const posted: Record<string, unknown>[] = []
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: 'code-1' }}
        postToParent={(message) => posted.push(message)}
      />
    )

    await waitFor(() => expect(bridge.handoffCalls).toEqual(['code-1']))
    await waitFor(() => expect(bridge.openCalls).toEqual(['p1']))
    await waitFor(() => expect(posted.some((message) => message.type === 'ready')).toBe(true))

    const ready = posted.find((message) => message.type === 'ready')
    expect(ready).toMatchObject({ source: 'orca-cloud-admin', type: 'ready', route: 'relay' })
    expect(typeof ready?.latencyMs).toBe('number')
    expect(posted).toContainEqual({ source: 'orca-cloud-admin', type: 'dirty', count: 0 })
    await waitFor(() => expect(screen.getByText('payment-svc')).toBeTruthy())
  })

  it('C3 兑换 410/403/网络失败 → 登录表单 + notice，不打开项目', async () => {
    const bridge = makeBridge({ handoffError: 'HANDOFF_GONE' })
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: 'spent-code' }}
        postToParent={() => undefined}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-embed-notice').textContent).toContain('已过期')
    )
    expect(screen.getByLabelText('域账号')).toBeTruthy()
    expect(bridge.openCalls).toEqual([])
  })

  it('C4 刷新（?embed=1&project）+ 已存会话 → 自动打开且不兑换；重渲染不双开', async () => {
    const bridge = makeBridge({ state: SIGNED_IN })
    const posted: Record<string, unknown>[] = []
    const embed = { projectId: 'p1', handoffCode: null }
    const { rerender } = render(
      <CloudApp bridge={bridge} embed={embed} postToParent={(message) => posted.push(message)} />
    )

    await waitFor(() => expect(bridge.openCalls).toEqual(['p1']))
    await waitFor(() => expect(posted.some((message) => message.type === 'ready')).toBe(true))
    expect(bridge.handoffCalls).toEqual([])

    rerender(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: null }}
        postToParent={(message) => posted.push(message)}
      />
    )
    await waitFor(() => expect(screen.getByText('payment-svc')).toBeTruthy())
    expect(bridge.openCalls).toEqual(['p1'])
    expect(posted.filter((message) => message.type === 'ready')).toHaveLength(1)
  })

  it('T11 刷新后持久会话已失效 → 登录表单（非空白），登录后自动打开同项目', async () => {
    const bridge = makeBridge({ platformUrl: 'https://platform.example' })
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: null }}
        postToParent={() => undefined}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId('cloud-embed-notice').textContent).toContain('嵌入会话已失效')
    )
    expect(screen.queryByTestId('cloud-embed-unavailable')).toBeNull()
    expect(bridge.openCalls).toEqual([])
    expect(screen.getByLabelText('域账号')).toBeTruthy()

    await waitFor(() =>
      expect((screen.getByLabelText('平台地址') as HTMLInputElement).value).toBe(
        'https://platform.example'
      )
    )
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } })
    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!)

    await waitFor(() => expect(bridge.openCalls).toEqual(['p1']))
  })

  it('父窗口 close 收尾并回 closed；logout 走 bridge.logout', async () => {
    const bridge = makeBridge()
    const posted: Record<string, unknown>[] = []
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: 'code-1' }}
        postToParent={(message) => posted.push(message)}
      />
    )
    await waitFor(() => expect(posted.some((message) => message.type === 'ready')).toBe(true))

    act(() => dispatchParentMessage({ type: 'close' }))
    await waitFor(() => expect(bridge.closeCalls).toEqual(['p1']))
    await waitFor(() =>
      expect(posted).toContainEqual({ source: 'orca-cloud-admin', type: 'closed' })
    )

    act(() => dispatchParentMessage({ type: 'logout' }))
    await waitFor(() => expect(bridge.logoutCalls).toBe(1))
  })

  it('U112 D1 end 先逐标签退役宿主 PTY/行，再 closeProject', async () => {
    const bridge = makeBridge()
    const posted: Record<string, unknown>[] = []
    const timeline: string[] = []
    const rpcCalls: { method: string; params?: Record<string, unknown> }[] = []
    bridge.closeProject = async (projectId: string) => {
      timeline.push('closeProject')
      bridge.closeCalls.push(projectId)
      return { ok: true }
    }
    bridge.rpc = async (method, params) => {
      timeline.push(method)
      rpcCalls.push({ method, params })
      if (method === 'workspace.info') {
        return {
          ok: true,
          result: {
            workspace: { branch: 'main' },
            capabilities: [CLOUD_SESSION_TABS_RESTORE_CAPABILITY]
          }
        }
      }
      if (method === 'session.tabs.list') {
        return {
          ok: true,
          result: {
            tabs: [
              { type: 'terminal', parentTabId: 'tab-a', leafId: 'leaf-1' },
              { type: 'terminal', parentTabId: 'tab-b', leafId: 'leaf-2' }
            ],
            activeTabId: 'tab-a'
          }
        }
      }
      return { ok: true, result: {} }
    }

    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: 'code-1' }}
        postToParent={(message) => posted.push(message)}
      />
    )
    await waitFor(() => expect(posted.some((message) => message.type === 'ready')).toBe(true))
    await waitFor(() =>
      expect(rpcCalls.some((call) => call.method === 'workspace.info')).toBe(true)
    )

    act(() => dispatchParentMessage({ type: 'end' }))
    await waitFor(() =>
      expect(posted).toContainEqual({ source: 'orca-cloud-admin', type: 'ended' })
    )

    expect(rpcCalls.filter((call) => call.method === 'session.tabs.close')).toEqual([
      {
        method: 'session.tabs.close',
        params: { worktree: WORKTREE, tabId: 'tab-a', reason: 'user' }
      },
      {
        method: 'session.tabs.close',
        params: { worktree: WORKTREE, tabId: 'tab-b', reason: 'user' }
      }
    ])
    // §4.3: the row retirement must be on the wire before the socket closes.
    expect(timeline.at(-1)).toBe('closeProject')
    expect(timeline.lastIndexOf('session.tabs.close')).toBeLessThan(
      timeline.lastIndexOf('closeProject')
    )
    expect(bridge.closeCalls).toEqual(['p1'])
  })

  it('B-令5 生命周期：ready 声明能力；close/suspend/end 各自回执，登出不隐式 end', async () => {
    const bridge = makeBridge()
    const posted: Record<string, unknown>[] = []
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: 'code-1' }}
        postToParent={(message) => posted.push(message)}
      />
    )
    await waitFor(() => expect(posted.some((message) => message.type === 'ready')).toBe(true))
    expect(posted.find((message) => message.type === 'ready')).toMatchObject({
      features: ['suspend', 'end']
    })

    // Old console: close is a suspend, but the legacy acknowledgement still lands.
    act(() => dispatchParentMessage({ type: 'close' }))
    await waitFor(() =>
      expect(posted).toContainEqual({ source: 'orca-cloud-admin', type: 'closed' })
    )
    expect(bridge.closeCalls).toEqual(['p1'])

    act(() => dispatchParentMessage({ type: 'suspend' }))
    await waitFor(() =>
      expect(posted).toContainEqual({ source: 'orca-cloud-admin', type: 'suspended' })
    )
    expect(bridge.closeCalls).toEqual(['p1', 'p1'])

    act(() => dispatchParentMessage({ type: 'end' }))
    await waitFor(() =>
      expect(posted).toContainEqual({ source: 'orca-cloud-admin', type: 'ended' })
    )
    expect(bridge.closeCalls).toEqual(['p1', 'p1', 'p1'])
    // No terminal.handle existed here, but an end must never hide a PTY close
    // behind an unmount policy: the workspace unmounted under the ending intent.
    expect(bridge.logoutCalls).toBe(0)
  })

  it('登出按 suspend 处理：iframe signOut，不关项目（不隐式 end）', async () => {
    const bridge = makeBridge()
    const posted: Record<string, unknown>[] = []
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: 'code-1' }}
        postToParent={(message) => posted.push(message)}
      />
    )
    await waitFor(() => expect(posted.some((message) => message.type === 'ready')).toBe(true))

    act(() => dispatchParentMessage({ type: 'logout' }))
    await waitFor(() => expect(bridge.logoutCalls).toBe(1))
    expect(bridge.closeCalls).toEqual([])
  })

  it('F-07 父消息负例：错误 origin/source 被忽略；referrer 缺失回落平台 origin', async () => {
    const bridge = makeBridge({ state: SIGNED_IN, platformUrl: 'https://platform.example' })
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: null }}
        postToParent={() => undefined}
      />
    )
    await waitFor(() => expect(bridge.openCalls).toEqual(['p1']))

    // Real parent window but a foreign origin: the close is ignored.
    act(() => dispatchParentMessage({ type: 'close' }, 'https://evil.example'))
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
    expect(bridge.closeCalls).toEqual([])

    // Right origin but another frame's source window: ignored too. (happy-dom's
    // window.parent is the window itself, so the frame must be a real second one.)
    const frame = document.createElement('iframe')
    document.body.appendChild(frame)
    const foreign = new MessageEvent('message', {
      data: { type: 'close' },
      origin: 'https://platform.example'
    })
    Object.defineProperty(foreign, 'source', { value: frame.contentWindow })
    act(() => window.dispatchEvent(foreign))
    frame.remove()
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)))
    expect(bridge.closeCalls).toEqual([])

    // No referrer + configured platform origin: the handshake still works.
    act(() => dispatchParentMessage({ type: 'close' }, 'https://platform.example'))
    await waitFor(() => expect(bridge.closeCalls).toEqual(['p1']))
  })

  it('F-03 ensure 失败 → §4.9 权限降级页，而非通用进度条', async () => {
    const bridge = makeBridge({ state: SIGNED_IN, openError: 'WORKSPACE_ENSURE_FAILED' })
    render(
      <CloudApp
        bridge={bridge}
        embed={{ projectId: 'p1', handoffCode: null }}
        postToParent={() => undefined}
      />
    )

    await waitFor(() => expect(screen.getByTestId('cloud-simple-workspace-degraded')).toBeTruthy())
    expect(screen.getByTestId('cloud-simple-workspace-degraded').textContent).toContain(
      'WORKSPACE_ENSURE_FAILED'
    )
    expect(screen.queryByTestId('cloud-embed-entering')).toBeNull()
  })

  it('C5 非 embed 模式零变化：工作台照常渲染，无自动打开、无消息上报', async () => {
    const bridge = makeBridge({ state: SIGNED_IN })
    const posted: Record<string, unknown>[] = []
    render(<CloudApp bridge={bridge} postToParent={(message) => posted.push(message)} />)

    await waitFor(() => expect(screen.getByText('工作台')).toBeTruthy())
    expect(bridge.openCalls).toEqual([])
    expect(bridge.handoffCalls).toEqual([])
    expect(posted).toEqual([])
  })
})
