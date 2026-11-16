import { selectCloudInitialWorktreeId } from '../../../shared/cloud-initial-worktree'
import { readCloudWorkspaceInfo } from '../../../shared/cloud-workspace-info'
import type { CloudWorkspaceInfo } from '../../../shared/cloud-workspace-info'
import type {
  CloudWorkspaceRoots,
  OpenCloudWorkspaceResult
} from '../../../shared/cloud-workspace-open'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { readObjectValue, readString } from '../../../shared/json-fields'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  cloudWorkspaceProjectDisplayName,
  defaultWebCloudWorkspacePorts,
  type WebCloudWorkspaceBootstrapPorts
} from './web-cloud-workspace-store-ports'
import {
  clearWebCloudSessionCapabilities,
  recordWebCloudSessionCapabilities,
  shouldMirrorCloudSessionTabs
} from './web-cloud-session-capabilities'
import {
  HYDRATION_SETTLE_TIMEOUT_MS,
  reassertActivationAfterLateHydration,
  waitForHydrationSettled
} from './web-cloud-workspace-hydration-settle'
import { IDLE, type WebCloudWorkspaceBootstrapStatus } from './web-cloud-workspace-bootstrap-status'

export type {
  WebCloudWorkspaceBootstrapPhase,
  WebCloudWorkspaceBootstrapStatus
} from './web-cloud-workspace-bootstrap-status'

/**
 * The cloud session's workspace bootstrap (W13 design §4): `workspace.info` →
 * register the project as the native sidebar repo row (`repo.add`, pinned by the
 * host to the ticket's project root) → the shared ensure flow
 * (`project.provision` / `worktree.list` / `worktree.createManaged`,
 * idempotency-keyed) → activate the checkout. Everything runs over the one
 * admitted connection, and every failure lands in the sidebar's cloud card
 * instead of degrading the W7c startup chain.
 *
 * Why the row comes first: the desktop cloud entry registers its rows before
 * opening (`cloud-entry-workspace-sync.ts`), because `worktree.list` and
 * `worktree.createManaged` resolve their repo-scoped guard through the host's
 * registered `path:<projectRoot>` row — a web session is the first opener, so
 * nothing else has created it.
 */

let status: WebCloudWorkspaceBootstrapStatus = IDLE
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null
let activePorts: WebCloudWorkspaceBootstrapPorts | null = null
let stopTransportWatch: (() => void) | null = null
let transportReconnectedSinceSettle = false

