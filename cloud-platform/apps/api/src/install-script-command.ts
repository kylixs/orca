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

/** Fail with EX_USAGE (64) unless `nodeExpr` reports at least the given version. */
export function requireNodeVersion(
  nodeExpr: string,
  minMajor: number,
  minMinor: number,
  message: string,
  exitCode = 64
): string {
  return `ORCA_NODE_VERSION="$(${nodeExpr} -p 'process.versions.node' 2>/dev/null || true)"
case "$ORCA_NODE_VERSION" in
  ''|*[!0-9.]*) echo ${shellQuote(`>> ${message}`)} >&2; exit ${exitCode} ;;
esac
ORCA_NODE_MAJOR="\${ORCA_NODE_VERSION%%.*}"
ORCA_NODE_REST="\${ORCA_NODE_VERSION#*.}"
ORCA_NODE_MINOR="\${ORCA_NODE_REST%%.*}"
if [ "$ORCA_NODE_MAJOR" -lt ${minMajor} ] || { [ "$ORCA_NODE_MAJOR" -eq ${minMajor} ] && [ "$ORCA_NODE_MINOR" -lt ${minMinor} ]; }; then
  echo ${shellQuote(`>> ${message}`)}"（当前 $ORCA_NODE_VERSION）" >&2
  exit ${exitCode}
fi`
}

/** Fail with EX_CONFIG (78) unless `dirExpr` exists or can be created and written. */
export function requireWritableDir(dirExpr: string, message: string, exitCode = 78): string {
  return `if ! mkdir -p "${dirExpr}" 2>/dev/null || [ ! -w "${dirExpr}" ]; then
  echo ${shellQuote(`>> ${message}`)} >&2
  exit ${exitCode}
fi`
}
