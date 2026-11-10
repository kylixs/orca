import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'

type Node = { kind: 'dir' } | { kind: 'file'; content: Buffer }

const fsStore = vi.hoisted(() => ({
  nodes: new Map<string, Node>(),
  normalize(path: string): string {
    const withoutScheme = path.replace(/^file:\/\//, '')
    return withoutScheme.length > 1 ? withoutScheme.replace(/\/+$/, '') : withoutScheme
  }
}))

vi.mock('expo-file-system', () => {
  const pathOf = (value: string | Directory, name?: string): string => {
    const base = typeof value === 'string' ? fsStore.normalize(value) : value.path
    return name ? `${base === '/' ? '' : base}/${name}` : base
  }
  const nodeAt = (path: string): Node | undefined => fsStore.nodes.get(fsStore.normalize(path))
  class Directory {
    readonly path: string
    constructor(value: string | Directory, name?: string) {
      this.path = fsStore.normalize(pathOf(value, name))
    }
    get uri(): string {
      return `file://${this.path}`
    }
    get name(): string {
      return this.path.split('/').pop() ?? ''
    }
    get exists(): boolean {
      return nodeAt(this.path)?.kind === 'dir'
    }
    create(): void {
      fsStore.nodes.set(this.path, { kind: 'dir' })
    }
    delete(): void {
      const prefix = `${this.path}/`
      for (const key of Array.from(fsStore.nodes.keys())) {
        if (key === this.path || key.startsWith(prefix)) {
          fsStore.nodes.delete(key)
        }
      }
    }
    list(): (Directory | File)[] {
      const prefix = `${this.path}/`
      const entries: (Directory | File)[] = []
      for (const [key, node] of fsStore.nodes) {
        if (!key.startsWith(prefix)) {
          continue
        }
        const rest = key.slice(prefix.length)
        if (rest.includes('/')) {
          continue
        }
        entries.push(node.kind === 'dir' ? new Directory(key) : new File(key))
      }
      return entries
    }
  }
  class File {
    readonly path: string
    constructor(value: string | Directory, name?: string) {
      this.path = fsStore.normalize(pathOf(value, name))
    }
    get uri(): string {
      return `file://${this.path}`
    }
    get name(): string {
      return this.path.split('/').pop() ?? ''
    }
    get exists(): boolean {
      return nodeAt(this.path)?.kind === 'file'
    }
    get size(): number {
      const node = nodeAt(this.path)
      return node?.kind === 'file' ? node.content.length : 0
    }
    create(): void {
      if (!nodeAt(this.path)) {
        fsStore.nodes.set(this.path, { kind: 'file', content: Buffer.alloc(0) })
      }
    }
    write(data: string, options?: { encoding?: 'utf8' | 'base64'; append?: boolean }): void {
      const bytes =
        options?.encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8')
      const existing = nodeAt(this.path)
      const previous = options?.append && existing?.kind === 'file' ? existing.content : null
      fsStore.nodes.set(this.path, {
        kind: 'file',
        content: previous ? Buffer.concat([previous, bytes]) : bytes
      })
    }
    textSync(): string {
      const node = nodeAt(this.path)
      return node?.kind === 'file' ? node.content.toString('utf8') : ''
    }
    base64(): string {
      const node = nodeAt(this.path)
      return node?.kind === 'file' ? node.content.toString('base64') : ''
    }
    delete(): void {
      fsStore.nodes.delete(this.path)
    }
  }
  return { Directory, File, Paths: { cache: '/cache' } }
})

vi.mock('./mobile-file-preview-request', () => ({
  loadMobileFilePreview: vi.fn()
}))

import { File } from 'expo-file-system'
import { prepareFileForAction, FileActionError } from './mobile-file-prepare'
import { DOWNLOAD_CACHE_DIRECTORY } from './mobile-file-download-cache'
import type { FileActionTarget } from './mobile-file-actions'
import { loadMobileFilePreview } from './mobile-file-preview-request'

const WORKTREE_TARGET: FileActionTarget = {
  source: 'worktree',
  hostId: 'host-1',
  worktreeId: 'wt-1',
  relativePath: 'src/app.ts',
  name: 'app.ts',
  kind: 'text',
  previewable: true
}

function ok(result: unknown): RpcResponse {
  return { id: 'response-id', ok: true, result, _meta: { runtimeId: 'runtime-id' } }
}

function client(handlers: {
  stat?: () => unknown
  chunk?: (params: { offset: number; length: number }) => unknown
}) {
  return {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      if (method === 'files.stat') {
        return ok(handlers.stat?.() ?? { size: 11, isDirectory: false, mtime: 1, ctime: 2 })
      }
      if (method === 'files.readChunk') {
        const offset =
          typeof params === 'object' && params !== null && 'offset' in params
            ? Number(params.offset)
            : 0
        const length =
          typeof params === 'object' && params !== null && 'length' in params
            ? Number(params.length)
            : 0
        return ok(handlers.chunk?.({ offset, length }))
      }
      throw new Error(`unexpected method ${method}`)
    })
  }
}

function callbacks(signal = new AbortController().signal) {
  const progress = vi.fn()
  const refreshed = vi.fn()
  return {
    progress,
    refreshed,
    value: {
      action: 'save' as const,
      signal,
      onProgress: progress,
      onTerminalArtifactSourceRefreshed: refreshed
    }
  }
}

