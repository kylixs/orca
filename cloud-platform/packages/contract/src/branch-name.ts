/**
 * Minimal guard for an admin-edited default branch. The host validates the full
 * git-ref grammar at clone time; the platform only rejects the shapes that are
 * obviously unsafe to store or echo back.
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
  if (branch.startsWith('-')) {
    return reject('默认分支名不能以 “-” 开头。')
  }
  if (/\s/.test(branch) || hasControlCharacter(branch)) {
    return reject('默认分支名不能包含空白或控制字符。')
  }
  return { ok: true, defaultBranch: branch }
}
