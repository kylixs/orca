import { useCallback, useEffect, useRef, useState } from 'react'
import { errorCodeOf, readField } from '../../../shared/json-fields'
import type {
  CloudConnectionEvent,
  CloudOpenResult,
  CloudProjectSummary,
  CloudRpcOutcome,
  CloudSessionState
} from '../../../shared/cloud-platform-ipc'

/**
 * Renderer-side cloud session state.
 *
 * The bridge is `window.api.cloud`; it is injected here so the hook can be
 * exercised headlessly (and so the UI has one place to learn it is unavailable).
 */

export type CloudBridge = {
  login: (username: string, password: string) => Promise<CloudSessionState>
  openWorkspace: (projectId: string) => Promise<CloudOpenResult>
  closeProject: () => Promise<{ ok: boolean }>
  logout: () => Promise<CloudSessionState>
  getState: () => Promise<CloudSessionState>
  listProjects: () => Promise<CloudProjectSummary[]>
  openProject: (projectId: string) => Promise<CloudOpenResult>
  rpc: (method: string, params?: Record<string, unknown>) => Promise<CloudRpcOutcome>
  onConnectionChanged: (listener: (event: CloudConnectionEvent) => void) => () => void
}

export type CloudOpenedProject = {
  projectId: string
  workspaceRoot: string
  capabilities: string[]
  route: 'direct' | 'relay'
  /** Runtime environment panes address; absent when registration was skipped. */
  environmentId?: string
}

export type CloudSessionView = {
  status: 'loading' | 'unavailable' | 'signed-out' | 'signing-in' | 'signed-in' | 'error'
  displayName: string | null
  projects: CloudProjectSummary[]
  /** Project currently open over the cloud link, if any. */
  openProjectId: string | null
  /** What the workspace view needs about the open project. */
  opened: CloudOpenedProject | null
  route: 'direct' | 'relay' | null
  /** Set when the host closed the socket (revocation, maintenance, network). */
  notice: { code: number | null; reason: string | null } | null
  error: string | null
  signIn: (username: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  openProject: (projectId: string) => Promise<CloudOpenResult | null>
  closeProject: () => Promise<void>
}

function isCloudState(value: unknown): value is CloudSessionState {
  const status = readField(value, 'status')
  return status === 'signed-out' || status === 'signed-in'
}

export function useCloudSession(bridge: CloudBridge | null | undefined): CloudSessionView {
  const [status, setStatus] = useState<CloudSessionView['status']>('loading')
  const [displayName, setDisplayName] = useState<string | null>(null)
  const [projects, setProjects] = useState<CloudProjectSummary[]>([])
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const [opened, setOpened] = useState<CloudOpenedProject | null>(null)
  const [route, setRoute] = useState<'direct' | 'relay' | null>(null)
  const [notice, setNotice] = useState<CloudSessionView['notice']>(null)
  const [error, setError] = useState<string | null>(null)
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
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [applyState])

  const signIn = useCallback(
    async (username: string, password: string) => {
      const active = bridgeRef.current
      if (!active) {
        return
      }
      setStatus('signing-in')
      setError(null)
      setNotice(null)
      try {
        applyState(await active.login(username, password))
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

  const openProject = useCallback(async (projectId: string) => {
    const active = bridgeRef.current
    if (!active) {
      return null
    }
    setError(null)
    const result = await active.openWorkspace(projectId)
    if (result.ok) {
      setOpenProjectId(result.projectId)
      setOpened({
        projectId: result.projectId,
        workspaceRoot: result.workspaceRoot,
        capabilities: result.capabilities,
        route: result.route,
        ...(result.environmentId ? { environmentId: result.environmentId } : {})
      })
      setRoute(result.route)
      setStatus('signed-in')
    } else {
      setError(result.code)
    }
    return result
  }, [])

  const closeProject = useCallback(async () => {
    const active = bridgeRef.current
    if (!active) {
      return
    }
    await active.closeProject()
    setOpenProjectId(null)
    setOpened(null)
    setRoute(null)
    setError(null)
    setNotice(null)
  }, [])

  return {
    status,
    displayName,
    projects,
    openProjectId,
    opened,
    route,
    notice,
    error,
    signIn,
    signOut,
    openProject,
    closeProject
  }
}
