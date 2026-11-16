import * as React from 'react'
import type { CloudSimpleWorkspaceSessionTabActions } from './use-cloud-simple-workspace-session-tabs'
import {
  cloudTerminalLeafId,
  type CloudSimpleWorkspaceTab,
  type CloudSimpleWorkspaceTabsAction
} from './cloud-simple-workspace-tabs'

/**
 * U96 B-令4: user gestures that the host session-tab inventory must observe.
 * Only host-backed terminal tabs write; local-only tabs keep today's path.
 */
export function useCloudSimpleWorkspaceHostTabActions({
  sessionTabs,
  tabs,
  nextTerminal,
  dispatch,
  requestLocalClose
}: {
  sessionTabs?: CloudSimpleWorkspaceSessionTabActions | null
  tabs: readonly CloudSimpleWorkspaceTab[]
  nextTerminal: Extract<CloudSimpleWorkspaceTab, { kind: 'terminal' }> | null
  dispatch: React.Dispatch<CloudSimpleWorkspaceTabsAction>
  requestLocalClose: (tab: CloudSimpleWorkspaceTab) => void
}): {
  activateTab: (id: string) => void
  requestCloseTab: (tab: CloudSimpleWorkspaceTab) => void
  openTerminal: () => void
} {
  const activateTab = React.useCallback(
    (id: string) => {
      dispatch({ type: 'activate', id })
      const tab = tabs.find((candidate) => candidate.id === id)
      // Only a user gesture writes activate; applying host frames never does (T-B2).
      if (tab?.kind === 'terminal' && tab.host) {
        sessionTabs?.activate(id)
      }
    },
    [dispatch, sessionTabs, tabs]
  )

  const requestCloseTab = React.useCallback(
    (tab: CloudSimpleWorkspaceTab) => {
      if (tab.kind === 'terminal' && tab.host && sessionTabs) {
        void sessionTabs.close(tab.id).then((outcome) => {
          // A refusal or a failed host close keeps the tab: closing locally would
          // hide a row the host still publishes (it would reappear on reopen).
          if (outcome === 'closed' || outcome === 'local') {
            dispatch({ type: 'close', id: tab.id })
          }
        })
        return
      }
      requestLocalClose(tab)
    },
    [dispatch, requestLocalClose, sessionTabs]
  )

  const openTerminal = React.useCallback(() => {
    if (!nextTerminal) {
      return
    }
    dispatch({ type: 'open', tab: nextTerminal })
    if (sessionTabs) {
      // T-B1: client-generated ids, so the host row lands on this same tab id.
      void sessionTabs.createTerminal(
        nextTerminal.id,
        cloudTerminalLeafId(nextTerminal.id),
        nextTerminal.title
      )
    }
  }, [dispatch, nextTerminal, sessionTabs])

  return { activateTab, requestCloseTab, openTerminal }
}
