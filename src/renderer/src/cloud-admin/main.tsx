import '../assets/main.css'

import ReactDOM from 'react-dom/client'
import { CloudApp } from '../cloud/cloud-app'
import { createCloudBrowserBridge } from '../cloud/cloud-browser-bridge'
import { takeCloudAdminEmbedEntry } from '../cloud/cloud-admin-embed'
import { createLocalStorageWebCloudDeviceKey } from '../web/web-cloud-device-key'
import { clearWebHandoffFromAddressBar } from '../web/web-cloud-handoff-entry'

/**
 * Standalone admin entry (design §4.2): its own login, no token from the URL.
 * The platform address comes from deployment config; without it the page shows
 * the existing "not configured" state instead of a dead login form.
 */
export function resolveCloudAdminApiUrl(location: Location = window.location): string {
  const injected = window.__ORCA_CLOUD_ADMIN_API_URL__
  const fromQuery = new URLSearchParams(location.search).get('api')
  return String(fromQuery ?? injected ?? import.meta.env.VITE_ORCA_CLOUD_API_URL ?? '').trim()
}

const apiUrl = resolveCloudAdminApiUrl()
// U46-4: the console hands us `?embed=1&project=<id>#handoff=<code>`; the code
// is wiped before the exchange so a refresh can never replay it (C1).
const embed = takeCloudAdminEmbedEntry(window.location, clearWebHandoffFromAddressBar)
const root = document.getElementById('root')
if (!root) {
  throw new Error('cloud-admin entry is missing #root')
}
const bridge = apiUrl
  ? createCloudBrowserBridge({
      apiUrl,
      deviceName: 'Orca Cloud Admin',
      deviceKeyStore: createLocalStorageWebCloudDeviceKey()
    })
  : null

ReactDOM.createRoot(root).render(<CloudApp bridge={bridge} embed={embed} />)

// Why: the admin session page hosts terminals too, so it starts the deferred
// WebGL addon load itself (same reason as web/main.tsx). Dynamic because this
// entry keeps the pane-manager graph out of its own startup chunk.
void import('../lib/pane-manager/pane-webgl-renderer').then((module) =>
  module.primeTerminalWebglAddon()
)
