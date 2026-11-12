import * as React from 'react'
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
        onSignIn={(username, password) => void session.signIn(username, password)}
      />
    )
  }

  const openedProject = openedProjectSummary(session)
  if (bridge && openedProject) {
    return (
      <CloudProjectWorkspace
        session={session}
        project={openedProject}
        rpc={() => bridge.rpc('status.get')}
      />
    )
  }

  return (
    <CloudWorkbench
      session={session}
      onOpenProject={(projectId: string) => void session.openProject(projectId)}
    />
  )
}
