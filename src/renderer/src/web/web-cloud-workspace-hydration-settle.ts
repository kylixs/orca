import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WebCloudWorkspaceBootstrapPorts } from './web-cloud-workspace-store-ports'

/** The activation wait is a courtesy, not a gate; a degraded boot must not wedge the bootstrap. */
export const HYDRATION_SETTLE_TIMEOUT_MS = 30_000
const HYDRATION_SETTLE_POLL_MS = 100

export async function waitForHydrationSettled(
  ports: WebCloudWorkspaceBootstrapPorts,
  isCancelled: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!ports.hydrationSettled() && Date.now() < deadline) {
    if (isCancelled()) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, HYDRATION_SETTLE_POLL_MS))
  }
  return ports.hydrationSettled()
}

/**
 * Why: an over-budget hydration finishes after the courtesy deadline and rewrites
 * activeWorktreeId from a catalog that is still empty, dropping the workspace back to
 * the landing view; re-assert the activation once it lands (U124).
 */
export function reassertActivationAfterLateHydration(args: {
  ports: WebCloudWorkspaceBootstrapPorts
  isCancelled: () => boolean
  hydrationSettledBeforeActivation: boolean
  hydrationSettleTimeoutMs: number
  activation: { worktreeId: string; executionHostId: ExecutionHostId; mountExplorer: boolean }
}): void {
  if (args.hydrationSettledBeforeActivation) {
    return
  }
  void waitForHydrationSettled(args.ports, args.isCancelled, args.hydrationSettleTimeoutMs).then(
    (settled) => {
      if (settled && !args.isCancelled()) {
        args.ports.activateWorkspace(args.activation)
      }
    }
  )
}
