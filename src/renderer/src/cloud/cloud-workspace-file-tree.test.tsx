// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { CloudWorkspaceFileTree } from './cloud-workspace-file-tree'

/** T3 (design §6.2/§4.6): lazy expand/collapse, cache + refresh, error row, filter, open verb. */

type Reply = (params?: Record<string, unknown>) => CloudRpcOutcome
type Entry = { name: string; isDirectory?: boolean }

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

function listing(entries: Entry[]): CloudRpcOutcome {
  return {
    ok: true,
    result: entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory === true,
      isSymlink: false
    }))
  }
}

function readDirCount(host: ReturnType<typeof bridge>, relativePath: string): number {
  return host.calls.filter(
    (call) => call.method === 'files.readDir' && call.params?.relativePath === relativePath
  ).length
}

function hostWithTree(): ReturnType<typeof bridge> {
  return bridge({
    'files.readDir': (params) => {
      const path = params?.relativePath
      if (path === 'src') {
        return listing([{ name: 'app.ts' }, { name: 'components', isDirectory: true }])
      }
      if (path === 'src/components') {
        return listing([{ name: 'Button.tsx' }])
      }
      return listing([
        { name: 'src', isDirectory: true },
        { name: 'docs', isDirectory: true },
        { name: 'README.md' },
        { name: 'zeta.ts' }
      ])
    }
  })
}

afterEach(cleanup)

describe('云端工作区文件树', () => {
  it('懒加载：展开只读一次目录，折叠再展开走缓存，刷新重拉根与已展开层', async () => {
    const user = userEvent.setup()
    const host = hostWithTree()
    render(
      <CloudWorkspaceFileTree rpc={host.rpc} workspacePath="/srv/checkout" onOpenFile={() => {}} />
    )

    const srcNode = await screen.findByTestId('cloud-workspace-file-tree-node-src')
    expect(readDirCount(host, '')).toBe(1)
    expect(screen.getByTestId('cloud-workspace-file-tree-node-README.md')).toBeTruthy()

    await user.click(srcNode)
    await screen.findByTestId('cloud-workspace-file-tree-node-src/app.ts')
    expect(readDirCount(host, 'src')).toBe(1)

    await user.click(srcNode)
    expect(screen.queryByTestId('cloud-workspace-file-tree-node-src/app.ts')).toBeNull()
    await user.click(srcNode)
    await screen.findByTestId('cloud-workspace-file-tree-node-src/app.ts')
    expect(readDirCount(host, 'src')).toBe(1)

    await user.click(screen.getByTestId('cloud-workspace-file-tree-refresh'))
    await waitFor(() => expect(readDirCount(host, '')).toBe(2))
    await waitFor(() => expect(readDirCount(host, 'src')).toBe(2))
  })

  it('按文件名过滤已加载项，提示未展开目录，清空后恢复树', async () => {
    const user = userEvent.setup()
    const host = hostWithTree()
    const onOpenFile = vi.fn()
    render(
      <CloudWorkspaceFileTree
        rpc={host.rpc}
        workspacePath="/srv/checkout"
        onOpenFile={onOpenFile}
      />
    )

    await user.click(await screen.findByTestId('cloud-workspace-file-tree-node-src'))
    await screen.findByTestId('cloud-workspace-file-tree-node-src/app.ts')

    const filter = within(screen.getByTestId('cloud-workspace-file-tree-filter')).getByRole(
      'textbox'
    )
    await user.type(filter, 'app')

    await screen.findByTestId('cloud-workspace-file-tree-match-src/app.ts')
    expect(screen.queryByTestId('cloud-workspace-file-tree-match-README.md')).toBeNull()
    expect(screen.queryByTestId('cloud-workspace-file-tree-nodes')).toBeNull()
    expect(screen.getByTestId('cloud-workspace-file-tree-filter-hint').textContent).toContain(
      '未展开的目录中可能还有匹配'
    )

    await user.click(screen.getByTestId('cloud-workspace-file-tree-match-src/app.ts'))
    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts')

    await user.clear(filter)
    await screen.findByTestId('cloud-workspace-file-tree-nodes')
    expect(screen.queryByTestId('cloud-workspace-file-tree-filter-hint')).toBeNull()
    // Expanded state survives filtering, and no extra directory read is needed.
    expect(screen.getByTestId('cloud-workspace-file-tree-node-src/app.ts')).toBeTruthy()
    expect(readDirCount(host, 'src')).toBe(1)

    await user.type(filter, 'zzz')
    expect(screen.getByText('没有匹配的文件')).toBeTruthy()
  })

  it('点选文件回调携带检出根相对路径', async () => {
    const user = userEvent.setup()
    const host = hostWithTree()
    const onOpenFile = vi.fn()
    render(
      <CloudWorkspaceFileTree
        rpc={host.rpc}
        workspacePath="/srv/checkout"
        onOpenFile={onOpenFile}
      />
    )

    await user.click(await screen.findByTestId('cloud-workspace-file-tree-node-README.md'))
    expect(onOpenFile).toHaveBeenLastCalledWith('README.md')

    await user.click(screen.getByTestId('cloud-workspace-file-tree-node-src'))
    await user.click(await screen.findByTestId('cloud-workspace-file-tree-node-src/app.ts'))
    expect(onOpenFile).toHaveBeenLastCalledWith('src/app.ts')
  })

  it('无 file:read 权限：降级占位且不发起读目录', () => {
    const host = hostWithTree()
    render(
      <CloudWorkspaceFileTree
        rpc={host.rpc}
        workspacePath="/srv/checkout"
        canReadFiles={false}
        onOpenFile={() => {}}
      />
    )

    expect(screen.getByTestId('cloud-workspace-file-tree-no-permission').textContent).toContain(
      '当前项目未授予文件读取权限'
    )
    expect(screen.queryByTestId('cloud-workspace-file-tree-filter')).toBeNull()
    expect(host.calls).toHaveLength(0)
  })

  it('目录排在文件前，各自按名称不区分大小写排序', async () => {
    const host = bridge({
      'files.readDir': () =>
        listing([
          { name: 'b.txt' },
          { name: 'zebra', isDirectory: true },
          { name: 'a.txt' },
          { name: 'Alpha', isDirectory: true }
        ])
    })
    render(
      <CloudWorkspaceFileTree rpc={host.rpc} workspacePath="/srv/checkout" onOpenFile={() => {}} />
    )

    await screen.findByTestId('cloud-workspace-file-tree-node-Alpha')
    expect(screen.getAllByRole('treeitem').map((node) => node.textContent)).toEqual([
      'Alpha',
      'zebra',
      'a.txt',
      'b.txt'
    ])
  })

  it('主机拒绝时显示错误行，不伪装成空目录', async () => {
    const user = userEvent.setup()
    const host = bridge({
      'files.readDir': (params) =>
        params?.relativePath === 'src'
          ? { ok: false, code: 'forbidden' }
          : listing([{ name: 'src', isDirectory: true }])
    })
    render(
      <CloudWorkspaceFileTree rpc={host.rpc} workspacePath="/srv/checkout" onOpenFile={() => {}} />
    )

    await user.click(await screen.findByTestId('cloud-workspace-file-tree-node-src'))
    const error = await screen.findByTestId('cloud-workspace-file-tree-error-src')
    expect(error.textContent).toBe('无权访问该路径')
    expect(screen.queryByText('空目录')).toBeNull()
  })
})
