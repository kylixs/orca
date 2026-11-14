import { useCallback, useEffect, useRef, useState } from 'react'
import { errorCodeOf, readField } from '../../../shared/json-fields'
import type * as cloudSubscription from './cloud-browser-bridge-subscription'
import type {
  CloudArchiveProjectResult,
  CloudConnectionEvent,
  CloudCreateProjectInput,
  CloudCreateProjectResult,
  CloudLoginContext,
  CloudOpenResult,
  CloudProjectRegistration,
  CloudProjectSummary,
  CloudProjectPermission,
  CloudProvisionableHost,
  CloudRetryPrepareResult,
  CloudConnectDiagnostics,
  CloudHostKeyMismatch,
  CloudRpcOutcome,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'

export type * from './cloud-browser-bridge-subscription'

/**
 * Renderer-side cloud session state.
 *
 * The bridge is `window.api.cloud`; it is injected here so the hook can be
 * exercised headlessly (and so the UI has one place to learn it is unavailable).
 */

export type CloudBridge = {
  login: (username: string, password: string, platformUrl?: string) => Promise<CloudSessionState>
  /** Address and username the login form prefills (M119/W10). */
  getLoginContext: () => Promise<CloudLoginContext | null>
  openWorkspace: (projectId: string) => Promise<CloudOpenResult>
  registerProjects: () => Promise<CloudProjectRegistration>
  retryPrepare: (projectId: string) => Promise<CloudRetryPrepareResult>
  createProject: (input: CloudCreateProjectInput) => Promise<CloudCreateProjectResult>
  archiveProject: (projectId: string) => Promise<CloudArchiveProjectResult>
  listProvisionableHosts: () => Promise<CloudProvisionableHost[]>
  closeProject: (projectId: string) => Promise<{ ok: boolean }>
  /**
   * Absent in the browser bridge: that path has no host-key pinning yet, so it
   * can neither detect nor re-verify a changed key (documented gap, M81).
   */
  trustHostKey?: (hostId: string) => Promise<{ ok: true } | { ok: false; code: string }>
  logout: () => Promise<CloudSessionState>
  getState: () => Promise<CloudSessionState>
  listProjects: () => Promise<CloudProjectSummary[]>
  openProject: (projectId: string) => Promise<CloudOpenResult>
  rpc: (
    method: string,
    params: Record<string, unknown>,
    projectId: string
  ) => Promise<CloudRpcOutcome>
  /** Streams one subscription over the project's live link; absent hides the terminal pane. */
  subscribe?: (
    projectId: string,
    method: string,
    params: Record<string, unknown>,
    callbacks: cloudSubscription.CloudSubscriptionCallbacks
  ) => Promise<cloudSubscription.CloudSubscribeOutcome>
  onConnectionChanged: (listener: (event: CloudConnectionEvent) => void) => () => void
}

export type CloudOpenedProject = {
  projectId: string
  /** The per-user parent directory the platform signs. */
  workspaceRoot: string
  /** The user's checkout inside it, created on first open if needed. */
  workspacePath?: string
  capabilities: string[]
  /** What the ticket grants; the host enforces it, the UI only hides panes. */
  permissions?: CloudProjectPermission[]
  route: 'direct' | 'relay'
  /** Runtime environment panes address; absent when registration was skipped. */
  environmentId?: string
  /** How the route was chosen (FR-5.7); absent when the reply predates it. */
  connectDiagnostics?: CloudConnectDiagnostics
}

export type CloudSessionView = {
  status: 'loading' | 'unavailable' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'
  displayName: string | null
  /** What the login form prefills; null until the bridge answers (or without one). */
  loginContext: CloudLoginContext | null
  projects: CloudProjectSummary[]
  /** Project currently open over the cloud link, if any. */
  openProjectId: string | null
  /** What the workspace view needs about the open project. */
  opened: CloudOpenedProject | null
  route: 'direct' | 'relay' | null
  /** Set when the host closed the socket (revocation, maintenance, network). */
  notice: { code: number | null; reason: string | null } | null
  error: string | null
  /**
   * Set when an open was refused because the host's key changed (AC-29); the UI
   * blocks on it until the user confirms or cancels.
   */
  hostKeyMismatch: (CloudHostKeyMismatch & { projectId: string }) | null
  /**
   * Set when every endpoint was unreachable (AC-07): the panel shows the code,
   * each probed address and a retry. Null for every other failure.
   */
  connectFailure: (CloudConnectDiagnostics & { code: string; projectId: string }) | null
  retryConnect: () => Promise<CloudOpenResult | null>
  dismissConnectFailure: () => void
  /** Pins the key the user just verified and retries the open. */
  confirmHostKey: () => Promise<CloudOpenResult | null>
  dismissHostKeyMismatch: () => void
  signIn: (username: string, password: string, platformUrl?: string) => Promise<void>
  signOut: () => Promise<void>
  openProject: (projectId: string) => Promise<CloudOpenResult | null>
  closeProject: (projectId: string) => Promise<void>
}

function isCloudState(value: unknown): value is CloudSessionState {
  const status = readField(value, 'status')
  return status === 'signed-out' || status === 'signed-in'
}

export function useCloudSession(bridge: CloudBridge | null | undefined): CloudSessionView {
  const [status, setStatus] = useState<CloudSessionView['status']>('loading')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [loginContext, setLoginContext] = useState<CloudLoginContext | null>(null)
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const [opened, setOpened] = useState<CloudOpenedProject | null>(null)
  const [route, setRoute] = useState<'direct' | 'relay' | null>(null)
  const [notice, setNotice] = useState<CloudSessionView['notice']>(null)
  const [error, setError] = useState<string | null>(null)
  const [hostKeyMismatch, setHostKeyMismatch] = useState<
    (CloudHostKeyMismatch & { projectId: string }) | null
  >(null)
  const [connectFailure, setConnectFailure] = useState<
    (CloudConnectDiagnostics & { code: string; projectId: string }) | null
  >(null)
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge

  const applyState = useCallback((next: CloudSessionState) => {
    if (next.status === 'signed-in') {
      setDisplayName(next.displayName)
      setProjects(next.projects)
      setStatus('signed-in')
      return
    }
    setDisplayName(null)
    setProjects([])
    setOpenProjectId(null)
    setOpened(null)
    setRoute(null)
    setStatus('signed-out')
  }, [])

  useEffect(() => {
    const active = bridgeRef.current
    if (!active) {
      // Not a cloud build: the UI must say so rather than showing a dead form.
      setStatus('unavailable')
      return
    }
    let cancelled = false
    // Why fire-and-forget: the prefill must never delay the session restore; a
    // failure just means the user types the address themselves.
    active
      .getLoginContext()
      .then((context) => {
        if (!cancelled && context) {
          setLoginContext(context)
        }
      })
      .catch(() => undefined)
    void active
      .getState()
      .then((state) => {
        if (!cancelled && isCloudState(state)) {
          applyState(state)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('signed-out')
        }
      })
    const unsubscribe = active.onConnectionChanged((event) => {
      if (event.closeCode !== null) {
        setOpenProjectId(null)
        setOpened(null)
        setRoute(null)
        setNotice({ code: event.closeCode, reason: event.reason })
      }
      if (event.reason === 'session_expired') {
        // Why re-read: main already signed out; trusting cached state would strand
        // the user on a workbench whose every action now fails.
        void active
          .getState()
          .then((state) => {
            if (!cancelled && isCloudState(state)) {
              applyState(state)
            }
          })
          .catch(() => {
            if (!cancelled) {
              applyState({ status: 'signed-out' })
            }
          })
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [applyState])

  const signIn = useCallback(
    async (username: string, password: string, platformUrl?: string) => {
      const active = bridgeRef.current
      if (!active) {
        return
      }
      setStatus('signing-in')
      setError(null)
      setNotice(null)
      try {
        applyState(await active.login(username, password, platformUrl))
      } catch (cause) {
        const code = errorCodeOf(cause) ?? (cause instanceof Error ? cause.message : '登录失败')
        setError(code)
        setStatus('signed-out')
      }
    },
    [applyState]
  )

  const signOut = useCallback(async () => {
    const active = bridgeRef.current
    if (!active) {
      return
    }
    applyState(await active.logout())
    setNotice(null)
  }, [applyState])

  const openProjectRef = useRef<(projectId: string) => Promise<CloudOpenResult | null>>(
    async () => null
  )

  const openProject = useCallback(async (projectId: string) => {
    const active = bridgeRef.current
    if (!active) {
      return null
    }
    setError(null)
    setConnectFailure(null)
    const result = await active.openWorkspace(projectId)
    if (result.ok) {
      setOpenProjectId(result.projectId)
      setOpened({
        projectId: result.projectId,
        workspaceRoot: result.workspaceRoot,
        ...(result.workspacePath ? { workspacePath: result.workspacePath } : {}),
        capabilities: result.capabilities,
        ...(result.permissions ? { permissions: result.permissions } : {}),
        route: result.route,
        ...(result.environmentId ? { environmentId: result.environmentId } : {}),
        ...(result.connectDiagnostics ? { connectDiagnostics: result.connectDiagnostics } : {})
      })
      setRoute(result.route)
      setStatus('signed-in')
    } else {
      setError(result.code)
      setHostKeyMismatch(result.hostKey ? { ...result.hostKey, projectId } : null)
      // Why only this code: other failures are explained by their own UI.
      setConnectFailure(
        result.code === 'ENDPOINT_UNREACHABLE' && result.connectDiagnostics
          ? { ...result.connectDiagnostics, code: result.code, projectId }
          : null
      )
    }
    return result
  }, [])

  /** The user re-verified a changed host key: pin it, then retry the same open. */
  const confirmHostKey = useCallback(async () => {
    const pending = hostKeyMismatch
    const active = bridgeRef.current
    if (!pending || !active) {
      return null
    }
    if (!active.trustHostKey) {
      setError('HOST_KEY_PINNING_UNSUPPORTED')
      return { ok: false as const, code: 'HOST_KEY_PINNING_UNSUPPORTED' }
    }
    const trusted = await active.trustHostKey(pending.hostId)
    if (!trusted.ok) {
      setError(trusted.code)
      return { ok: false as const, code: trusted.code }
    }
    setHostKeyMismatch(null)
    return openProjectRef.current(pending.projectId)
  }, [hostKeyMismatch])

  const dismissHostKeyMismatch = useCallback(() => setHostKeyMismatch(null), [])

  const retryConnect = useCallback(async () => {
    const pending = connectFailure
    if (!pending) {
      return null
    }
    return openProjectRef.current(pending.projectId)
  }, [connectFailure])

  const dismissConnectFailure = useCallback(() => setConnectFailure(null), [])

  openProjectRef.current = openProject

  const closeProject = useCallback(async (projectId: string) => {
    const active = bridgeRef.current
    if (!active) {
      return
    }
    await active.closeProject(projectId)
    setOpenProjectId(null)
    setOpened(null)
    setRoute(null)
    setError(null)
    setNotice(null)
  }, [])

  return {
    status,
    displayName,
    loginContext,
    projects,
    openProjectId,
    opened,
    route,
    notice,
    error,
    hostKeyMismatch,
    connectFailure,
    retryConnect,
    dismissConnectFailure,
    confirmHostKey,
    dismissHostKeyMismatch,
    signIn,
    signOut,
    openProject,
    closeProject
  }
}
