import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ContainerHarness } from './relay-container-harness.ts'

/**
 * U183 R13b: runs the relay installer inside the R13a container and writes a
 * durable evidence directory. No product code; CI without Docker skips via the
 * harness skipReason and records verdict=null instead of failing.
 */

export type RelayExitClass =
  | 'ok'
  | 'usage'
  | 'unavailable'
  | 'checksum'
  | 'manifest'
  | 'platform-unreachable'
  | 'relay-not-online'
  | 'config'
  | 'other'

export type RelayRunStatus = RelayExitClass | 'skipped'

/** Installer exit codes per the U183 design (R4/R5/R6/R11b). */
const EXIT_CLASS_BY_CODE = new Map<number, RelayExitClass>([
  [0, 'ok'],
  [64, 'usage'],
  [65, 'unavailable'],
  [66, 'checksum'],
  [67, 'manifest'],
  [68, 'platform-unreachable'],
  [70, 'relay-not-online'],
  [78, 'config']
])

export function classifyRelayExitCode(exitCode: number): RelayExitClass {
  return EXIT_CLASS_BY_CODE.get(exitCode) ?? 'other'
}

export type RelayInstallRunResult = {
  /** null when skipped; 124 when the runner timeout fired. */
  exitCode: number | null
  classification: RelayRunStatus
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  skipped: boolean
  skipReason?: string
}

type RelayHarness = Pick<ContainerHarness, 'available' | 'skipReason' | 'execInContainer'>

export type RunRelayInstallOptions = {
  harness: RelayHarness
  installCommand: string
  timeoutMs?: number
}

const TIMEOUT_EXIT_CODE = 124

