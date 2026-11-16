/**
 * Read-budget policy parsing (design §9.3 `project.<id>.readRatePerHour`).
 *
 * The host enforces the budget, so a bad value here would either disable the
 * limit (zero/NaN) or lock a project out. Unparsable input is rejected rather
 * than coerced to a default, so an operator sees the mistake at write time.
 */

export type ReadRate = { calls: number; bytes: number }

export type ReadRateInput =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'clear' }
  | { kind: 'set'; rate: ReadRate }

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  // Safe integer only: 1e300 is integral, but it can never be a real budget.
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function parseReadRate(value: unknown): ReadRateInput {
  if (value === undefined) {
    return { kind: 'absent' }
  }
  // Explicit null clears a project override; it is not the same as "not supplied".
  if (value === null) {
    return { kind: 'clear' }
  }
  if (!value || typeof value !== 'object') {
    return { kind: 'invalid' }
  }
  const calls = 'calls' in value ? positiveInteger(value.calls) : null
  const bytes = 'bytes' in value ? positiveInteger(value.bytes) : null
  return calls === null || bytes === null
    ? { kind: 'invalid' }
    : { kind: 'set', rate: { calls, bytes } }
}
