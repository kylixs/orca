// @vitest-environment happy-dom
import * as React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudProjectPermission, CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { CloudSimpleWorkspaceTabsAction } from './cloud-simple-workspace-tabs'
import {
  CloudWorkspaceDiffTab,
  createCloudWorkspaceDiffTab,
  type CloudWorkspaceDiffTabApi
} from './cloud-workspace-diff-tab'
import type { CloudWorkspaceDiffEditorProps } from './cloud-workspace-diff-tab-monaco'

/** U46-7b: working-tree vs commit sources, Monaco mode switch, binary/large downgrades. */

const ALL: CloudProjectPermission[] = ['open', 'terminal', 'file:read']
const COMMIT = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)

function bridge(replies: Record<string, (params?: Record<string, unknown>) => CloudRpcOutcome>) {
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

function textReply(original: string, modified: string): CloudRpcOutcome {
  return {
    ok: true,
    result: {
      kind: 'text',
      originalContent: original,
      modifiedContent: modified,
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}

function FakeDiffEditor({
  original,
  modified,
  language,
  sideBySide
}: CloudWorkspaceDiffEditorProps): React.JSX.Element {
  return (
    <div data-testid="fake-diff-editor">
      <span data-testid="fake-diff-original">{original}</span>
      <span data-testid="fake-diff-modified">{modified}</span>
      <span data-testid="fake-diff-language">{language}</span>
      <span data-testid="fake-diff-side-by-side">{String(sideBySide)}</span>
    </div>
  )
}

function renderTab(options: {
  replies: Record<string, (params?: Record<string, unknown>) => CloudRpcOutcome>
  source?: CloudWorkspaceDiffTabApi['source']
  permissions?: CloudProjectPermission[]
}) {
  const mock = bridge(options.replies)
  const dispatch = vi.fn<(action: CloudSimpleWorkspaceTabsAction) => void>()
  render(
    <CloudWorkspaceDiffTab
      tab={{ id: 'diff:src/a.ts', kind: 'diff', title: 'a.ts', path: 'src/a.ts' }}
      active
      dispatch={dispatch}
      rpc={mock.rpc}
      workspacePath="/srv/checkout"
      permissions={options.permissions ?? ALL}
      source={options.source}
      diffEditor={FakeDiffEditor}
    />
  )
  return mock
}

afterEach(cleanup)

describe('工作区 Diff 标签', () => {
  it('工作区行用 git.diff(staged:false, compareAgainstHead:true) 读两侧全文', async () => {
    const mock = renderTab({ replies: { 'git.diff': () => textReply('old', 'new') } })

    expect((await screen.findByTestId('fake-diff-original')).textContent).toBe('old')
    expect(screen.getByTestId('fake-diff-modified').textContent).toBe('new')
    expect(screen.getByTestId('fake-diff-language').textContent).toBe('typescript')
    expect(mock.calls).toEqual([
      {
        method: 'git.diff',
        params: {
          worktree: 'path:/srv/checkout',
          filePath: 'src/a.ts',
          staged: false,
          compareAgainstHead: true
        }
      }
    ])
    // The default source is the working tree.
    expect(screen.getByTestId('cloud-workspace-diff-source').textContent).toBe('工作区')
  })

  it('左右/合并切换把 renderSideBySide 传给 Monaco', async () => {
    renderTab({ replies: { 'git.diff': () => textReply('old', 'new') } })
    await screen.findByTestId('fake-diff-editor')
    expect(screen.getByTestId('fake-diff-side-by-side').textContent).toBe('true')
    expect(
      screen.getByTestId('cloud-workspace-diff-mode-side-by-side').getAttribute('aria-pressed')
    ).toBe('true')

    await userEvent.click(screen.getByTestId('cloud-workspace-diff-mode-inline'))
    expect(screen.getByTestId('fake-diff-side-by-side').textContent).toBe('false')
    expect(
      screen.getByTestId('cloud-workspace-diff-mode-inline').getAttribute('aria-pressed')
    ).toBe('true')

    await userEvent.click(screen.getByTestId('cloud-workspace-diff-mode-side-by-side'))
    expect(screen.getByTestId('fake-diff-side-by-side').textContent).toBe('true')
  })

  it('提交行先经 commitCompare.summary 解析 parentOid，再调 git.commitDiff', async () => {
    const mock = renderTab({
      source: { kind: 'commit', commitOid: COMMIT },
      replies: {
        'git.commitCompare': () => ({
          ok: true,
          result: { summary: { commitOid: COMMIT, parentOid: PARENT }, entries: [] }
        }),
        'git.commitDiff': () => textReply('before', 'after')
      }
    })

    expect((await screen.findByTestId('fake-diff-modified')).textContent).toBe('after')
    expect(mock.calls).toEqual([
      {
        method: 'git.commitCompare',
        params: { worktree: 'path:/srv/checkout', commitId: COMMIT }
      },
      {
        method: 'git.commitDiff',
        params: {
          worktree: 'path:/srv/checkout',
          filePath: 'src/a.ts',
          commitOid: COMMIT,
          parentOid: PARENT
        }
      }
    ])
    expect(screen.getByTestId('cloud-workspace-diff-source').textContent).toBe('提交 aaaaaaa')
  })

  it('根提交的 parentOid=null 原样传给 commitDiff', async () => {
    const mock = renderTab({
      source: { kind: 'commit', commitOid: COMMIT },
      replies: {
        'git.commitCompare': () => ({
          ok: true,
          result: { summary: { commitOid: COMMIT, parentOid: null }, entries: [] }
        }),
        'git.commitDiff': () => textReply('', 'root')
      }
    })

    await screen.findByTestId('fake-diff-modified')
    expect(mock.calls[1]).toEqual({
      method: 'git.commitDiff',
      params: {
        worktree: 'path:/srv/checkout',
        filePath: 'src/a.ts',
        commitOid: COMMIT,
        parentOid: null
      }
    })
  })

  it('调用方已带 parentOid 时不再多发 commitCompare', async () => {
    const mock = renderTab({
      source: { kind: 'commit', commitOid: COMMIT, parentOid: PARENT },
      replies: { 'git.commitDiff': () => textReply('x', 'y') }
    })

    await screen.findByTestId('fake-diff-editor')
    expect(mock.calls.map((call) => call.method)).toEqual(['git.commitDiff'])
  })

  it('binary diff 按 kind 呈现：图片两侧 data URL 对比', async () => {
    renderTab({
      replies: {
        'git.diff': () => ({
          ok: true,
          result: {
            kind: 'binary',
            originalContent: 'AAAA',
            modifiedContent: 'BBBB',
            isImage: true,
            mimeType: 'image/png',
            originalIsBinary: true,
            modifiedIsBinary: true
          }
        })
      }
    })

    const original = await screen.findByTestId('cloud-workspace-diff-image-original')
    const modified = screen.getByTestId('cloud-workspace-diff-image-modified')
    expect(original.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(modified.getAttribute('src')).toBe('data:image/png;base64,BBBB')
    expect(screen.queryByTestId('fake-diff-editor')).toBeNull()
  })

  it('非图片 binary diff 给出占位而非空白', async () => {
    renderTab({
      replies: {
        'git.diff': () => ({
          ok: true,
          result: {
            kind: 'binary',
            originalContent: '',
            modifiedContent: '',
            isImage: false,
            originalIsBinary: true,
            modifiedIsBinary: true
          }
        })
      }
    })

    const binary = await screen.findByTestId('cloud-workspace-diff-binary')
    expect(binary.textContent).toContain('二进制')
    expect(screen.queryByTestId('fake-diff-editor')).toBeNull()
  })

  it('largeDiffRenderLimit 降级为概要卡片，不挂载 Monaco', async () => {
    renderTab({
      replies: {
        'git.diff': () => ({
          ok: true,
          result: {
            kind: 'text',
            originalContent: '',
            modifiedContent: '',
            originalIsBinary: false,
            modifiedIsBinary: false,
            largeDiffRenderLimit: {
              limited: true,
              reason: 'line-count',
              lineCounts: { original: 150000, modified: 150001 },
              characterCount: 9000000,
              limits: { maxLinesPerSide: 120000, maxCombinedCharacters: 6000000 }
            }
          }
        })
      }
    })

    const large = await screen.findByTestId('cloud-workspace-diff-large')
    expect(large.textContent).toContain('150000')
    expect(large.textContent).toContain('行数超限')
    expect(screen.queryByTestId('fake-diff-editor')).toBeNull()
  })

  it('RPC 失败显示错误码并可重试', async () => {
    let attempt = 0
    const mock = renderTab({
      replies: {
        'git.diff': () =>
          attempt++ === 0 ? { ok: false, code: 'method_denied' } : textReply('old', 'new')
      }
    })

    await screen.findByText('method_denied')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByTestId('fake-diff-editor')
    expect(mock.calls).toHaveLength(2)
  })

  it('无 file:read 时降级且零 RPC', async () => {
    const mock = renderTab({ replies: {}, permissions: ['open'] })
    await screen.findByTestId('cloud-workspace-diff-denied')
    expect(mock.calls).toEqual([])
  })

  it('工厂把 RPC/source 绑定进 shell 注册组件', async () => {
    const mock = bridge({ 'git.diff': () => textReply('a', 'b') })
    const Component = createCloudWorkspaceDiffTab({
      rpc: mock.rpc,
      workspacePath: '/srv/checkout',
      permissions: ALL,
      diffEditor: FakeDiffEditor
    })
    const dispatch = vi.fn<(action: CloudSimpleWorkspaceTabsAction) => void>()
    render(
      <Component
        tab={{ id: 'diff:src/a.ts', kind: 'diff', title: 'a.ts', path: 'src/a.ts' }}
        active
        dispatch={dispatch}
      />
    )
    expect((await screen.findByTestId('fake-diff-modified')).textContent).toBe('b')
  })
})
