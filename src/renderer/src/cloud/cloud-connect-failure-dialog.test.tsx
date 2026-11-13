// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudConnectFailureDialog, connectDiagnosticsText } from './cloud-connect-failure-dialog'

/**
 * AC-07's panel: the error code, every address that was tried with its outcome,
 * a retry entry and a copy action for escalation. The text sent to the admin is
 * the same list the user sees, so the two cannot drift.
 */

const DIAGNOSTICS = {
  probes: [
    { route: 'direct' as const, endpoint: '10.0.0.5:4433', ok: false, elapsedMs: 2001 },
    { route: 'relay' as const, endpoint: '10.0.0.9:4433', ok: false, elapsedMs: 12 }
  ]
}

afterEach(cleanup)

describe('云端连接失败面板（AC-07）', () => {
  it('展示错误码与逐地址诊断，并提供重试', () => {
    const onRetry = vi.fn()
    render(
      <CloudConnectFailureDialog
        code="ENDPOINT_UNREACHABLE"
        diagnostics={DIAGNOSTICS}
        retrying={false}
        onRetry={onRetry}
        onClose={() => undefined}
      />
    )

    expect(screen.getByTestId('cloud-connect-failure-code').textContent).toBe(
      'ENDPOINT_UNREACHABLE'
    )
    const steps = screen.getByTestId('cloud-connect-failure-steps')
    expect(steps.textContent).toContain('直连 10.0.0.5:4433 不可达（2001ms）')
    expect(steps.textContent).toContain('中继 10.0.0.9:4433 不可达（12ms）')

    fireEvent.click(screen.getByText('重试'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('重试进行中禁用按钮，避免重复发起', () => {
    const onRetry = vi.fn()
    render(
      <CloudConnectFailureDialog
        code="ENDPOINT_UNREACHABLE"
        diagnostics={DIAGNOSTICS}
        retrying
        onRetry={onRetry}
        onClose={() => undefined}
      />
    )
    const button = screen.getByText('重试中…')
    expect(button.closest('button')?.disabled).toBe(true)
    fireEvent.click(button)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('复制内容与界面显示的一致：错误码 + 每个地址一行', () => {
    expect(connectDiagnosticsText('ENDPOINT_UNREACHABLE', DIAGNOSTICS)).toBe(
      [
        'ENDPOINT_UNREACHABLE',
        '直连 10.0.0.5:4433 不可达（2001ms）',
        '中继 10.0.0.9:4433 不可达（12ms）'
      ].join('\n')
    )
  })
})
