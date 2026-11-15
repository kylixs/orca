// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import type { FileContent } from './editor-panel-content-types'
import { guardEditorFileContent, isKnownBinaryEditorFile } from './editor-file-content-binary-guard'
import {
  useEditorPanelFileContentLoader,
  type EditorPanelFileContentLoader
} from './useEditorPanelFileContentLoader'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileClient>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const WORKTREE = 'repo-1::/root/repo'
const ROOT = '/root/repo/'

function seedLocalWorkspace(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    activeWorktreeId: WORKTREE,
    repos: [
      {
        id: 'repo-1',
        path: '/root/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        kind: 'git'
      }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE, repoId: 'repo-1', path: '/root/repo' })]
    }
  })
}

function openFile(filePath: string): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath.slice(ROOT.length),
      worktreeId: WORKTREE,
      language: 'plaintext',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

describe('desktop editor binary guard', () => {
  it('classifies a known binary extension and leaves SVG as editable text', () => {
    expect(isKnownBinaryEditorFile('/root/repo/man-review-binary.bin')).toBe(true)
    expect(isKnownBinaryEditorFile('/root/repo/archive.zip')).toBe(true)
    expect(isKnownBinaryEditorFile('/root/repo/icon.svg')).toBe(false)
  })

  it('downgrades NUL-bearing content that the host returned as text', () => {
    expect(guardEditorFileContent({ content: 'AB\u0000CD', isBinary: false })).toEqual({
      content: '',
      isBinary: true
    })
    expect(guardEditorFileContent({ content: 'plain text', isBinary: false })).toEqual({
      content: 'plain text',
      isBinary: false
    })
  })
})

describe('desktop editor file loader binary guard', () => {
  let container: HTMLDivElement
  let root: Root
  let load: EditorPanelFileContentLoader | null
  let fileContents: Record<string, FileContent>

  beforeEach(() => {
    mocks.readRuntimeFileContent.mockReset()
    fileContents = {}
    load = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    function LoaderHarness(): null {
      load = useEditorPanelFileContentLoader({
        fileLoadRetryAttemptsRef: { current: {} },
        fileReadGenerationCounterRef: { current: 0 },
        fileReadGenerationRef: { current: {} },
        openFilesRef: {
          get current() {
            return useAppStore.getState().openFiles
          }
        },
        outstandingFileReadsRef: { current: {} },
        setFileContents: (updater) => {
          fileContents = typeof updater === 'function' ? updater(fileContents) : updater
        }
      })
      return null
    }
    act(() => root.render(<LoaderHarness />))
    seedLocalWorkspace()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('opens a .bin as a read-only binary placeholder without reading bytes', async () => {
    const filePath = `${ROOT}man-review-binary.bin`
    const id = openFile(filePath)

    await act(async () => {
      await load!(filePath, id, WORKTREE, 'man-review-binary.bin')
    })

    expect(fileContents[id]).toEqual({ content: '', isBinary: true })
    expect(mocks.readRuntimeFileContent).not.toHaveBeenCalled()
  })

  it('turns host text containing NUL into the binary placeholder', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({
      content: 'AB\u0000CD',
      isBinary: false
    })
    const filePath = `${ROOT}unknown.dat`
    const id = openFile(filePath)

    await act(async () => {
      await load!(filePath, id, WORKTREE, 'unknown.dat')
    })

    expect(fileContents[id]).toEqual({ content: '', isBinary: true })
  })

  it('keeps ordinary text editable', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'hello', isBinary: false })
    const filePath = `${ROOT}README.md`
    const id = openFile(filePath)

    await act(async () => {
      await load!(filePath, id, WORKTREE, 'README.md')
    })

    expect(fileContents[id]).toEqual({ content: 'hello', isBinary: false })
  })
})
