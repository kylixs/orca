import { describe, expect, it, vi } from 'vitest'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import {
  cloudWorkspaceFileFailureText,
  cloudWorkspaceFileLanguage,
  isCloudWorkspaceMarkdownPath,
  readCloudWorkspaceFile,
  writeCloudWorkspaceFile
} from './cloud-workspace-file-io'

/** U46-7a: read/write mapping (design §4.7) and extension → Monaco language. */

function rpcReturning(outcome: CloudRpcOutcome): CloudRpc {
  return vi.fn(async () => outcome)
}

describe('编辑器文件 IO', () => {
  it('按扩展名映射 Monaco 语言（常见开发文件）', () => {
    expect(cloudWorkspaceFileLanguage('src/a.ts')).toBe('typescript')
    expect(cloudWorkspaceFileLanguage('src/a.tsx')).toBe('typescript')
    expect(cloudWorkspaceFileLanguage('src/a.js')).toBe('javascript')
    expect(cloudWorkspaceFileLanguage('package.json')).toBe('json')
    expect(cloudWorkspaceFileLanguage('README.md')).toBe('markdown')
    expect(cloudWorkspaceFileLanguage('app.py')).toBe('python')
    expect(cloudWorkspaceFileLanguage('main.go')).toBe('go')
    expect(cloudWorkspaceFileLanguage('lib.rs')).toBe('rust')
    expect(cloudWorkspaceFileLanguage('Dockerfile')).toBe('dockerfile')
    expect(cloudWorkspaceFileLanguage('unknown.xyz')).toBe('plaintext')
  })

  it('只把 md/markdown/mdx 识别为可预览', () => {
    expect(isCloudWorkspaceMarkdownPath('docs/README.md')).toBe(true)
    expect(isCloudWorkspaceMarkdownPath('NOTES.MARKDOWN')).toBe(true)
    expect(isCloudWorkspaceMarkdownPath('page.mdx')).toBe(true)
    expect(isCloudWorkspaceMarkdownPath('README.txt')).toBe(false)
    expect(isCloudWorkspaceMarkdownPath('md/notes')).toBe(false)
  })

  it('files.read 使用 path: 工作区选择器并解析 content/truncated/byteLength', async () => {
    const rpc = vi.fn(async (): Promise<CloudRpcOutcome> => ({
      ok: true,
      result: { content: 'hello\n', truncated: false, byteLength: 6 }
    }))

    const result = await readCloudWorkspaceFile(rpc, '/srv/wt', 'src/a.ts')

    expect(rpc).toHaveBeenCalledWith('files.read', {
      worktree: 'path:/srv/wt',
      relativePath: 'src/a.ts'
    })
    expect(result).toEqual({
      ok: true,
      content: 'hello\n',
      truncated: false,
      byteLength: 6,
      binary: false
    })
  })

  it('NUL 字节或宿主 binary 标志判为二进制，供编辑器强制只读（U59②）', async () => {
    const nul = rpcReturning({
      ok: true,
      result: { content: 'abc\u0000def', truncated: false }
    })
    expect(await readCloudWorkspaceFile(nul, '/srv/wt', 'data/unknown.dat')).toMatchObject({
      ok: true,
      binary: true
    })

    const flagged = rpcReturning({ ok: true, result: { content: 'abc', isBinary: true } })
    expect(await readCloudWorkspaceFile(flagged, '/srv/wt', 'data/unknown.dat')).toMatchObject({
      ok: true,
      binary: true
    })
  })

  it('截断标记原样透出（供标签降级为只读）', async () => {
    const rpc = rpcReturning({
      ok: true,
      result: { content: 'partial', truncated: true, byteLength: 600_000 }
    })

    const result = await readCloudWorkspaceFile(rpc, '/srv/wt', 'big.ts')

    expect(result).toMatchObject({ ok: true, truncated: true, byteLength: 600_000 })
  })

  it('无法读取的回复不伪装成空文件', async () => {
    const rpc = rpcReturning({ ok: true, result: { truncated: false } })

    expect(await readCloudWorkspaceFile(rpc, '/srv/wt', 'a.ts')).toEqual({
      ok: false,
      code: 'malformed_reply'
    })
  })

  it('读取失败保留错误码（binary_file 等）', async () => {
    const rpc = rpcReturning({ ok: false, code: 'binary_file' })

    expect(await readCloudWorkspaceFile(rpc, '/srv/wt', 'logo.png')).toEqual({
      ok: false,
      code: 'binary_file'
    })
    expect(cloudWorkspaceFileFailureText({ code: 'binary_file' })).toContain('二进制')
  })

  it('files.write 发送工作区、相对路径、完整内容与宿主标识（U48）', async () => {
    const rpc = vi.fn(async (): Promise<CloudRpcOutcome> => ({ ok: true, result: null }))

    const result = await writeCloudWorkspaceFile(rpc, '/srv/wt', 'src/a.ts', 'next')

    expect(result).toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith('files.write', {
      worktree: 'path:/srv/wt',
      relativePath: 'src/a.ts',
      content: 'next',
      expectedExecutionHostId: 'local'
    })
  })

  it('宿主按 payload 中的宿主标识校验写入并接受（U48）', async () => {
    // Mirrors assertRuntimeFileMutationExpectation: no id → update-required, wrong id → host changed.
    const rpc = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.expectedExecutionHostId === undefined) {
        return {
          ok: false as const,
          code: 'runtime_error',
          message: 'Remote file changes require a newer Orca client.'
        }
      }
      if (params.expectedExecutionHostId !== 'local') {
        return { ok: false as const, code: 'runtime_error', message: 'Workspace host changed' }
      }
      return { ok: true as const, result: null }
    })

    expect(await writeCloudWorkspaceFile(rpc, '/srv/wt', 'src/a.ts', 'next')).toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith('files.write', {
      worktree: 'path:/srv/wt',
      relativePath: 'src/a.ts',
      content: 'next',
      expectedExecutionHostId: 'local'
    })
  })

  it('写入失败保留错误码与消息', async () => {
    const rpc = rpcReturning({ ok: false, code: 'path_denied', message: 'outside worktree' })

    expect(await writeCloudWorkspaceFile(rpc, '/srv/wt', '../x', 'next')).toEqual({
      ok: false,
      code: 'path_denied',
      message: 'outside worktree'
    })
  })
})
