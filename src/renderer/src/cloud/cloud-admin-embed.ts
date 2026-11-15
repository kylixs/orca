/**
 * U46-4: the console embeds this page with `?embed=1&project=<id>#handoff=<code>`.
 * Parsing and copy live here so the entry and the app share one contract.
 */

export type CloudAdminEmbedEntry = {
  projectId: string
  /** One-time code; null on a reload, where the persisted session carries the user. */
  handoffCode: string | null
}

/** How long the embed waits for its own ready before falling back to the standalone page. */
export const CLOUD_ADMIN_EMBED_READY_TIMEOUT_MS = 20_000

/** Reads `<cloud-admin.html>?embed=1&project=<id>#handoff=<code>&project=<id>`. */
export function readCloudAdminEmbedEntry(location: {
  hash: string
  search: string
}): CloudAdminEmbedEntry | null {
  const search = new URLSearchParams(location.search)
  if (search.get('embed') !== '1') {
    return null
  }
  const hash = new URLSearchParams(location.hash.replace(/^#/, '').trim())
  const projectId = (hash.get('project') ?? search.get('project') ?? '').trim()
  if (!projectId) {
    return null
  }
  const code = (hash.get('handoff') ?? '').trim()
  return { projectId, handoffCode: code || null }
}

/**
 * C1: the code leaves the address bar before anything redeems it, so refresh,
 * history and Referer never see it again. `clearHash` is injected to keep this testable.
 */
export function takeCloudAdminEmbedEntry(
  location: { hash: string; search: string },
  clearHash: () => void
): CloudAdminEmbedEntry | null {
  const entry = readCloudAdminEmbedEntry(location)
  if (entry?.handoffCode) {
    clearHash()
  }
  return entry
}

/** Copy for a handoff that could not be spent; the login form shows it (C3). */
export function cloudAdminHandoffFailureNotice(code: string): string {
  if (code === 'HANDOFF_GONE') {
    return '这个入口链接已过期或已被使用，请从管理台重新打开项目。'
  }
  if (code === 'PROJECT_FORBIDDEN') {
    return '当前账号已无权访问该项目，请重新登录。'
  }
  if (code === 'network_error') {
    return '无法连接平台，请检查网络后从管理台重新打开。'
  }
  return '项目未能在嵌入模式下自动打开，请从管理台重新打开。'
}
