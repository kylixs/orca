/**
 * Project roots are signed into every ticket as `projectRoot`, and the host
 * derives the user's workspace from it. A root carrying `..` is not merely
 * untidy: `/srv/work/svc/../../etc` passes containment checks as `/srv/etc`,
 * so the credential silently covers a directory nobody granted.
 *
 * Rejecting is the only honest answer. Normalising on the way in would guess at
 * intent and make the stored path differ from the one an operator typed.
 */

export type ProjectPathVerdict =
  | { ok: true; path: string }
  | { ok: false; code: 'PROJECT_PATH_INVALID'; message: string }

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function reject(message: string): ProjectPathVerdict {
  return { ok: false, code: 'PROJECT_PATH_INVALID', message }
}

/** Absolute project root with no `.`/`..` segments, no empty segments, no trailing separator. */
export function validateProjectPath(value: unknown): ProjectPathVerdict {
  if (typeof value !== 'string' || value === '') {
    return reject('项目路径不能为空。')
  }
  if (hasControlCharacter(value)) {
    return reject('项目路径包含控制字符。')
  }
  const isPosix = value.startsWith('/')
  const isWindows = WINDOWS_ABSOLUTE.test(value)
  if (!isPosix && !isWindows) {
    return reject('项目路径必须是绝对路径。')
  }
  const rootOnly = isPosix ? '/' : value.slice(0, 3)
  if (value !== rootOnly && /[\\/]$/.test(value)) {
    return reject('项目路径不能以分隔符结尾。')
  }
  // Both separator styles are legal on a Windows host; POSIX paths take `/` only.
  if (isPosix && value.includes('\\')) {
    return reject('项目路径混用了反斜杠。')
  }
  const body = isPosix ? value.slice(1) : value.slice(3)
  for (const segment of body.split(/[\\/]/)) {
    if (segment === '') {
      return reject('项目路径包含空段（重复分隔符）。')
    }
    if (segment === '.' || segment === '..') {
      return reject('项目路径不能包含 “.” 或 “..” 段。')
    }
  }
  return { ok: true, path: value }
}

/** True when both paths are already canonical absolute roots (host-side re-check). */
export function isCanonicalProjectRoot(value: unknown): boolean {
  return validateProjectPath(value).ok
}
