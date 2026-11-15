import type { CloudFileCopyFailureReason } from './cloud-file-copy-audit'

/** Desktop IPC first, then the browser clipboard; the web preload mirrors this. */
export async function writeCloudClipboardText(text: string): Promise<void> {
  const write = window.api?.ui?.writeClipboardText
  if (typeof write === 'function') {
    await write(text)
    return
  }
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    await navigator.clipboard.writeText(text)
    return
  }
  throw new Error('Clipboard write is unavailable in this browser context')
}

export function cloudClipboardFailureReason(error: unknown): CloudFileCopyFailureReason {
  return error instanceof Error && error.name === 'NotAllowedError'
    ? 'clipboard_denied'
    : 'clipboard_write_failed'
}
