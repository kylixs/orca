import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { checkCloudTargetScope } from '../../../cloud-platform/cloud-path-boundary'
import type { RpcContext } from '../core'

type CloudFilterableInventory = {
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative?: true
}

/**
 * U96 A: a cloud ticket sees only worktrees inside its own workspaceRoot. Any
 * selector that cannot be resolved is dropped (fail-closed), and a ticket with
 * no root sees nothing rather than the host's whole inventory.
 */
export async function projectCloudSessionTabsInventory<T extends CloudFilterableInventory>(
  inventory: T,
  context: RpcContext
): Promise<T> {
  const cloud = context.cloud
  if (!cloud) {
    return inventory
  }
  if (cloud.workspaceRoot === '') {
    return { ...inventory, snapshots: [] }
  }
  const resolutions = new Map<string, Promise<string | null>>()
  const resolveRoot = (worktree: string): Promise<string | null> => {
    let pending = resolutions.get(worktree)
    if (!pending) {
      pending = context.runtime.resolveWorktreeRootPath(worktree).catch((): null => null)
      resolutions.set(worktree, pending)
    }
    return pending
  }
  const kept: RuntimeMobileSessionTabsResult[] = []
  for (const snapshot of inventory.snapshots) {
    const root = await resolveRoot(snapshot.worktree)
    if (root !== null && checkCloudTargetScope(cloud, 'write', root).ok) {
      kept.push(snapshot)
    }
  }
  return {
    ...inventory,
    snapshots: kept
  }
}
