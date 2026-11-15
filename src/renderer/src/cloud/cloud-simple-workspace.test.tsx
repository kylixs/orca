// @vitest-environment happy-dom
import * as React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudProjectPermission } from '../../../shared/cloud-platform-ipc'
import {
  CloudSimpleWorkspace,
  type CloudSimpleWorkspaceTabComponentProps
} from './cloud-simple-workspace'

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
