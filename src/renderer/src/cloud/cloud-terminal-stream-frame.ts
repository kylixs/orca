import { readString } from '../../../shared/json-fields'
import {
  readCloudScrollbackReplay,
  type CloudScrollbackBoundary
} from './cloud-terminal-replay-boundary'

/**
 * U96 B-令3: one wire frame → what the pane must do. Pure, so the attach path
 * can consume the replay payload and its boundary flags together.
 */

export type CloudTerminalStreamFrame =
  | {
      kind: 'replay'
      payload: string | null
      size: { cols: number; rows: number } | null
      boundary: CloudScrollbackBoundary
    }
  | { kind: 'data'; chunk: string }
  | { kind: 'fit-override'; event: unknown }
  | { kind: 'unknown' }

export function readCloudTerminalStreamFrame(event: unknown): CloudTerminalStreamFrame {
  const type = readString(event, 'type')
  if (type === 'scrollback') {
    const replay = readCloudScrollbackReplay(event)
    return {
      kind: 'replay',
      payload: replay.payload,
      size:
        replay.cols !== null && replay.rows !== null
          ? { cols: replay.cols, rows: replay.rows }
          : null,
      boundary: replay.boundary
    }
  }
  if (type === 'data') {
    const chunk = readString(event, 'chunk')
    return chunk === null ? { kind: 'unknown' } : { kind: 'data', chunk }
  }
  if (type === 'fit-override-changed') {
    return { kind: 'fit-override', event }
  }
  return { kind: 'unknown' }
}
