import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyRelayExitCode,
  collectRelayEvidence,
  createRelayEvidenceDir,
  relayEvidenceDirName,
  runRelayInstallInContainer,
  type RelayEvidenceStep,
  type RelayInstallRunResult
} from './helpers/relay-container-runner.ts'

/**
 * U183 R13b self-test. Uses a mock harness so it never starts Docker; the real
 * R13a fixture is exercised by relay-container-harness.e2e.test.ts.
 */

type MockHarness = {
  available: boolean
  skipReason?: string
  execInContainer: (command: string) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

function mockHarness(
  result: Awaited<ReturnType<MockHarness['execInContainer']>>
): MockHarness & { commands: string[] } {
  const commands: string[] = []
  return {
    available: true,
    commands,
    execInContainer: async (command) => {
      commands.push(command)
      return result
    }
  }
}

function unavailableHarness(skipReason = 'docker CLI not found on PATH'): MockHarness {
  return {
    available: false,
    skipReason,
    execInContainer: async () => {
      throw new Error('execInContainer must not run when the harness is unavailable')
    }
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'u183-container-evidence-'))
}

function stepFrom(name: string, result: RelayInstallRunResult): RelayEvidenceStep {
  return { name, ...result }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  assert.ok(isRecord(parsed), `${path} is not a JSON object`)
  return parsed
}

test('classifies every documented installer exit code', () => {
  const expected = new Map<number, string>([
    [0, 'ok'],
    [64, 'usage'],
    [65, 'unavailable'],
    [66, 'checksum'],
    [67, 'manifest'],
    [68, 'platform-unreachable'],
    [78, 'config'],
    [70, 'other'],
    [1, 'other'],
    [124, 'other']
  ])
  for (const [code, label] of expected) {
    assert.equal(classifyRelayExitCode(code), label, `exit ${code}`)
  }
})

test('runs the install command and preserves stream contents', async () => {
  const harness = mockHarness({ exitCode: 0, stdout: 'installed\n', stderr: 'warn\n' })
  const result = await runRelayInstallInContainer({
    harness,
    installCommand: 'bash -c "install relay"'
  })

  assert.deepEqual(harness.commands, ['bash -c "install relay"'])
  assert.equal(result.exitCode, 0)
  assert.equal(result.classification, 'ok')
  assert.equal(result.stdout, 'installed\n')
  assert.equal(result.stderr, 'warn\n')
  assert.equal(result.skipped, false)
  assert.equal(result.timedOut, false)
  assert.ok(result.durationMs >= 0)
})

test('maps a failing installer execution to its exit class', async () => {
  const harness = mockHarness({ exitCode: 66, stdout: '', stderr: 'sha mismatch\n' })
  const result = await runRelayInstallInContainer({ harness, installCommand: 'install' })

  assert.equal(result.exitCode, 66)
  assert.equal(result.classification, 'checksum')
  assert.equal(result.stderr, 'sha mismatch\n')
})

test('skips without executing when the harness is unavailable', async () => {
  const harness = unavailableHarness('image jlc-deb12:rust not present locally')
  const result = await runRelayInstallInContainer({ harness, installCommand: 'install' })

  assert.equal(result.skipped, true)
  assert.equal(result.exitCode, null)
  assert.equal(result.classification, 'skipped')
  assert.equal(result.skipReason, 'image jlc-deb12:rust not present locally')
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('bounds the wait and reports exit 124 on timeout', async () => {
  const harness: MockHarness = {
    available: true,
    execInContainer: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ exitCode: 0, stdout: 'late', stderr: '' }), 200)
      })
  }
  const result = await runRelayInstallInContainer({
    harness,
    installCommand: 'install',
    timeoutMs: 10
  })

  assert.equal(result.timedOut, true)
  assert.equal(result.exitCode, 124)
  assert.equal(result.classification, 'other')
  assert.match(result.stderr, /timed out after 10ms/)
})

test('rejects an empty install command', async () => {
  await assert.rejects(
    runRelayInstallInContainer({
      harness: mockHarness({ exitCode: 0, stdout: '', stderr: '' }),
      installCommand: '  '
    }),
    /must be non-empty/
  )
})

test('evidence dir follows the u183-container-<ts> convention', () => {
  const now = new Date('2026-11-17T10:11:12.345Z')
  assert.equal(relayEvidenceDirName(now), 'u183-container-20261117T101112Z')

  const root = tempDir()
  const dir = createRelayEvidenceDir({ root, now })
  assert.equal(dir, join(root, 'u183-container-20261117T101112Z'))
  assert.equal(existsSync(dir), true)
})

