// @vitest-environment happy-dom
import * as React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudProjectPermission, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import {
  CloudSimpleWorkspace,
  CloudSimpleWorkspaceSession,
  cloudSimpleWorkspaceTabForFile,
  type CloudSimpleWorkspaceTabComponentProps
} from './cloud-simple-workspace'
import { createCloudWorkspaceFileTab } from './cloud-workspace-file-tab'
import type { CloudWorkspaceEditorProps } from './cloud-workspace-monaco-editor'
import type { CloudRpc } from '../../../shared/cloud-file-browser'

/** T1 (design §6.2): tab dedupe, switching, close-neighbour, empty state, plus permissions. */

const ALL: CloudProjectPermission[] = ['open', 'terminal', 'file:read', 'file:write']

afterEach(cleanup)

function renderWorkspace(
  overrides: Partial<React.ComponentProps<typeof CloudSimpleWorkspace>> = {}
) {
  return render(
    <CloudSimpleWorkspace
      route="relay"
      latencyMs={18}
      branch="feat/refund"
      workspacePath="/srv/checkout"
      permissions={ALL}
      {...overrides}
    />
  )
}

describe('文件点击分发（U59②）', () => {
  it('二进制扩展进预览占位，文本进编辑器，图片进图片预览', () => {
    expect(cloudSimpleWorkspaceTabForFile('dist/app.bin')).toMatchObject({
      kind: 'preview',
      path: 'dist/app.bin',
      mode: 'binary'
    })
    expect(cloudSimpleWorkspaceTabForFile('tools/run.exe')).toMatchObject({
      kind: 'preview',
      mode: 'binary'
    })
    expect(cloudSimpleWorkspaceTabForFile('src/a.ts')).toMatchObject({ kind: 'editor' })
    expect(cloudSimpleWorkspaceTabForFile('README.md')).toMatchObject({ kind: 'editor' })
    expect(cloudSimpleWorkspaceTabForFile('assets/logo.png')).toMatchObject({
      kind: 'preview',
      mode: 'image'
    })
  })
})

