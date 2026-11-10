import { describe, expect, it } from 'vitest'
import {
  buildFileActions,
  fileActionCapabilityNotice,
  fileActionPath,
  fileActionTargetKey,
  FULL_FILE_ACTION_CAPABILITIES,
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_TEXT_MAX_BYTES,
  type FileActionTarget,
  type WorktreeFileActionTarget
} from './mobile-file-actions'

function worktree(overrides: Partial<WorktreeFileActionTarget> = {}): FileActionTarget {
  return {
    source: 'worktree',
    worktreeId: 'wt-1',
    relativePath: 'src/app.ts',
    name: 'app.ts',
    kind: 'text',
    previewable: true,
    ...overrides
  }
}

function terminal(
  overrides: Partial<Extract<FileActionTarget, { source: 'terminalArtifact' }>> = {}
) {
  return {
    source: 'terminalArtifact' as const,
    worktreeId: 'wt-1',
    absolutePath: '/tmp/result.txt',
    grantId: 'grant-1',
    displayPath: '/tmp/result.txt',
    name: 'result.txt',
    kind: 'text' as const,
    ...overrides
  }
}

const labels = (target: FileActionTarget, context: 'list' | 'preview' = 'list') =>
  buildFileActions(target, { context, capabilities: FULL_FILE_ACTION_CAPABILITIES }).map(
    (action) => action.label
  )

