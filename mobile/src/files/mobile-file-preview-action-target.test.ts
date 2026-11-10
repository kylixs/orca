import { describe, expect, it } from 'vitest'
import { buildFileActions, FULL_FILE_ACTION_CAPABILITIES } from './mobile-file-actions'
import { previewActionTarget } from './mobile-file-preview-action-target'

const ROUTE = {
  hostId: 'host-1',
  worktreeId: 'wt-1',
  relativePath: 'manual.pdf',
  name: 'manual.pdf'
}

function labels(relativePath: string): string[] {
  const target = previewActionTarget(
    { ...ROUTE, relativePath, name: relativePath },
    { title: relativePath, readOnly: false }
  )
  if (!target) {
    throw new Error('expected a target')
  }
  return buildFileActions(target, {
    context: 'preview',
    capabilities: FULL_FILE_ACTION_CAPABILITIES
  }).map((action) => action.label)
}

describe('previewActionTarget', () => {
  it('treats a PDF reached by deep link as binary, so it offers no Copy content', () => {
    expect(labels('manual.pdf')).toEqual(['Save to phone', 'Open with', 'Copy path', 'Cancel'])
  })

  it('keeps text and images on their matrix rows', () => {
    expect(labels('README.md')).toContain('Copy content')
    expect(labels('logo.png')).toEqual(['Save to phone', 'Open with', 'Copy path', 'Cancel'])
  })

  it('keeps extensionless and unknown-extension files on the text row', () => {
    for (const path of ['LICENSE', 'Makefile', 'foo.log', '.env', 'conf/app.conf']) {
      expect(labels(path)).toContain('Copy content')
      const target = previewActionTarget(
        { ...ROUTE, relativePath: path, name: path },
        { title: path, readOnly: false }
      )
      expect(target).toMatchObject({ source: 'worktree', previewable: true })
    }
  })

  it('treats a zip archive like a PDF: binary, with no Copy content', () => {
    expect(labels('archive.zip')).toEqual(['Save to phone', 'Open with', 'Copy path', 'Cancel'])
  })
})
