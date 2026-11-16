import { readArrayValue, readField, readObjectValue, readString } from './json-fields'

/**
 * `workspace.info` response (W13): the ticket's own project/workspace facts plus
 * the checkout the host found inside the workspace root. The field set is the
 * information boundary — an extra key would leak host-wide state to the session.
 * `capabilities` is the one explicit extension: names only, no host facts.
 */

/** Host capabilities this response can advertise (U96 A). */
export const CLOUD_SESSION_TABS_RESTORE_CAPABILITY = 'cloud.session-tabs-restore.v1'

/** The permissions a platform ticket can carry; the host's CloudPermission twin. */
export type CloudWorkspacePermission =
  | 'open'
  | 'terminal'
  | 'agent'
  | 'file:read'
  | 'file:write'
  | 'browser'
  | 'download'

export type CloudWorkspaceInfo = {
  project: {
    /** Platform project id. */
    id: string
    /** The ticket's project root: this session's read boundary. */
    root: string
    /** Clone source; '' on tickets minted before project provisioning existed. */
    repoUrl: string
    /** Branch the client's ensure step checks out; '' when the ticket names none. */
    defaultBranch: string
  }
  workspace: {
    /** This user's checkout root for the project (the write boundary). */
    root: string
    /** Existing checkout path; null = not ensured yet, the normal first-open state. */
    path: string | null
    /** That checkout's branch; null when nothing is ensured or git could not tell. */
    branch: string | null
  }
  perms: readonly CloudWorkspacePermission[]
  /** Optional additive capability names (U96 A); absent on hosts that predate them. */
  capabilities?: readonly string[]
}

/** The only failure shape: the caller is not a cloud session. */
export type CloudWorkspaceInfoFailure = {
  ok: false
  code: 'CLOUD_SESSION_REQUIRED'
  message: string
}

export type CloudWorkspaceInfoResponse = CloudWorkspaceInfo | CloudWorkspaceInfoFailure

const PERMISSIONS: ReadonlySet<string> = new Set<string>([
  'open',
  'terminal',
  'agent',
  'file:read',
  'file:write',
  'browser',
  'download'
])

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value : undefined
}

/**
 * Shape-checked read of a `workspace.info` reply for host, web and tests: null
 * unless every documented field is present, with unknown permission values
 * dropped rather than poisoning the whole answer.
 */
export function readCloudWorkspaceInfo(value: unknown): CloudWorkspaceInfo | null {
  const response = readObjectValue(value)
  if (response === null) {
    return null
  }
  const project = readObjectValue(readField(response, 'project'))
  const workspace = readObjectValue(readField(response, 'workspace'))
  const perms = readArrayValue(readField(response, 'perms'))
  if (project === null || workspace === null || perms === null) {
    return null
  }
  const id = readString(project, 'id')
  const root = readString(project, 'root')
  const repoUrl = readString(project, 'repoUrl')
  const defaultBranch = readString(project, 'defaultBranch')
  const workspaceRoot = readString(workspace, 'root')
  // path/branch are `string | null` by contract, so null is a value here — only
  // an absent or mistyped field (undefined) breaks the shape.
  const path = nullableString(readField(workspace, 'path'))
  const branch = nullableString(readField(workspace, 'branch'))
  if (
    id === null ||
    root === null ||
    repoUrl === null ||
    defaultBranch === null ||
    workspaceRoot === null ||
    path === undefined ||
    branch === undefined
  ) {
    return null
  }
  // Why: an old host omits the field and a malformed one must not void the answer.
  const capabilities = readArrayValue(readField(response, 'capabilities'))
  return {
    project: { id, root, repoUrl, defaultBranch },
    workspace: { root: workspaceRoot, path, branch },
    perms: perms.filter(
      (permission): permission is CloudWorkspacePermission =>
        typeof permission === 'string' && PERMISSIONS.has(permission)
    ),
    ...(capabilities === null
      ? {}
      : { capabilities: capabilities.filter((name): name is string => typeof name === 'string') })
  }
}