describe('buildFileActions', () => {
  it('lists text actions in the one fixed order', () => {
    expect(labels(worktree())).toEqual([
      'Preview',
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
  })

  it('omits Preview in the preview context but keeps the rest in order', () => {
    expect(labels(worktree(), 'preview')).toEqual([
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
  })

  it('offers a directory only Copy path and Cancel', () => {
    expect(labels(worktree({ kind: 'directory', previewable: false }))).toEqual([
      'Copy path',
      'Cancel'
    ])
  })

  it('keeps binary rows actionable without Preview or Copy content', () => {
    expect(
      labels(worktree({ kind: 'binary', relativePath: 'a.pdf', name: 'a.pdf', previewable: false }))
    ).toEqual(['Save to phone', 'Open with', 'Copy path', 'Cancel'])
  })

  it('gives images and media no Copy content', () => {
    expect(labels(worktree({ kind: 'image', relativePath: 'a.png', previewable: true }))).toEqual([
      'Preview',
      'Save to phone',
      'Open with',
      'Copy path',
      'Cancel'
    ])
    expect(labels(worktree({ kind: 'media', relativePath: 'a.mp4', previewable: true }))).toEqual([
      'Preview',
      'Save to phone',
      'Open with',
      'Copy path',
      'Cancel'
    ])
  })

  it('shows Retry read and keeps only actions that do not need the content', () => {
    expect(labels(worktree({ readFailed: true }))).toEqual([
      'Retry read',
      'Save to phone',
      'Open with',
      'Copy path',
      'Cancel'
    ])
  })

  it('hides Save and Open when the native modules are missing', () => {
    expect(
      buildFileActions(worktree(), {
        context: 'list',
        capabilities: { saveToPhone: false, openWith: false }
      }).map((action) => action.label)
    ).toEqual(['Preview', 'Copy content', 'Copy path', 'Cancel'])
  })

  it('replaces the generic Preview with the HTML mode pair in both contexts', () => {
    const html = worktree({ kind: 'html', relativePath: 'a.html', name: 'a.html' })
    const expected = [
      'Preview',
      'Source',
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ]
    expect(labels(html)).toEqual(expected)
    expect(labels(html, 'preview')).toEqual(expected)
  })

  it('adds the source mode for a source-only terminal artifact', () => {
    const target = terminal({ kind: 'text', name: 'result.html' })
    expect(
      buildFileActions(target, {
        context: 'preview',
        htmlActionState: {
          source: 'terminalArtifact',
          previewDisabled: false,
          readFailed: false
        },
        capabilities: FULL_FILE_ACTION_CAPABILITIES
      }).map((action) => action.label)
    ).toEqual(['Source', 'Save to phone', 'Open with', 'Copy content', 'Copy path', 'Cancel'])
  })

  it('keeps only Source and hints a partial copy when the HTML read was truncated', () => {
    const html = worktree({ kind: 'html', relativePath: 'a.html', name: 'a.html' })
    const actions = buildFileActions(html, {
      context: 'preview',
      htmlActionState: {
        source: 'worktree',
        previewDisabled: true,
        readFailed: false
      },
      capabilities: FULL_FILE_ACTION_CAPABILITIES
    })
    expect(actions.map((action) => action.label)).toEqual([
      'Source',
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
    expect(actions.find((action) => action.id === 'copy-content')?.hint).toBe(
      'Copies the first 512 KB'
    )
  })

  it('hides every HTML mode and Copy content after a failed read', () => {
    const html = worktree({
      kind: 'html',
      relativePath: 'a.html',
      name: 'a.html',
      readFailed: true
    })
    expect(labels(html, 'preview')).toEqual([
      'Retry read',
      'Save to phone',
      'Open with',
      'Copy path',
      'Cancel'
    ])
  })

  it('keeps terminal text within 512 KB fully actionable', () => {
    expect(labels(terminal({ size: TERMINAL_TEXT_MAX_BYTES }))).toEqual([
      'Save to phone',
      'Open with',
      'Copy content',
      'Copy path',
      'Cancel'
    ])
  })

  it('reduces an over-budget terminal artifact to Copy path', () => {
    expect(labels(terminal({ size: TERMINAL_TEXT_MAX_BYTES + 1 }))).toEqual(['Copy path', 'Cancel'])
    expect(
      labels(terminal({ kind: 'image', name: 'shot.png', size: TERMINAL_IMAGE_MAX_BYTES + 1 }))
    ).toEqual(['Copy path', 'Cancel'])
  })

  it('copies pathText when present, even after a grant refresh', () => {
    expect(
      fileActionPath(
        terminal({ absolutePath: '/private/var/tmp/result.txt', pathText: '~/result.txt' })
      )
    ).toBe('~/result.txt')
    expect(fileActionPath(terminal())).toBe('/tmp/result.txt')
    expect(fileActionPath(worktree())).toBe('src/app.ts')
  })

  it('keys the same file the same way from either screen', () => {
    expect(fileActionTargetKey(worktree({ hostId: 'host-1' }))).toBe(
      fileActionTargetKey(worktree({ hostId: 'host-1' }))
    )
    expect(fileActionTargetKey(worktree({ hostId: 'host-1' }))).not.toBe(
      fileActionTargetKey(worktree({ hostId: 'host-2' }))
    )
  })
})

describe('fileActionCapabilityNotice', () => {
  const notice = (
    target: FileActionTarget,
    capabilities: { saveToPhone: boolean; openWith: boolean }
  ) => fileActionCapabilityNotice(target, { context: 'list', capabilities })

  it('stays silent only when every action is available', () => {
    expect(notice(worktree(), FULL_FILE_ACTION_CAPABILITIES)).toBeNull()
  })

  it('explains a partial degradation instead of hiding an applicable action silently', () => {
    expect(notice(worktree(), { saveToPhone: true, openWith: false })).toBe(
      'Update Orca on this device to use file actions'
    )
    expect(notice(worktree(), { saveToPhone: false, openWith: true })).toBe(
      'Update Orca on this device to use file actions'
    )
    expect(notice(worktree(), { saveToPhone: false, openWith: false })).toBe(
      'Update Orca on this device to use file actions'
    )
    expect(
      notice(
        worktree({ kind: 'binary', relativePath: 'a.pdf', name: 'a.pdf', previewable: false }),
        { saveToPhone: false, openWith: false }
      )
    ).toBe('Update Orca on this device to use file actions')
  })

  it('stays silent for a directory that never has Save/Open', () => {
    expect(
      notice(worktree({ kind: 'directory', previewable: false }), {
        saveToPhone: false,
        openWith: false
      })
    ).toBeNull()
  })

  it('stays silent for an over-budget terminal artifact that never has Save/Open', () => {
    expect(
      notice(terminal({ size: TERMINAL_TEXT_MAX_BYTES + 1 }), {
        saveToPhone: false,
        openWith: false
      })
    ).toBeNull()
    expect(
      notice(terminal({ kind: 'image', name: 'shot.png', size: TERMINAL_IMAGE_MAX_BYTES + 1 }), {
        saveToPhone: false,
        openWith: false
      })
    ).toBeNull()
  })
})