export async function runRelayInstallInContainer(
  options: RunRelayInstallOptions
): Promise<RelayInstallRunResult> {
  const { harness, installCommand, timeoutMs = 120_000 } = options
  if (installCommand.trim().length === 0) {
    throw new Error('installCommand must be non-empty')
  }
  if (!harness.available) {
    return {
      exitCode: null,
      classification: 'skipped',
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      skipped: true,
      skipReason: harness.skipReason ?? 'relay container harness unavailable'
    }
  }

  const startedAt = Date.now()
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  try {
    // execInContainer has no cancellation hook; the timeout only bounds the runner's wait.
    const outcome = await Promise.race([harness.execInContainer(installCommand), timeout])
    if (outcome === 'timeout') {
      return {
        exitCode: TIMEOUT_EXIT_CODE,
        classification: 'other',
        stdout: '',
        stderr: `relay install timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - startedAt,
        timedOut: true,
        skipped: false
      }
    }
    return {
      exitCode: outcome.exitCode,
      classification: classifyRelayExitCode(outcome.exitCode),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      skipped: false
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export type RelayEvidenceStep = RelayInstallRunResult & { name: string }

export type RelayEvidenceOptions = {
  steps: RelayEvidenceStep[]
  harness?: Pick<ContainerHarness, 'available' | 'skipReason'>
  /** Override for replaying/tests; defaults to the write time. */
  generatedAt?: string
  /** Task label in summary.json; R13b's default keeps older callers stable. */
  task?: string
}

export type RelayEvidenceIssue = {
  code: string
  file: string | null
  message: string
}

export type RelayEvidenceValidation = {
  ok: boolean
  exitCode: number | null
  issues: RelayEvidenceIssue[]
  logFile: string
}

export type RelayEvidenceResult = {
  dir: string
  verdict: 'pass' | 'fail' | null
  skipReason: string | null
  generatedAt: string
  files: string[]
  validation: RelayEvidenceValidation
}

const EVIDENCE_ROOT = fileURLToPath(new URL('../../../evidence/', import.meta.url))
const VALIDATE_SCRIPT = fileURLToPath(
  new URL('../../../scripts/validate-evidence.mjs', import.meta.url)
)

/** `cloud-platform/evidence/u183-container-<ts>/`, matching the evidence convention. */
export function relayEvidenceDirName(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
  return `u183-container-${stamp}`
}

export function createRelayEvidenceDir(options: { root?: string; now?: Date } = {}): string {
  const dir = join(options.root ?? EVIDENCE_ROOT, relayEvidenceDirName(options.now))
  mkdirSync(dir, { recursive: true })
  return dir
}

function computeVerdict(
  steps: RelayEvidenceStep[],
  harness: RelayEvidenceOptions['harness']
): { verdict: 'pass' | 'fail' | null; skipReason: string | null } {
  if (harness && !harness.available) {
    return {
      verdict: null,
      skipReason: harness.skipReason ?? 'relay container harness unavailable'
    }
  }
  const skipped = steps.find((step) => step.skipped)
  if (skipped) {
    return { verdict: null, skipReason: skipped.skipReason ?? `step ${skipped.name} skipped` }
  }
  const verdict = steps.every((step) => step.exitCode === 0) ? 'pass' : 'fail'
  return { verdict, skipReason: null }
}

function slug(name: string, index: number): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return safe.length > 0 ? safe : `step-${index + 1}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseValidatorIssues(value: unknown): RelayEvidenceIssue[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return []
    }
    return [
      {
        code: typeof item.code === 'string' ? item.code : 'validator-issue',
        file: typeof item.file === 'string' ? item.file : null,
        message: typeof item.message === 'string' ? item.message : ''
      }
    ]
  })
}

function runValidator(dir: string): RelayEvidenceValidation {
  const logFile = 'validate-evidence.log'
  const result = spawnSync(
    process.execPath,
    [VALIDATE_SCRIPT, dir, '--check-generated-at', '--json'],
    { encoding: 'utf8', timeout: 30_000 }
  )
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(join(dir, logFile), text)

  let parsed: unknown = null
  try {
    parsed = JSON.parse(result.stdout ?? '')
  } catch {
    // A broken validator run is a warning too: evidence still gets written.
  }
  const issues = isRecord(parsed) ? parseValidatorIssues(parsed.issues) : null
  const ok = isRecord(parsed) && parsed.ok === true && result.status === 0
  return {
    ok,
    exitCode: result.status,
    issues: issues ?? [
      {
        code: 'validator-unavailable',
        file: null,
        message: `validate-evidence did not return JSON (exit ${result.status ?? 'spawn-error'})`
      }
    ],
    logFile
  }
}

export function collectRelayEvidence(
  dir: string,
  options: RelayEvidenceOptions
): RelayEvidenceResult {
  if (options.steps.length === 0) {
    throw new Error('collectRelayEvidence requires at least one step')
  }
  mkdirSync(dir, { recursive: true })

  const generatedAt = options.generatedAt ?? new Date().toISOString()
  const { verdict, skipReason } = computeVerdict(options.steps, options.harness)
  const files: string[] = []

  const stepRecords = options.steps.map((step, index) => {
    const base = `${String(index + 1).padStart(2, '0')}-${slug(step.name, index)}`
    const stdoutFile = `${base}.stdout.log`
    const stderrFile = `${base}.stderr.log`
    writeFileSync(join(dir, stdoutFile), step.stdout)
    writeFileSync(join(dir, stderrFile), step.stderr)
    files.push(stdoutFile, stderrFile)
    return {
      name: step.name,
      exitCode: step.exitCode,
      classification: step.classification,
      skipped: step.skipped,
      skipReason: step.skipReason ?? null,
      timedOut: step.timedOut,
      durationMs: step.durationMs,
      stdoutFile,
      stderrFile,
      stdoutBytes: Buffer.byteLength(step.stdout),
      stderrBytes: Buffer.byteLength(step.stderr)
    }
  })

  const results = { generatedAt, verdict, skipReason, steps: stepRecords }
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  files.push('results.json')

  const validation = runValidator(dir)

  const summary = {
    task: options.task ?? 'U183 R13b relay install in clean container',
    generatedAt,
    verdict,
    skipReason,
    steps: stepRecords.map(({ name, exitCode, classification, skipped }) => ({
      name,
      exitCode,
      classification,
      skipped
    })),
    validation: { ok: validation.ok, issues: validation.issues }
  }
  writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  files.push('summary.json', validation.logFile)

  if (!validation.ok) {
    console.warn(
      `[u183-container] validate-evidence failed for ${dir}: ${validation.issues
        .map((issue) => `${issue.code} ${issue.message}`)
        .join('; ')}`
    )
  }

  return { dir, verdict, skipReason, generatedAt, files, validation }
}
