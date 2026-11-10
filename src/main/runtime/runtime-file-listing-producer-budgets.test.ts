import { describe, expect, it, vi } from 'vitest'
import { getSshFilesystemProviderMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  MOBILE_FILE_LIST_LIMIT,
  MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT
} from './runtime-file-commands-mobile-file-list-limit'
const { localList } = vi.hoisted(() => ({ localList: vi.fn() }))
vi.mock('../ipc/filesystem-list-files', () => ({ listQuickOpenFiles: localList }))
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

function inventory(count: number) {
  const paths = Array.from({ length: count }, (_, index) => `src/file-${index}.ts`)
  return vi.fn(async (_root: string, options?: { maxResults?: number }) =>
    paths.slice(0, options?.maxResults)
  )
}

describe('runtime producer listing budgets', () => {
  useRuntimeFileCommandsLifecycle()
  it.each([5000, 5001, 5002])(
    'passes the mobile sentinel budget on SSH for %i paths',
    async (count) => {
      const listFiles = inventory(count)
      getSshFilesystemProviderMock.mockReturnValue({ listFiles })
      const { commands } = createRuntimeFileCommands({ hostId: 'ssh:host' })
      const result = await commands.listMobileFiles('id:wt-1')
      expect(listFiles).toHaveBeenCalledWith('/repo', { maxResults: 5001, signal: undefined })
      expect(result.files).toHaveLength(MOBILE_FILE_LIST_LIMIT)
      expect(result.totalCount).toBe(Math.min(count, MOBILE_FILE_LIST_LIMIT + 1))
      expect(result.truncated).toBe(count > MOBILE_FILE_LIST_LIMIT)
      expect(result.libraryTruncated).toBe(count > MOBILE_FILE_LIST_LIMIT)
    }
  )

  it('passes the same sentinel budget before local enumeration', async () => {
    localList.mockImplementation(async (_root, _store, _excluded, _signal, maxResults) =>
      Array.from({ length: Math.min(5002, maxResults) }, (_, i) => `file-${i}.txt`)
    )
    const { commands } = createRuntimeFileCommands()
    const result = await commands.listMobileFiles('id:wt-1')
    expect(localList.mock.calls[0][4]).toBe(MOBILE_FILE_LIST_LIMIT + 1)
    expect(result.totalCount).toBe(MOBILE_FILE_LIST_LIMIT + 1)
    expect(result.truncated).toBe(true)
    expect(result.libraryTruncated).toBe(true)
  })

  it('reports a truncated path-search inventory as libraryTruncated', async () => {
    localList.mockClear()
    localList.mockImplementation(async (_root, _store, _excluded, _signal, maxResults) =>
      Array.from(
        { length: Math.min(MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1, maxResults) },
        (_, i) => `src/file-${i}.ts`
      )
    )
    const { commands } = createRuntimeFileCommands()
    const result = await commands.searchMobileFilePaths('id:wt-1', 'file', 5)
    expect(localList.mock.calls[0][4]).toBe(MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1)
    expect(result.files).toHaveLength(5)
    expect(result.truncated).toBe(true)
    expect(result.libraryTruncated).toBe(true)
  })

  it('does not report libraryTruncated when the path-search inventory fits the cap', async () => {
    localList.mockClear()
    localList.mockImplementation(async () => ['src/app.ts', 'src/main.ts', 'README.md'])
    const { commands } = createRuntimeFileCommands()
    const result = await commands.searchMobileFilePaths('id:wt-1', 'app', 5)
    expect(result.files.map((file) => file.relativePath)).toEqual(['src/app.ts'])
    expect(result.truncated).toBe(false)
    expect(result.libraryTruncated).toBe(false)
  })

  it.each([25002, 100000])(
    'keeps late files in an unqualified %i-file SSH inventory',
    async (count) => {
      const listFiles = inventory(count)
      getSshFilesystemProviderMock.mockReturnValue({ listFiles })
      const { commands } = createRuntimeFileCommands({ hostId: 'ssh:host' })
      const files = await commands.listRuntimeFiles('id:wt-1')
      expect(files).toHaveLength(count)
      expect(files.at(-1)).toBe(`src/file-${count - 1}.ts`)
      expect(listFiles.mock.calls[0][1]?.maxResults).toBeUndefined()
    }
  )

  it('preserves the full local inventory and explicit caller limits', async () => {
    localList.mockClear()
    localList.mockImplementation(async (_root, _store, _excluded, _signal, maxResults) =>
      Array.from({ length: 25002 }, (_, i) => `file-${i}.txt`).slice(0, maxResults)
    )
    const { commands } = createRuntimeFileCommands()
    expect((await commands.listRuntimeFiles('id:wt-1')).at(-1)).toBe('file-25001.txt')
    expect(localList.mock.calls[0][4]).toBeUndefined()
    expect(await commands.listRuntimeFiles('id:wt-1', { maxResults: 3 })).toHaveLength(3)
  })

  it('requests Markdown from its semantic producer, without retaining unrelated paths', async () => {
    const listFiles = vi.fn()
    const listMarkdownDocuments = vi.fn().mockResolvedValue([])
    getSshFilesystemProviderMock.mockReturnValue({ listFiles, listMarkdownDocuments })
    const { commands } = createRuntimeFileCommands({ hostId: 'ssh:host' })
    await commands.listRuntimeMarkdownDocuments('id:wt-1')
    expect(listMarkdownDocuments).toHaveBeenCalledWith('/repo')
    expect(listFiles).not.toHaveBeenCalled()
  })
})
