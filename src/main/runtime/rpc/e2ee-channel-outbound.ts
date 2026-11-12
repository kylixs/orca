import type { WebSocket } from 'ws'
import type { EventProps } from '../../../shared/telemetry-events'
import { track } from '../../telemetry/client'
import type { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'
import { isMobileE2EEOutboundItemWithinLimit } from './mobile-e2ee-outbound-admission'
import type { DesktopMobileE2EEV2OutboundItem } from './mobile-e2ee-v2-desktop-outbound'
import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'

type OutboundBudgetEmitter = EventProps<'remote_outbound_budget_close'>['emitter']

/** Outbound v2 queueing and the budget close, kept out of the channel class. */
export function enqueueE2EEV2Item(
  outbound: MobileE2EEDesktopOutboundOwner,
  session: DesktopMobileE2EEV2Session | null,
  ws: WebSocket,
  item: DesktopMobileE2EEV2OutboundItem,
  onBudget: (emitter: OutboundBudgetEmitter) => void
): boolean {
  if (!session || ws.readyState !== ws.OPEN) {
    return false
  }
  if (!isMobileE2EEOutboundItemWithinLimit(item)) {
    onBudget('size')
    return false
  }
  return outbound.enqueueV2(item, session, () => onBudget('queue'))
}

// Why: this close kills the whole remote session. `size` means a producer emitted something
// too big and should fall to zero once producers cap themselves; `queue` means a backed-up link.
export function closeE2EEOutboundBudget(
  onError: (code: number, reason: string) => void,
  emitter: OutboundBudgetEmitter
): void {
  try {
    track('remote_outbound_budget_close', { emitter })
  } catch {
    // Telemetry is best-effort; closing the unsafe socket remains authoritative.
  }
  onError(1013, 'Outbound reply buffer overflow')
}
