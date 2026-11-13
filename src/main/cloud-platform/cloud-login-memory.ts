import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../shared/secure-file'
import { readField, readObjectValue, readString } from '../../shared/json-fields'

/**
 * The address and username of the last successful login (M119/W10), so the next
 * launch prefills the form instead of asking again. Deliberately a sibling of the
 * saved session file, not inside it: sign-out deletes the session but must keep
 * the memory. No credential ever lands here — the username is not a secret.
 */

export const CLOUD_LOGIN_MEMORY_FILENAME = 'orca-cloud-login-memory.json'

export type CloudLoginMemory = {
  lastPlatformUrl: string | null
  lastUsername: string | null
}

const EMPTY_MEMORY: CloudLoginMemory = { lastPlatformUrl: null, lastUsername: null }

function readMemoryShape(value: unknown): CloudLoginMemory {
  const cloud = readObjectValue(readField(value, 'cloud'))
  if (cloud === null) {
    return EMPTY_MEMORY
  }
  const lastPlatformUrl = readString(cloud, 'lastPlatformUrl')
  const lastUsername = readString(cloud, 'lastUsername')
  if (lastPlatformUrl === null || lastUsername === null) {
    return EMPTY_MEMORY
  }
  return { lastPlatformUrl, lastUsername }
}

/**
 * Returns the remembered login, or empty memory when the file is missing,
 * malformed, or half-written — a lost prefill is never a login-screen error.
 */
export function readCloudLoginMemory(userDataPath: string): CloudLoginMemory {
  const path = join(userDataPath, CLOUD_LOGIN_MEMORY_FILENAME)
  if (!existsSync(path)) {
    return EMPTY_MEMORY
  }
  try {
    return readMemoryShape(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return EMPTY_MEMORY
  }
}

/** True when the memory was written; a failed write only costs the next prefill. */
export function writeCloudLoginMemory(
  userDataPath: string,
  value: { platformUrl: string; username: string }
): boolean {
  const path = join(userDataPath, CLOUD_LOGIN_MEMORY_FILENAME)
  try {
    const written = writeSecureJsonFile(path, {
      version: 1,
      cloud: { lastPlatformUrl: value.platformUrl, lastUsername: value.username },
      savedAtMs: Date.now()
    })
    hardenExistingSecureFile(path)
    return written
  } catch {
    return false
  }
}
