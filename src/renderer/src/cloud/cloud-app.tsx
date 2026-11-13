import * as React from 'react'
import { CloudConnectFailureDialog } from './cloud-connect-failure-dialog'
import { CloudHostKeyDialog } from './cloud-host-key-dialog'
import { CloudLoginPanel } from './cloud-login-panel'
import { CloudProjectWorkspace, openedProjectSummary } from './cloud-project-workspace'
import { CloudWorkbench } from './cloud-workbench'
import { useCloudSession, type CloudBridge } from './use-cloud-session'

/**
 * Entry point for cloud mode. `bridge` is `window.api.cloud`; passing null renders
 * the "not a cloud build" state instead of a login form that cannot work.
 */
export function CloudApp({ bridge }: { bridge: CloudBridge | null }): React.JSX.Element {
  const session = useCloudSession(bridge)
  const [confirmingKey, setConfirmingKey] = React.useState(false)

  if (session.status === 'unavailable') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        当前版本未配置云端开发平台地址，无法登录。
      </div>
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

  const openedProject = openedProjectSummary(session)
  if (bridge && openedProject) {
    return (
      <CloudProjectWorkspace
        session={session}
        project={openedProject}
        rpc={(method, params) => bridge.rpc(method, params ?? {}, openedProject.id)}
      />
    )
  }

  return (
    <>
      <CloudWorkbench
        session={session}
        onOpenProject={(projectId: string) => void session.openProject(projectId)}
      />
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
}