function cacheDirectories(): string[] {
  const prefix = `/cache/${DOWNLOAD_CACHE_DIRECTORY}/`
  return [...fsStore.nodes.keys()].filter(
    (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
  )
}

afterEach(() => {
  fsStore.nodes.clear()
  vi.mocked(loadMobileFilePreview).mockReset()
})

describe('prepareFileForAction (worktree)', () => {
  it('writes chunks, reports progress, and hashes exactly the bytes on disk', async () => {
    const content = Buffer.from('hello world', 'utf8')
    const chunks = [content.subarray(0, 5), content.subarray(5)]
    const call = callbacks()
    const api = client({
      chunk: ({ offset }) => {
        const index = offset === 0 ? 0 : 1
        const bytes = chunks[index]!
        return {
          contentBase64: bytes.toString('base64'),
          bytesRead: bytes.length,
          eof: index === 1
        }
      }
    })

    const prepared = await prepareFileForAction(api, WORKTREE_TARGET, call.value)

    expect(prepared.size).toBe(content.length)
    expect(prepared.sha256).toBe(bytesToHex(sha256(content)))
    expect(prepared.mimeType).toBe('text/plain')
    expect(call.progress).toHaveBeenLastCalledWith({
      action: 'save',
      bytes: content.length,
      total: content.length
    })
    expect(new File(prepared.uri).textSync()).toBe('hello world')
  })

  it('rejects a chunk whose byte count disagrees and removes the temp directory', async () => {
    const api = client({
      chunk: () => ({
        contentBase64: Buffer.from('ab').toString('base64'),
        bytesRead: 3,
        eof: true
      })
    })

    await expect(
      prepareFileForAction(api, WORKTREE_TARGET, callbacks().value)
    ).rejects.toMatchObject({ code: 'changed' })
    expect(cacheDirectories()).toEqual([])
  })

  it('rejects when the file changed between the first and final stat', async () => {
    let statCall = 0
    const api = client({
      stat: () => {
        statCall += 1
        return {
          size: 11,
          isDirectory: false,
          mtime: statCall === 1 ? 1 : 99,
          ctime: 2
        }
      },
      chunk: () => ({
        contentBase64: Buffer.from('hello world').toString('base64'),
        bytesRead: 11,
        eof: true
      })
    })

    await expect(
      prepareFileForAction(api, WORKTREE_TARGET, callbacks().value)
    ).rejects.toMatchObject({ code: 'changed' })
    expect(cacheDirectories()).toEqual([])
  })

  it('deletes the temp directory when cancelled mid-download', async () => {
    const controller = new AbortController()
    const call = callbacks(controller.signal)
    call.progress.mockImplementation((progress: { bytes: number }) => {
      if (progress.bytes > 0) {
        controller.abort()
      }
    })
    const api = client({
      chunk: () => ({
        contentBase64: Buffer.from('hello world').toString('base64'),
        bytesRead: 11,
        eof: true
      })
    })

    await expect(prepareFileForAction(api, WORKTREE_TARGET, call.value)).rejects.toBeInstanceOf(
      FileActionError
    )
    await expect(prepareFileForAction(api, WORKTREE_TARGET, call.value)).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(cacheDirectories()).toEqual([])
  })

  it('refuses a file above the 256 MB cap before reading a chunk', async () => {
    const api = client({
      stat: () => ({
        size: 256 * 1024 * 1024 + 1,
        isDirectory: false,
        mtime: 1,
        ctime: 2
      })
    })
    await expect(
      prepareFileForAction(api, WORKTREE_TARGET, callbacks().value)
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(api.sendRequest).not.toHaveBeenCalledWith('files.readChunk', expect.anything())
  })
})

describe('prepareFileForAction (terminal artifact)', () => {
  const TERMINAL_TARGET: FileActionTarget = {
    source: 'terminalArtifact',
    hostId: 'host-1',
    worktreeId: 'wt-1',
    absolutePath: '/tmp/result.txt',
    grantId: 'grant-1',
    pathText: '~/result.txt',
    displayPath: '/tmp/result.txt',
    name: 'result.txt',
    kind: 'text'
  }

  it('asks for a grant refresh and forwards the refreshed source', async () => {
    vi.mocked(loadMobileFilePreview).mockResolvedValue({
      status: 'ready',
      kind: 'text',
      content: 'result',
      truncated: false,
      byteLength: 6
    })
    const call = callbacks()

    const prepared = await prepareFileForAction(client({}), TERMINAL_TARGET, call.value)

    expect(loadMobileFilePreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        source: 'terminalArtifact',
        absolutePath: '/tmp/result.txt',
        grantId: 'grant-1'
      }),
      undefined,
      { refreshGrant: true, onTerminalArtifactSourceRefreshed: call.refreshed }
    )
    expect(prepared.sha256).toBe(bytesToHex(sha256(Buffer.from('result'))))
    expect(prepared.fileName).toBe('result.txt')
  })

  it('refuses terminal text above 512 KB before reading it', async () => {
    const tooLarge: FileActionTarget = {
      ...TERMINAL_TARGET,
      size: 512 * 1024 + 1
    }
    await expect(
      prepareFileForAction(client({}), tooLarge, callbacks().value)
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(loadMobileFilePreview).not.toHaveBeenCalled()
  })
})