describe('简易工作区外壳', () => {
  it('呈现标签区、右侧双 tab 与状态栏', () => {
    renderWorkspace()

    expect(screen.getByTestId('cloud-simple-workspace-tabs')).toBeTruthy()
    expect(screen.getByTestId('cloud-simple-workspace-right-tab-files').textContent).toBe('文件')
    expect(screen.getByTestId('cloud-simple-workspace-right-tab-git').textContent).toBe('Git 变更')
    expect(screen.getByTestId('cloud-simple-workspace-status-connection').textContent).toContain(
      '已连接'
    )
    expect(screen.getByTestId('cloud-simple-workspace-status-route').textContent).toContain('中继')
    expect(screen.getByTestId('cloud-simple-workspace-status-branch').textContent).toContain(
      'feat/refund'
    )
    expect(screen.getByTestId('cloud-simple-workspace-status-path').textContent).toContain(
      '/srv/checkout'
    )
    expect(screen.getByTestId('cloud-simple-workspace-empty').textContent).toContain(
      '从右侧文件树打开文件，或新建终端'
    )
  })

  it('F-09 标签带类型图标，终端关闭带结束会话 tooltip', async () => {
    const user = userEvent.setup()
    renderWorkspace({
      renderFileTree: ({ openFile }) => (
        <div>
          <button type="button" onClick={() => openFile('src/a.ts')}>
            open-a
          </button>
        </div>
      )
    })

    await user.click(screen.getByText('open-a'))
    await user.click(screen.getByTestId('cloud-simple-workspace-new-terminal'))

    const tabButton = screen.getByTestId('cloud-simple-workspace-tab-file:src/a.ts')
    expect(tabButton.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
    const terminalButton = screen.getByTestId(/^cloud-simple-workspace-tab-terminal:/)
    expect(terminalButton.querySelector('svg[aria-hidden="true"]')).toBeTruthy()

    expect(screen.getByTestId('cloud-simple-workspace-tab-close-file:src/a.ts').title).toBe(
      '关闭 a.ts'
    )
    expect(screen.getByTestId(/^cloud-simple-workspace-tab-close-terminal:/).title).toBe(
      '关闭将结束该终端会话'
    )
  })

  it('F-09 空态文案按 file:read 权限分支，无读取权不提示文件树', () => {
    renderWorkspace({ permissions: ['open', 'terminal'] })
    const empty = screen.getByTestId('cloud-simple-workspace-empty').textContent ?? ''
    expect(empty).toContain('未授予文件读取权限')
    expect(empty).not.toContain('文件树')

    cleanup()
    renderWorkspace({ permissions: ['open'] })
    expect(screen.getByTestId('cloud-simple-workspace-empty').textContent).toContain(
      '未授予终端与文件读取权限'
    )
  })

  it('右侧栏文件树与 Git 变更双 tab 切换，内容由挂载点注入', async () => {
    const user = userEvent.setup()
    renderWorkspace({
      renderFileTree: ({ workspacePath }) => <div>树:{workspacePath}</div>,
      renderGitChanges: ({ workspacePath }) => <div>变更:{workspacePath}</div>
    })

    expect(screen.getByText('树:/srv/checkout')).toBeTruthy()
    await user.click(screen.getByTestId('cloud-simple-workspace-right-tab-git'))
    expect(screen.getByText('变更:/srv/checkout')).toBeTruthy()
    expect(
      screen.getByTestId('cloud-simple-workspace-right-tab-git').getAttribute('aria-selected')
    ).toBe('true')
  })

  it('T1：打开去重、切换、关闭 active 激活右邻、最后关闭回空态', async () => {
    const user = userEvent.setup()
    renderWorkspace({
      renderFileTree: ({ openFile }) => (
        <div>
          <button type="button" onClick={() => openFile('src/a.ts')}>
            open-a
          </button>
          <button type="button" onClick={() => openFile('src/b.ts')}>
            open-b
          </button>
        </div>
      )
    })

    const workspaceTabs = () => within(screen.getByRole('tablist', { name: '工作区标签' }))
    const tabCount = () => workspaceTabs().queryAllByRole('tab').length
    const selected = (id: string) =>
      screen.getByTestId(`cloud-simple-workspace-tab-${id}`).getAttribute('aria-selected')

    await user.click(screen.getByText('open-a'))
    expect(tabCount()).toBe(1)
    expect(selected('file:src/a.ts')).toBe('true')

    // Same path again: activate, never a second tab (design §4.4).
    await user.click(screen.getByText('open-a'))
    expect(tabCount()).toBe(1)

    await user.click(screen.getByText('open-b'))
    expect(tabCount()).toBe(2)
    expect(selected('file:src/b.ts')).toBe('true')

    await user.click(screen.getByTestId('cloud-simple-workspace-tab-file:src/a.ts'))
    expect(selected('file:src/a.ts')).toBe('true')

    await user.click(screen.getByTestId('cloud-simple-workspace-tab-close-file:src/a.ts'))
    expect(tabCount()).toBe(1)
    expect(selected('file:src/b.ts')).toBe('true')

    await user.click(screen.getByTestId('cloud-simple-workspace-tab-close-file:src/b.ts'))
    expect(tabCount()).toBe(0)
    expect(screen.getByTestId('cloud-simple-workspace-empty')).toBeTruthy()
  })

  it('按 terminal|editor|preview|diff 类型分发到注册的挂载组件', () => {
    function Registered({ tab }: CloudSimpleWorkspaceTabComponentProps) {
      return <div data-testid={`registered-${tab.kind}`}>{tab.title}</div>
    }

    renderWorkspace({
      initialTabs: [
        { id: 'terminal-1', kind: 'terminal', title: 'Terminal 1' },
        { id: 'file:a.ts', kind: 'editor', title: 'a.ts', path: 'src/a.ts' },
        {
          id: 'file:b.html',
          kind: 'preview',
          title: 'b.html',
          path: 'b.html',
          mode: 'preview'
        },
        { id: 'diff:a.ts', kind: 'diff', title: 'a.ts', path: 'src/a.ts' }
      ],
      tabComponents: {
        terminal: Registered,
        editor: Registered,
        preview: Registered,
        diff: Registered
      }
    })

    expect(screen.getByTestId('registered-terminal').textContent).toBe('Terminal 1')
    expect(screen.getByTestId('registered-editor').textContent).toBe('a.ts')
    expect(screen.getByTestId('registered-preview').textContent).toBe('b.html')
    expect(screen.getByTestId('registered-diff').textContent).toBe('a.ts')
  })

  it('无 terminal 权限：不渲染新建终端，终端标签与 Git 变更呈现拒绝态', async () => {
    const user = userEvent.setup()
    renderWorkspace({
      permissions: ['open', 'file:read'],
      initialTabs: [{ id: 'terminal-1', kind: 'terminal', title: 'Terminal 1' }]
    })

    expect(screen.queryByTestId('cloud-simple-workspace-new-terminal')).toBeNull()
    expect(screen.getByTestId('cloud-simple-workspace-terminal-denied').textContent).toContain(
      '未授予终端权限'
    )

    await user.click(screen.getByTestId('cloud-simple-workspace-right-tab-git'))
    expect(screen.getByTestId('cloud-simple-workspace-git-no-permission').textContent).toContain(
      '未授予终端权限'
    )
  })

  it('无 file:read 权限：文件树降级态', () => {
    renderWorkspace({ permissions: ['open', 'terminal'] })

    expect(
      screen.getByTestId('cloud-simple-workspace-file-tree-no-permission').textContent
    ).toContain('未授予文件读取权限')
  })

  it('无 workspacePath：文件树与 Git 变更提示工作区尚未创建', async () => {
    const user = userEvent.setup()
    renderWorkspace({ workspacePath: null })

    expect(
      screen.getByTestId('cloud-simple-workspace-file-tree-no-workspace').textContent
    ).toContain('工作区尚未创建')

    await user.click(screen.getByTestId('cloud-simple-workspace-right-tab-git'))
    expect(screen.getByTestId('cloud-simple-workspace-git-no-workspace').textContent).toContain(
      '工作区尚未创建'
    )
  })

  it('ensure 失败呈现明确降级页，而非空白工作区', () => {
    renderWorkspace({
      permissions: ['open'],
      degraded: {
        code: 'worktree_unavailable',
        message: '权限不足',
        fallbackHref: 'https://console.test/cloud-admin.html'
      }
    })

    const page = screen.getByTestId('cloud-simple-workspace-degraded')
    expect(page.textContent).toContain('当前项目未授予终端权限，无法创建工作区')
    expect(page.textContent).toContain('worktree_unavailable')
    expect(
      screen.getByTestId('cloud-simple-workspace-degraded-fallback').getAttribute('href')
    ).toBe('https://console.test/cloud-admin.html')
    expect(screen.queryByTestId('cloud-simple-workspace-tabs')).toBeNull()
    expect(screen.queryByTestId('cloud-simple-workspace-status-bar')).toBeNull()
  })

  it('dirty 标签关闭先确认：取消保留、放弃才关闭并回收 dirty 计数', async () => {
    const user = userEvent.setup()
    function DirtyToggle({ tab, dispatch }: CloudSimpleWorkspaceTabComponentProps) {
      return (
        <button
          type="button"
          onClick={() => dispatch({ type: 'setDirty', id: tab.id, dirty: true })}
        >
          mark-dirty
        </button>
      )
    }

    renderWorkspace({
      initialTabs: [{ id: 'file:a.ts', kind: 'editor', title: 'a.ts', path: 'src/a.ts' }],
      tabComponents: { editor: DirtyToggle }
    })

    await user.click(screen.getByText('mark-dirty'))
    expect(screen.getByTestId('cloud-simple-workspace-tab-dirty-file:a.ts')).toBeTruthy()
    expect(screen.getByTestId('cloud-simple-workspace-status-dirty').textContent).toContain('1')

    await user.click(screen.getByTestId('cloud-simple-workspace-tab-close-file:a.ts'))
    const confirm = screen.getByTestId('cloud-simple-workspace-close-confirm')
    expect(confirm.textContent).toContain('关闭「a.ts」？')
    // No save handler was registered by this stub pane.
    expect(
      screen.getByTestId('cloud-simple-workspace-close-confirm-save').hasAttribute('disabled')
    ).toBe(true)

    await user.click(screen.getByTestId('cloud-simple-workspace-close-confirm-cancel'))
    expect(screen.queryByTestId('cloud-simple-workspace-close-confirm')).toBeNull()
    expect(screen.getByTestId('cloud-simple-workspace-tab-file:a.ts')).toBeTruthy()
    expect(screen.getByTestId('cloud-simple-workspace-status-dirty').textContent).toContain('1')

    await user.click(screen.getByTestId('cloud-simple-workspace-tab-close-file:a.ts'))
    await user.click(screen.getByTestId('cloud-simple-workspace-close-confirm-discard'))
    expect(screen.queryByTestId('cloud-simple-workspace-tab-file:a.ts')).toBeNull()
    expect(screen.queryByTestId('cloud-simple-workspace-status-dirty')).toBeNull()
  })

  it('dirty 关闭选「保存」走标签编辑器保存路径后关，父覆盖层计数回 0', async () => {
    const user = userEvent.setup()
    const dirtyCounts: number[] = []
    const writes: Record<string, unknown>[] = []
    let stored = 'base'
    const rpc: CloudRpc = async (method, params) => {
      if (method === 'files.read') {
        return {
          ok: true,
          result: { content: stored, truncated: false, byteLength: stored.length }
        }
      }
      if (method === 'files.write') {
        writes.push(params ?? {})
        stored = String(params?.content ?? '')
        return { ok: true, result: null }
      }
      return { ok: false, code: 'method_denied' }
    }

    function TestEditor({ value, onChange }: CloudWorkspaceEditorProps): React.JSX.Element {
      return (
        <textarea
          data-testid="test-editor-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    }

    renderWorkspace({
      onDirtyCountChange: (count) => dirtyCounts.push(count),
      tabComponents: {
        editor: createCloudWorkspaceFileTab({
          rpc,
          workspacePath: '/srv/checkout',
          permissions: ALL,
          editor: TestEditor
        })
      },
      renderFileTree: ({ openFile }) => (
        <button type="button" onClick={() => openFile('src/a.ts')}>
          open-a
        </button>
      )
    })

    await user.click(screen.getByText('open-a'))
    const input = await screen.findByTestId('test-editor-input')
    await user.type(input, '!')
    expect(screen.getByTestId('cloud-simple-workspace-tab-dirty-file:src/a.ts')).toBeTruthy()
    expect(dirtyCounts.at(-1)).toBe(1)

    await user.click(screen.getByTestId('cloud-simple-workspace-tab-close-file:src/a.ts'))
    await user.click(screen.getByTestId('cloud-simple-workspace-close-confirm-save'))

    await waitFor(() =>
      expect(screen.queryByTestId('cloud-simple-workspace-tab-file:src/a.ts')).toBeNull()
    )
    expect(writes).toEqual([
      {
        worktree: 'path:/srv/checkout',
        relativePath: 'src/a.ts',
        content: 'base!',
        expectedExecutionHostId: 'local'
      }
    ])
    expect(stored).toBe('base!')
    await waitFor(() => expect(dirtyCounts.at(-1)).toBe(0))
  })
})

const SESSION_COMMIT_OID = 'c'.repeat(40)
const SESSION_PARENT_OID = 'd'.repeat(40)

/** U46-8 assembly: the shell's factories and rail panes bound to one scripted RPC. */
function scriptedSessionRpc(): {
  rpc: CloudRpc
  calls: { method: string; params?: object }[]
} {
  const calls: { method: string; params?: object }[] = []
  const rpc: CloudRpc = async (method, params): Promise<CloudRpcOutcome> => {
    calls.push({ method, params })
    switch (method) {
      case 'workspace.info':
        return { ok: true, result: { workspace: { branch: 'feat/refund' } } }
      case 'files.readDir': {
        const relativePath = (params as { relativePath?: string } | undefined)?.relativePath
        return relativePath === 'src'
          ? { ok: true, result: [{ name: 'a.ts', isDirectory: false }] }
          : {
              ok: true,
              result: [
                { name: 'src', isDirectory: true },
                { name: 'logo.png', isDirectory: false },
                { name: 'README.md', isDirectory: false },
                { name: 'app.bin', isDirectory: false }
              ]
            }
      }
      case 'files.readPreview':
        return (params as { relativePath?: string } | undefined)?.relativePath === 'app.bin'
          ? {
              ok: true,
              result: {
                content: '',
                isBinary: true,
                isImage: false,
                mimeType: 'application/octet-stream'
              }
            }
          : {
              ok: true,
              result: {
                content: 'iVBORw0KGgo=',
                isBinary: true,
                isImage: true,
                mimeType: 'image/png'
              }
            }
      case 'files.read':
        return { ok: false, code: 'denied' }
      case 'git.status':
        return {
          ok: true,
          result: { entries: [{ path: 'src/a.ts', status: 'modified' }] }
        }
      case 'git.history':
        return {
          ok: true,
          result: { items: [{ id: SESSION_COMMIT_OID, subject: 'init' }] }
        }
      case 'git.commitCompare':
        return {
          ok: true,
          result: {
            entries: [{ path: 'src/a.ts', status: 'modified' }],
            summary: { parentOid: SESSION_PARENT_OID }
          }
        }
      case 'git.diff':
        return { ok: false, code: 'denied' }
      case 'git.commitDiff':
        return {
          ok: true,
          result: { kind: 'text', originalContent: 'old', modifiedContent: 'new' }
        }
      default:
        return { ok: false, code: 'unexpected_method' }
    }
  }
  return { rpc, calls }
}

describe('简易工作区装配（U46-8）', () => {
  it('挂载真实四类型工厂与右栏：分支来自 workspace.info，文件点击开编辑器/预览，Git 行开 diff', async () => {
    const user = userEvent.setup()
    const { rpc, calls } = scriptedSessionRpc()

    render(
      <CloudSimpleWorkspaceSession
        projectName="payment-svc"
        route="relay"
        latencyMs={18}
        workspacePath="/srv/checkout"
        permissions={ALL}
        rpc={rpc}
      />
    )

    expect(screen.getByTestId('cloud-simple-workspace-status-project').textContent).toContain(
      'payment-svc'
    )
    await waitFor(() =>
      expect(screen.getByTestId('cloud-simple-workspace-status-branch').textContent).toContain(
        'feat/refund'
      )
    )

    // Right rail = the real tree, whose readDir rides the same RPC.
    await screen.findByTestId('cloud-workspace-file-tree-node-src')
    expect(calls.some((call) => call.method === 'files.readDir')).toBe(true)

    // Text file → editor factory.
    await user.click(screen.getByTestId('cloud-workspace-file-tree-node-README.md'))
    await within(screen.getByTestId('cloud-simple-workspace-pane-file:README.md')).findByTestId(
      'cloud-workspace-file-tab'
    )

    // Image file → preview factory and readPreview.
    await user.click(screen.getByTestId('cloud-workspace-file-tree-node-logo.png'))
    await within(screen.getByTestId('cloud-simple-workspace-pane-preview:logo.png')).findByTestId(
      'cloud-workspace-preview-tab'
    )
    expect(
      calls.some(
        (call) =>
          call.method === 'files.readPreview' &&
          (call.params as { relativePath?: string } | undefined)?.relativePath === 'logo.png'
      )
    ).toBe(true)

    // Git rail → real changes pane; a row opens the diff factory.
    await user.click(screen.getByTestId('cloud-simple-workspace-right-tab-git'))
    await screen.findByTestId('cloud-workspace-git-panel')
    await screen.findByTestId('cloud-workspace-git-change-src/a.ts')
    await user.click(screen.getByTestId('cloud-workspace-git-change-src/a.ts'))
    await within(screen.getByTestId('cloud-simple-workspace-pane-diff:src/a.ts')).findByTestId(
      'cloud-workspace-diff-tab'
    )
  })

  it('点击 .bin 打开预览二进制占位而非编辑器（U59②）', async () => {
    const user = userEvent.setup()
    const { rpc, calls } = scriptedSessionRpc()

    render(
      <CloudSimpleWorkspaceSession
        projectName="payment-svc"
        route="relay"
        latencyMs={18}
        workspacePath="/srv/checkout"
        permissions={ALL}
        rpc={rpc}
      />
    )

    await user.click(await screen.findByTestId('cloud-workspace-file-tree-node-app.bin'))

    const pane = screen.getByTestId('cloud-simple-workspace-pane-preview:app.bin')
    const binary = await within(pane).findByTestId('cloud-workspace-preview-binary')
    expect(binary.textContent).toContain('二进制')
    expect(binary.textContent).toContain('application/octet-stream')
    expect(binary.textContent).toContain('下载')
    expect(screen.queryByTestId('cloud-simple-workspace-pane-file:app.bin')).toBeNull()
    expect(
      calls.some(
        (call) =>
          call.method === 'files.read' &&
          (call.params as { relativePath?: string } | undefined)?.relativePath === 'app.bin'
      )
    ).toBe(false)
  })

  it('提交行开 diff：标签携带完整 commitOid/parentOid，差异走 git.commitDiff（U50）', async () => {
    const user = userEvent.setup()
    const { rpc, calls } = scriptedSessionRpc()

    render(
      <CloudSimpleWorkspaceSession
        projectName="payment-svc"
        route="relay"
        workspacePath="/srv/checkout"
        permissions={ALL}
        rpc={rpc}
      />
    )

    await user.click(screen.getByTestId('cloud-simple-workspace-right-tab-git'))
    await user.click(await screen.findByTestId(`cloud-workspace-git-commit-${SESSION_COMMIT_OID}`))
    const files = await screen.findByTestId(
      `cloud-workspace-git-commit-files-${SESSION_COMMIT_OID}`
    )
    await user.click(await within(files).findByTestId('cloud-workspace-git-commit-file-src/a.ts'))

    const paneId = `cloud-simple-workspace-pane-diff:${SESSION_COMMIT_OID}:src/a.ts`
    await within(await screen.findByTestId(paneId)).findByTestId('cloud-workspace-diff-tab')
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'git.commitDiff',
        params: {
          worktree: 'path:/srv/checkout',
          filePath: 'src/a.ts',
          commitOid: SESSION_COMMIT_OID,
          parentOid: SESSION_PARENT_OID
        }
      })
    )
  })

  it('无工作区（viewer 票据）：四类型与服务工厂不注册，右栏落在无工作区态', async () => {
    const { rpc, calls } = scriptedSessionRpc()
    render(
      <CloudSimpleWorkspaceSession
        projectName="viewer-svc"
        route="relay"
        workspacePath={null}
        permissions={['open', 'file:read']}
        rpc={rpc}
      />
    )

    expect(screen.getByTestId('cloud-simple-workspace-file-tree-no-workspace')).toBeTruthy()
    await userEvent.setup().click(screen.getByTestId('cloud-simple-workspace-right-tab-git'))
    // Git reads need `terminal`; a viewer ticket lacks it, so that gate wins over no-workspace.
    expect(screen.getByTestId('cloud-simple-workspace-git-no-permission')).toBeTruthy()
    expect(calls).toEqual([])
  })
})
