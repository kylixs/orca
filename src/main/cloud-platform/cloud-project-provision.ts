import { isAbsolute, win32 } from 'node:path'

/**
 * Cloud project provisioning decisions, kept pure so the URL and branch rules can
 * be tested without a platform, a runtime or a spawned git.
 */

export type CloudProjectProvisionInput = {
  projectRoot: string
  /** Empty when the admin already prepared the path on the host. */
  repoUrl: string
  defaultBranch: string
}

export type CloudProjectProvisionResult =
  | { ok: true; provisioned: boolean }
  | { ok: false; code: string; message: string }

/** What the host sends on its next heartbeat; never carries the repo URL or a token. */
export type CloudProvisionReport = {
  projectId: string
  ok: boolean
  error?: string
}

export type CloudProvisionReporter = (report: CloudProvisionReport) => void

export type CloudProvisionPlan =
  | { kind: 'already-provisioned' }
  | { kind: 'clone' }
  /** No repo and no URL: the ticket's directory is initialized on the host. */
  | { kind: 'init' }

export function planCloudProjectProvision(input: {
  hasRepo: boolean
  hasRepoUrl: boolean
}): CloudProvisionPlan {
  if (input.hasRepo) {
    return { kind: 'already-provisioned' }
  }
  return input.hasRepoUrl ? { kind: 'clone' } : { kind: 'init' }
}

export type CloudProvisionValidation<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'CLONE_URL_INVALID' | 'BRANCH_INVALID'; message: string }

const MAX_CLONE_URL_LENGTH = 4096
const MAX_BRANCH_LENGTH = 200
const SCP_LIKE = /^[A-Za-z0-9._-]+@[^:/\s]+:.+$/
const ALLOWED_SCHEMES = ['https://', 'http://', 'ssh://', 'git://'] as const

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function rejectUrl(message: string): CloudProvisionValidation<string> {
  return { ok: false, code: 'CLONE_URL_INVALID', message }
}

function rejectBranch(message: string): CloudProvisionValidation<string> {
  return { ok: false, code: 'BRANCH_INVALID', message }
}

/** Absolute local path in either separator style; the host's platform decides which is real. */
function isAbsoluteLocalPath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value)
}

/** `file://` is another name for a host-local path; a hostname would resolve elsewhere. */
function isLocalFileUrl(value: string): boolean {
  if (!/^file:\/\//i.test(value)) {
    return false
  }
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'file:' &&
      (parsed.hostname === '' || parsed.hostname === 'localhost') &&
      parsed.pathname.length > 1
    )
  } catch {
    return false
  }
}

export function validateCloudCloneUrl(value: string): CloudProvisionValidation<string> {
  const url = value.trim()
  if (url === '') {
    return rejectUrl('仓库地址不能为空。')
  }
  if (url.length > MAX_CLONE_URL_LENGTH) {
    return rejectUrl('仓库地址过长。')
  }
  if (hasControlCharacter(url)) {
    return rejectUrl('仓库地址包含控制字符。')
  }
  if (url.startsWith('-')) {
    return rejectUrl('仓库地址不能以 “-” 开头。')
  }
  // git's ext:: transport executes an arbitrary command; it must never come from a ticket.
  if (url.toLowerCase().includes('ext::')) {
    return rejectUrl('不支持 git ext:: 传输协议。')
  }
  if (isAbsoluteLocalPath(url) || isLocalFileUrl(url) || SCP_LIKE.test(url)) {
    return { ok: true, value: url }
  }
  const scheme = ALLOWED_SCHEMES.find((candidate) => url.toLowerCase().startsWith(candidate))
  if (!scheme) {
    return rejectUrl('仓库地址必须使用 https/http/ssh/git/file 协议或为本地绝对路径。')
  }
  try {
    const parsed = new URL(url)
    if (!parsed.hostname) {
      return rejectUrl('仓库地址缺少主机名。')
    }
  } catch {
    return rejectUrl('仓库地址格式无效。')
  }
  return { ok: true, value: url }
}

export function validateCloudBranchName(value: string): CloudProvisionValidation<string> {
  const branch = value
  if (branch === '') {
    return rejectBranch('分支名不能为空。')
  }
  if (branch.length > MAX_BRANCH_LENGTH) {
    return rejectBranch('分支名过长。')
  }
  if (branch.startsWith('-') || branch.startsWith('/') || branch.startsWith('.')) {
    return rejectBranch('分支名不能以 “-”、“/” 或 “.” 开头。')
  }
  if (branch.endsWith('/') || branch.endsWith('.')) {
    return rejectBranch('分支名不能以 “/” 或 “.” 结尾。')
  }
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) {
    return rejectBranch('分支名包含无效的引用序列。')
  }
  if (/[\s~^:?*[\\]/.test(branch) || hasControlCharacter(branch)) {
    return rejectBranch('分支名包含空白或无效字符。')
  }
  if (branch === '@') {
    return rejectBranch('分支名不能是 “@”。')
  }
  return { ok: true, value: branch }
}

/** Short, credential-free text safe to put in the platform audit log. */
export function provisionFailureMessage(code: string): string {
  switch (code) {
    case 'PROJECT_NOT_PREPARED':
      return '项目尚未准备：缺少仓库地址，且目标路径不是 git 仓库。'
    case 'INIT_FAILED':
      return '项目目录初始化失败，请查看主机日志。'
    case 'CLONE_URL_INVALID':
      return '仓库地址无效。'
    case 'BRANCH_INVALID':
      return '默认分支名无效。'
    default:
      return '项目准备失败，请查看主机日志。'
  }
}
