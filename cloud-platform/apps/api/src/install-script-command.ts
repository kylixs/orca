/**
 * U183 R12: shell fragments shared by the generated host and relay install
 * scripts. Kept pure so the script text is unit-testable.
 */

/** Embed an untrusted value as one single-quoted shell literal. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Fail with EX_CONFIG (78) when none of `names` is on PATH. An `if`-friendly
 * block rather than `|| exit` so it composes with multi-candidate probes.
 */
export function requireCommand(
  names: string | readonly string[],
  message: string,
  exitCode = 78
): string {
  const probes = (typeof names === 'string' ? [names] : names)
    .map((name) => `command -v ${name} >/dev/null 2>&1`)
    .join(' || ')
  return `if ! { ${probes}; }; then
  echo ${shellQuote(`>> ${message}`)} >&2
  exit ${exitCode}
fi`
}

/** Usable directly as an `if` condition in a generated script. */
export function systemdAvailable(): string {
  return 'command -v systemctl >/dev/null 2>&1'
}
