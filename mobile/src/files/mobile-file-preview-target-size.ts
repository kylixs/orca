import type { MobileFilePreviewResult } from './mobile-file-preview-request'

/** The size a prepared terminal artifact is checked against before Save/Open is offered. */
export function previewByteSize(preview: MobileFilePreviewResult): number | undefined {
  if (preview.status === 'empty') {
    return 0
  }
  if (preview.status !== 'ready') {
    return undefined
  }
  if (preview.kind === 'image') {
    const encoded = preview.dataUri.slice(preview.dataUri.indexOf(',') + 1)
    return Math.floor((encoded.length * 3) / 4)
  }
  return preview.kind === 'media' ? undefined : preview.byteLength
}

export function saveErrorMessageFromPreviewResult(result: MobileFilePreviewResult): string {
  return result.status === 'error' || result.status === 'waiting'
    ? result.message
    : 'Unable to save file'
}

/** Binary/over-budget previews are policy results, not read failures, and get no row badge. */
export function isNonReadPreviewMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('binary preview unavailable') ||
    normalized.includes('file too large for mobile preview')
  )
}
