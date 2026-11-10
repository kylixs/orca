import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { getMobileFileKind, isMarkdownPath } from './file-tree'
import type { FileActionTargetKind } from './mobile-file-actions'
import { mobileFileMediaMime } from './mobile-file-media'

/** One mapping from a path to the action-matrix row, shared by the list and the preview. */
export function fileTargetKindForPath(
  relativePath: string,
  kind: 'text' | 'binary'
): FileActionTargetKind {
  const artifact = classifyMobileArtifact(relativePath)
  if (artifact === 'image') {
    return 'image'
  }
  if (artifact === 'html') {
    return 'html'
  }
  if (mobileFileMediaMime(relativePath)) {
    return 'media'
  }
  if (isMarkdownPath(relativePath)) {
    return 'markdown'
  }
  return kind === 'text' ? 'text' : 'binary'
}

/**
 * The same matrix row for a route that only has a path, not the list's server-provided kind.
 * Extensionless and unknown-extension files are text, exactly as the list classifies them; only a
 * known-binary extension (PDF, zip, images) loses Preview and Copy content. Office documents
 * (`.docx`/`.xlsx`) are text here too, since the list's binary table has no office extensions; media
 * is the row above.
 */
export function fileTargetKindForPreviewPath(relativePath: string): FileActionTargetKind {
  return fileTargetKindForPath(relativePath, getMobileFileKind(relativePath))
}
