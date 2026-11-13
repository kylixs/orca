import '../assets/main.css'

import { Suspense, useMemo, useState } from 'react'
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
    const initialPairingInput = readPairingInputFromLocation(window.location)
    const storedEnvironment = readStoredWebRuntimeEnvironment()
    const cloudSessionEnded =
      storedEnvironment !== null && isCloudSessionWebEnvironment(storedEnvironment)
    if (cloudSessionEnded) {
      // Why clear: the ticket cannot be replayed, so keeping the record only
      // risks mounting App against a pairing that can never authenticate.
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
    return { decision, cloudSessionEnded }
  }, [])
  const startupDecision = startup.decision
  const [hasEnvironment, setHasEnvironment] = useState(() => {
    if (startupDecision.kind === 'auto-save-runtime-offer') {
      saveStoredWebRuntimeEnvironment(
        createStoredWebRuntimeEnvironment({
          name: 'Orca Server',
          offer: startupDecision.offer,
          previousEnvironment: readStoredWebRuntimeEnvironment()
        })
      )
      return true
    }
    return startupDecision.kind === 'use-stored-environment'
  })

  if (!hasEnvironment) {
    return (
      <WebConnect
        initialPairingInput={
          startupDecision.kind === 'show-connect' ? startupDecision.initialPairingInput : null
        }
        initialNotice={
          startup.cloudSessionEnded &&
          startupDecision.kind === 'show-connect' &&
          startupDecision.initialPairingInput === null
            ? translate(
                'auto.web.WebConnect.cloudSessionEnded',
                'Your cloud session ended when this page closed. Sign in again to continue.'
              )
            : null
        }
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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <I18nProvider>
    <WebRootBoundary />
  </I18nProvider>
)

// Why: the web client is its own entry point and hosts terminals too, so it has
// to start the deferred WebGL addon load itself (see main.tsx). Dynamic because
// this entry deliberately keeps the whole App graph — pane manager included —
// out of its own startup chunk.
void import('../lib/pane-manager/pane-webgl-renderer').then((module) =>
  module.primeTerminalWebglAddon()
)
