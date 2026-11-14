import { createCloudAccessGuard } from '../cloud-platform/cloud-access-guard'
import type { CloudAgentClient } from '../cloud-platform/cloud-agent-client'
import { createCloudProvisionAssignmentExecutor } from '../cloud-platform/cloud-provision-assignment'
import { installCloudPlatformIpc } from '../ipc/cloud-platform'
import type { CloudRuntimeAdmission, CloudRuntimeTarget } from './cloud-runtime-admission'

/**
 * Post-start wiring of a runtime to the cloud client: the renderer IPC surface,
 * revocation → live sockets, the download/read-budget guard, and the heartbeat
 * reporters. Split from the admission lifecycle so `attachCloudRuntime` stays a
 * single call on the launch path.
 */

/** Installs the policy/read-budget guard; the client's snapshot is read per call. */
export function installCloudAccessGuard(
  runtime: Pick<CloudRuntimeTarget, 'setCloudAccessGuard'>,
  client: Pick<CloudAgentClient, 'snapshot'>
): void {
  // Why resolve per call: a policy change must reach existing sessions, and the
  // snapshot is refreshed on the heartbeat timer.
  runtime.setCloudAccessGuard?.(
    createCloudAccessGuard(() => ({ policies: client.snapshot().policies }))
  )
}

/** What installing the surfaces needs from the client; narrow so stubs can drive it. */
type CloudSurfacesClient = Pick<
  CloudAgentClient,
  'snapshot' | 'reportProvisioned' | 'reportAudit' | 'onProvisionAssignment'
>

/** The slice of an admission `attach` consumes; `CloudRuntimeAdmission` satisfies it. */
export type AttachableCloudAdmission = {
  bindRuntime: CloudRuntimeAdmission['bindRuntime']
  /** Null while first-start enrolment is still in flight. */
  client: CloudSurfacesClient | null
  ready: Promise<void>
}

/** Everything the runtime needs from the live cloud client (W12 §2-B). */
function installRuntimeCloudSurfaces(
  runtime: CloudRuntimeTarget,
  client: CloudSurfacesClient
): void {
  installCloudAccessGuard(runtime, client)
  runtime.setCloudProvisionReporter?.((report) => client.reportProvisioned(report))
  runtime.setCloudHostAudit?.((event) => client.reportAudit(event))
  // U37: assignments are cloned outside any ticket, so a repo-ful project can
  // reach `ready` without a first `/connect`. Same install point as the reporter,
  // so the W12b-2 first-start timing fix covers the executor too.
  client.onProvisionAssignment(
    createCloudProvisionAssignmentExecutor({
      provision: runtime.provisionCloudProject?.bind(runtime) ?? null,
      report: (report) => client.reportProvisioned(report),
      inMaintenance: () => client.snapshot().maintenance !== null
    })
  )
}

/**
 * Injectable core of `attachCloudRuntime`: binds revocations and installs the
 * access guard plus the provision/audit reporters.
 *
 * A first start enrols over the network, so the client does not exist yet when
 * the RPC server is constructed and attached; the wiring then follows `ready`.
 * Skipping it there left enrolled hosts permanently without a provision reporter
 * (the platform never saw `failed`) and without the download guard.
 */
export function attachRuntimeToCloudAdmission(
  runtime: CloudRuntimeTarget,
  admission: AttachableCloudAdmission | null
): void {
  if (!admission) {
    installCloudPlatformIpc()
    return
  }
  admission.bindRuntime(runtime)
  if (admission.client) {
    // Poll mode and a restart that reads the stored credential both have the
    // client already: install now, exactly as before.
    installRuntimeCloudSurfaces(runtime, admission.client)
  } else {
    // Why the rejection handler: no launch-path consumer awaits `ready`, and the
    // not-enrolled admission refuses every upgrade anyway, so this log line is
    // the failure's only trace.
    void admission.ready.then(
      () => {
        const client = admission.client
        if (client) {
          installRuntimeCloudSurfaces(runtime, client)
        }
      },
      (error: unknown) => console.error('[cloud] host enrolment failed:', error)
    )
  }
  installCloudPlatformIpc()
}
