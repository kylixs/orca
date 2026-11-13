import { parseJsonText, readNumber, readString } from '../../../shared/json-fields'

/**
 * The browser's saved platform session. It deliberately carries no device secret:
 * that half lives in `web-cloud-device-key`, which is the storage this session
 * must keep using so the platform still recognises the same device.
 *
 * localStorage is readable by any same-origin script, so an XSS on the admin page
 * can steal these tokens. That is the accepted trade-off for surviving a reload;
 * the tokens are never put in a URL, a log line, or bridge state.
 */

export const WEB_CLOUD_SESSION_STORAGE_KEY = 'orca.webCloudSession'

export type PersistedWebCloudSession = {
  version: 1
  apiUrl: string
  accessToken: string
  refreshToken: string
  deviceId: string
  displayName: string
  savedAtMs: number
}

export type WebCloudSessionStorage = {
  read(): string | null
  write(value: string): void
  remove(): void
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '')
}

function isPersistedWebCloudSession(value: unknown): value is PersistedWebCloudSession {
  return (
    readNumber(value, 'version') === 1 &&
    readString(value, 'apiUrl') !== null &&
    readString(value, 'accessToken') !== null &&
    readString(value, 'refreshToken') !== null &&
    readString(value, 'deviceId') !== null &&
    readString(value, 'displayName') !== null &&
    readNumber(value, 'savedAtMs') !== null
  )
}

/** Browser wiring for the storage seam; tests and node runs inject their own. */
export function createLocalStorageWebCloudSessionStorage(
  storage: Storage = window.localStorage
): WebCloudSessionStorage {
  return {
    read: () => storage.getItem(WEB_CLOUD_SESSION_STORAGE_KEY),
    write: (value) => storage.setItem(WEB_CLOUD_SESSION_STORAGE_KEY, value),
    remove: () => storage.removeItem(WEB_CLOUD_SESSION_STORAGE_KEY)
  }
}

/** A node run has no localStorage; persist nothing rather than crash on load. */
export function createBrowserWebCloudSessionStorage(): WebCloudSessionStorage {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { read: () => null, write: () => undefined, remove: () => undefined }
  }
  return createLocalStorageWebCloudSessionStorage(window.localStorage)
}

/** Null means "no usable saved login"; a mismatched platform must re-authenticate. */
export function readPersistedWebCloudSession(
  storage: WebCloudSessionStorage,
  currentApiUrl: string
): PersistedWebCloudSession | null {
  const parsed = parseJsonText(storage.read() ?? '')
  if (!isPersistedWebCloudSession(parsed)) {
    return null
  }
  return normalizeApiUrl(parsed.apiUrl) === normalizeApiUrl(currentApiUrl) ? parsed : null
}

/** False when the browser refused the write (quota, private mode); the login still works. */
export function writePersistedWebCloudSession(
  storage: WebCloudSessionStorage,
  value: PersistedWebCloudSession
): boolean {
  try {
    storage.write(JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function deletePersistedWebCloudSession(storage: WebCloudSessionStorage): void {
  try {
    storage.remove()
  } catch {
    // Why: a failed cleanup must not turn sign-out into an error the UI reports.
  }
}
