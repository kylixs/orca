// @vitest-environment happy-dom
import * as React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudLoginEntryProvider, CloudLoginStatusSegment } from './cloud-login-entry'
import type { CloudSessionView } from './use-cloud-session'

/**
 * W11 (FR-2.7 revision): the native shell keeps a permanent cloud entry in every
 * build, as an in-flow status bar segment. Signed out, the segment opens the
 * login dialog (address prefilled from the login context, read-only on a managed
 * build); signed in, it shows the account and the way out. The dialog is the
 * only place the form lives, so the native workflow never disappears behind a
 * login page.
 */

function sessionView(overrides: Partial<CloudSessionView> = {}): CloudSessionView {
  return {
    status: 'signed-out',
    displayName: null,
    loginContext: null,
    projects: [],
    openProjectId: null,
    opened: null,
    route: null,
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

/** Why a factory: the segment derives from the session object, so failure and
 * signed-in transitions are driven by re-rendering with the mutated session. */
function makeSegment(
  session: CloudSessionView,
  options: { requestSignOut?: () => void; leading?: React.ReactNode } = {}
): () => React.JSX.Element {
  return () => (
    <CloudLoginEntryProvider
      session={session}
      requestSignOut={options.requestSignOut ?? vi.fn()}
      {...(options.leading !== undefined ? { leading: options.leading } : {})}
    >
      <div data-testid="native-shell">native shell stays mounted</div>
      <CloudLoginStatusSegment />
    </CloudLoginEntryProvider>
  )
}

function renderSegment(
  session: CloudSessionView,
  options: { requestSignOut?: () => void; leading?: React.ReactNode } = {}
): { rerender: (next: CloudSessionView) => void } {
  const view = makeSegment(session, options)
  const { rerender } = render(view())
  return { rerender: (next: CloudSessionView) => rerender(makeSegment(next, options)()) }
}

afterEach(cleanup)

async function openDialog(): Promise<void> {
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: '登录云端平台' }))
  })
  await screen.findByLabelText('域账号')
}

describe('原生界面的常驻登录入口（W11）', () => {
  it('零 env（无预填地址）也有按钮，弹框打开且地址留空待填', async () => {
    renderSegment(sessionView())

    await openDialog()

    expect(screen.getByLabelText<HTMLInputElement>('平台地址').value).toBe('')
    expect(screen.getByText('使用公司域账号登录后选择项目。')).toBeTruthy()
    expect(screen.getByTestId('native-shell')).toBeTruthy()
  })

  it('没有云端会话提供者（浏览器管理页/Orca Web）时整段不渲染', () => {
    render(<CloudLoginStatusSegment />)

    expect(screen.queryByRole('button', { name: '登录云端平台' })).toBeNull()
  })

  it('弹框可通过 Escape 与遮罩点击关闭', async () => {
    renderSegment(sessionView())
    await openDialog()

    await act(async () => {
      await userEvent.keyboard('{Escape}')
    })
    await waitFor(() => expect(screen.queryByLabelText('域账号')).toBeNull())

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录云端平台' }))
    })
    await screen.findByLabelText('域账号')
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')
    expect(overlay).not.toBeNull()
    await act(async () => {
      if (overlay) {
        await userEvent.click(overlay)
      }
    })
    await waitFor(() => expect(screen.queryByLabelText('域账号')).toBeNull())
  })

  it('登录上下文预填地址与用户名，登录成功后弹框关闭', async () => {
    const session = sessionView({
      loginContext: {
        platformUrl: 'https://memory.example.com',
        username: 'zhangsan',
        locked: false
      }
    })
    const signIn = vi.fn(async () => undefined)
    const { rerender } = renderSegment(session)
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录云端平台' }))
    })
    expect(screen.getByLabelText<HTMLInputElement>('平台地址').value).toBe(
      'https://memory.example.com'
    )
    expect(screen.getByLabelText<HTMLInputElement>('域账号').value).toBe('zhangsan')

    session.signIn = signIn
    rerender(session)
    await userEvent.type(screen.getByLabelText('密码'), 'Passw0rd!')
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录' }))
    })

    expect(signIn).toHaveBeenCalledWith('zhangsan', 'Passw0rd!', 'https://memory.example.com')
    // The session flipped to signed-in: the dialog closes on that state change.
    session.status = 'signed-in'
    session.displayName = '张伟'
    await act(async () => {
      rerender(session)
    })
    await waitFor(() => expect(screen.queryByLabelText('域账号')).toBeNull())
    expect(screen.getByText('张伟')).toBeTruthy()
  })

  it('登录失败给内联报错并保持弹框打开', async () => {
    const session = sessionView()
    const signIn = vi.fn(async () => {
      session.error = 'INVALID_CREDENTIALS'
    })
    const { rerender } = renderSegment(session)
    await openDialog()

    session.signIn = signIn
    rerender(session)
    await userEvent.type(screen.getByLabelText('平台地址'), 'https://cloud.example.com')
    await userEvent.type(screen.getByLabelText('域账号'), 'zhangsan')
    await userEvent.type(screen.getByLabelText('密码'), 'Passw0rd!')
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录' }))
    })
    rerender(session)

    expect(signIn).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toContain('账号或密码不正确')
    expect(screen.getByLabelText('域账号')).toBeTruthy()
  })

  it('托管构建：弹框地址只读并说明由管理员指定', async () => {
    renderSegment(
      sessionView({
        loginContext: {
          platformUrl: 'https://pinned.example.com',
          username: 'zhangsan',
          locked: true
        }
      })
    )
    await openDialog()

    const field = screen.getByLabelText<HTMLInputElement>('平台地址')
    expect(field.disabled).toBe(true)
    expect(field.value).toBe('https://pinned.example.com')
    expect(screen.getByText('平台地址由企业管理员指定。')).toBeTruthy()
  })

  it('已登录显示共享动作、用户名与登出，登出走提供者的统一入口', async () => {
    const requestSignOut = vi.fn()
    renderSegment(
      sessionView({
        status: 'signed-in',
        displayName: '张伟',
        loginContext: {
          platformUrl: 'https://cloud.example.com',
          username: 'zhangsan',
          locked: false
        }
      }),
      { requestSignOut, leading: <button type="button">新建云端项目</button> }
    )

    expect(screen.getByRole('button', { name: '新建云端项目' })).toBeTruthy()
    expect(screen.getByText('张伟')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登录云端平台' })).toBeNull()

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登出' }))
    })

    expect(requestSignOut).toHaveBeenCalledOnce()
  })
})
