import { hasBinaryFileExtension } from '../../../../shared/binary-file-extensions'
import type { FileContent } from './editor-panel-content-types'

// Git's own probe length; a NUL anywhere in this prefix means "not text".
const BINARY_PROBE_CHARS = 8192

/**
 * The desktop editor trusts whatever a host returns, but a host that only
 * screens its own small extension allowlist can hand back raw bytes. Keep the
 * same two-layer guard the cloud file tabs use: extension first, then content.
 */
export function isKnownBinaryEditorFile(filePath: string): boolean {
  return hasBinaryFileExtension(filePath)
}

export function guardEditorFileContent(result: FileContent): FileContent {
  if (result.isBinary || result.csvPreview !== undefined || result.loadError !== undefined) {
    return result
  }
  if (result.content.slice(0, BINARY_PROBE_CHARS).includes('\u0000')) {
    return { content: '', isBinary: true }
  }
  return result
}
