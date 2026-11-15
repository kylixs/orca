// @vitest-environment happy-dom
import * as React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudProjectPermission, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CloudWorkspaceFileTab, createCloudWorkspaceFileTab } from './cloud-workspace-file-tab'
import type { CloudWorkspaceEditorProps } from './cloud-workspace-monaco-editor'
import type { CloudSimpleWorkspaceTabsAction } from './cloud-simple-workspace-tabs'

/**
 * U46-7a T4/T5: open → edit → save, conflict box, read-only downgrade,
 * Monaco language mapping, markdown toggle, and dirty reporting.
 */

const ALL: CloudProjectPermission[] = ['open', 'terminal', 'file:read', 'file:write']

function FakeEditor({
  value,
  language,
  readOnly,
  onChange,
  onSave
}: CloudWorkspaceEditorProps): React.JSX.Element {
  return (
    <div data-testid="fake-editor">
      <span data-testid="fake-editor-language">{language}</span>
      <textarea
        data-testid="fake-editor-input"
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" data-testid="fake-editor-save" onClick={onSave}>
        editor-save
      </button>
    </div>
  )
}

type RpcScript = {
  content: string
  truncated?: boolean
  binary?: boolean
  writeFailure?: { code: string; message?: string }
  readFailure?: { code: string; message?: string }
}

function makeRpc(script: RpcScript) {
  let content = script.content
  const rpc = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<CloudRpcOutcome> => {
      if (method === 'files.read') {
        if (script.readFailure) {
          return { ok: false, ...script.readFailure }
        }
        return {
          ok: true,
          result: {
            content,
            truncated: script.truncated === true,
            byteLength: content.length,
            ...(script.binary === true ? { isBinary: true } : {})
          }
        }
      }
      if (method === 'files.write') {
        if (script.writeFailure) {
          return { ok: false, ...script.writeFailure }
        }
        content = String(params?.content ?? '')
        return { ok: true, result: null }
      }
      return { ok: false, code: 'method_denied' }
    }
  )
  const cloudRpc: CloudRpc = rpc
  return {
    rpc: cloudRpc,
    mock: rpc,
    setContent: (next: string) => {
      content = next
    }
  }
}

function renderTab(
  options: {
    rpc?: ReturnType<typeof makeRpc>
    path?: string
    permissions?: CloudProjectPermission[]
    title?: string
  } = {}
) {
  const mock = options.rpc ?? makeRpc({ content: 'base' })
  const dispatch = vi.fn<(action: CloudSimpleWorkspaceTabsAction) => void>()
  const path = options.path ?? 'src/a.ts'
  render(
    <CloudWorkspaceFileTab
      tab={{ id: `file:${path}`, kind: 'editor', title: options.title ?? 'a.ts', path }}
      active
      dispatch={dispatch}
      rpc={mock.rpc}
      workspacePath="/srv/wt"
      permissions={options.permissions ?? ALL}
      editor={FakeEditor}
    />
  )
  return { mock, dispatch, path }
}

function dirtyActions(
  dispatch: ReturnType<typeof vi.fn<(action: CloudSimpleWorkspaceTabsAction) => void>>
): CloudSimpleWorkspaceTabsAction[] {
  return dispatch.mock.calls.map((call) => call[0]).filter((action) => action.type === 'setDirty')
}

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
})

