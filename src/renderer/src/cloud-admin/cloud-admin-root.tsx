import ReactDOM from 'react-dom/client'
import { CloudApp } from '../cloud/cloud-app'
import { createCloudBrowserBridge } from '../cloud/cloud-browser-bridge'
import { takeCloudAdminEmbedEntry, type CloudAdminEmbedEntry } from '../cloud/cloud-admin-embed'
import type { CloudBridge } from '../cloud/use-cloud-session'
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

/**
 * U59 P0: an embed entry carrying a one-time code must spend it before the app
 * mounts. Otherwise the saved session's restore and the code exchange race, the
 * restored state auto-opens while the exchange has cleared the in-memory
 * session, and the open fails with NOT_SIGNED_IN. Pre-redeeming also leaves the
 * exchange's own failure state for the app to report (the code is retried once).
 */
export async function prepareCloudAdminEntry(
  bridge: CloudBridge | null,
  embed: CloudAdminEmbedEntry | null,
  mount: (embed: CloudAdminEmbedEntry | null) => void
): Promise<void> {
  if (!bridge?.loginWithHandoff || !embed?.handoffCode) {
    mount(embed)
    return
  }
  try {
    await bridge.loginWithHandoff(embed.handoffCode)
    // The session is live in memory now; the app restores it, never the code.
    mount({ projectId: embed.projectId, handoffCode: null })
  } catch {
    // Why keep the code: the app renders the expired/forbidden notice and form.
    mount(embed)
  }
}

/** Side-effect-free module: only mounting renders, so this graph's shared chunks
 *  cannot mount the admin root when the web entry loads them (U49). */
export function mountCloudAdmin(): void {
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

  void prepareCloudAdminEntry(bridge, embed, (entry) =>
    ReactDOM.createRoot(root).render(<CloudApp bridge={bridge} embed={entry} />)
  )
}
