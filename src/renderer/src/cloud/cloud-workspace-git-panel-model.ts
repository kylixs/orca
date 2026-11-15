import { getDominantStatus } from '@/components/right-sidebar/status-display'
import { readArray, readNumber, readString } from '../../../shared/json-fields'
import type { GitFileStatus } from '../../../shared/git-status-types'

/**
 * Wire parsing and grouping for the cloud Git pane (U46-6b, design §11.3).
 * `git.status` and `git.commitCompare` share the same entries shape, so one
 * parser serves both; grouping reuses Source Control's dominant-status rule.
 */

export type CloudWorkspaceGitChange = {
  path: string
  status: GitFileStatus
}

export type CloudWorkspaceGitCommit = {
  id: string
  displayId?: string
  subject: string
  author?: string
  /** Epoch milliseconds, matching `GitHistoryItem.timestamp`. */
  timestamp?: number
}

export type CloudWorkspaceGitGroup = {
  status: GitFileStatus
  label: string
  changes: CloudWorkspaceGitChange[]
}

const GIT_FILE_STATUSES = new Set<string>([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked'
])

const GROUP_ORDER: readonly GitFileStatus[] = [
  'modified',
  'untracked',
  'added',
  'deleted',
  'renamed',
  'copied'
]

const GROUP_LABELS: Record<GitFileStatus, string> = {
  modified: '修改',
  untracked: '未跟踪',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  copied: '复制'
}

function isGitFileStatus(value: string | null): value is GitFileStatus {
  return value !== null && GIT_FILE_STATUSES.has(value)
}

/** path → dominant status; staged and unstaged views of one file collapse. */
export function groupCloudGitChanges(
  changes: readonly CloudWorkspaceGitChange[]
): CloudWorkspaceGitGroup[] {
  const byPath = new Map<string, GitFileStatus>()
  for (const change of changes) {
    const existing = byPath.get(change.path)
    const status =
      existing === undefined
        ? change.status
        : (getDominantStatus([existing, change.status]) ?? change.status)
    byPath.set(change.path, status)
  }

  const groups: CloudWorkspaceGitGroup[] = []
  for (const status of GROUP_ORDER) {
    const entries = [...byPath.entries()]
      .filter(([, entryStatus]) => entryStatus === status)
      .map(([path]) => ({ path, status }))
    if (entries.length > 0) {
      groups.push({ status, label: GROUP_LABELS[status], changes: entries })
    }
  }
  return groups
}

export function parseCloudGitStatus(result: unknown): CloudWorkspaceGitChange[] | null {
  return parseCloudGitChangeEntries(result)
}

/** `git.commitCompare` returns the same `entries` shape as `git.status`. */
export function parseCloudGitCommitFiles(result: unknown): CloudWorkspaceGitChange[] | null {
  return parseCloudGitChangeEntries(result)
}

function parseCloudGitChangeEntries(result: unknown): CloudWorkspaceGitChange[] | null {
  const entries = readArray(result, 'entries')
  if (entries === null) {
    return null
  }
  const changes: CloudWorkspaceGitChange[] = []
  for (const entry of entries) {
    const path = readString(entry, 'path')
    const status = readString(entry, 'status')
    if (path === null || path === '' || !isGitFileStatus(status)) {
      continue
    }
    changes.push({ path, status })
  }
  return changes
}

export function parseCloudGitHistory(result: unknown): CloudWorkspaceGitCommit[] | null {
  const items = readArray(result, 'items')
  if (items === null) {
    return null
  }
  const commits: CloudWorkspaceGitCommit[] = []
  for (const item of items) {
    const id = readString(item, 'id')
    if (id === null || id === '') {
      continue
    }
    commits.push({
      id,
      displayId: readString(item, 'displayId') ?? undefined,
      subject: readString(item, 'subject') ?? '(无提交信息)',
      author: readString(item, 'author') ?? undefined,
      timestamp: readNumber(item, 'timestamp') ?? undefined
    })
  }
  return commits
}

/** "刚刚 / N 分钟前 / N 小时前 / N 天前", then a date once it stops being recent. */
export function cloudGitRelativeTime(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return ''
  }
  const elapsed = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) {
    return '刚刚'
  }
  if (minutes < 60) {
    return `${minutes} 分钟前`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours} 小时前`
  }
  const days = Math.floor(hours / 24)
  if (days < 30) {
    return `${days} 天前`
  }
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function shortHash(commit: CloudWorkspaceGitCommit): string {
  return commit.displayId ?? commit.id.slice(0, 7)
}

export function splitPath(path: string): { name: string; directory: string } {
  const cut = path.lastIndexOf('/')
  return cut === -1
    ? { name: path, directory: '' }
    : { name: path.slice(cut + 1), directory: path.slice(0, cut) }
}
