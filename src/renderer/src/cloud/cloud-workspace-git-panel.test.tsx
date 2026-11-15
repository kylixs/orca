// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CloudWorkspaceGitPanel } from './cloud-workspace-git-panel'
import {
  cloudGitRelativeTime,
  groupCloudGitChanges,
  parseCloudGitHistory,
  parseCloudGitStatus
} from './cloud-workspace-git-panel-model'

/** U46-6b (design §11.3): status groups, commit history expansion, diff callbacks, degradation. */

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

const MODIFIED_OID = 'a'.repeat(40)
const ADDED_OID = 'b'.repeat(40)
const PARENT_OID = 'c'.repeat(40)

function statusReply(): CloudRpcOutcome {
  return {
    ok: true,
    result: {
      entries: [
        { path: 'src/a.ts', status: 'modified', area: 'unstaged' },
        { path: 'src/b.ts', status: 'modified', area: 'staged' },
        // The same file seen in both staging areas must collapse into one row.
        { path: 'src/b.ts', status: 'modified', area: 'unstaged' },
        { path: 'src/new.ts', status: 'added', area: 'staged' },
        { path: 'old.txt', status: 'deleted', area: 'unstaged' },
        { path: 'notes.md', status: 'untracked', area: 'untracked' }
      ]
    }
  }
}

function historyReply(now = Date.now()): CloudRpcOutcome {
  return {
    ok: true,
    result: {
      items: [
        {
          id: MODIFIED_OID,
          displayId: 'aaaaaaa',
          subject: '修复构建',
          author: 'Dev',
          timestamp: now - 2 * 60 * 60 * 1000
        },
        {
          id: ADDED_OID,
          displayId: 'bbbbbbb',
          subject: '新增面板',
          author: 'QA',
          timestamp: now - 60 * 1000
        }
      ]
    }
  }
}

function baseReplies(now?: number): Record<string, Reply> {
  return {
    'git.status': () => statusReply(),
    'git.history': () => historyReply(now),
    'git.commitCompare': () => ({
      ok: true,
      result: {
        entries: [{ path: 'src/a.ts', status: 'modified' }],
        summary: { parentOid: PARENT_OID }
      }
    })
  }
}

function renderPanel(
  options: {
    replies?: Record<string, Reply>
    canReadFiles?: boolean
    onOpenDiff?: (path: string, status: string, source?: unknown) => void
  } = {}
) {
  const host = bridge(options.replies ?? baseReplies())
  const onOpenDiff = options.onOpenDiff ?? vi.fn()
  render(
    <CloudWorkspaceGitPanel
      rpc={host.rpc}
      workspacePath="/srv/wt"
      canReadFiles={options.canReadFiles}
      onOpenDiff={onOpenDiff}
    />
  )
  return { host, onOpenDiff }
}

afterEach(cleanup)

