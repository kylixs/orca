// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CloudFilePanel } from './cloud-file-panel'

/**
 * What the file pane shows the user. The host is scripted here; the same
 * functions run against a real host in cloud-file-panel.test.ts (main side).
 */

type Reply = (params?: Record<string, unknown>) => CloudRpcOutcome

function bridge(replies: Record<string, Reply>) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const rpc = async (
    method: string,
    params?: Record<string, unknown>
  ): Promise<CloudRpcOutcome> => {
    calls.push({ method, params })
    const reply = replies[method]
    return reply ? reply(params) : { ok: false, code: 'method_not_found' }
  }
  return { rpc, calls }
}

const listing =
  (entries: { name: string; isDirectory: boolean }[]): Reply =>
  () => ({
    ok: true,
    result: entries.map((entry) => ({ ...entry, isSymlink: false }))
  })

afterEach(cleanup)

describe('云端文件面板', () => {
  it('列目录、进子目录、打开文件预览', async () => {
    const host = bridge({
      'files.readDir': (params) =>
        params?.relativePath === 'src'
          ? { ok: true, result: [{ name: 'app.ts', isDirectory: false, isSymlink: false }] }
          : {
              ok: true,
              result: [
                { name: 'src', isDirectory: true, isSymlink: false },
                { name: 'README.md', isDirectory: false, isSymlink: false }
              ]
            },
      'files.readPreview': () => ({
        ok: true,
        result: { content: 'export const a = 1', isBinary: false }
      })
    })

    render(<CloudFilePanel rpc={host.rpc} workspacePath="/srv/checkout" />)

    await screen.findByTestId('cloud-file-entry-src')
    expect(screen.getByTestId('cloud-file-entry-README.md')).toBeTruthy()

    await userEvent.click(screen.getByTestId('cloud-file-entry-src'))
    await screen.findByTestId('cloud-file-entry-app.ts')
    expect(host.calls.at(-1)).toEqual({
      method: 'files.readDir',
      params: { worktree: 'path:/srv/checkout', relativePath: 'src' }
    })

    await userEvent.click(screen.getByTestId('cloud-file-entry-app.ts'))
    await waitFor(() =>
      expect(screen.getByTestId('cloud-file-content').textContent).toBe('export const a = 1')
    )
    expect(host.calls.at(-1)).toEqual({
      method: 'files.readPreview',
      params: { worktree: 'path:/srv/checkout', relativePath: 'src/app.ts' }
    })
  })

  it('主机拒绝时显示原因，不显示空目录', async () => {
    const host = bridge({
      'files.readDir': () => ({
        ok: false,
        code: 'forbidden',
        message: 'That file is outside the project this cloud session was granted.'
      })
    })
    render(<CloudFilePanel rpc={host.rpc} workspacePath="/srv/checkout" />)
    const error = await screen.findByTestId('cloud-file-error')
    expect(error.textContent).toContain('outside the project')
    expect(screen.queryByText('空目录')).toBeNull()
  })

  it('二进制文件只说明类型，不把内容当文本显示', async () => {
    const host = bridge({
      'files.readDir': listing([{ name: 'logo.png', isDirectory: false }]),
      'files.readPreview': () => ({
        ok: true,
        result: { content: 'iVBORw0KGgo=', isBinary: true, isImage: true, mimeType: 'image/png' }
      })
    })
    render(<CloudFilePanel rpc={host.rpc} workspacePath="/srv/checkout" />)
    await userEvent.click(await screen.findByTestId('cloud-file-entry-logo.png'))
    await waitFor(() => expect(screen.getByText(/image\/png/)).toBeTruthy())
    expect(screen.queryByTestId('cloud-file-content')).toBeNull()
  })
})