test('collectRelayEvidence writes summary/results plus raw logs for a pass', async () => {
  const run = await runRelayInstallInContainer({
    harness: mockHarness({ exitCode: 0, stdout: 'relay id: r1\n', stderr: '' }),
    installCommand: 'install'
  })
  const dir = join(tempDir(), 'pass-run')
  const evidence = collectRelayEvidence(dir, {
    generatedAt: '2026-11-17T10:11:12.345Z',
    harness: { available: true },
    steps: [stepFrom('install', run)]
  })

  assert.equal(evidence.verdict, 'pass')
  assert.equal(evidence.skipReason, null)
  assert.equal(evidence.validation.ok, true, JSON.stringify(evidence.validation.issues))
  assert.equal(evidence.validation.logFile, 'validate-evidence.log')

  const summary = readJson(join(dir, 'summary.json'))
  assert.equal(summary.generatedAt, '2026-11-17T10:11:12.345Z')
  assert.equal(summary.verdict, 'pass')
  assert.equal(summary.skipReason, null)
  assert.deepEqual(summary.steps, [
    { name: 'install', exitCode: 0, classification: 'ok', skipped: false }
  ])

  const results = readJson(join(dir, 'results.json'))
  assert.ok(isRecordArray(results.steps))
  assert.equal(results.steps[0].stdoutFile, '01-install.stdout.log')
  assert.equal(readFileSync(join(dir, '01-install.stdout.log'), 'utf8'), 'relay id: r1\n')
  assert.equal(readFileSync(join(dir, '01-install.stderr.log'), 'utf8'), '')
})

test('collectRelayEvidence records fail with the offending step exit code', async () => {
  const run = await runRelayInstallInContainer({
    harness: mockHarness({ exitCode: 68, stdout: '', stderr: 'health 500\n' }),
    installCommand: 'install'
  })
  const dir = join(tempDir(), 'fail-run')
  const evidence = collectRelayEvidence(dir, {
    harness: { available: true },
    steps: [stepFrom('install', run)]
  })

  assert.equal(evidence.verdict, 'fail')
  const summary = readJson(join(dir, 'summary.json'))
  assert.deepEqual(summary.steps, [
    { name: 'install', exitCode: 68, classification: 'platform-unreachable', skipped: false }
  ])
  assert.equal(readFileSync(join(dir, '01-install.stderr.log'), 'utf8'), 'health 500\n')
})

test('collectRelayEvidence yields verdict=null and a skipReason when the harness is unavailable', () => {
  const harness = unavailableHarness('docker daemon unavailable')
  const skipped = {
    name: 'install',
    exitCode: null,
    classification: 'skipped' as const,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    skipped: true,
    skipReason: 'docker daemon unavailable'
  }
  const dir = join(tempDir(), 'skip-run')
  const evidence = collectRelayEvidence(dir, { harness, steps: [skipped] })

  assert.equal(evidence.verdict, null)
  assert.equal(evidence.skipReason, 'docker daemon unavailable')
  assert.equal(evidence.validation.ok, true)

  const summary = readJson(join(dir, 'summary.json'))
  assert.equal(summary.verdict, null)
  assert.equal(summary.skipReason, 'docker daemon unavailable')
})

test('a skipped step also forces verdict=null without a harness object', () => {
  const dir = join(tempDir(), 'skip-step')
  const evidence = collectRelayEvidence(dir, {
    steps: [
      {
        name: 'install',
        exitCode: null,
        classification: 'skipped',
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        skipped: true,
        skipReason: 'container tools not ready'
      }
    ]
  })
  assert.equal(evidence.verdict, null)
  assert.equal(evidence.skipReason, 'container tools not ready')
})

test('rejects evidence collection without steps', () => {
  assert.throws(() => collectRelayEvidence(tempDir(), { steps: [] }), /at least one step/)
})

// Discriminative power: the automatic validator must reject a summary without generatedAt,
// so a collectRelayEvidence() that stopped writing it would go red here.
test('validate-evidence rejects a summary without generatedAt', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'summary.json'), '{"verdict":"pass"}')
  writeFileSync(join(dir, 'results.json'), '{"steps":[]}')
  const script = fileURLToPath(new URL('../../scripts/validate-evidence.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, dir, '--check-generated-at', '--json'], {
    encoding: 'utf8'
  })
  assert.equal(result.status, 1)
  const parsed: unknown = JSON.parse(result.stdout)
  assert.ok(isRecord(parsed))
  assert.equal(parsed.ok, false)
  assert.ok(isRecordArray(parsed.issues))
  assert.deepEqual(
    parsed.issues.map((issue) => issue.code),
    ['summary-generated-at-missing']
  )
})
