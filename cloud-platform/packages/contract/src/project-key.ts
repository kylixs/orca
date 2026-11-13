/**
 * Self-service project keys become the last segment of a host path the platform
 * derives itself, so the grammar is deliberately narrow: no separators, no
 * traversal fragments, and a fixed shape an operator can recognise in an audit
 * event.
 */

export type ProjectKeyVerdict =
  | { ok: true; key: string }
  | { ok: false; code: 'PROJECT_KEY_INVALID'; message: string }

const MAX_PROJECT_KEY_LENGTH = 64
const PROJECT_KEY = /^[a-z0-9][a-z0-9._-]*$/

function reject(message: string): ProjectKeyVerdict {
  return { ok: false, code: 'PROJECT_KEY_INVALID', message }
}

export function validateProjectKey(value: unknown): ProjectKeyVerdict {
  if (typeof value !== 'string') {
    return reject('项目 Key 必须是字符串。')
  }
  const key = value.trim()
  if (key.length === 0 || key.length > MAX_PROJECT_KEY_LENGTH) {
    return reject('项目 Key 长度必须为 1–64 个字符。')
  }
  if (!PROJECT_KEY.test(key)) {
    return reject(
      '项目 Key 必须以小写字母或数字开头，且只能包含小写字母、数字、点、下划线或连字符。'
    )
  }
  if (key === '.' || key === '..' || key.endsWith('.')) {
    return reject('项目 Key 不能是 “.” 或 “..”，也不能以 “.” 结尾。')
  }
  return { ok: true, key }
}

/** Default key from a display name; may be empty (non-Latin names), so callers validate. */
export function projectKeyFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}
