import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import { readNumber, readString } from '../../shared/json-fields'

/**
 * The desktop's cloud session at rest, so a restart does not require a new login.
 *
 * The device secret is persisted with the tokens because the platform registered
 * that key as this device and every host ticket is bound to it; a new key would
 * look like a second device and fail the E2EE binding. Passwords never land here.
 */

export const CLOUD_SESSION_FILENAME = 'orca-cloud-session.json'

export type PersistedCloudSession = {
  version: 1
  apiUrl: string
  accessToken: string
  refreshToken: string
  deviceId: string
  deviceSecretKeyB64: string
  displayName: string
  savedAtMs: number
}

const SECRET_KEY_BYTES = 32
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function isSecretKeyB64(value: string): boolean {
  return BASE64.test(value) && Buffer.from(value, 'base64').length === SECRET_KEY_BYTES
}

function isPersistedCloudSession(value: unknown): value is PersistedCloudSession {
  const secretKeyB64 = readString(value, 'deviceSecretKeyB64')
  return (
    readNumber(value, 'version') === 1 &&
    readString(value, 'apiUrl') !== null &&
    readString(value, 'accessToken') !== null &&
    readString(value, 'refreshToken') !== null &&
    readString(value, 'deviceId') !== null &&
    secretKeyB64 !== null &&
    isSecretKeyB64(secretKeyB64) &&
    readString(value, 'displayName') !== null &&
    readNumber(value, 'savedAtMs') !== null
  )
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '')
}

/**
 * Returns null when there is no usable saved session. An unreadable or malformed
 * file means "not signed in" — never "signed in with empty tokens" — and is left
 * untouched so a transient read failure cannot destroy a recoverable session.
 */
export function readPersistedCloudSession(
  userDataPath: string,
  currentApiUrl: string
): PersistedCloudSession | null {
  const path = join(userDataPath, CLOUD_SESSION_FILENAME)
  if (!existsSync(path)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isPersistedCloudSession(parsed)) {
      return null
    }
    // Why: a token minted by another platform must never be sent to this one.
    return normalizeApiUrl(parsed.apiUrl) === normalizeApiUrl(currentApiUrl) ? parsed : null
  } catch {
    return null
  }
}

/** True when the session was written and its permissions could be restricted. */
export function writePersistedCloudSession(
  userDataPath: string,
  value: PersistedCloudSession
): boolean {
  const path = join(userDataPath, CLOUD_SESSION_FILENAME)
  try {
    const hardened = writeSecureJsonFile(path, value)
    hardenExistingSecureFile(path)
    return hardened
  } catch {
    return false
  }
}

export function deletePersistedCloudSession(userDataPath: string): void {
  try {
    rmSync(join(userDataPath, CLOUD_SESSION_FILENAME), { force: true })
  } catch {
    // Why: a failed cleanup must not turn sign-out into an error the UI reports.
  }
}
