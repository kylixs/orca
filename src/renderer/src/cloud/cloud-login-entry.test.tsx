// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudLoginEntry } from './cloud-login-entry'
import type { CloudSessionView } from './use-cloud-session'

/**
 * W11 (FR-2.7 revision): the native shell keeps a permanent cloud entry in every
 * build. Signed out, the chip opens the login dialog (address prefilled from the
 * login context, read-only on a managed build); signed in, it shows the account
 * and the way out. The dialog is the only place the form lives, so the native
 * workflow never disappears behind a login page.
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

function renderEntry(overrides: Partial<CloudSessionView> = {}): void {
  render(<CloudLoginEntry session={sessionView(overrides)} onSignOut={vi.fn(async () => {})} />)
}

async function openDialog(): Promise<void> {
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: '登录云端平台' }))
  })
  await screen.findByLabelText('域账号')
}

afterEach(cleanup)

describe('原生界面的常驻登录入口（W11）', () => {
  it('零 env 开发模式（无预填地址）也有按钮，弹框打开且地址留空待填', async () => {
    renderEntry()

    await openDialog()

    expect(screen.getByLabelText<HTMLInputElement>('平台地址').value).toBe('')
    expect(screen.getByText('使用公司域账号登录后选择项目。')).toBeTruthy()
  })

  it('弹框可通过 Escape 与遮罩点击关闭', async () => {
    renderEntry()
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
    const { rerender } = render(
      <CloudLoginEntry session={session} onSignOut={vi.fn(async () => {})} />
    )
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录云端平台' }))
    })
    expect(screen.getByLabelText<HTMLInputElement>('平台地址').value).toBe(
      'https://memory.example.com'
    )
    expect(screen.getByLabelText<HTMLInputElement>('域账号').value).toBe('zhangsan')

    session.signIn = signIn
    rerender(<CloudLoginEntry session={session} onSignOut={vi.fn(async () => {})} />)
    await act(async () => {
      await userEvent.type(screen.getByLabelText('密码'), 'Passw0rd!')
      await userEvent.click(screen.getByRole('button', { name: '登录' }))
    })

    expect(signIn).toHaveBeenCalledWith('zhangsan', 'Passw0rd!', 'https://memory.example.com')
    // The session flipped to signed-in: the dialog closes on that state change.
    session.status = 'signed-in'
    session.displayName = '张伟'
    await act(async () => {
      rerender(<CloudLoginEntry session={session} onSignOut={vi.fn(async () => {})} />)
    })
    await waitFor(() => expect(screen.queryByLabelText('域账号')).toBeNull())
    expect(screen.getByText('张伟')).toBeTruthy()
  })

  it('登录失败给内联报错并保持弹框打开', async () => {
    const session = sessionView()
    const signIn = vi.fn(async () => {
      session.error = 'INVALID_CREDENTIALS'
    })
    const { rerender } = render(
      <CloudLoginEntry session={session} onSignOut={vi.fn(async () => {})} />
    )
    await openDialog()

    session.signIn = signIn
    rerender(<CloudLoginEntry session={session} onSignOut={vi.fn(async () => {})} />)
    await userEvent.type(screen.getByLabelText('平台地址'), 'https://cloud.example.com')
    await userEvent.type(screen.getByLabelText('域账号'), 'zhangsan')
    await userEvent.type(screen.getByLabelText('密码'), 'Passw0rd!')
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录' }))
    })
    rerender(<CloudLoginEntry session={session} onSignOut={vi.fn(async () => {})} />)

    expect(signIn).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toContain('账号或密码不正确')
    expect(screen.getByLabelText('域账号')).toBeTruthy()
  })

  it('托管构建：弹框地址只读并说明由管理员指定', async () => {
    renderEntry({
      loginContext: {
        platformUrl: 'https://pinned.example.com',
        username: 'zhangsan',
        locked: true
      }
    })
    await openDialog()

    const field = screen.getByLabelText<HTMLInputElement>('平台地址')
    expect(field.disabled).toBe(true)
    expect(field.value).toBe('https://pinned.example.com')
    expect(screen.getByText('平台地址由企业管理员指定。')).toBeTruthy()
  })

  it('已登录显示用户名与登出；登出先清理云端仓库再结束会话', async () => {
    const onSignOut = vi.fn(async () => {})
    const sessionSignOut = vi.fn(async () => undefined)
    render(
      <CloudLoginEntry
        session={sessionView({
          status: 'signed-in',
          displayName: '张伟',
          signOut: sessionSignOut
        })}
        onSignOut={onSignOut}
      />
    )

    expect(screen.getByText('张伟')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登录云端平台' })).toBeNull()

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登出' }))
    })

    expect(onSignOut).toHaveBeenCalledOnce()
    expect(sessionSignOut).toHaveBeenCalledOnce()
    expect(onSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      sessionSignOut.mock.invocationCallOrder[0]
    )
  })
})
