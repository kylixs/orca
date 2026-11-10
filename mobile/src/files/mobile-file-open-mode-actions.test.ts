import { describe, expect, it } from 'vitest'
import { availableHtmlOpenActions } from './mobile-file-open-mode-actions'

const worktree = {
  source: 'worktree' as const,
  previewDisabled: false,
  readFailed: false
}

describe('availableHtmlOpenActions', () => {
  it('offers Preview and Source for a readable worktree file', () => {
    expect(availableHtmlOpenActions(worktree)).toEqual([
      { id: 'preview', label: 'Preview' },
      { id: 'source', label: 'Source' }
    ])
  })

  it('keeps Source and hides Preview once the read is truncated', () => {
    expect(availableHtmlOpenActions({ ...worktree, previewDisabled: true })).toEqual([
      { id: 'source', label: 'Source' }
    ])
  })

  it('offers only the source mode for a terminal artifact', () => {
    expect(availableHtmlOpenActions({ ...worktree, source: 'terminalArtifact' })).toEqual([
      { id: 'source', label: 'Source' }
    ])
  })

  it('offers no mode action after a failed read', () => {
    expect(availableHtmlOpenActions({ ...worktree, readFailed: true })).toEqual([])
    expect(
      availableHtmlOpenActions({ ...worktree, source: 'terminalArtifact', readFailed: true })
    ).toEqual([])
  })
})