function setStatus(next: WebCloudWorkspaceBootstrapStatus): void {
  status = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Per-page dedup with one reconnect allowance: a cloud ticket's main socket
 * normally never returns, but a transport that drops and comes back may re-run
 * the (idempotent) bootstrap instead of leaving a stale fallback up.
 */
function watchTransport(ports: WebCloudWorkspaceBootstrapPorts): void {
  let sawDisconnect = false
  stopTransportWatch = ports.subscribeTransport((transport) => {
    if (transport === 'disconnected') {
      sawDisconnect = true
      return
    }
    if (transport === 'ready' && sawDisconnect) {
      sawDisconnect = false
      transportReconnectedSinceSettle = true
    }
  })
}

function fallback(args: {
  reason: NonNullable<WebCloudWorkspaceBootstrapStatus['fallbackReason']>
  detail?: string | null
  retryable?: boolean
  terminalNotGranted?: boolean
}): void {
  setStatus({
    phase: 'fallback',
    fallbackReason: args.reason,
    fallbackDetail: args.detail ?? null,
    retryable: args.retryable ?? false,
    terminalNotGranted: args.terminalNotGranted ?? false
  })
}

async function runBootstrap(
  ports: WebCloudWorkspaceBootstrapPorts,
  isCancelled: () => boolean,
  hydrationSettleTimeoutMs: number
): Promise<void> {
  try {
    setStatus({ ...IDLE, phase: 'loading' })
    const api = ports.api()
    if (api === null) {
      fallback({ reason: 'unavailable' })
      return
    }
    const response: unknown = await api.info()
    const info: CloudWorkspaceInfo | null = readCloudWorkspaceInfo(response)
    if (isCancelled()) {
      return
    }
    if (info === null) {
      // Why clear: the host refused to describe itself, so a record from an earlier pairing must
      // not keep authorizing the restore family for whatever host answers now (U113/D4).
      const environmentId = ports.environment()?.id
      if (environmentId) {
        clearWebCloudSessionCapabilities(environmentId)
      }
      // A shape-checked read fails on the host's refusal reply and on anything
      // malformed; a host predating the method throws instead (handled below).
      const refusal = readObjectValue(response)
      fallback({
        reason: 'failed',
        detail:
          (refusal === null ? null : readString(refusal, 'message')) ??
          'The host did not describe this session’s workspace.',
        retryable: false
      })
      return
    }
    const environment = ports.environment()
    if (environment === null) {
      fallback({ reason: 'unavailable' })
      return
    }
    // Why here: every admitted cloud session runs this one self-description call, so an old
    // host's absent field reads as "unsupported" and the mirror keeps its cloud skip.
    recordWebCloudSessionCapabilities(environment.id, info.capabilities ?? [])
    const executionHostId = toRuntimeExecutionHostId(environment.id)
    const terminalGranted = info.perms.includes('terminal')
    // §4.3: the explorer is a file-tree surface, so it mounts only on a read
    // grant — without one its mounts would fire refused file RPCs.
    const fileReadGranted = info.perms.includes('file:read')

    // Why wait: hydrateWorkspaceSession rewrites activeWorktreeId and the tab map
    // from the persisted session, so state written before it would be silently cleared.
    const hydrationSettledBeforeActivation = await waitForHydrationSettled(
      ports,
      isCancelled,
      hydrationSettleTimeoutMs
    )
    if (isCancelled()) {
      return
    }

    setStatus({
      ...IDLE,
      phase: 'registering',
      terminalNotGranted: !terminalGranted
    })
    const repo = await ports.ensureRepoRow({
      path: info.project.root,
      displayName: cloudWorkspaceProjectDisplayName(environment.name, info.project.root),
      runtimeEnvironmentId: environment.id
    })
    if (isCancelled()) {
      return
    }
    if (repo === null) {
      fallback({
        reason: 'failed',
        detail: 'The host refused to register the project.',
        retryable: true
      })
      return
    }

    let workspacePath: string | null = info.workspace.path
    if (terminalGranted) {
      setStatus({ ...IDLE, phase: 'ensuring' })
      const roots: CloudWorkspaceRoots = {
        projectRoot: info.project.root,
        workspaceRoot: info.workspace.root,
        defaultBranch: info.project.defaultBranch
      }
      const opened: OpenCloudWorkspaceResult = await api.ensure({
        projectId: info.project.id,
        roots
      })
      if (isCancelled()) {
        return
      }
      if (!opened.ok) {
        fallback({
          reason: 'failed',
          detail: opened.message ?? opened.code,
          retryable: true
        })
        return
      }
      workspacePath = opened.workspacePath
    } else {
      // Open-only ticket: the row registers, no workspace may be driven (§4.3);
      // a stale checkout is not one this session may open either.
      setStatus({ ...IDLE, phase: 'done', terminalNotGranted: true })
      return
    }

    setStatus({ ...IDLE, phase: 'activating' })
    await ports.fetchWorktrees(repo.id, executionHostId)
    if (isCancelled()) {
      return
    }
    const worktreeId = selectCloudInitialWorktreeId({
      workspacePath,
      repo,
      worktrees: ports.worktreesForRepo(repo.id)
    })
    if (worktreeId === null) {
      fallback({
        reason: 'failed',
        detail: 'The checkout was not in the workspace catalog yet.',
        retryable: true
      })
      return
    }
    // Why: a restoring host publishes the session's tabs; seeding before that
    // lands would add a terminal the user never opened. Legacy hosts advertise
    // no capability and keep the immediate fallback.
    if (shouldMirrorCloudSessionTabs(environment.id)) {
      await ports.waitForSessionTabsRestore({
        environmentId: environment.id,
        worktreeId
      })
      if (isCancelled()) {
        return
      }
    }
    ports.activateWorkspace({
      worktreeId,
      executionHostId,
      mountExplorer: fileReadGranted
    })
    setStatus({ ...IDLE, phase: 'done' })
    reassertActivationAfterLateHydration({
      ports,
      isCancelled,
      hydrationSettledBeforeActivation,
      hydrationSettleTimeoutMs,
      activation: { worktreeId, executionHostId, mountExplorer: fileReadGranted }
    })
  } catch (error) {
    if (!isCancelled()) {
      // A host predating the method answers method_not_found; that is permanent,
      // while every other failure is worth one idempotent retry.
      const legacyHost = hasRuntimeRpcErrorCode(error, 'method_not_found')
      const environmentId = ports.environment()?.id
      if (environmentId) {
        // Why a failed probe clears: an old host's `method_not_found` proves no `workspace.info`
        // consent exists, so a stale record must not re-enable the restore family (U113/D4).
        clearWebCloudSessionCapabilities(environmentId)
      }
      fallback({
        reason: legacyHost ? 'unsupported-host' : 'failed',
        detail: error instanceof Error ? error.message : String(error),
        retryable: !legacyHost
      })
    }
  }
}

async function launch(
  ports: WebCloudWorkspaceBootstrapPorts,
  args: {
    force: boolean
    isCancelled: () => boolean
    hydrationSettleTimeoutMs?: number
  }
): Promise<void> {
  if (activePorts === null) {
    activePorts = ports
    watchTransport(ports)
  }
  if (inFlight !== null) {
    return inFlight
  }
  const settled = status.phase === 'done' || status.phase === 'fallback'
  if (settled && !args.force && !transportReconnectedSinceSettle) {
    return
  }
  transportReconnectedSinceSettle = false
  inFlight = runBootstrap(
    activePorts,
    args.isCancelled,
    args.hydrationSettleTimeoutMs ?? HYDRATION_SETTLE_TIMEOUT_MS
  ).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Entry point the startup chain calls once per page; concurrent calls share one run. */
export function startWebCloudWorkspaceBootstrap(): Promise<void> {
  return launch(defaultWebCloudWorkspacePorts(), {
    force: false,
    isCancelled: () => false
  })
}

/** Test seam: the same launch against injected ports (a short settle window keeps the deadline test fast). */
export function startWebCloudWorkspaceBootstrapForTests(
  ports: WebCloudWorkspaceBootstrapPorts,
  options?: { hydrationSettleTimeoutMs?: number }
): Promise<void> {
  return launch(ports, { force: false, isCancelled: () => false, ...options })
}

/** The cloud card's retry: rerun ensure + seeding, which the host deduplicates. */
export function retryWebCloudWorkspaceBootstrap(): Promise<void> {
  return launch(activePorts ?? defaultWebCloudWorkspacePorts(), {
    force: true,
    isCancelled: () => false
  })
}

export function readWebCloudWorkspaceBootstrapStatus(): WebCloudWorkspaceBootstrapStatus {
  return status
}

export function subscribeToWebCloudWorkspaceBootstrap(listener: () => void): () => void {
  return subscribe(listener)
}

/** Test seam: drops the run memory so a suite starts from `idle`. */
export function resetWebCloudWorkspaceBootstrap(): void {
  inFlight = null
  activePorts = null
  stopTransportWatch?.()
  stopTransportWatch = null
  transportReconnectedSinceSettle = false
  setStatus(IDLE)
}
