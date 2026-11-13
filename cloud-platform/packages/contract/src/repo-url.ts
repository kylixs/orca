/**
 * A project's optional clone source. The host copies it from the signed ticket,
 * so the platform rejects hostile shapes early: an argument-looking value or a
 * git `ext::` transport would make the host run something other than `git clone`.
 */

export type ProjectRepoUrlVerdict =
  | { ok: true; repoUrl: string }
  | { ok: false; code: 'REPO_URL_INVALID'; message: string }

const MAX_REPO_URL_LENGTH = 4096

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function reject(message: string): ProjectRepoUrlVerdict {
  return { ok: false, code: 'REPO_URL_INVALID', message }
}

/** Empty is valid: the admin prepared the path on the host, so no clone is needed. */
export function validateProjectRepoUrl(value: unknown): ProjectRepoUrlVerdict {
  if (value === undefined || value === null) {
    return { ok: true, repoUrl: '' }
  }
  if (typeof value !== 'string') {
    return reject('仓库地址必须是字符串。')
  }
  const repoUrl = value.trim()
  if (repoUrl === '') {
    return { ok: true, repoUrl: '' }
  }
  if (repoUrl.length > MAX_REPO_URL_LENGTH) {
    return reject('仓库地址过长。')
  }
  if (hasControlCharacter(repoUrl)) {
    return reject('仓库地址包含控制字符。')
  }
  if (repoUrl.startsWith('-')) {
    return reject('仓库地址不能以 “-” 开头。')
  }
  if (repoUrl.toLowerCase().includes('ext::')) {
    return reject('不支持 git ext:: 传输协议。')
  }
  return { ok: true, repoUrl }
}
