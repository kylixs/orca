import * as React from 'react'
import type { CloudRpc } from '../../../shared/cloud-file-browser'
import { readNumber } from '../../../shared/json-fields'
import {
  cloudTerminalFitConflictOf,
  describeAutoRestoreFit,
  parseCloudFitOverrideEvent,
  type CloudTerminalFitConflict,
  type CloudTerminalFitMode
} from './cloud-terminal-fit-overlay-state'

/**
 * U96 B-令6: the simple workspace's size-floor observer.
 *
 * Attaching is passive (U98); a conflict is only ever resolved by an explicit
 * user gesture — claim the floor for this window, or restore desktop dims when a
 * phone holds them. The host's `fit-override-changed` stream is the only input.
 */

export type CloudTerminalFitControl = {
  /** Non-null only while a prompt should be visible. */
  overlayConflict: CloudTerminalFitConflict | null
  autoRestoreText: string | null
  pending: boolean
  onFitOverrideEvent: (event: unknown) => void
  onTakeOver: () => Promise<void>
  onKeep: () => void
}

type Viewport = { cols: number; rows: number }

export function useCloudTerminalFitControl(args: {
  rpc: CloudRpc
  active: boolean
  live: boolean
  clientId: string
  handleRef: { readonly current: string | null }
  termRef: { readonly current: Viewport | null }
}): CloudTerminalFitControl {
  const { rpc, active, live, clientId, handleRef, termRef } = args
  const [mode, setMode] = React.useState<CloudTerminalFitMode | null>(null)
  const [dismissedMode, setDismissedMode] = React.useState<CloudTerminalFitMode | null>(null)
  const [pending, setPending] = React.useState(false)
  // undefined = not asked yet; null = the host's global preference is Indefinite.
  const [autoRestoreMs, setAutoRestoreMs] = React.useState<number | null | undefined>(undefined)
  const autoRestoreAskedRef = React.useRef(false)

  const conflict = cloudTerminalFitConflictOf(mode)

  // Ask once, when a conflict first surfaces: the prompt then says whether the
  // host will restore on its own. An older host refusing leaves the text absent.
  React.useEffect(() => {
    if (!active || conflict === null || autoRestoreAskedRef.current) {
      return
    }
    autoRestoreAskedRef.current = true
    void rpc('terminal.getAutoRestoreFit', {}).then((outcome) => {
      if (outcome.ok) {
        setAutoRestoreMs(readNumber(outcome.result, 'ms'))
      }
    })
  }, [active, conflict, rpc])

  const onFitOverrideEvent = React.useCallback((event: unknown): void => {
    const parsed = parseCloudFitOverrideEvent(event)
    if (parsed !== null) {
      setMode(parsed.mode)
    }
  }, [])

  const onTakeOver = React.useCallback(async (): Promise<void> => {
    const viewport = termRef.current
    const handle = handleRef.current
    if (viewport === null || handle === null || conflict === null) {
      return
    }
    setPending(true)
    try {
      const outcome =
        conflict === 'remote-desktop'
          ? await rpc('terminal.updateViewport', {
              terminal: handle,
              client: { id: clientId, type: 'desktop' },
              viewport,
              claim: true
            })
          : await rpc('terminal.restoreFit', { terminal: handle })
      if (outcome.ok) {
        setMode(null)
      }
    } finally {
      setPending(false)
    }
  }, [conflict, rpc, clientId, handleRef, termRef])

  const onKeep = React.useCallback((): void => {
    // Same holder, same prompt: only a different mode re-asks (design §3.3.4).
    setDismissedMode(mode)
  }, [mode])

  const visible = active && live && conflict !== null && dismissedMode !== mode
  return {
    overlayConflict: visible ? conflict : null,
    autoRestoreText: autoRestoreMs === undefined ? null : describeAutoRestoreFit(autoRestoreMs),
    pending,
    onFitOverrideEvent,
    onTakeOver,
    onKeep
  }
}
