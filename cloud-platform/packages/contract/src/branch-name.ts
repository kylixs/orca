/**
 * Guard for a registered default branch, mirroring the host's git-ref grammar
 * (src/main/cloud-platform/cloud-project-provision.ts validateCloudBranchName).
 * The platform rejects the same shapes so a project cannot register ready and
 * then fail provisioning on every open with BRANCH_INVALID.
 *
 * Difference from the host: empty is valid — the host then clones the remote's
 * default branch, and registration stores 'main'.
 */

export type ProjectDefaultBranchVerdict =
  | { ok: true; defaultBranch: string }
  | { ok: false; code: 'BRANCH_INVALID'; message: string }

const MAX_BRANCH_LENGTH = 200

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function reject(message: string): ProjectDefaultBranchVerdict {
  return { ok: false, code: 'BRANCH_INVALID', message }
}

/** Empty is valid: the host then clones the remote's default branch. */
export function validateProjectDefaultBranch(value: unknown): ProjectDefaultBranchVerdict {
  if (value === undefined || value === null) {
    return { ok: true, defaultBranch: '' }
  }
  if (typeof value !== 'string') {
    return reject('默认分支名必须是字符串。')
  }
  const branch = value.trim()
  if (branch === '') {
    return { ok: true, defaultBranch: '' }
  }
  if (branch.length > MAX_BRANCH_LENGTH) {
    return reject('默认分支名过长。')
  }
  if (branch.startsWith('-') || branch.startsWith('/') || branch.startsWith('.')) {
    return reject('默认分支名不能以 “-”、“/” 或 “.” 开头。')
  }
  if (branch.endsWith('/') || branch.endsWith('.')) {
    return reject('默认分支名不能以 “/” 或 “.” 结尾。')
  }
  if (branch.includes('..') || branch.includes('//') || branch.includes('@{')) {
    return reject('默认分支名包含无效的引用序列。')
  }
  if (/[\s~^:?*[\\]/.test(branch) || hasControlCharacter(branch)) {
    return reject('默认分支名不能包含空白或无效字符。')
  }
  if (branch === '@') {
    return reject('默认分支名不能是 “@”。')
  }
  return { ok: true, defaultBranch: branch }
}
