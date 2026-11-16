import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cloudWorktreeSelector, type CloudRpc } from '../../../shared/cloud-file-browser'
import type { CloudRpcOutcome } from '../../../shared/cloud-platform-ipc'
import { readField, readNumber, readString, readStringArray } from '../../../shared/json-fields'

/**
 * U96 A-令7: the replay boundary and the explicit ended state.
 *
 * The host owns the caps (1000 rows / 512 KiB, unchanged); this module only
 * reads the flags the snapshot carries and decides what the pane says. It never
 * reads `localOnlyScrollbackByTabId` — that buffer never leaves its client.
 */

/** Mirrors `MOBILE_SUBSCRIBE_SCROLLBACK_ROWS`; display-only, the host enforces it. */
export const REPLAY_SCROLLBACK_ROWS = 1000
/** Mirrors `MOBILE_SNAPSHOT_BYTE_BUDGET`; display-only, the host enforces it. */
export const REPLAY_BYTE_BUDGET = 512 * 1024

export const REPLAY_TRUNCATED_NOTICE = `回放已截断：仅显示最近 ${REPLAY_SCROLLBACK_ROWS} 行，最多 ${REPLAY_BYTE_BUDGET / 1024} KiB 历史。`
export const REPLAY_UNAVAILABLE_NOTICE = '宿主未保留可回放的终端历史。'
export const SESSION_ENDED_NOTICE = '会话已结束（宿主已重启或终端已退出）。'

export type CloudScrollbackBoundary = {
  /** The host dropped history by row cap or byte budget. */
  truncated: boolean
  truncatedByByteBudget: boolean
  /** Host-reported reason the snapshot could not be serialized. */
  unavailable: string | null
}

export type CloudScrollbackReplay = {
  payload: string | null
  cols: number | null
  rows: number | null
  boundary: CloudScrollbackBoundary
}

function framePayloadOf(event: unknown): string | null {
  const serialized = readString(event, 'serialized')
  if (serialized !== null) {
    return serialized
  }
  const lines = readStringArray(event, 'lines')
  return lines === null ? null : `${lines.join('\r\n')}\r\n`
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && value > 0 ? value : null
}

/**
 * The whole replay payload the cloud pane may paint: the host's serialized ANSI
 * (or the older text fallback) plus its truncation flags. Deliberately blind to
 * `localOnlyScrollbackByTabId`, which is client-local by contract.
 */
export function readCloudScrollbackReplay(event: unknown): CloudScrollbackReplay {
  return {
    payload: framePayloadOf(event),
    cols: positiveOrNull(readNumber(event, 'cols')),
    rows: positiveOrNull(readNumber(event, 'rows')),
    boundary: {
      truncated:
        readField(event, 'truncated') === true ||
        readField(event, 'truncatedByByteBudget') === true,
      truncatedByByteBudget: readField(event, 'truncatedByByteBudget') === true,
      unavailable: readString(event, 'unavailable')
    }
  }
}

/** Error codes that mean the PTY behind the handle is gone, not a dropped link. */
const TERMINAL_GONE_CODES = [
  'terminal_handle_stale',
  'terminal_exited',
  'terminal_unknown',
  'terminal_not_found',
  'no_connected_pty'
] as const

export function isTerminalSessionGone(code: string | null, message?: string | null): boolean {
  const normalized = (code ?? '').toLowerCase()
  if ((TERMINAL_GONE_CODES as readonly string[]).includes(normalized)) {
    return true
  }
  const text = (message ?? '').toLowerCase()
  return TERMINAL_GONE_CODES.some((gone) => text.includes(gone))
}

export type CloudTerminalReopenArgs = {
  workspacePath: string
  title: string
  /** The restored tab id; the host rebuilds the PTY under the same tab. */
  tabId?: string
  leafId?: string
}

export function buildCloudTerminalReopenParams(
  args: CloudTerminalReopenArgs
): Record<string, unknown> {
  return {
    worktree: cloudWorktreeSelector(args.workspacePath),
    title: args.title,
    ...(args.tabId ? { tabId: args.tabId } : {}),
    ...(args.leafId ? { leafId: args.leafId } : {})
  }
}

function terminalHandleOf(result: unknown): string | null {
  return readString(readField(result, 'terminal'), 'handle')
}

/** Rebuilds the PTY after an ended session; the caller re-subscribes with the new handle. */
export function useCloudTerminalReopen(args: {
  rpc: CloudRpc
  workspacePath: string
  title: string
  tabId?: string
  leafId?: string
  onReopened: (handle: string | null) => void
}): { reopen: () => Promise<void>; pending: boolean } {
  const [pending, setPending] = React.useState(false)
  const { rpc, workspacePath, title, tabId, leafId, onReopened } = args

  const reopen = React.useCallback(async (): Promise<void> => {
    setPending(true)
    let outcome: CloudRpcOutcome
    try {
      outcome = await rpc(
        'terminal.create',
        buildCloudTerminalReopenParams({ workspacePath, title, tabId, leafId })
      )
    } catch {
      outcome = { ok: false, code: 'terminal_create_failed' }
    }
    setPending(false)
    onReopened(outcome.ok ? terminalHandleOf(outcome.result) : null)
  }, [rpc, workspacePath, title, tabId, leafId, onReopened])

  return { reopen, pending }
}

export function CloudTerminalReplayNotice({
  boundary
}: {
  boundary: CloudScrollbackBoundary
}): React.JSX.Element | null {
  if (boundary.truncated) {
    return (
      <p data-testid="cloud-terminal-replay-truncated" className="text-xs text-muted-foreground">
        {REPLAY_TRUNCATED_NOTICE}
      </p>
    )
  }
  if (boundary.unavailable !== null) {
    return (
      <p data-testid="cloud-terminal-replay-unavailable" className="text-xs text-muted-foreground">
        {REPLAY_UNAVAILABLE_NOTICE}
      </p>
    )
  }
  return null
}

export function CloudTerminalEndedNotice({
  pending = false,
  onReopen
}: {
  pending?: boolean
  onReopen: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="cloud-terminal-ended"
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded border border-border bg-muted/40 px-3 py-2"
    >
      <span data-testid="cloud-terminal-ended-text" className="text-xs text-foreground">
        {SESSION_ENDED_NOTICE}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="cloud-terminal-reopen"
        disabled={pending}
        onClick={onReopen}
      >
        重新打开终端
      </Button>
    </div>
  )
}
