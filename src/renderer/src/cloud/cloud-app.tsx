import * as React from 'react'
import { readField } from '../../../shared/json-fields'
import { CloudConnectFailureDialog } from './cloud-connect-failure-dialog'
import { CloudHostKeyDialog } from './cloud-host-key-dialog'
import { CloudLoginPanel } from './cloud-login-panel'
import { CloudProjectWorkspace, openedProjectSummary } from './cloud-project-workspace'
import { CloudWorkbench } from './cloud-workbench'
import {
  CLOUD_ADMIN_EMBED_READY_TIMEOUT_MS,
  cloudAdminHandoffFailureNotice,
  type CloudAdminEmbedEntry
} from './cloud-admin-embed'
import { useCloudSession, type CloudBridge, type CloudSessionView } from './use-cloud-session'

/** Where the console page lives, derived from the referrer when the browser reports it. */
function cloudAdminParentOrigin(): string | null {
  if (typeof document === 'undefined' || !document.referrer) {
    return null
  }
  try {
    return new URL(document.referrer).origin
  } catch {
    return null
  }
}

/**
 * iframe → parent (§4.2). The message carries route/latency/dirty only, never a
 * token or a path; the origin is the console's when the browser tells us, else
 * the documented `'*'` fallback.
 */
function postToCloudAdminParent(message: Record<string, unknown>): void {
  window.parent.postMessage(message, cloudAdminParentOrigin() ?? '*')
}

/** Parent → iframe is accepted only from the embedding window on the console origin. */
function isCloudAdminParentMessage(event: MessageEvent): boolean {
  if (event.source !== window.parent) {
    return false
  }
  const expected = cloudAdminParentOrigin()
  return expected === null || event.origin === expected
}

function CloudEmbedProgress({ error }: { error: string | null }): React.JSX.Element {
  if (error) {
    return (
      <div
        role="alert"
        data-testid="cloud-embed-open-failed"
        className="flex h-full items-center justify-center p-8 text-center text-sm text-destructive"
      >
        工作区打开失败（{error}）
      </div>
    )
  }
  return (
    <div
      data-testid="cloud-embed-entering"
      className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground"
    >
      正在进入项目工作区…
    </div>
  )
}

function CloudEmbedSessionMissing(): React.JSX.Element {
  return (
    <div
      data-testid="cloud-embed-unavailable"
      className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground"
    >
      嵌入会话不可用，请从管理台重新打开项目。
    </div>
  )
}

export type CloudAppProps = {
  bridge: CloudBridge | null
  /** U46-4: non-null when the console embeds this page (`?embed=1&project=<id>`). */
  embed?: CloudAdminEmbedEntry | null
  /** Test seam for the iframe → parent channel; defaults to `window.parent`. */
  postToParent?: (message: Record<string, unknown>) => void
}

/**
 * Entry point for cloud mode. `bridge` is `window.api.cloud`; passing null renders
 * the "not a cloud build" state instead of a login form that cannot work.
 */
