import { readNumber, readString } from '../../../shared/json-fields'

/**
 * U96 B-令6 / U98: the simple workspace observes the host's size-floor state
 * passively. These pure helpers decide when a conflict is worth a prompt.
 */

export type CloudTerminalFitMode = 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'

export type CloudTerminalFitConflict = 'remote-desktop' | 'mobile'

export function parseCloudFitOverrideEvent(event: unknown): {
  mode: CloudTerminalFitMode
  cols: number | null
  rows: number | null
} | null {
  const mode = readString(event, 'mode')
  if (mode !== 'mobile-fit' && mode !== 'remote-desktop-fit' && mode !== 'desktop-fit') {
    return null
  }
  return {
    mode,
    cols: readNumber(event, 'cols'),
    rows: readNumber(event, 'rows')
  }
}

/** `desktop-fit` means this viewer owns the floor; nothing to ask. */
export function cloudTerminalFitConflictOf(
  mode: CloudTerminalFitMode | null
): CloudTerminalFitConflict | null {
  if (mode === 'remote-desktop-fit') {
    return 'remote-desktop'
  }
  return mode === 'mobile-fit' ? 'mobile' : null
}

export function describeAutoRestoreFit(ms: number | null): string {
  return ms === null ? '保持当前尺寸，直到手动恢复' : `${Math.round(ms / 1000)} 秒后自动恢复`
}
