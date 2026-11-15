import { openCloudWorkspaceOverRpc } from '../../../shared/cloud-workspace-open'
import type { CloudOpenResult } from '../../../shared/cloud-platform-ipc'
import { outcomeOf } from './cloud-browser-bridge-replies'
import type { BrowserProjectConnections } from './cloud-browser-project-connections'

/** The reply the workspace view consumes once a project's link is live. */
function openedResult(
  projectId: string,
  opened: Exclude<Awaited<ReturnType<BrowserProjectConnections['open']>>, CloudOpenResult>
): Extract<CloudOpenResult, { ok: true }> {
  return {
    ok: true,
    projectId,
    route: opened.route,
    workspaceRoot: opened.workspace.workspaceRoot,
    capabilities: opened.capabilities,
    ...(opened.permissions ? { permissions: opened.permissions } : {}),
    ...(opened.hostFingerprint ? { hostFingerprint: opened.hostFingerprint } : {})
  }
}

/** Connect only: enough for the viewer placeholder, no checkout is ensured. */
export async function openProjectOnConnection(
  connections: BrowserProjectConnections,
  projectId: string
): Promise<CloudOpenResult> {
  const opened = await connections.open(projectId)
  return 'ok' in opened ? opened : openedResult(projectId, opened)
}

/** Open plus ensure: the checkout the terminal and file panes address. */
export async function openWorkspaceOnConnection(
  connections: BrowserProjectConnections,
  projectId: string
): Promise<CloudOpenResult> {
  const opened = await connections.open(projectId)
  if ('ok' in opened) {
    return opened
  }
  const ensured = await openCloudWorkspaceOverRpc(
    async (method, params, timeoutMs) =>
      outcomeOf(await opened.client.call(method, params, { timeoutMs })),
    projectId,
    opened.workspace
  )
  if (!ensured.ok) {
    return ensured
  }
  return { ...openedResult(projectId, opened), workspacePath: ensured.workspacePath }
}
