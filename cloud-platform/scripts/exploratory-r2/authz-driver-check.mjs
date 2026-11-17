/**
 * U195: combo drivers summarize their own checks, so a malformed check (for
 * example an array accidentally nested by `[entries.map(...)]`) must fail loudly
 * instead of being counted as an opaque failure or silently passing.
 */

export function assertCheckShape(id, checks) {
  if (!Array.isArray(checks)) {
    throw new Error(`${id}: checks must be an array, got ${typeof checks}`)
  }
  checks.forEach((check, index) => {
    if (Array.isArray(check)) {
      throw new Error(`${id}: check[${index}] is a nested array; flatten the map() result`)
    }
    if (!check || typeof check !== 'object' || typeof check.name !== 'string') {
      throw new Error(`${id}: check[${index}] must be an object with a string name`)
    }
    if (typeof check.ok !== 'boolean') {
      throw new Error(`${id}: check[${index}] (${check.name}) must carry a boolean ok`)
    }
  })
}

export function summarizeChecks(id, checks) {
  assertCheckShape(id, checks)
  const failed = checks.filter((check) => !check.ok)
  return { failed, ok: failed.length === 0 }
}
