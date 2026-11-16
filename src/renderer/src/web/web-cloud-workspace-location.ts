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
