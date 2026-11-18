/**
 * U298: the API replica needs these thresholds at import time, but importing
 * lockout.ts also runs its service-bootstrap top-level await. Keep them here so
 * constants stay side-effect-free.
 */
export const MAX_FAILURES = 5
export const LOCK_MS = 15 * 60_000
