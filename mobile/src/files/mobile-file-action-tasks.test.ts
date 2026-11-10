import { afterEach, describe, expect, it, vi } from 'vitest'

const cacheFs = vi.hoisted(
  (): { entries: { name: string; metadata: string | null }[]; deleted: string[] } => ({
    entries: [],
    deleted: []
  })
)

// A cache root whose entries the LRU trim can read and remove without touching a device.
vi.mock('expo-file-system', () => {
  class MockDirectory {
    name: string
    constructor(...parts: unknown[]) {
      const last = parts.at(-1)
      this.name = typeof last === 'string' ? last : ''
    }
    get exists(): boolean {
      return this.name === 'orca-file-actions'
    }
    list(): MockDirectory[] {
      return cacheFs.entries.map((entry) => new MockDirectory(undefined, entry.name))
    }
    create(): void {}
    delete(): void {
      cacheFs.deleted.push(this.name)
    }
  }
  class MockFile {
    name: string
    constructor(...parts: unknown[]) {
      const last = parts.at(-1)
      this.name = typeof last === 'string' ? last : ''
    }
    get exists(): boolean {
      return cacheFs.entries.some((entry) => `${entry.name}.json` === this.name)
    }
    textSync(): string {
      return cacheFs.entries.find((entry) => `${entry.name}.json` === this.name)?.metadata ?? ''
    }
    write(): void {}
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { cache: '' } }
})

const prepare = vi.hoisted(() => vi.fn())
vi.mock('./mobile-file-prepare', () => ({ prepareFileForAction: prepare }))

import { fileActionTargetKey, type FileActionTarget } from './mobile-file-actions'
import {
  forgetFileActionTask,
  resetAllFileActionTasks,
  startFileActionTask,
  taskStateFor
} from './mobile-file-action-tasks'
import {
  clearDownloadCache,
  enforceDownloadCacheLimit,
  type PreparedCachedFile
} from './mobile-file-download-cache'
import type { PrepareCallbacks } from './mobile-file-prepare'

const TARGET: FileActionTarget = {
  source: 'worktree',
  hostId: 'host-1',
  worktreeId: 'wt-1',
  relativePath: 'src/app.ts',
  name: 'app.ts',
  kind: 'text',
  previewable: true
}

const PREPARED: PreparedCachedFile = {
  targetKey: fileActionTargetKey(TARGET),
  fileName: 'app.ts',
  uri: 'file:///cache/app.ts',
  directoryUri: 'file:///cache/one',
  size: 3,
  sha256: 'abc',
  mimeType: 'text/plain',
  uti: 'public.plain-text',
  createdAt: 1,
  usedAt: 1
}

const client = { sendRequest: vi.fn() }

afterEach(() => {
  resetAllFileActionTasks()
  cacheFs.entries = []
  cacheFs.deleted = []
  prepare.mockReset()
  vi.restoreAllMocks()
})

describe('the shared file action task', () => {
  it('runs one prepare for concurrent Save and Open requests', async () => {
    let resolvePrepare: ((value: PreparedCachedFile) => void) | undefined
    prepare.mockImplementation(
      () =>
        new Promise<PreparedCachedFile>((resolve) => {
          resolvePrepare = resolve
        })
    )

    const save = startFileActionTask(TARGET, 'save', client)
    const open = startFileActionTask(TARGET, 'open', client)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(taskStateFor(fileActionTargetKey(TARGET)).status).toBe('preparing')

    resolvePrepare?.(PREPARED)
    await expect(save).resolves.toEqual(PREPARED)
    await expect(open).resolves.toEqual(PREPARED)
    expect(taskStateFor(fileActionTargetKey(TARGET))).toMatchObject({
      status: 'ready',
      action: 'save',
      prepared: PREPARED
    })
  })

  it('forgets a ready result after it was used, so the next action re-reads the file', async () => {
    prepare.mockResolvedValue(PREPARED)
    await startFileActionTask(TARGET, 'save', client)
    expect(taskStateFor(fileActionTargetKey(TARGET)).status).toBe('ready')

    forgetFileActionTask(fileActionTargetKey(TARGET))

    expect(taskStateFor(fileActionTargetKey(TARGET))).toEqual({ status: 'idle' })
  })

  it('forwards the refreshed terminal artifact source through prepare', async () => {
    prepare.mockImplementation((_client: unknown, _target: unknown, options: PrepareCallbacks) => {
      options.onTerminalArtifactSourceRefreshed?.({
        source: 'terminalArtifact',
        worktreeId: 'wt-1',
        absolutePath: '/tmp/new.txt',
        grantId: 'grant-2'
      })
      return Promise.resolve(PREPARED)
    })
    const refreshed = vi.fn()

    await startFileActionTask(TARGET, 'save', client, refreshed)

    expect(refreshed).toHaveBeenCalledWith({
      source: 'terminalArtifact',
      worktreeId: 'wt-1',
      absolutePath: '/tmp/new.txt',
      grantId: 'grant-2'
    })
  })

  it('drops every ready task when the download cache is cleared', async () => {
    prepare.mockResolvedValue(PREPARED)
    await startFileActionTask(TARGET, 'save', client)
    expect(taskStateFor(fileActionTargetKey(TARGET)).status).toBe('ready')

    clearDownloadCache()

    expect(taskStateFor(fileActionTargetKey(TARGET))).toEqual({ status: 'idle' })
  })

  it('drops only the ready task whose cache directory the LRU trim evicted', async () => {
    const otherTarget = { ...TARGET, relativePath: 'src/other.ts', name: 'other.ts' }
    const otherPrepared: PreparedCachedFile = {
      ...PREPARED,
      targetKey: fileActionTargetKey(otherTarget),
      directoryUri: 'file:///cache/two'
    }
    prepare.mockResolvedValueOnce(PREPARED).mockResolvedValueOnce(otherPrepared)
    await startFileActionTask(TARGET, 'save', client)
    await startFileActionTask(otherTarget, 'save', client)

    // The oldest entry alone exceeds the 512 MB cap, so only it is removed.
    const metadata = (fileName: string, size: number, usedAt: number): string =>
      JSON.stringify({ fileName, size, sha256: 'abc', createdAt: 1, usedAt })
    cacheFs.entries = [
      { name: 'one', metadata: metadata('app.ts', 600 * 1024 * 1024, 1) },
      { name: 'two', metadata: metadata('other.ts', 10, 2) }
    ]

    enforceDownloadCacheLimit(3)

    expect(cacheFs.deleted).toEqual(['one'])
    expect(taskStateFor(fileActionTargetKey(TARGET))).toEqual({ status: 'idle' })
    expect(taskStateFor(fileActionTargetKey(otherTarget)).status).toBe('ready')
  })

  it('publishes progress and a retryable failure', async () => {
    prepare.mockImplementation((_client: unknown, _target: unknown, options: PrepareCallbacks) => {
      options.onProgress({ action: 'save', bytes: 2, total: 4 })
      expect(taskStateFor(fileActionTargetKey(TARGET))).toMatchObject({
        status: 'preparing',
        bytes: 2,
        total: 4
      })
      return Promise.reject(new Error('read failed'))
    })

    await expect(startFileActionTask(TARGET, 'save', client)).rejects.toThrow('read failed')
    expect(taskStateFor(fileActionTargetKey(TARGET))).toMatchObject({
      status: 'failed',
      message: 'read failed',
      retryable: true
    })
  })
})
