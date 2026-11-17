// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudLoginPanel, cloudErrorMessage } from './cloud-login-panel'

/**
 * M119/W10: the login form carries the platform address. It prefills from the
 * last successful login or the build default, validates inline, and a managed
 * build shows its pinned address read-only.
 */

const ADDRESS_LABEL = '平台地址'

function renderPanel(overrides: Partial<Parameters<typeof CloudLoginPanel>[0]> = {}): void {
  render(<CloudLoginPanel submitting={false} error={null} onSignIn={vi.fn()} {...overrides} />)
}

async function fillAndSubmit(input: {
  platformUrl?: string
  username?: string
  password?: string
}): Promise<void> {
  const {
    platformUrl = 'https://cloud.example.com',
    username = 'zhangsan',
    password = 'Passw0rd!'
  } = input
  if (platformUrl) {
    await userEvent.type(screen.getByLabelText(ADDRESS_LABEL), platformUrl)
  }
  await userEvent.type(screen.getByLabelText('域账号'), username)
  await userEvent.type(screen.getByLabelText('密码'), password)
  await act(async () => {
    await userEvent.click(screen.getByRole('button', { name: '登录' }))
  })
}

afterEach(cleanup)

describe('云端登录表单的平台地址（M119/W10）', () => {
  it('预填上次成功登录的地址与用户名，直接补密码即可登录', async () => {
    const onSignIn = vi.fn()
    renderPanel({
      defaultPlatformUrl: 'https://memory.example.com',
      defaultUsername: 'zhangsan',
      onSignIn
    })
    expect(screen.getByLabelText<HTMLInputElement>(ADDRESS_LABEL).value).toBe(
      'https://memory.example.com'
    )
    expect(screen.getByLabelText<HTMLInputElement>('域账号').value).toBe('zhangsan')

    await userEvent.type(screen.getByLabelText('密码'), 'Passw0rd!')
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录' }))
    })

    expect(onSignIn).toHaveBeenCalledWith('zhangsan', 'Passw0rd!', 'https://memory.example.com')
  })

  it('默认值晚于首帧到达时作为预填落入空字段', async () => {
    const { rerender } = render(
      <CloudLoginPanel submitting={false} error={null} onSignIn={vi.fn()} />
    )
    expect(screen.getByLabelText<HTMLInputElement>(ADDRESS_LABEL).value).toBe('')

    rerender(
      <CloudLoginPanel
        submitting={false}
        error={null}
        defaultPlatformUrl="https://late.example.com"
        defaultUsername="lisi"
        onSignIn={vi.fn()}
      />
    )
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>(ADDRESS_LABEL).value).toBe(
        'https://late.example.com'
      )
    )
    expect(screen.getByLabelText<HTMLInputElement>('域账号').value).toBe('lisi')
  })

  it('没有默认地址时必须填写，登录按钮才可用', async () => {
    const onSignIn = vi.fn()
    renderPanel({ onSignIn })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '登录' }).disabled).toBe(true)

    await fillAndSubmit({ platformUrl: '' })
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it('地址格式非法给内联报错，不发起登录', async () => {
    const onSignIn = vi.fn()
    renderPanel({ onSignIn })

    await fillAndSubmit({ platformUrl: 'cloud example' })

    expect(screen.getByRole('alert').textContent).toContain('平台地址格式不正确')
    expect(onSignIn).not.toHaveBeenCalled()

    // Typing again clears the stale message that described the previous value.
    await userEvent.type(screen.getByLabelText(ADDRESS_LABEL), 'https://fixed.example.com')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('托管构建锁定地址：只读展示并照常登录', async () => {
    const onSignIn = vi.fn()
    renderPanel({
      defaultPlatformUrl: 'https://pinned.example.com',
      defaultUsername: 'zhangsan',
      addressLocked: true,
      onSignIn
    })
    const field = screen.getByLabelText<HTMLInputElement>(ADDRESS_LABEL)
    expect(field.disabled).toBe(true)
    expect(screen.getByText('平台地址由企业管理员指定。')).toBeTruthy()

    await userEvent.type(screen.getByLabelText('密码'), 'Passw0rd!')
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: '登录' }))
    })

    expect(onSignIn).toHaveBeenCalledWith('zhangsan', 'Passw0rd!', 'https://pinned.example.com')
  })

  it('主进程拒绝的地址错误码映射为可读提示', () => {
    expect(cloudErrorMessage('PLATFORM_ADDRESS_INVALID')).toContain('平台地址格式不正确')
    expect(cloudErrorMessage('PLATFORM_ADDRESS_REQUIRED')).toContain('请填写平台地址')
  })

  it('LDAP 准入组拒绝给出可读提示，而不是裸露错误码', () => {
    expect(cloudErrorMessage('LDAP_GROUP_NOT_ADMITTED')).toBe('账号未加入平台准入组。')
  })
})
