import * as React from 'react'
import type {
  CloudSimpleWorkspaceLifecycle,
  CloudSimpleWorkspaceLifecycleIntent
} from './cloud-simple-workspace-lifecycle'

/**
 * U96 B-令5 (§4.1/§4.2): the console's overlay lifecycle. Suspend destroys the
 * iframe's stream and socket but keeps host PTYs; an explicit end lets the
 * panels close their PTYs first, then closes the project. Logout suspends.
 */

/**
 * One task between unmounting the workspace and closing the socket: a suspend
 * must leave no close behind, and an end's per-PTY closes must be written
 * before the project connection goes away.
 */
function nextEmbedTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export type CloudAdminEmbedLifecycle = {
  phase: CloudSimpleWorkspaceLifecycleIntent
  lifecycle: CloudSimpleWorkspaceLifecycle
  handleParentMessage: (type: unknown) => void
}

export function useCloudAdminEmbedLifecycle({
  projectId,
  closeProject,
  signOut,
  postToParent
}: {
  projectId: string | null
  closeProject: (projectId: string) => Promise<void>
  signOut: () => Promise<void>
  postToParent: (message: Record<string, unknown>) => void
}): CloudAdminEmbedLifecycle {
  const [phase, setPhase] = React.useState<CloudSimpleWorkspaceLifecycleIntent>('active')
  const intent = React.useRef<CloudSimpleWorkspaceLifecycleIntent>('active')
  // Read at unmount: the removed subtree never re-renders with the new intent.
  const lifecycle = React.useMemo<CloudSimpleWorkspaceLifecycle>(
    () => ({ intent: () => intent.current }),
    []
  )

  const suspend = React.useCallback(
    async (reply: 'suspended' | 'closed') => {
      intent.current = 'suspending'
      if (projectId === null) {
        return
      }
      setPhase('suspending')
      await nextEmbedTask()
      await closeProject(projectId)
      postToParent({ source: 'orca-cloud-admin', type: reply })
    },
    [projectId, closeProject, postToParent]
  )

  const end = React.useCallback(async () => {
    intent.current = 'ending'
    if (projectId === null) {
      return
    }
    setPhase('ending')
    await nextEmbedTask()
    await closeProject(projectId)
    postToParent({ source: 'orca-cloud-admin', type: 'ended' })
  }, [projectId, closeProject, postToParent])

  const handleParentMessage = React.useCallback(
    (type: unknown) => {
      if (type === 'close') {
        // §4.2 legacy: an old console's close is a suspend; still answer `closed`.
        void suspend('closed')
      } else if (type === 'suspend') {
        void suspend('suspended')
      } else if (type === 'end') {
        void end()
      } else if (type === 'logout') {
        // T-B7: logout suspends (no implicit end); signOut drops the sockets.
        intent.current = 'suspending'
        setPhase('suspending')
        void signOut()
      }
    },
    [suspend, end, signOut]
  )

  return { phase, lifecycle, handleParentMessage }
}
