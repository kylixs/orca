import { useRef, useCallback, useEffect } from 'react'
import { Keyboard } from 'react-native'
import { openExternalLink } from '../platform/external-link'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { consumeLegacyTerminalLinkOpenMode, saveTerminalLinkOpenMode } from '../storage/preferences'
import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'
import { resolveMobileNativeChatFileSessionId } from './mobile-native-chat-eligibility'
import { activateOpenedSourceControlDiffTab } from './opened-mobile-session-tab'
import {
  resolveDirectTerminalLinkAction,
  resolveTerminalLinkRemoteAvailability
} from './terminal-link-open-policy'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTerminalSendActionsModel } from './use-mobile-session-terminal-send-actions'

export function useMobileSessionFileActions(scope: MobileSessionTerminalSendActionsModel) {
  const {
    hostId,
    worktreeId,
    routeWorktreeName,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    client,
    connState,
    hostCapabilities,
    statusReadable,
    creatingBrowser,
    sessionTabsRef,
    terminalLinkOpenMode,
    setTerminalLinkOpenMode,
    terminalLinkChoice,
    setTerminalLinkChoice,
    activeHandle,
    keyboardHeight,
    liveInputRef,
    focusLiveInput,
    showToast,
    activeSessionTabIdRef,
    terminalCwdRef,
    activeHandleRef,
    activeSessionTab,
    activeSessionTabTypeRef,
    switchSessionTabRef,
    handleCreateBrowserRef,
    handleCreateBackgroundBrowserRef,
    scheduleDelayedAction,
    nativeChatSendError,
    fetchSessionTabs
  } = scope
  // Tap a terminal or chat file path → resolve on host, open as file tab/preview.
  const { handleFileTap, handleNativeChatFileTap } = useMobileFileTapHandlers<MobileSessionTab>({
    client,
    hostId,
    worktreeId,
    worktreeName: routeWorktreeName,
    nativeChatSessionId: resolveMobileNativeChatFileSessionId(activeSessionTab),
    activeHandleRef,
    terminalCwdRef,
    openBrowser: (url) => void handleCreateBrowserRef.current?.(url),
    fetchSessionTabs,
    getSessionTabs: () => sessionTabsRef.current,
    getActiveSessionTabId: () => activeSessionTabIdRef.current,
    getActiveSessionTabType: () => activeSessionTabTypeRef.current,
    switchSessionTab: (tab) => switchSessionTabRef.current?.(tab),
    scheduleDelayedAction,
    reportChatTapFailure: nativeChatSendError.show
  })

  const handleOpenedFileDiffActivationSeqRef = useRef(0)
  // Capture active tab at tap time; reading it after openDiff would misread a mid-RPC switch and let the retry steal focus.
  const fileOpenStartActiveTabIdRef = useRef<string | null>(null)
  const handleFileOpenStart = useCallback(() => {
    fileOpenStartActiveTabIdRef.current = activeSessionTabIdRef.current
  }, [])
  const handleOpenedFileDiff = useCallback(
    (relativePath: string) => {
      const activationSeq = ++handleOpenedFileDiffActivationSeqRef.current
      const activeTabIdAtTap = fileOpenStartActiveTabIdRef.current

      let activated = false
      const activateOpenedTab = async (): Promise<void> => {
        // Route matching through the shared helper so the repro test exercises the same logic production runs.
        const settled = await activateOpenedSourceControlDiffTab<MobileSessionTab>({
          relativePath,
          activeTabIdAtTap,
          fetchSessionTabs,
          getTabs: () => sessionTabsRef.current,
          getActiveTabId: () => activeSessionTabIdRef.current,
          getActivationState: () => ({
            activated,
            activationSeq,
            latestActivationSeq: handleOpenedFileDiffActivationSeqRef.current
          }),
          switchSessionTab: (tab) => switchSessionTabRef.current?.(tab)
        })
        if (settled) {
          activated = true
        }
      }

      scheduleDelayedAction(() => void activateOpenedTab(), 300)
      scheduleDelayedAction(() => void activateOpenedTab(), 900)
      scheduleDelayedAction(() => void activateOpenedTab(), 1800)
    },
    [fetchSessionTabs, scheduleDelayedAction]
  )

  const clipboard = useClipboardWriter()
  const linkKeyboardWasOpenRef = useRef(false)
  const linkActionInFlightRef = useRef(false)
  const linkSheetSeqRef = useRef(0)

  const remoteAvailability = resolveTerminalLinkRemoteAvailability({
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    client,
    connState,
    statusReadable,
    hostCapabilities,
    creatingBrowser
  })

  const closeTerminalLinkSheet = useCallback(() => {
    linkSheetSeqRef.current += 1
    linkActionInFlightRef.current = false
    setTerminalLinkChoice(null)
    if (linkKeyboardWasOpenRef.current) {
      linkKeyboardWasOpenRef.current = false
      focusLiveInput()
    }
  }, [focusLiveInput, setTerminalLinkChoice])

  // Why: a tab switch while the sheet is open invalidates its handle; the action would no longer
  // belong to the terminal the user is looking at.
  useEffect(() => {
    if (terminalLinkChoice !== null && terminalLinkChoice.handle !== activeHandle) {
      closeTerminalLinkSheet()
    }
  }, [activeHandle, closeTerminalLinkSheet, terminalLinkChoice])

  const openTerminalLinkSheet = useCallback(
    (handle: string, url: string) => {
      if (keyboardHeight > 0) {
        linkKeyboardWasOpenRef.current = true
      }
      // Why: the drawer is a native window; take first responder from the terminal before it opens.
      liveInputRef.current?.blur()
      if (keyboardHeight > 0) {
        Keyboard.dismiss()
      }
      const requestSeq = ++linkSheetSeqRef.current
      // Why: the guard stays latched after an action until the next sheet, so a second press in
      // the same tick cannot repeat it.
      linkActionInFlightRef.current = false
      setTerminalLinkChoice({ handle, url, preselect: null })
      void consumeLegacyTerminalLinkOpenMode().then((preselect) => {
        if (!preselect || requestSeq !== linkSheetSeqRef.current) {
          return
        }
        setTerminalLinkChoice((current) =>
          current !== null && current.handle === handle && current.url === url
            ? { ...current, preselect }
            : current
        )
      })
    },
    [keyboardHeight, liveInputRef, setTerminalLinkChoice]
  )

  const handleTerminalOpenUrl = useCallback(
    (handle: string, url: string) => {
      if (handle !== activeHandleRef.current) {
        return
      }
      const direct = resolveDirectTerminalLinkAction(terminalLinkOpenMode, url, remoteAvailability)
      if (direct === 'phone-browser') {
        openExternalLink(url, () => {
          triggerError()
          showToast("Couldn't open link", 1600)
        })
        return
      }
      if (direct === 'orca-browser') {
        const create = handleCreateBackgroundBrowserRef?.current
        if (!create) {
          openTerminalLinkSheet(handle, url)
          return
        }
        void create(url)
          .then((created) => {
            // Why: the capability gate can change between the tap and the call; never leave the
            // user with a tap that did nothing.
            if (!created && handle === activeHandleRef.current) {
              openTerminalLinkSheet(handle, url)
            }
          })
          .catch(() => {
            if (handle === activeHandleRef.current) {
              openTerminalLinkSheet(handle, url)
            }
          })
        return
      }

      openTerminalLinkSheet(handle, url)
    },
    [
      activeHandleRef,
      handleCreateBackgroundBrowserRef,
      openTerminalLinkSheet,
      remoteAvailability,
      showToast,
      terminalLinkOpenMode
    ]
  )

  const runTerminalLinkAction = useCallback(
    (kind: 'phone-browser' | 'orca-browser' | 'copy' | 'cancel', remember: boolean): void => {
      if (kind === 'cancel') {
        closeTerminalLinkSheet()
        return
      }
      const choice = terminalLinkChoice
      // Why: React state is not a lock; a double-tap's second press lands before the drawer unmounts.
      if (!choice || linkActionInFlightRef.current) {
        return
      }
      if (choice.handle !== activeHandleRef.current) {
        closeTerminalLinkSheet()
        return
      }
      linkActionInFlightRef.current = true
      linkSheetSeqRef.current += 1
      setTerminalLinkChoice(null)
      if (linkKeyboardWasOpenRef.current) {
        linkKeyboardWasOpenRef.current = false
        focusLiveInput()
      }

      if (kind === 'copy') {
        void clipboard
          .writeText(choice.url)
          .then(() => {
            triggerSuccess()
            showToast('Link copied')
          })
          .catch(() => {
            triggerError()
            showToast("Couldn't copy link", 1500)
          })
        return
      }

      if (remember) {
        void saveTerminalLinkOpenMode(kind)
          .then(() => setTerminalLinkOpenMode(kind))
          .catch(() => showToast("Couldn't save link preference", 1600))
      }
      if (kind === 'phone-browser') {
        openExternalLink(choice.url, () => {
          triggerError()
          showToast("Couldn't open link", 1600)
        })
        return
      }
      const create = handleCreateBackgroundBrowserRef?.current
      if (!create) {
        showToast("Couldn't open link on desktop", 1600)
        return
      }
      void create(choice.url)
    },
    [
      clipboard,
      closeTerminalLinkSheet,
      focusLiveInput,
      handleCreateBackgroundBrowserRef,
      setTerminalLinkChoice,
      setTerminalLinkOpenMode,
      showToast,
      terminalLinkChoice
    ]
  )

  return {
    handleFileTap,
    handleNativeChatFileTap,
    handleOpenedFileDiffActivationSeqRef,
    fileOpenStartActiveTabIdRef,
    handleFileOpenStart,
    handleOpenedFileDiff,
    handleTerminalOpenUrl,
    terminalLinkChoice,
    terminalLinkRemoteAvailability: remoteAvailability,
    closeTerminalLinkSheet,
    runTerminalLinkAction
  }
}

export type MobileSessionFileActionsModel = MobileSessionTerminalSendActionsModel &
  ReturnType<typeof useMobileSessionFileActions>
