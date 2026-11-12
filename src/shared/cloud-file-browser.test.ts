import { describe, expect, it } from 'vitest'
import type { CloudRpcOutcome } from './cloud-platform-ipc'
import {
  CLOUD_FILE_ROOT,
  browseCloudDirectory,
  cloudChildPath,
  cloudParentPath,
  cloudPathSegments,
  cloudWorktreeSelector,
  previewCloudFile,
  sortCloudEntries,
  type CloudFileEntry
} from './cloud-file-browser'

/**
 * The panel trusts the host's listing, so these pin the two halves that can go
 * wrong without a server: the paths it composes from entry names, and how it
 * reads a reply it does not recognise (never as "empty").
 */

function scripted(rpcResult: CloudRpcOutcome) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  return {
    calls,
    rpc: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      return rpcResult
    }
  }
}

describe('云端路径拼接', () => {
  it('子路径总是用 / 分隔，根目录不加前缀', () => {
    expect(cloudChildPath(CLOUD_FILE_ROOT, 'src')).toBe('src')
    expect(cloudChildPath('src', 'app.ts')).toBe('src/app.ts')
    expect(cloudWorktreeSelector('/srv/checkout')).toBe('path:/srv/checkout')
  })

  it('拒绝带分隔符或指向上级的“文件名”', () => {
    for (const name of ['..', '.', '', 'a/b', 'a\\b']) {
      expect(cloudChildPath('src', name), name).toBeNull()
    }
  })

  it('上一级在根目录回到根，深路径去掉最后一段', () => {
    expect(cloudParentPath('src/app.ts')).toBe('src')
    expect(cloudParentPath('src')).toBe(CLOUD_FILE_ROOT)
    expect(cloudParentPath(CLOUD_FILE_ROOT)).toBe(CLOUD_FILE_ROOT)
    expect(cloudPathSegments('a/b/c')).toEqual(['a', 'b', 'c'])
    expect(cloudPathSegments(CLOUD_FILE_ROOT)).toEqual([])
  })
})

describe('目录排序', () => {
  it('目录在前，同类按名称不区分大小写', () => {
    const entries: CloudFileEntry[] = [
      { name: 'zeta.ts', kind: 'file', isSymlink: false },
      { name: 'Alpha', kind: 'directory', isSymlink: false },
      { name: 'beta.ts', kind: 'file', isSymlink: false },
      { name: 'docs', kind: 'directory', isSymlink: false }
    ]
    expect(sortCloudEntries(entries).map((entry) => entry.name)).toEqual([
      'Alpha',
      'docs',
      'beta.ts',
      'zeta.ts'
    ])
  })
})

describe('读取目录与预览', () => {
  it('读出条目并过滤没有名字或指向上级的项', async () => {
    const client = scripted({
      ok: true,
      result: [
        { name: 'src', isDirectory: true, isSymlink: false },
        { name: 'README.md', isDirectory: false, isSymlink: false },
        { name: '.git', isDirectory: false, isSymlink: false },
        { name: '..', isDirectory: true, isSymlink: false },
        { isDirectory: false }
      ]
    })
    const outcome = await browseCloudDirectory(client.rpc, '/srv/checkout')
    expect(outcome).toEqual({
      ok: true,
      entries: [
        { name: 'src', kind: 'directory', isSymlink: false },
        { name: 'README.md', kind: 'file', isSymlink: false }
      ]
    })
    expect(client.calls).toEqual([
      {
        method: 'files.readDir',
        params: { worktree: 'path:/srv/checkout', relativePath: '' }
      }
    ])
  })

  it('无法识别的回复报 malformed_reply，而不是空目录', async () => {
    const client = scripted({ ok: true, result: { entries: [] } })
    expect(await browseCloudDirectory(client.rpc, '/srv/checkout')).toEqual({
      ok: false,
      code: 'malformed_reply'
    })
  })

  it('主机拒绝时原样带出错误码与说明', async () => {
    const client = scripted({
      ok: false,
      code: 'forbidden',
      message: 'That file is outside the project this cloud session was granted.'
    })
    expect(await browseCloudDirectory(client.rpc, '/srv/checkout', '../other')).toEqual({
      ok: false,
      code: 'forbidden',
      message: 'That file is outside the project this cloud session was granted.'
    })
  })

  it('预览读取文本内容与类型标记', async () => {
    const client = scripted({
      ok: true,
      result: { content: 'hello\n', isBinary: false, isImage: false }
    })
    expect(await previewCloudFile(client.rpc, '/srv/checkout', 'README.md')).toEqual({
      ok: true,
      preview: { content: 'hello\n', isBinary: false, isImage: false }
    })
    expect(client.calls[0]).toEqual({
      method: 'files.readPreview',
      params: { worktree: 'path:/srv/checkout', relativePath: 'README.md' }
    })
  })

  it('预览回复缺 content 时同样不当作空文件', async () => {
    const client = scripted({ ok: true, result: { isBinary: true } })
    expect(await previewCloudFile(client.rpc, '/srv/checkout', 'a.bin')).toEqual({
      ok: false,
      code: 'malformed_reply'
    })
  })
})