describe('工作区 Git 变更面板', () => {
  it('按状态分组渲染工作区变更，同一文件跨暂存区只出现一次', async () => {
    const { host } = renderPanel()

    const modified = await screen.findByTestId('cloud-workspace-git-group-modified')
    expect(within(modified).getByText('修改')).toBeTruthy()
    expect(within(modified).getByText('2')).toBeTruthy()
    expect(within(modified).getByTestId('cloud-workspace-git-change-src/a.ts')).toBeTruthy()
    expect(screen.getAllByTestId('cloud-workspace-git-change-src/b.ts')).toHaveLength(1)
    expect(
      within(screen.getByTestId('cloud-workspace-git-group-untracked')).getByText('未跟踪')
    ).toBeTruthy()
    expect(
      within(screen.getByTestId('cloud-workspace-git-group-added')).getByTestId(
        'cloud-workspace-git-change-src/new.ts'
      )
    ).toBeTruthy()
    expect(
      within(screen.getByTestId('cloud-workspace-git-group-deleted')).getByTestId(
        'cloud-workspace-git-change-old.txt'
      )
    ).toBeTruthy()

    const statusCall = host.calls.find((call) => call.method === 'git.status')
    expect(statusCall?.params).toEqual({ worktree: 'path:/srv/wt' })
    const historyCall = host.calls.find((call) => call.method === 'git.history')
    expect(historyCall?.params).toEqual({ worktree: 'path:/srv/wt', limit: 30 })
  })

  it('点击工作区文件回调 path 与状态', async () => {
    const user = userEvent.setup()
    const { onOpenDiff } = renderPanel()

    await user.click(await screen.findByTestId('cloud-workspace-git-change-src/a.ts'))
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', 'modified')

    await user.click(screen.getByTestId('cloud-workspace-git-change-notes.md'))
    expect(onOpenDiff).toHaveBeenCalledWith('notes.md', 'untracked')
  })

  it('提交记录显示短哈希/作者/相对时间，展开后按 commitCompare 列出文件并可开 diff', async () => {
    const user = userEvent.setup()
    const now = Date.now()
    const { host, onOpenDiff } = renderPanel({ replies: baseReplies(now) })

    const commit = await screen.findByTestId(`cloud-workspace-git-commit-${MODIFIED_OID}`)
    expect(within(commit).getByText('修复构建')).toBeTruthy()
    expect(within(commit).getByText(/aaaaaaa · Dev · 2 小时前/)).toBeTruthy()

    await user.click(commit)
    const files = await screen.findByTestId(`cloud-workspace-git-commit-files-${MODIFIED_OID}`)
    await waitFor(() => {
      expect(within(files).getByTestId('cloud-workspace-git-commit-file-src/a.ts')).toBeTruthy()
    })

    const compareCall = host.calls.find((call) => call.method === 'git.commitCompare')
    expect(compareCall?.params).toEqual({
      worktree: 'path:/srv/wt',
      commitId: MODIFIED_OID
    })

    await user.click(within(files).getByTestId('cloud-workspace-git-commit-file-src/a.ts'))
    // U50: a commit row carries the full commit identity, not just path/status.
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', 'modified', {
      kind: 'commit',
      commitOid: MODIFIED_OID,
      parentOid: PARENT_OID
    })

    // Collapsing hides the cached file list.
    await user.click(commit)
    expect(screen.queryByTestId(`cloud-workspace-git-commit-files-${MODIFIED_OID}`)).toBeNull()
  })

  it('无 file:read 权限时降级且不发 git RPC', () => {
    const { host } = renderPanel({ canReadFiles: false })
    expect(screen.getByTestId('cloud-workspace-git-no-permission')).toBeTruthy()
    expect(host.calls).toHaveLength(0)
  })

  it('git.status 失败不影响提交记录，失败码如实呈现', async () => {
    renderPanel({
      replies: {
        ...baseReplies(),
        'git.status': () => ({ ok: false, code: 'forbidden', message: '拒绝访问' })
      }
    })
    expect(await screen.findByText('forbidden：拒绝访问')).toBeTruthy()
    expect(await screen.findByTestId(`cloud-workspace-git-commit-${MODIFIED_OID}`)).toBeTruthy()
  })

  it('解析器拒绝不可读的回复，并按主导状态归组', () => {
    expect(parseCloudGitStatus(null)).toBeNull()
    expect(parseCloudGitHistory({ items: 'nope' })).toBeNull()

    const groups = groupCloudGitChanges([
      { path: 'staged-then-modified.ts', status: 'added' },
      { path: 'staged-then-modified.ts', status: 'modified' }
    ])
    expect(groups).toEqual([
      {
        status: 'modified',
        label: '修改',
        changes: [{ path: 'staged-then-modified.ts', status: 'modified' }]
      }
    ])
  })

  it('相对时间在边界处取整', () => {
    const now = 1_700_000_000_000
    expect(cloudGitRelativeTime(now - 10_000, now)).toBe('刚刚')
    expect(cloudGitRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前')
    expect(cloudGitRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前')
    expect(cloudGitRelativeTime(now - 2 * 86_400_000, now)).toBe('2 天前')
    expect(cloudGitRelativeTime(undefined, now)).toBe('')
  })
})
