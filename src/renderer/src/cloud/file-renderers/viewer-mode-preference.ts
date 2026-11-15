import type { CloudFileMode, CloudFileRendererDescriptor, CloudFileRendererId } from './registry'

/**
 * Session-scoped mode memory (FS-1, design §3.2): scoped by renderer id so a
 * user's "show Markdown source" choice carries across files in one session.
 */

const KEY_PREFIX = 'cloud-ws:viewer-mode:v1:'

function storage(): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function isMode(value: string | null): value is CloudFileMode {
  return value === 'preview' || value === 'source'
}

export function cloudFileModePreferenceKey(id: CloudFileRendererId): string {
  return `${KEY_PREFIX}${id}`
}

export function readCloudFileModePreference(id: CloudFileRendererId): CloudFileMode | null {
  try {
    const value = storage()?.getItem(cloudFileModePreferenceKey(id)) ?? null
    return isMode(value) ? value : null
  } catch {
    return null
  }
}

/** Only explicit user switches write; automatic fallbacks must not override the default. */
export function writeCloudFileModePreference(id: CloudFileRendererId, mode: CloudFileMode): void {
  try {
    storage()?.setItem(cloudFileModePreferenceKey(id), mode)
  } catch {
    // Storage can be blocked; the mounted React state still tracks the choice.
  }
}

export function clearCloudFileModePreference(id: CloudFileRendererId): void {
  try {
    storage()?.removeItem(cloudFileModePreferenceKey(id))
  } catch {
    // Best effort.
  }
}

/** React state wins first; then session preference; then the descriptor default. */
export function initialCloudFileMode(renderer: CloudFileRendererDescriptor): CloudFileMode {
  if (renderer.canPreview && renderer.canEditSource) {
    return readCloudFileModePreference(renderer.id) ?? renderer.defaultMode
  }
  return renderer.defaultMode
}
