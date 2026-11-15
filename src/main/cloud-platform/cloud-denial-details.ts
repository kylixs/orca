import { cloudMethodAccess } from './cloud-rpc-permission'
import type { CloudPermission } from './cloud-credential'

/**
 * Machine-readable denial reasons the CLI and clients can branch on.
 *
 * The top-level RPC `code` stays `forbidden` for wire compatibility (shipped
 * clients read it as "this host refused"), so the precise reason travels in
 * `error.data` — the vocabulary the platform documentation and the simulator use.
 */

export type CloudDenialCode =
  | 'PATH_OUTSIDE_ROOT'
  | 'PERMISSION_MISSING'
  | 'METHOD_NOT_AVAILABLE'
  | 'DOWNLOAD_DISABLED'

export type CloudDenialDetails = {
  denial: CloudDenialCode
  /** The guard's own reason (`workspace_scope`, `project_scope`, …) when it has one. */
  reason?: string
  permission?: CloudPermission
}

/** Every path verdict is a boundary verdict: the path resolution simply did not land inside a root. */
export function pathDenialDetails(reason: string): CloudDenialDetails {
  return { denial: 'PATH_OUTSIDE_ROOT', reason }
}

export function methodDenialDetails(
  scope: { permissions: readonly CloudPermission[]; downloadAllowed: boolean },
  methodName: string
): CloudDenialDetails | null {
  const access = cloudMethodAccess(methodName)
  if (access === 'session') {
    return null
  }
  if (access === null) {
    return { denial: 'METHOD_NOT_AVAILABLE' }
  }
  if (!scope.permissions.includes(access)) {
    return { denial: 'PERMISSION_MISSING', permission: access }
  }
  if (access === 'download' && !scope.downloadAllowed) {
    return { denial: 'DOWNLOAD_DISABLED', permission: access }
  }
  return null
}

/**
 * U66 phase 2: the readChunk rebuild refusal uses the L1 vocabulary — a ticket
 * without the `download` bit is a missing permission, a policy refusal stays
 * `DOWNLOAD_DISABLED`.
 */
export function downloadRebuildDenialDetails(hasDownloadPermission: boolean): CloudDenialDetails {
  return hasDownloadPermission
    ? { denial: 'DOWNLOAD_DISABLED', permission: 'download' }
    : { denial: 'PERMISSION_MISSING', permission: 'download' }
}
