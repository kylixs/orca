// Log primitives for mobile terminal diagnostics, split from the class so the load-timing
// module can share them without a cycle. Keep this leaf free of class/value imports.
export const MOBILE_TERMINAL_DIAGNOSTIC_TAG = '[terminal-diagnostic]'

type MobileTerminalDiagnosticValue = string | number | boolean | null | undefined

export type MobileTerminalDiagnosticDetails = Readonly<
  Record<string, MobileTerminalDiagnosticValue>
>

// Why: full runtime identifiers make shared logs unnecessarily sensitive; the
// suffix is enough to correlate lifecycle events within one reproduction.
export function shortenMobileTerminalDiagnosticId(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  return value.slice(-8)
}

export function getMobileTerminalDiagnosticErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name
  }
  return typeof error
}

export function logMobileTerminalDiagnostic(
  event: string,
  details: MobileTerminalDiagnosticDetails = {}
): void {
  // Why: lifecycle diagnostics are intentionally available for HMR repros,
  // but high-frequency WebView events must not add production log overhead.
  if (typeof __DEV__ !== 'undefined' && !__DEV__) {
    return
  }
  // Keep this structured and content-free so users can safely share a filtered log.
  console.log(MOBILE_TERMINAL_DIAGNOSTIC_TAG, event, details)
}