describe('工作区文件编辑标签', () => {
  it('打开 worktree 内文件、按扩展名着色，初始为干净状态', async () => {
    const { mock, dispatch } = renderTab()

    const input = await screen.findByTestId('fake-editor-input')

    expect((input as HTMLTextAreaElement).value).toBe('base')
    expect(screen.getByTestId('fake-editor-language').textContent).toBe('typescript')
    // Pure source formats get no mode switch (FS-1).
    expect(screen.queryByTestId('cloud-workspace-file-tab-mode-preview')).toBeNull()
    expect(mock.mock).toHaveBeenCalledWith('files.read', {
      worktree: 'path:/srv/wt',
      relativePath: 'src/a.ts'
    })
    expect(dirtyActions(dispatch)).toEqual([
      { type: 'setDirty', id: 'file:src/a.ts', dirty: false }
    ])
  })

  it('编辑上报 dirty；保存前重读一致时 files.write 写入完整内容并清除 dirty', async () => {
    const user = userEvent.setup()
    const rpc = makeRpc({ content: 'base' })
    const { dispatch } = renderTab({ rpc })

    const input = await screen.findByTestId('fake-editor-input')
    await user.clear(input)
    await user.type(input, 'edited')

    await waitFor(() =>
      expect(dirtyActions(dispatch)).toContainEqual({
        type: 'setDirty',
        id: 'file:src/a.ts',
        dirty: true
      })
    )

    await user.click(screen.getByTestId('cloud-workspace-file-tab-save'))

    await waitFor(() =>
      expect(rpc.mock).toHaveBeenCalledWith('files.write', {
        worktree: 'path:/srv/wt',
        relativePath: 'src/a.ts',
        content: 'edited',
        expectedExecutionHostId: 'local'
      })
    )
    // Initial read + save-time re-read.
    expect(rpc.mock.mock.calls.filter((call) => call[0] === 'files.read')).toHaveLength(2)
    await waitFor(() =>
      expect(dirtyActions(dispatch).at(-1)).toEqual({
        type: 'setDirty',
        id: 'file:src/a.ts',
        dirty: false
      })
    )
    expect(screen.getByTestId('cloud-workspace-file-tab-save').hasAttribute('disabled')).toBe(true)
  })

  it('保存前重读发现外部修改 → 冲突框，不静默覆盖；覆盖保存写入本地缓冲', async () => {
    const user = userEvent.setup()
    const rpc = makeRpc({ content: 'base' })
    renderTab({ rpc })

    const input = await screen.findByTestId('fake-editor-input')
    await user.clear(input)
    await user.type(input, 'edited')
    rpc.setContent('remote change')

    await user.click(screen.getByTestId('cloud-workspace-file-tab-save'))

    const conflict = await screen.findByTestId('cloud-workspace-file-tab-conflict')
    expect(conflict.textContent).toContain('文件已在别处修改')
    expect(rpc.mock.mock.calls.filter((call) => call[0] === 'files.write')).toHaveLength(0)

    await user.click(screen.getByTestId('cloud-workspace-file-tab-conflict-overwrite'))
    await waitFor(() =>
      expect(rpc.mock).toHaveBeenCalledWith('files.write', {
        worktree: 'path:/srv/wt',
        relativePath: 'src/a.ts',
        content: 'edited',
        expectedExecutionHostId: 'local'
      })
    )
    expect(screen.queryByTestId('cloud-workspace-file-tab-conflict')).toBeNull()
  })

  it('冲突框「重新加载」丢弃本地缓冲并回到干净状态', async () => {
    const user = userEvent.setup()
    const rpc = makeRpc({ content: 'base' })
    const { dispatch } = renderTab({ rpc })

    const input = await screen.findByTestId('fake-editor-input')
    await user.clear(input)
    await user.type(input, 'edited')
    rpc.setContent('remote change')
    await user.click(screen.getByTestId('cloud-workspace-file-tab-save'))

    const conflict = await screen.findByTestId('cloud-workspace-file-tab-conflict')
    await user.click(within(conflict).getByTestId('cloud-workspace-file-tab-conflict-reload'))

    await waitFor(() =>
      expect((screen.getByTestId('fake-editor-input') as HTMLTextAreaElement).value).toBe(
        'remote change'
      )
    )
    expect(dirtyActions(dispatch).at(-1)).toEqual({
      type: 'setDirty',
      id: 'file:src/a.ts',
      dirty: false
    })
  })

  it('冲突框「取消」保留本地缓冲，不写回', async () => {
    const user = userEvent.setup()
    const rpc = makeRpc({ content: 'base' })
    renderTab({ rpc })

    const input = await screen.findByTestId('fake-editor-input')
    await user.clear(input)
    await user.type(input, 'edited')
    rpc.setContent('remote change')
    await user.click(screen.getByTestId('cloud-workspace-file-tab-save'))

    const conflict = await screen.findByTestId('cloud-workspace-file-tab-conflict')
    await user.click(within(conflict).getByTestId('cloud-workspace-file-tab-conflict-cancel'))

    expect(screen.queryByTestId('cloud-workspace-file-tab-conflict')).toBeNull()
    expect((screen.getByTestId('fake-editor-input') as HTMLTextAreaElement).value).toBe('edited')
    expect(rpc.mock.mock.calls.filter((call) => call[0] === 'files.write')).toHaveLength(0)
  })

  it('无 file:write → 只读：无保存按钮、有只读徽标、编辑器只读', async () => {
    renderTab({ permissions: ['open', 'terminal', 'file:read'] })

    const input = await screen.findByTestId('fake-editor-input')

    expect((input as HTMLTextAreaElement).readOnly).toBe(true)
    expect(screen.queryByTestId('cloud-workspace-file-tab-save')).toBeNull()
    expect(screen.getByTestId('cloud-workspace-file-tab-readonly').textContent).toContain('只读')
  })

  it('截断文件降级为只读并提示，绝不写回', async () => {
    const rpc = makeRpc({ content: 'partial', truncated: true })
    renderTab({ rpc })

    const input = await screen.findByTestId('fake-editor-input')

    expect((input as HTMLTextAreaElement).readOnly).toBe(true)
    expect(screen.getByTestId('cloud-workspace-file-tab-notice').textContent).toContain('已截断')
    expect(screen.queryByTestId('cloud-workspace-file-tab-save')).toBeNull()
  })

  it('宿主以 binary_file 拒绝读取 → 二进制占位，而非编辑器', async () => {
    renderTab({
      path: 'dist/app.bin',
      rpc: makeRpc({ content: '', readFailure: { code: 'binary_file' } })
    })

    const binary = await screen.findByTestId('cloud-workspace-file-tab-binary')
    expect(binary.textContent).toContain('二进制')
    expect(binary.textContent).toContain('下载')
    expect(screen.queryByTestId('fake-editor-input')).toBeNull()
    expect(screen.queryByTestId('cloud-workspace-file-tab-save')).toBeNull()
  })

  it('读取内容含 NUL 字节 → 二进制占位，而非只读 Monaco（FS-1）', async () => {
    const rpc = makeRpc({ content: 'abc\u0000def' })
    renderTab({ path: 'data/unknown.dat', rpc })

    const binary = await screen.findByTestId('cloud-workspace-file-tab-binary')
    expect(binary.textContent).toContain('二进制')
    expect(binary.textContent).toContain('下载')
    expect(screen.queryByTestId('fake-editor-input')).toBeNull()
    expect(screen.queryByTestId('cloud-workspace-file-tab-save')).toBeNull()
    expect(rpc.mock.mock.calls.filter((call) => call[0] === 'files.write')).toHaveLength(0)
  })

  it('宿主 binary 标志 → 二进制占位，而非只读 Monaco（FS-1）', async () => {
    renderTab({ path: 'data/unknown.dat', rpc: makeRpc({ content: 'abc', binary: true }) })

    await screen.findByTestId('cloud-workspace-file-tab-binary')
    expect(screen.queryByTestId('fake-editor-input')).toBeNull()
    expect(screen.queryByTestId('cloud-workspace-file-tab-save')).toBeNull()
  })

  it('无 file:read → 拒绝态，不发 RPC', async () => {
    const rpc = makeRpc({ content: 'base' })
    renderTab({ rpc, permissions: ['open', 'terminal'] })

    expect(screen.getByTestId('cloud-workspace-file-tab-denied').textContent).toContain(
      '未授予文件读取权限'
    )
    expect(rpc.mock).not.toHaveBeenCalled()
  })

  it('markdown 默认预览：渲染标题、脚本不执行、javascript: 链接被清除，可切源码', async () => {
    const user = userEvent.setup()
    renderTab({
      path: 'README.md',
      title: 'README.md',
      rpc: makeRpc({
        content: [
          '# 标题',
          '',
          '<script>window.__xss = true</script>',
          '',
          '[bad](javascript:alert(1))',
          '',
          '- 列表项',
          '',
          '```ts',
          'const value = 1',
          '```',
          '',
          '| 列 | 值 |',
          '| --- | --- |',
          '| a | b |'
        ].join('\n')
      })
    })

    const preview = await screen.findByTestId('cloud-workspace-markdown-preview', undefined, {
      timeout: 10_000
    })
    expect(screen.queryByTestId('fake-editor-input')).toBeNull()
    expect(
      screen.getByTestId('cloud-workspace-file-tab-mode-preview').getAttribute('aria-pressed')
    ).toBe('true')
    expect(within(preview).getByRole('heading', { name: '标题' })).toBeTruthy()
    expect(within(preview).getByText('列表项')).toBeTruthy()
    expect(preview.querySelector('pre code')?.textContent).toContain('const value = 1')
    expect(within(preview).getByRole('table')).toBeTruthy()
    expect(within(preview).getByRole('columnheader', { name: '列' })).toBeTruthy()
    expect(preview.querySelector('script')).toBeNull()
    const link = preview.querySelector('a')
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:')

    await user.click(screen.getByTestId('cloud-workspace-file-tab-mode-edit'))
    expect(await screen.findByTestId('fake-editor-input')).toBeTruthy()

    await user.click(screen.getByTestId('cloud-workspace-file-tab-mode-preview'))
    await screen.findByTestId('cloud-workspace-markdown-preview')
  })

  it('HTML 默认预览；源码模式为可编辑 Monaco，可保存', async () => {
    const user = userEvent.setup()
    const html = '<!doctype html><html><body><script>window.__xss=true</script>hi</body></html>'
    const rpc = makeRpc({ content: html })
    renderTab({ path: 'docs/index.html', title: 'index.html', rpc })

    const frame = await screen.findByTestId('cloud-workspace-preview-html-frame')
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('srcdoc')).toBe(html)

    await user.click(screen.getByTestId('cloud-workspace-file-tab-mode-edit'))
    const input = await screen.findByTestId<HTMLTextAreaElement>('fake-editor-input')
    expect(screen.getByTestId('fake-editor-language').textContent).toBe('html')
    expect(input.readOnly).toBe(false)

    await user.clear(input)
    await user.type(input, '<h1>edited</h1>')
    await user.click(screen.getByTestId('cloud-workspace-file-tab-save'))
    await waitFor(() =>
      expect(rpc.mock).toHaveBeenCalledWith('files.write', {
        worktree: 'path:/srv/wt',
        relativePath: 'docs/index.html',
        content: '<h1>edited</h1>',
        expectedExecutionHostId: 'local'
      })
    )
  })

  it('模式切换按渲染器 id 记入 sessionStorage，新标签优先用偏好（FS-1）', async () => {
    const user = userEvent.setup()
    renderTab({ path: 'README.md', title: 'README.md', rpc: makeRpc({ content: '# hi' }) })

    await screen.findByTestId('cloud-workspace-markdown-preview', undefined, { timeout: 10_000 })
    await user.click(screen.getByTestId('cloud-workspace-file-tab-mode-edit'))
    await screen.findByTestId('fake-editor-input')

    cleanup()

    renderTab({ path: 'README.md', title: 'README.md', rpc: makeRpc({ content: '# hi' }) })
    expect(await screen.findByTestId('fake-editor-input')).toBeTruthy()
    expect(screen.queryByTestId('cloud-workspace-markdown-preview')).toBeNull()
  })

  it('工厂把 RPC/权限绑定进 shell 注册组件', async () => {
    const rpc = makeRpc({ content: 'factory content' })
    const dispatch = vi.fn<(action: CloudSimpleWorkspaceTabsAction) => void>()
    const Component = createCloudWorkspaceFileTab({
      rpc: rpc.rpc,
      workspacePath: '/srv/wt',
      permissions: ALL,
      editor: FakeEditor
    })

    render(
      <Component
        tab={{ id: 'file:src/a.ts', kind: 'editor', title: 'a.ts', path: 'src/a.ts' }}
        active
        dispatch={dispatch}
      />
    )

    expect(((await screen.findByTestId('fake-editor-input')) as HTMLTextAreaElement).value).toBe(
      'factory content'
    )
  })
})