export function CloudApp({
  bridge,
  embed = null,
  postToParent = postToCloudAdminParent
}: CloudAppProps): React.JSX.Element {
  const session = useCloudSession(bridge)
  const [confirmingKey, setConfirmingKey] = React.useState(false)
  const [embedTimedOut, setEmbedTimedOut] = React.useState(false)
  const embedStartedAt = React.useRef<number | null>(null)
  const handoffStarted = React.useRef(false)
  const autoOpenStarted = React.useRef(false)
  const readySent = React.useRef(false)

  const { signInWithHandoff, openProject, closeProject, signOut } = session
  const embedProjectId = embed?.projectId ?? null
  const handoffCode = embed?.handoffCode ?? null
  const embedActive = embedProjectId !== null && !embedTimedOut
  const embedHandoffFailed =
    embedActive && handoffCode !== null && session.status === 'signed-out' && session.error !== null

  React.useEffect(() => {
    embedStartedAt.current ??= Date.now()
  }, [])

  React.useEffect(() => {
    if (!handoffCode || !signInWithHandoff || handoffStarted.current) {
      return
    }
    handoffStarted.current = true
    void signInWithHandoff(handoffCode)
  }, [handoffCode, signInWithHandoff])

  // R9: a bundle that never reports ready must not trap the console overlay.
  React.useEffect(() => {
    if (embedProjectId === null) {
      return
    }
    const timer = setTimeout(() => {
      if (!readySent.current) {
        setEmbedTimedOut(true)
      }
    }, CLOUD_ADMIN_EMBED_READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [embedProjectId])

  // Idempotent auto-open: a rerender or a reconnected session must not add a
  // second open; a fresh mount (reload) starts from no open and opens once.
  React.useEffect(() => {
    if (!embedActive || embedProjectId === null || session.status !== 'signed-in') {
      return
    }
    if (session.openProjectId === embedProjectId || autoOpenStarted.current) {
      return
    }
    autoOpenStarted.current = true
    void openProject(embedProjectId)
  }, [embedActive, embedProjectId, session.status, session.openProjectId, openProject])

  React.useEffect(() => {
    if (!embedActive || embedProjectId === null || readySent.current) {
      return
    }
    if (session.status !== 'signed-in' || session.openProjectId !== embedProjectId) {
      return
    }
    readySent.current = true
    postToParent({
      source: 'orca-cloud-admin',
      type: 'ready',
      route: session.route,
      latencyMs: Date.now() - (embedStartedAt.current ?? Date.now())
    })
    // No workspace tabs yet (U46-5): still emit the protocol's dirty frame.
    postToParent({ source: 'orca-cloud-admin', type: 'dirty', count: 0 })
  }, [
    embedActive,
    embedProjectId,
    session.status,
    session.openProjectId,
    session.route,
    postToParent
  ])

  React.useEffect(() => {
    if (embedProjectId === null) {
      return
    }
    const onMessage = (event: MessageEvent): void => {
      if (!isCloudAdminParentMessage(event)) {
        return
      }
      const type = readField(event.data, 'type')
      if (type === 'close') {
        // R1: close the PTY/socket before the console drops the document.
        void closeProject(embedProjectId).then(() =>
          postToParent({ source: 'orca-cloud-admin', type: 'closed' })
        )
      } else if (type === 'logout') {
        // R10: the console owns logout; the host still clears every project link.
        void signOut()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [embedProjectId, closeProject, signOut, postToParent])

  const dialogs = (
    <>
      {session.connectFailure ? (
        <CloudConnectFailureDialog
          code={session.connectFailure.code}
          diagnostics={{ probes: session.connectFailure.probes }}
          retrying={confirmingKey}
          onRetry={() => {
            setConfirmingKey(true)
            void session.retryConnect().finally(() => setConfirmingKey(false))
          }}
          onClose={() => session.dismissConnectFailure()}
        />
      ) : null}
      {session.hostKeyMismatch ? (
        <CloudHostKeyDialog
          mismatch={session.hostKeyMismatch}
          busy={confirmingKey}
          onCancel={() => session.dismissHostKeyMismatch()}
          onConfirm={() => {
            setConfirmingKey(true)
            void session.confirmHostKey().finally(() => setConfirmingKey(false))
          }}
        />
      ) : null}
    </>
  )

  if (session.status === 'unavailable') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        当前版本未配置云端开发平台地址，无法登录。
      </div>
    )
  }

  const openedProject = openedProjectSummary(session)

  // U46-4: embedded mode renders only the workspace; the console owns the
  // workbench chrome, navigation and login.
  if (embedActive) {
    if (session.status === 'signed-in' && bridge && openedProject) {
      return (
        <>
          <EmbeddedWorkspace session={session} project={openedProject} bridge={bridge} />
          {dialogs}
        </>
      )
    }
    if (session.status === 'signed-in') {
      return (
        <>
          <CloudEmbedProgress error={session.error} />
          {dialogs}
        </>
      )
    }
    if (embedHandoffFailed) {
      // C3: a spent/forbidden code returns here with the form, never a blank pane.
      return (
        <div className="flex h-full flex-col bg-background">
          <p
            role="status"
            data-testid="cloud-embed-notice"
            className="border-b border-border bg-muted px-6 py-2 text-sm text-muted-foreground"
          >
            {cloudAdminHandoffFailureNotice(session.error ?? '')}
          </p>
          <div className="min-h-0 flex-1">
            <CloudLoginPanel
              submitting={false}
              error={session.error}
              notice={null}
              defaultPlatformUrl={session.loginContext?.platformUrl ?? null}
              defaultUsername={session.loginContext?.username ?? null}
              addressLocked={session.loginContext?.locked ?? false}
              onSignIn={(username, password, platformUrl) =>
                void session.signIn(username, password, platformUrl)
              }
            />
          </div>
          {dialogs}
        </div>
      )
    }
    if (session.status === 'signed-out' && !handoffCode) {
      return (
        <>
          <CloudEmbedSessionMissing />
          {dialogs}
        </>
      )
    }
    return (
      <>
        <CloudEmbedProgress error={null} />
        {dialogs}
      </>
    )
  }

  if (session.status !== 'signed-in') {
    return (
      <CloudLoginPanel
        submitting={session.status === 'signing-in'}
        error={session.error}
        notice={session.notice}
        defaultPlatformUrl={session.loginContext?.platformUrl ?? null}
        defaultUsername={session.loginContext?.username ?? null}
        addressLocked={session.loginContext?.locked ?? false}
        onSignIn={(username, password, platformUrl) =>
          void session.signIn(username, password, platformUrl)
        }
      />
    )
  }

  if (bridge && openedProject) {
    const { subscribe } = bridge
    return (
      <CloudProjectWorkspace
        session={session}
        project={openedProject}
        rpc={(method, params) => bridge.rpc(method, params ?? {}, openedProject.id)}
        subscribe={
          subscribe
            ? (method, params, callbacks) => subscribe(openedProject.id, method, params, callbacks)
            : null
        }
      />
    )
  }

  return (
    <>
      <CloudWorkbench
        session={session}
        onOpenProject={(projectId: string) => void session.openProject(projectId)}
      />
      {dialogs}
    </>
  )
}

/** The same workspace view the standalone page shows, wired to the live bridge. */
function EmbeddedWorkspace({
  session,
  project,
  bridge
}: {
  session: CloudSessionView
  project: NonNullable<ReturnType<typeof openedProjectSummary>>
  bridge: CloudBridge
}): React.JSX.Element {
  const { subscribe } = bridge
  return (
    <CloudProjectWorkspace
      session={session}
      project={project}
      rpc={(method, params) => bridge.rpc(method, params ?? {}, project.id)}
      subscribe={
        subscribe
          ? (method, params, callbacks) => subscribe(project.id, method, params, callbacks)
          : null
      }
    />
  )
}
