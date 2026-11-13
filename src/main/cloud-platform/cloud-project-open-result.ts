import type {
  CloudConnectDiagnostics,
  CloudEndpointProbe,
  CloudOpenResult
} from '../../shared/cloud-platform-ipc'
import type { ProvisionCloudProjectResult } from '../../shared/cloud-workspace-open'
import type { CloudConnectTicket } from './cloud-connect-client'
import { hostKeyDetails } from './cloud-host-key-guard'

/** One open attempt's result, with the fields the workspace view needs (AC-29 included). */
export function openedCloudProject(
  projectId: string,
  connection: { route: 'direct' | 'relay' },
  ticket: CloudConnectTicket,
  hostFingerprint: string | null
): CloudOpenResult {
  return {
    ok: true,
    projectId,
    route: connection.route,
    workspaceRoot: ticket.workspace.workspaceRoot,
    capabilities: ticket.host.capabilities,
    ...(hostFingerprint ? { hostFingerprint } : {})
  }
}

export function failedCloudOpen(code: string, error: unknown): CloudOpenResult {
  return {
    ok: false,
    code,
    message: error instanceof Error ? error.message : String(error),
    ...hostKeyDetails(error),
    ...connectDiagnostics(error)
  }
}

/** `ENDPOINT_UNREACHABLE` carries the probe log; nothing else does (AC-07). */
function connectDiagnostics(error: unknown): { connectDiagnostics?: CloudConnectDiagnostics } {
  const probes =
    error === null || typeof error !== 'object' ? undefined : Reflect.get(error, 'probes')
  if (!Array.isArray(probes) || probes.length === 0) {
    return {}
  }
  const valid = probes.filter(
    (probe): probe is CloudEndpointProbe =>
      probe !== null &&
      typeof probe === 'object' &&
      typeof Reflect.get(probe, 'endpoint') === 'string' &&
      typeof Reflect.get(probe, 'ok') === 'boolean' &&
      typeof Reflect.get(probe, 'elapsedMs') === 'number' &&
      (Reflect.get(probe, 'route') === 'direct' || Reflect.get(probe, 'route') === 'relay')
  )
  // Why all-or-nothing: a partial list would show a diagnosis that is missing the step that failed.
  return valid.length === probes.length ? { connectDiagnostics: { probes: valid } } : {}
}

export async function openCloudProject(
  plan: {
    open: (
      projectId: string
    ) => Promise<{ connection: { route: 'direct' | 'relay' }; ticket: CloudConnectTicket }>
    pinnedFingerprint: (hostId: string) => string | null
    failureCode: (error: unknown) => string
  },
  projectId: string
): Promise<CloudOpenResult> {
  try {
    const { connection, ticket } = await plan.open(projectId)
    return openedCloudProject(projectId, connection, ticket, plan.pinnedFingerprint(ticket.host.id))
  } catch (error) {
    return failedCloudOpen(plan.failureCode(error), error)
  }
}

export function failedProvision(code: string, error: unknown): ProvisionCloudProjectResult {
  return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
}
