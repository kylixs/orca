import { parseJsonText, readField, readNumber, readString } from '../../../shared/json-fields'

/**
 * The browser remembers which project it last opened on each platform, so a
 * re-login resumes that workspace instead of falling back to the first row of
 * `/v1/projects` (which may be a project this account cannot open).
 */

export const WEB_CLOUD_PROJECT_MEMORY_STORAGE_KEY = 'orca.webCloudLastProject.v1'

export type WebCloudProjectMemoryStorage = {
  read(): string | null
  write(value: string): void
}

const MEMORY_VERSION = 1

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '')
}

function noMemory(): WebCloudProjectMemoryStorage {
  return { read: () => null, write: () => undefined }
}

/** A node run has no localStorage; persist nothing rather than crash on load. */
export function createBrowserWebCloudProjectMemoryStorage(): WebCloudProjectMemoryStorage {
  if (typeof window === 'undefined' || !window.localStorage) {
    return noMemory()
  }
  return {
    read: () => window.localStorage.getItem(WEB_CLOUD_PROJECT_MEMORY_STORAGE_KEY),
    write: (value) => {
      try {
        window.localStorage.setItem(WEB_CLOUD_PROJECT_MEMORY_STORAGE_KEY, value)
      } catch {
        // Why: private mode/quota must not fail an otherwise valid connection.
      }
    }
  }
}

function readMemory(storage: WebCloudProjectMemoryStorage): Record<string, string> {
  const parsed = parseJsonText(storage.read() ?? '')
  const projects: Record<string, string> = {}
  if (readNumber(parsed, 'version') !== MEMORY_VERSION) {
    return projects
  }
  const byApiUrl = readField(parsed, 'byApiUrl')
  if (byApiUrl === null || typeof byApiUrl !== 'object' || Array.isArray(byApiUrl)) {
    return projects
  }
  // Why the whitelist: a corrupted record must only lose the memory, never the
  // ability to make the connection.
  for (const key of Object.keys(byApiUrl)) {
    const projectId = readString(byApiUrl, key)
    if (projectId !== null && projectId.trim()) {
      projects[normalizeApiUrl(key)] = projectId
    }
  }
  return projects
}

export function readRememberedCloudProjectId(
  storage: WebCloudProjectMemoryStorage,
  apiUrl: string
): string | null {
  const normalized = normalizeApiUrl(apiUrl)
  return normalized ? (readMemory(storage)[normalized] ?? null) : null
}

export function rememberCloudProjectId(
  storage: WebCloudProjectMemoryStorage,
  apiUrl: string,
  projectId: string
): void {
  const normalized = normalizeApiUrl(apiUrl)
  if (!normalized || !projectId.trim()) {
    return
  }
  const projects = readMemory(storage)
  projects[normalized] = projectId
  storage.write(JSON.stringify({ version: MEMORY_VERSION, byApiUrl: projects }))
}
