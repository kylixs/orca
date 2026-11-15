// @vitest-environment happy-dom
import * as React from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudProjectPermission, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import {
  CloudSimpleWorkspace,
  CloudSimpleWorkspaceSession,
  type CloudSimpleWorkspaceTabComponentProps
} from './cloud-simple-workspace'
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

  it('dirty 状态位同时反映在标签与状态栏，关闭后清除', async () => {
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
    expect(screen.queryByTestId('cloud-simple-workspace-status-dirty')).toBeNull()
  })
})

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
                { name: 'README.md', isDirectory: false }
              ]
            }
      }
      case 'files.readPreview':
        return {
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
          result: { items: [{ id: 'abc123', subject: 'init' }] }
        }
      case 'git.diff':
        return { ok: false, code: 'denied' }
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
