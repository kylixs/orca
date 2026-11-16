/**
 * The page-level address of an Orca Web cloud workspace: `?api=<platform>&project=<id>`.
 * The project id is not a secret, so it may sit in the address bar and survive a
 * refresh; the handoff code never does.
 */

export type WebCloudWorkspaceLocation = {
  apiUrl: string | null
  projectId: string | null
}

function readParam(search: string, name: string): string | null {
  const value = (new URLSearchParams(search).get(name) ?? '').trim()
  return value || null
}

export type WebCloudWorkspaceLocationError = 'invalid-project' | 'invalid-api'

/** Platform project ids are opaque (`proj_…`): a shape check, not a UUID check. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * U106-W3: an address we cannot even name a project with is a 404 page, not a
 * failed sign-in. Rejecting the shape also keeps `javascript:` in `api` from
 * ever reaching a fetch or a rendered link.
 */
export function webCloudWorkspaceLocationError(
  location: WebCloudWorkspaceLocation
): WebCloudWorkspaceLocationError | null {
  if (location.projectId !== null && !PROJECT_ID_PATTERN.test(location.projectId)) {
    return 'invalid-project'
  }
  if (location.apiUrl !== null && !isHttpUrl(location.apiUrl)) {
    return 'invalid-api'
  }
  return null
}

export function readWebCloudWorkspaceLocation(location: {
  search: string
}): WebCloudWorkspaceLocation {
  const apiUrl = readParam(location.search, 'api')
  return {
    apiUrl: apiUrl ? apiUrl.replace(/\/+$/, '') : null,
    projectId: readParam(location.search, 'project')
  }
}

/**
 * Rewrites the address bar to the canonical, secret-free form: `?api=&project=`,
 * no hash. Existing unrelated query values (e.g. `embed`) are kept.
 */
export function normalizeWebCloudWorkspaceUrl(input: {
  apiUrl: string | null
  projectId: string | null
}): void {
  if (typeof window === 'undefined' || !window.history?.replaceState) {
    return
  }
  const params = new URLSearchParams(window.location.search)
  if (input.apiUrl) {
    params.set('api', input.apiUrl)
  } else {
    params.delete('api')
  }
  if (input.projectId) {
    params.set('project', input.projectId)
  } else {
    params.delete('project')
  }
  const query = params.toString()
  window.history.replaceState(
    null,
    document.title,
    `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`
  )
}
