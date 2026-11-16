/**
 * A project's optional clone source. The host copies it from the signed ticket,
 * so the platform rejects hostile shapes early: an argument-looking value or a
 * git `ext::` transport would make the host run something other than `git clone`.
 */

export type ProjectRepoUrlVerdict =
  | { ok: true; repoUrl: string }
  | { ok: false; code: 'REPO_URL_INVALID'; message: string }

const MAX_REPO_URL_LENGTH = 4096

// Git clone transports the host can actually fetch from. `ext::` is excluded
// above because it runs a command; ftp(s) is deliberately not offered.
const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'ssh:', 'git:', 'file:'])

// SCP-like syntax: `[user@]host:path`. A host without `user@` must look like a
// hostname so a Windows drive path (`C:/repo`) is not mistaken for one.
const SCP_LIKE =
  /^(?:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+|(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+|localhost)):[^\s\\]+$/

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

function isSupportedRepoAddress(value: string): boolean {
  if (SCP_LIKE.test(value)) return true
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (!SUPPORTED_SCHEMES.has(url.protocol)) return false
  if (url.protocol === 'file:') {
    // Only local file URLs: a hostname would leave the signed ticket pointing
    // somewhere the host cannot resolve.
    return (
      /^file:\/\//i.test(value) &&
      (url.hostname === '' || url.hostname === 'localhost') &&
      url.pathname.length > 1
    )
  }
  // WHATWG parses `https:///org/repo` as host `org`; a typo like that should
  // not be sent to a host as an address the user did not type.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]/.test(value)) return false
  return url.hostname !== '' && url.pathname.replace(/^\/+/, '') !== ''
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
  if (/\s/.test(repoUrl) || repoUrl.includes('\\')) {
    return reject('仓库地址不能包含空白字符或反斜杠。')
  }
  if (!isSupportedRepoAddress(repoUrl)) {
    return reject(
      '仓库地址格式无效：请填写 https://、http://、ssh://、git://、file:// 或以 git@主机:路径 形式的地址。'
    )
  }
  return { ok: true, repoUrl }
}
