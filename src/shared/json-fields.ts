/**
 * Shape-checked reads over platform JSON. A missing or mistyped field reads as
 * null, so callers decide the failure instead of trusting a cast.
 */

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function readField(source: unknown, key: string): unknown {
  return source !== null && typeof source === 'object' ? Reflect.get(source, key) : undefined
}

export function readString(source: unknown, key: string): string | null {
  const value = readField(source, key)
  return typeof value === 'string' ? value : null
}

export function readNumber(source: unknown, key: string): number | null {
  const value = readField(source, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readArrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

export function readArray(source: unknown, key: string): unknown[] | null {
  return readArrayValue(readField(source, key))
}

export function readStringArray(source: unknown, key: string): string[] | null {
  const value = readArray(source, key)
  return value === null ? null : value.filter((item) => typeof item === 'string')
}

/** The value itself when it is a JSON object, else null. */
export function readObjectValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** Own enumerable entries of a JSON object; empty for anything else. */
export function ownEntries(source: unknown): [string, unknown][] {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    return []
  }
  return Object.entries(source)
}

/** `code` on a thrown error such as `Object.assign(new Error(...), { code })`. */
export function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return null
  }
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : null
}
