#!/usr/bin/env node
// Remove orphaned test processes from THIS repo only (never host/env processes).
// Default is dry-run; pass --yes to terminate matched PIDs (TERM, then KILL).
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Repo root derived from this script (<repo>/cloud-platform/scripts/...), not a user-specific path.
export const REPO = resolve(import.meta.dirname, '..', '..')

// Test runtime provisioned under a temp root (e.g. /tmp/node24.5.0/bin/node).
const TEST_RUNTIME_PATTERN = /^\/(?:private\/)?tmp\/node[^/\s]*\/bin\/node$/

// Processes that belong to the live dev environment or the current run are never touched.
const KEEP_PATTERNS = [/orca-local-env/, /host-supervisor\.mjs/, /forwarder\.mjs/, /relay\.mjs/]

// Test-owned markers: temp dirs created by e2e/unit runs.
const TEST_PATTERNS = [
  /\/tmp\/orca-/,
  /\/private\/tmp\/orca-/,
  /\/private\/tmp\/u\d+-/,
  /\/private\/tmp\/w\d+[ab]?-/,
  /\/private\/tmp\/c6-/,
  /\/private\/tmp\/gate-/,
  /\/private\/tmp\/smoke-/,
  /\/private\/tmp\/resmon-/,
  /\/private\/var\/folders\/.*\/T\/orca-/
]

export function executableToken(command) {
  return command.trim().split(/\s+/)[0] ?? ''
}

// Only executables we can prove belong to this repo's test runs are eligible.
export function isProjectTestExecutable(command, repoRoot = REPO) {
  const executable = executableToken(command)
  return executable.startsWith(`${repoRoot}/node_modules/`) || TEST_RUNTIME_PATTERN.test(executable)
}

export function classifyProcess(
  command,
  ageSeconds,
  { keepPatterns = KEEP_PATTERNS, testPatterns = TEST_PATTERNS, repoRoot = REPO } = {}
) {
  if (keepPatterns.some((pattern) => pattern.test(command))) return 'keep'
  if (!isProjectTestExecutable(command, repoRoot)) return 'unrelated'
  if (!testPatterns.some((pattern) => pattern.test(command))) return 'unrelated'
  if (ageSeconds <= 1800) return 'recent' // may belong to the run that is in flight
  return 'cleanup'
}

export function parseElapsedSeconds(etime) {
  const match = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!match) return 0
  const [, days = '0', hours = '0', minutes, seconds] = match
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

export function parseProcesses(psOutput) {
  const rows = []
  for (const line of psOutput.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!match) continue
    const [, pid, ppid, etime, command] = match
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      command,
      ageSeconds: parseElapsedSeconds(etime)
    })
  }
  return rows
}

export function selectTargets(psOutput, options) {
  const rows = parseProcesses(psOutput)
  const targets = []
  const kept = []
  for (const row of rows) {
    const verdict = classifyProcess(row.command, row.ageSeconds, options)
    if (verdict === 'cleanup') targets.push(row)
    else if (verdict === 'keep' || verdict === 'recent') kept.push({ ...row, verdict })
  }
  return { targets, kept }
}

// Re-sample before SIGKILL: a recycled PID shows a different command line and must be spared.
export function revalidateTarget(psOutput, target) {
  return parseProcesses(psOutput).some(
    (row) => row.pid === target.pid && row.command === target.command
  )
}

async function main(argv) {
  const apply = argv.includes('--yes')
  const outDir = resolve(
    argv.find((arg) => arg.startsWith('--out='))?.slice(6) ??
      'cloud-platform/evidence/process-cleanup'
  )
  mkdirSync(outDir, { recursive: true })
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' })
  const { targets, kept } = selectTargets(ps.stdout ?? '')
  const report = {
    apply,
    targets: targets.map(({ pid, ageSeconds, command }) => ({
      pid,
      ageSeconds: Math.round(ageSeconds),
      command: command.slice(0, 120)
    })),
    keptCount: kept.length
  }
  appendFileSync(
    resolve(outDir, 'process-cleanup.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...report })}\n`
  )
  for (const target of report.targets)
    console.log(
      `${apply ? 'kill' : 'would kill'} ${target.pid} age=${target.ageSeconds}s ${target.command}`
    )
  console.log(`matched=${targets.length} kept=${kept.length} (${apply ? 'applied' : 'dry-run'})`)
  if (apply) {
    await Promise.allSettled(
      targets.map((target) => Promise.resolve(process.kill(target.pid, 'SIGTERM')))
    )
    await new Promise((done) => setTimeout(done, 1500))
    const after = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' })
    let skipped = 0
    for (const target of targets) {
      if (!revalidateTarget(after.stdout ?? '', target)) {
        skipped += 1
        continue
      }
      try {
        process.kill(target.pid, 0)
        process.kill(target.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    if (skipped > 0) console.log(`skipped-identity-mismatch=${skipped}`)
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
