import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useWebSessionRecovery } from './web-session-recovery'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import ReactDOM from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import WebConnect from './WebConnect'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  clearPairingInputFromAddressBar,
  decideWebPairingStartup,
  readPairingInputFromLocation
} from './web-pairing'
import {
  readWebCloudApiUrlFromLocation,
  readWebCloudHandoffEntry,
  useWebCloudHandoffEntry
} from './web-cloud-handoff-entry'
import {
  normalizeWebCloudWorkspaceUrl,
  readWebCloudWorkspaceLocation
} from './web-cloud-workspace-location'
import {
  createBrowserWebCloudSessionStorage,
  readPersistedWebCloudSession
} from './web-cloud-session-storage'
import { createLocalStorageWebCloudDeviceKey } from './web-cloud-device-key'
import { resumeWebCloudSession, webCloudResumeFailureNotice } from './web-cloud-session-resume'
import {
  clearStoredWebRuntimeEnvironment,
  createStoredWebRuntimeEnvironment,
  isCloudSessionWebEnvironment,
  readStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { installWebPreloadApi } from './web-preload-api'
import { I18nProvider } from '../i18n/I18nProvider'
import { translate } from '../i18n/i18n'
import { installOsFileDropCancellationGuard } from '../lib/os-file-drop-cancellation-guard'

const disposeOsFileDropGuard = installOsFileDropCancellationGuard()
import.meta.hot?.dispose(disposeOsFileDropGuard)
const App = lazy(() => import('../App'))

function WebRoot(): React.JSX.Element {
  // Why here, once: startup routing must see the same stored environment the App
  // will install, including whether a cloud ticket (already consumed) produced it.
  const startup = useMemo(() => {
    // FR-3.10: an explicit handoff outranks every stored environment, and its
    // code leaves the address bar before anything can record it again. The project
    // id stays, so a spent code still has a page to return to after sign-in.
    const handoffEntry = readWebCloudHandoffEntry(window.location)
    if (handoffEntry) {
      normalizeWebCloudWorkspaceUrl({
        apiUrl: handoffEntry.apiUrl || null,
        projectId: handoffEntry.projectId
      })
      return {
        decision: null,
        cloudSessionEnded: false,
        handoffEntry,
        cloudApiUrl: handoffEntry.apiUrl || null,
        workspaceLocation: {
          apiUrl: handoffEntry.apiUrl || null,
          projectId: handoffEntry.projectId
        },
        resume: null
      }
    }
    const initialPairingInput = readPairingInputFromLocation(window.location)
    const workspaceLocation = readWebCloudWorkspaceLocation(window.location)
    const storedEnvironment = readStoredWebRuntimeEnvironment()
    const cloudSessionEnded =
      storedEnvironment !== null && isCloudSessionWebEnvironment(storedEnvironment)
    if (cloudSessionEnded) {
      // Why clear the spent pairing: its ticket cannot be replayed. The saved
      // cloud login below is what makes the reload recoverable.
      clearStoredWebRuntimeEnvironment()
    }
    // Why: current runtime links carry scope metadata. Runtime-scope offers keep
    // the instant save path; mobile/legacy-unknown offers must be shown/probed.
    const decision = decideWebPairingStartup({
      initialPairingInput,
      hasStoredEnvironment: storedEnvironment !== null && !cloudSessionEnded
    })
    if (
      decision.kind === 'auto-save-runtime-offer' ||
      (decision.kind === 'show-connect' && decision.initialPairingInput !== null)
    ) {
      clearPairingInputFromAddressBar()
    }
    // U103-B1: a saved cloud login resumes the workspace instead of forcing the
    // sign-in form. An explicit pairing input or a live pairing environment wins.
    const canResume =
      initialPairingInput === null &&
      (storedEnvironment === null || cloudSessionEnded) &&
      workspaceLocation.apiUrl !== null &&
      readPersistedWebCloudSession(
        createBrowserWebCloudSessionStorage(),
        workspaceLocation.apiUrl
      ) !== null
    return {
      decision,
      cloudSessionEnded,
      handoffEntry: null,
      // Why: `?api=` outlives the handoff hash, so a spent-code fallback and a
      // plain refresh both keep the platform address on the sign-in form.
      cloudApiUrl: workspaceLocation.apiUrl ?? readWebCloudApiUrlFromLocation(window.location),
      workspaceLocation,
      resume: canResume
        ? {
            location: workspaceLocation,
            previousEnvironment: cloudSessionEnded ? storedEnvironment : null
          }
        : null
    }
  }, [])
  const startupDecision = startup.decision
  const [hasEnvironment, setHasEnvironment] = useState(() => {
    if (startupDecision?.kind === 'auto-save-runtime-offer') {
      saveStoredWebRuntimeEnvironment(
        createStoredWebRuntimeEnvironment({
          name: 'Orca Server',
          offer: startupDecision.offer,
          previousEnvironment: readStoredWebRuntimeEnvironment()
        })
      )
      return true
    }
    return startupDecision?.kind === 'use-stored-environment'
  })
  // Why here, unconditionally: a cloud client can die before the App ever mounts,
  // and a lost ticket must never leave the user on a dead screen.
  const sessionRecovery = useWebSessionRecovery(() => setHasEnvironment(false))
  const handoff = useWebCloudHandoffEntry(() => setHasEnvironment(true))
  const handoffStarted = useRef(false)
  useEffect(() => {
    if (!startup.handoffEntry || handoffStarted.current) {
      return
    }
    handoffStarted.current = true
    handoff.begin(startup.handoffEntry)
  }, [startup.handoffEntry, handoff])
  const [resumeState, setResumeState] = useState<
    { status: 'idle' } | { status: 'running' } | { status: 'failed'; notice: string | null }
  >({ status: 'idle' })
  const resumeStarted = useRef(false)
  useEffect(() => {
    const resume = startup.resume
    if (!resume || resumeStarted.current) {
      return
    }
    resumeStarted.current = true
    setResumeState({ status: 'running' })
    void resumeWebCloudSession({
      location: resume.location,
      storage: createBrowserWebCloudSessionStorage(),
      deviceKeyStore: createLocalStorageWebCloudDeviceKey(),
      previousEnvironment: resume.previousEnvironment
    })
      .then((result) => {
        if (result.status === 'resumed') {
          // Why: a remembered-project resume must leave a page-level URL too.
          normalizeWebCloudWorkspaceUrl({
            apiUrl: resume.location.apiUrl,
            projectId: result.projectId
          })
          setHasEnvironment(true)
          return
        }
        setResumeState({
          status: 'failed',
          notice: webCloudResumeFailureNotice(result)
        })
      })
      .catch(() =>
        setResumeState({
          status: 'failed',
          notice: translate(
            'auto.web.WebConnect.resumeFailed',
            'The saved cloud session could not be resumed. Sign in to continue.'
          )
        })
      )
  }, [startup.resume])

  if (!hasEnvironment) {
    if (handoff.state.status === 'entering' || resumeState.status === 'running') {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
          <p className="text-sm text-muted-foreground">
            {translate('auto.web.WebConnect.handoffEntering', 'Opening the project workspace…')}
          </p>
        </div>
      )
    }
    const handoffFailure = handoff.state.status === 'failed' ? handoff.state : null
    return (
      <WebConnect
        initialPairingInput={
          startupDecision?.kind === 'show-connect' ? startupDecision.initialPairingInput : null
        }
        initialNotice={
          resumeState.status === 'failed' && resumeState.notice
            ? resumeState.notice
            : sessionRecovery.status === 'signed-out'
              ? sessionRecovery.notice
              : handoffFailure
                ? handoffFailure.notice
                : startup.cloudSessionEnded &&
                    startupDecision?.kind === 'show-connect' &&
                    startupDecision.initialPairingInput === null
                  ? translate(
                      'auto.web.WebConnect.cloudSessionEnded',
                      'Your cloud session ended when this page closed. Sign in again to continue.'
                    )
                  : null
        }
        initialCloudApiUrl={handoffFailure?.apiUrl ?? startup.cloudApiUrl}
        initialProjectId={startup.workspaceLocation.projectId}
        onConnected={() => setHasEnvironment(true)}
      />
    )
  }

  installWebPreloadApi()
  return (
    <Suspense fallback={<div className="min-h-dvh bg-background" />}>
      <App />
    </Suspense>
  )
}

function WebRootBoundary(): React.JSX.Element {
  useTranslation()
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="web.root"
      surface="web-root"
      title={translate('app.recoverableError.webTitle', 'Orca web hit a renderer error.')}
      description={translate(
        'app.recoverableError.webDescription',
        'Retry the web client or reconnect to the paired runtime.'
      )}
    >
      <WebRoot />
    </RecoverableRenderErrorBoundary>
  )
}

/** Side-effect-free module: only mounting calls createRoot, so one of this
 *  graph's shared chunks cannot mount a second root when another entry loads it. */
export function mountWebRoot(): void {
  const root = document.getElementById('root')
  if (!root) {
    throw new Error('web entry is missing #root')
  }
  ReactDOM.createRoot(root).render(
    <I18nProvider>
      <WebRootBoundary />
    </I18nProvider>
  )
}
