import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRelayBundle } from '../../scripts/build-relay-bundle.mjs'
import { evidenceDir, makeTlsCerts, spawnService, type Service } from './harness.ts'
import { startContainerHarness, type ContainerHarness } from './helpers/relay-container-harness.ts'
import {
  classifyRelayExitCode,
  collectRelayEvidence,
  runRelayInstallInContainer,
  type RelayEvidenceStep,
  type RelayInstallRunResult
} from './helpers/relay-container-runner.ts'

/**
 * U183 R14c: clean-container negative e2e III, reusing the R13c TLS/evidence
 * setup. N5 installs a bundle whose relay exits at startup: a fresh install has
 * no previous release (exit 69), an upgrade rolls back (exit 70 rollback=ok).
 * N7 races two installers on one root: exactly one wins the mkdir lock, the
 * other must exit 75 relay_install_busy. A serialized race is INVALID, not a
 * fabricated pass.
 */

const INTERNAL_TOKEN = 'u183-r14c-internal-token'
const CONTAINER_IMAGE = process.env.ORCA_E2E_RELAY_IMAGE ?? 'orca-e2e-node24-bookworm:local'
// Distinct ports isolate the per-root relay ids (hostname:port) on one platform.
const N5_FRESH_ROOT = '$HOME/.orca-cloud/relay-n5a'
const N5_FRESH_PORT = '18451'
const N5_UPGRADE_ROOT = '$HOME/.orca-cloud/relay-n5b'
const N5_UPGRADE_PORT = '18452'
const N7_ROOT = '$HOME/.orca-cloud/relay-n7'
const N7_PORT = '18453'

let api: Service
let harness: ContainerHarness
let normalSha = ''
let crashSha = ''
let bundleDir = ''
let certsDir = ''
let adminToken = ''
let caseDir = ''

type RelayRecord = {
  id: string
  online: boolean
  installNonce: string
  lastSeenAt: number
}

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }
}

function stamp(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

function assertionStep(
  name: string,
  ok: boolean,
  details: unknown,
  failure: string
): RelayEvidenceStep {
  return {
    name,
    exitCode: ok ? 0 : 1,
    classification: ok ? 'ok' : 'other',
    stdout: `${JSON.stringify(details, null, 2)}\n`,
    stderr: ok ? '' : `${failure}\n`,
    durationMs: 0,
    timedOut: false,
    skipped: false
  }
}

function skippedStep(name: string, reason: string): RelayEvidenceStep {
  return {
    name,
    exitCode: null,
    classification: 'skipped',
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    skipped: true,
    skipReason: reason
  }
}

/** The `>>` progress lines plus exit/rollback markers, for the evidence report. */
function keyStderrLines(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('>>') || /rollback=/.test(line))
}

function readEnvValue(envText: string, key: string): string {
  for (const line of envText.split('\n')) {
    if (line.startsWith(`${key}=`)) {
      return line.slice(key.length + 1).trim()
    }
  }
  return ''
}

function redactEnv(envText: string): string {
  return envText.replaceAll(INTERNAL_TOKEN, '<redacted>')
}

function relayRecord(relays: RelayRecord[], id: string): RelayRecord | undefined {
  return relays.find((relay) => relay.id === id)
}

async function readRelays(): Promise<{ status: number; relays: RelayRecord[] }> {
  const res = await fetch(`${api.url}/v1/relays`, { headers: authHeaders() })
  const body = (await res.json()) as { relays: RelayRecord[] }
  return { status: res.status, relays: body.relays ?? [] }
}

async function readContainerEnv(root: string): Promise<string> {
  const env = await harness.execInContainer(`cat "${root}/relay.env" 2>/dev/null || true`)
  return env.stdout
}

async function createInstallUrl(sha: string | null): Promise<string> {
  const res = await fetch(`${api.url}/v1/relays/install-tokens`, {
    method: 'POST',
    headers: authHeaders()
  })
  const text = await res.text()
  assert.equal(res.status, 201, text)
  const { downloadToken } = JSON.parse(text) as { downloadToken: string }
  assert.ok(harness.platformUrl, 'harness platform URL must be available')
  const shaQuery = sha ? `&sha=${sha}` : ''
  return `${harness.platformUrl}/install/relay.sh?download=${encodeURIComponent(downloadToken)}${shaQuery}`
}

async function downloadInstallScript(installUrl: string, dest: string): Promise<void> {
  const prep = await harness.execInContainer(`curl -fsSL '${installUrl}' -o '${dest}'`)
  assert.equal(prep.exitCode, 0, `could not download install script: ${prep.stderr}`)
}

function runInstall(
  root: string,
  port: string,
  scriptPath: string,
  timeoutMs = 120_000
): Promise<RelayInstallRunResult> {
  return runRelayInstallInContainer({
    harness,
    installCommand: `PORT=${port} ORCA_RELAY_ROOT=${root} bash ${scriptPath}`,
    timeoutMs
  })
}

/** Writes the crash bundle to the platform's bundle dir, like R15's serveBundle. */
function serveBundle(bundle: { bytes: Buffer; sha: string }): void {
  writeFileSync(join(bundleDir, `relay-bundle-${bundle.sha}.tgz`), bundle.bytes)
  writeFileSync(
    join(bundleDir, `relay-bundle-${bundle.sha}.manifest.json`),
    JSON.stringify(
      {
        bundleSha256: bundle.sha,
        schemaVersion: 1,
        relayCodeVersion: '0.1.0',
        files: ['VERSION', 'apps/relay/src/relay.ts']
      },
      null,
      2
    )
  )
}

/** Minimal extractable relay tree for tar fixtures (install-wizard R11b shape). */
function seedRelaySource(dir: string): void {
  mkdirSync(join(dir, 'apps/relay/src'), { recursive: true })
  mkdirSync(join(dir, 'packages/contract/src'), { recursive: true })
  writeFileSync(join(dir, 'VERSION'), '{"schemaVersion":1,"relayCodeVersion":"0.1.0"}\n')
  writeFileSync(join(dir, 'apps/relay/src/relay.ts'), `// relay ${dir}\n`)
  writeFileSync(join(dir, 'packages/contract/src/internal-fetch.ts'), '// internal-fetch\n')
}

/** Builds a real tgz whose relay entry is replaced by `relaySource`. */
function buildCrashBundle(relaySource: string): { bytes: Buffer; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'u183-r14c-bundle-src-'))
  const out = join(mkdtempSync(join(tmpdir(), 'u183-r14c-bundle-out-')), 'bundle.tgz')
  seedRelaySource(dir)
  writeFileSync(join(dir, 'apps/relay/src/relay.ts'), relaySource)
  // macOS Node writes com.apple.provenance xattrs; GNU tar would unpack the
  // AppleDouble ._* sidecars and reject them as non-whitelisted top-level files.
  const tar = spawnSync('tar', ['-czf', out, '-C', dir, 'VERSION', 'apps', 'packages'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' }
  })
  assert.equal(tar.status, 0, tar.stderr)
  const bytes = readFileSync(out)
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') }
}

/** Relay.pid/process/current facts, so a start failure is proven, not assumed. */
async function inspectInstall(root: string): Promise<{
  pid: string
  pidAlive: boolean
  processes: string
  current: string
  previous: string
  releases: string
  envExists: boolean
  lockExists: boolean
}> {
  const probe = await harness.execInContainer(
    [
      `pid="$(cat "${root}/relay.pid" 2>/dev/null | tr -d '[:space:]')"`,
      `printf 'pid=%s\\n' "$pid"`,
      `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo 'pid_alive=1'; else echo 'pid_alive=0'; fi`,
      `printf 'current=%s\\n' "$(readlink "${root}/current" 2>/dev/null || true)"`,
      `printf 'previous=%s\\n' "$(readlink "${root}/previous" 2>/dev/null || true)"`,
      `printf 'releases=%s\\n' "$(ls -1 "${root}/releases" 2>/dev/null | tr '\\n' ' ')"`,
      `if [ -f "${root}/relay.env" ]; then echo 'env=1'; else echo 'env=0'; fi`,
      `if [ -d "${root}/.install.lock" ]; then echo 'lock=1'; else echo 'lock=0'; fi`,
      'for f in /proc/[0-9]*/cmdline; do',
      // Match the relay entry, not just the root: this probe's own cmdline
      // contains the root path in its cat/ls arguments.
      `  if tr '\\0' ' ' < "$f" 2>/dev/null | grep -Eq 'relay-n5[ab]/current/apps/relay/src/relay[.]ts|relay-n7/current/apps/relay/src/relay[.]ts'; then echo "process:$f:$(tr '\\0' ' ' < "$f" 2>/dev/null)"; fi`,
      'done'
    ].join('\n')
  )
  const field = (key: string): string =>
    probe.stdout
      .split('\n')
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? ''
  return {
    pid: field('pid'),
    pidAlive: field('pid_alive') === '1',
    processes: probe.stdout
      .split('\n')
      .filter((line) => line.startsWith('process:'))
      .join('\n'),
    current: field('current'),
    previous: field('previous'),
    releases: field('releases'),
    envExists: field('env') === '1',
    lockExists: field('lock') === '1'
  }
}

before(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'u183-r14c-bundles-'))
  const built = await buildRelayBundle({ outDir: bundleDir })
  normalSha = built.bundleSha256
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_RELAY_BUNDLE_DIR: bundleDir,
      ORCA_RELAY_BUNDLE_SHA: normalSha
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'u183-r14c-api'
  )
  const certs = makeTlsCerts({
    commonName: 'host.docker.internal',
    subjectAltName: 'DNS:host.docker.internal',
    trustAnchor: true
  })
  certsDir = certs.dir
  harness = await startContainerHarness({
    platformPort: api.port,
    image: CONTAINER_IMAGE,
    tls: { key: certs.key, cert: certs.cert }
  })

  if (harness.available) {
    const login = await fetch(`${api.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u183-r14c' })
    })
    const loginText = await login.text()
    assert.equal(login.status, 200, loginText)
    adminToken = (JSON.parse(loginText) as { accessToken: string }).accessToken
  }
})

after(async () => {
  await harness?.stop()
  await api?.stop()
  if (certsDir) {
    rmSync(certsDir, { recursive: true, force: true })
  }
  if (caseDir) {
    const ps = spawnSync(
      'docker',
      ['ps', '-a', '--filter', 'name=relay-e2e-', '--format', '{{.Names}}'],
      { encoding: 'utf8', timeout: 15_000 }
    )
    writeFileSync(
      join(caseDir, 'docker-ps-after.txt'),
      `docker ps -a --filter name=relay-e2e- --format '{{.Names}}'\n` +
        `${ps.stdout ?? ''}${ps.stderr ?? ''}`
    )
  }
})

test('U183 R14c: startup-crash installs and concurrent installs fail closed', async () => {
  caseDir = evidenceDir(`u183-r14c-${stamp()}`)

  writeFileSync(
    join(caseDir, 'capabilities.json'),
    `${JSON.stringify(
      {
        image: harness.image,
        dockerVersion: harness.dockerVersion,
        ...harness.capabilities,
        normalBundleSha: normalSha
      },
      null,
      2
    )}\n`
  )

  if (!harness.available) {
    const reason = harness.skipReason ?? 'docker-unavailable'
    collectRelayEvidence(caseDir, {
      task: 'U183 R14c clean-container install negatives III',
      harness: { available: false, skipReason: reason },
      steps: [
        skippedStep('n5-fresh-crash-install', reason),
        skippedStep('n5-upgrade-rollback', reason),
        skippedStep('n7-concurrent-install-lock', reason)
      ]
    })
    const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
      verdict: string | null
      validation: { ok: boolean }
    }
    assert.equal(summary.verdict, null)
    assert.equal(summary.validation.ok, true, 'INVALID evidence must still validate')
    console.log(`[u183-r14c] INVALID (${reason}); evidence: ${caseDir}`)
    return
  }

  // ---- N5a: fresh install of a bundle whose relay exits at startup ----
  const crashBundle = buildCrashBundle('process.exit(1)\n')
  crashSha = crashBundle.sha
  serveBundle(crashBundle)

  const freshScriptUrl = await createInstallUrl(crashSha)
  await downloadInstallScript(freshScriptUrl, '/tmp/n5a-install.sh')
  const freshRun = await runInstall(N5_FRESH_ROOT, N5_FRESH_PORT, '/tmp/n5a-install.sh')
  const freshFacts = await inspectInstall(N5_FRESH_ROOT)
  const freshEnv = await readContainerEnv(N5_FRESH_ROOT)
  const freshRelayId = readEnvValue(freshEnv, 'ORCA_CLOUD_RELAY_ID')
  const freshRelays = await readRelays()
  const freshRecord = relayRecord(freshRelays.relays, freshRelayId)
  const freshExitOk = freshRun.exitCode === 69 || freshRun.exitCode === 70
  const freshNoOnline = freshRecord === undefined
  const freshNoService =
    !freshFacts.pidAlive && freshFacts.processes.length === 0 && freshFacts.lockExists === false

  writeFileSync(
    join(caseDir, 'n5-fresh.json'),
    `${JSON.stringify(
      {
        command: `PORT=${N5_FRESH_PORT} ORCA_RELAY_ROOT=${N5_FRESH_ROOT} bash /tmp/n5a-install.sh`,
        bundleSha: crashSha,
        exitCode: freshRun.exitCode,
        classification: classifyRelayExitCode(freshRun.exitCode ?? -1),
        durationMs: freshRun.durationMs,
        keyStderrLines: keyStderrLines(freshRun.stderr),
        stdout: freshRun.stdout,
        stderr: freshRun.stderr,
        env: redactEnv(freshEnv),
        facts: freshFacts,
        platformRelays: freshRelays.relays,
        record: freshRecord ?? null
      },
      null,
      2
    )}\n`
  )

  // ---- N5b: upgrade to the crash bundle rolls back to the previous release ----
  const normalScriptUrl = await createInstallUrl(null)
  await downloadInstallScript(normalScriptUrl, '/tmp/n5b-install.sh')
  const firstInstall = await runInstall(N5_UPGRADE_ROOT, N5_UPGRADE_PORT, '/tmp/n5b-install.sh')
  const firstEnv = await readContainerEnv(N5_UPGRADE_ROOT)
  const firstRelayId = readEnvValue(firstEnv, 'ORCA_CLOUD_RELAY_ID')
  const firstNonce = readEnvValue(firstEnv, 'ORCA_CLOUD_INSTALL_NONCE')
  const firstRelays = await readRelays()
  const firstRecord = relayRecord(firstRelays.relays, firstRelayId)
  const firstOk =
    firstInstall.exitCode === 0 &&
    firstRecord?.online === true &&
    firstNonce.length > 0 &&
    firstRecord.installNonce === firstNonce

  const crashScriptUrl = await createInstallUrl(crashSha)
  await downloadInstallScript(crashScriptUrl, '/tmp/n5b-crash-install.sh')
  const upgradeRun = await runInstall(
    N5_UPGRADE_ROOT,
    N5_UPGRADE_PORT,
    '/tmp/n5b-crash-install.sh'
  )
  const upgradeFacts = await inspectInstall(N5_UPGRADE_ROOT)
  const upgradeEnv = await readContainerEnv(N5_UPGRADE_ROOT)
  const upgradeRelayId = readEnvValue(upgradeEnv, 'ORCA_CLOUD_RELAY_ID')
  const upgradeNonce = readEnvValue(upgradeEnv, 'ORCA_CLOUD_INSTALL_NONCE')
  const upgradeRelays = await readRelays()
  const upgradeRecord = relayRecord(upgradeRelays.relays, upgradeRelayId)
  const upgradeRollbackOk =
    upgradeRun.exitCode === 70 && /rollback=ok/.test(upgradeRun.stderr)
  const upgradeCurrentOk = upgradeFacts.current === `releases/${normalSha}`
  const upgradeOnlineOk =
    upgradeRecord?.online === true &&
    upgradeNonce.length > 0 &&
    upgradeNonce !== firstNonce &&
    upgradeRecord.installNonce === upgradeNonce

  writeFileSync(
    join(caseDir, 'n5-upgrade.json'),
    `${JSON.stringify(
      {
        firstInstall: {
          command: `PORT=${N5_UPGRADE_PORT} ORCA_RELAY_ROOT=${N5_UPGRADE_ROOT} bash /tmp/n5b-install.sh`,
          bundleSha: normalSha,
          exitCode: firstInstall.exitCode,
          durationMs: firstInstall.durationMs,
          keyStderrLines: keyStderrLines(firstInstall.stderr),
          stdout: firstInstall.stdout,
          stderr: firstInstall.stderr,
          env: redactEnv(firstEnv),
          record: firstRecord ?? null
        },
        crashUpgrade: {
          command: `PORT=${N5_UPGRADE_PORT} ORCA_RELAY_ROOT=${N5_UPGRADE_ROOT} bash /tmp/n5b-crash-install.sh`,
          bundleSha: crashSha,
          exitCode: upgradeRun.exitCode,
          classification: classifyRelayExitCode(upgradeRun.exitCode ?? -1),
          durationMs: upgradeRun.durationMs,
          keyStderrLines: keyStderrLines(upgradeRun.stderr),
          stdout: upgradeRun.stdout,
          stderr: upgradeRun.stderr
        },
        after: {
          env: redactEnv(upgradeEnv),
          facts: upgradeFacts,
          platformRelays: upgradeRelays.relays,
          record: upgradeRecord ?? null
        }
      },
      null,
      2
    )}\n`
  )

  // Stop the rolled-back relay before N7 so no stale announcer races its id.
  await harness.execInContainer(
    `pid="$(cat "${N5_UPGRADE_ROOT}/relay.pid" 2>/dev/null || true)"; ` +
      `if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi; echo stopped`
  )

  // ---- N7: two installers on one root race the mkdir lock ----
  type RoundRun = RelayInstallRunResult & {

    tag: string
    startedAt: number
    finishedAt: number
  }
  type Round = { round: number; runs: RoundRun[]; valid: boolean; detail: string }

  const concurrencyScriptUrl = await createInstallUrl(normalSha)
  await downloadInstallScript(concurrencyScriptUrl, '/tmp/n7-install.sh')
  const rounds: Round[] = []
  for (let round = 1; round <= 3; round += 1) {
    const launch = (tag: string): Promise<RoundRun> => {
      const startedAt = Date.now()
      return runInstall(N7_ROOT, N7_PORT, '/tmp/n7-install.sh').then((result) => ({
        ...result,
        tag,
        startedAt,
        finishedAt: Date.now()
      }))
    }
    const runs = await Promise.all([launch('a'), launch('b')])
    const codes = runs.map((run) => run.exitCode)
    const zeros = codes.filter((code) => code === 0).length
    const busy = runs.filter((run) => run.exitCode === 75)
    const valid =
      zeros === 1 &&
      busy.length === 1 &&
      /relay_install_busy/.test(busy[0]?.stderr ?? '')
    rounds.push({
      round,
      runs,
      valid,
      detail: `codes=${JSON.stringify(codes)}`
    })
    // A serialized race (both 0) makes the lock assertion unobservable; stop.
    if (!valid) {
      break
    }
    const lock = await inspectInstall(N7_ROOT)
    if (lock.lockExists) {
      const latest = rounds.at(-1)
      if (latest) {
        latest.valid = false
        latest.detail += ' residual-lock'
      }
      break
    }
  }
  const concurrencyValid = rounds.length > 0 && rounds.every((round) => round.valid)
  const invalidSerialized = rounds.some(
    (round) => round.runs.every((run) => run.exitCode === 0)
  )
  const n7Env = await readContainerEnv(N7_ROOT)
  const n7RelayId = readEnvValue(n7Env, 'ORCA_CLOUD_RELAY_ID')
  const n7Nonce = readEnvValue(n7Env, 'ORCA_CLOUD_INSTALL_NONCE')
  const n7Relays = await readRelays()
  const n7Record = relayRecord(n7Relays.relays, n7RelayId)
  const n7OnlineOk =
    n7Record?.online === true && n7Nonce.length > 0 && n7Record.installNonce === n7Nonce
  const n7LockAfter = await inspectInstall(N7_ROOT)

  writeFileSync(
    join(caseDir, 'n7-concurrency.json'),
    `${JSON.stringify(
      {
        command: `Promise.all(${N7_ROOT} x2, PORT=${N7_PORT})`,
        bundleSha: normalSha,
        rounds: rounds.map((round) => ({
          round: round.round,
          valid: round.valid,
          detail: round.detail,
          runs: round.runs.map((run) => ({
            tag: run.tag,
            exitCode: run.exitCode,
            classification: run.classification,
            startedAt: new Date(run.startedAt).toISOString(),
            finishedAt: new Date(run.finishedAt).toISOString(),
            startedAtMs: run.startedAt,
            finishedAtMs: run.finishedAt,
            durationMs: run.durationMs,
            stdout: run.stdout,
            stderr: run.stderr
          }))
        })),
        serialized: invalidSerialized,
        after: {
          env: redactEnv(n7Env),
          facts: n7LockAfter,
          platformRelays: n7Relays.relays,
          record: n7Record ?? null
        }
      },
      null,
      2
    )}\n`
  )

  const steps: RelayEvidenceStep[] = [
    assertionStep(
      'n5-fresh-crash-install-exit-69-or-70',
      freshExitOk,
      {
        expectedExitCodes: [69, 70],
        actualExitCode: freshRun.exitCode,
        classification: classifyRelayExitCode(freshRun.exitCode ?? -1),
        keyStderrLines: keyStderrLines(freshRun.stderr)
      },
      `fresh crash install produced exit ${freshRun.exitCode}, expected 69 (start) or 70 (proof)`
    ),
    assertionStep(
      'n5-fresh-crash-no-online-no-service',
      freshNoOnline && freshNoService,
      {
        relayId: freshRelayId,
        record: freshRecord ?? null,
        platformRelayCount: freshRelays.relays.length,
        facts: freshFacts
      },
      `fresh crash install left an online registration or a live relay: ${JSON.stringify({
        record: freshRecord ?? null,
        facts: freshFacts
      })}`
    ),
    assertionStep(
      'n5-upgrade-first-install-online',
      firstOk,
      {
        exitCode: firstInstall.exitCode,
        relayId: firstRelayId,
        nonce: firstNonce,
        record: firstRecord ?? null,
        keyStderrLines: keyStderrLines(firstInstall.stderr)
      },
      `baseline install did not come online: exit=${firstInstall.exitCode} record=${JSON.stringify(
        firstRecord
      )}`
    ),
    assertionStep(
      'n5-upgrade-crash-exit-70-rollback-ok',
      upgradeRollbackOk,
      {
        expectedExitCode: 70,
        actualExitCode: upgradeRun.exitCode,
        classification: classifyRelayExitCode(upgradeRun.exitCode ?? -1),
        keyStderrLines: keyStderrLines(upgradeRun.stderr)
      },
      `crash upgrade produced exit ${upgradeRun.exitCode} without rollback=ok`
    ),
    assertionStep(
      'n5-upgrade-current-restored',
      upgradeCurrentOk,
      {
        expected: `releases/${normalSha}`,
        current: upgradeFacts.current,
        previous: upgradeFacts.previous,
        releases: upgradeFacts.releases
      },
      `current did not return to the previous release: ${upgradeFacts.current}`
    ),
    assertionStep(
      'n5-upgrade-online-with-crash-install-nonce',
      upgradeOnlineOk,
      {
        relayId: upgradeRelayId,
        nonce: upgradeNonce,
        previousNonce: firstNonce,
        record: upgradeRecord ?? null,
        facts: upgradeFacts
      },
      `rolled-back relay is not online with the crash install nonce: ${JSON.stringify({
        record: upgradeRecord ?? null,
        nonce: upgradeNonce
      })}`
    ),
    concurrencyValid
      ? assertionStep(
          'n7-concurrent-install-one-x0-one-x75',
          true,
          { rounds: rounds.map((round) => round.detail), roundCount: rounds.length },
          ''
        )
      : skippedStep(
          'n7-concurrent-install-one-x0-one-x75',
          invalidSerialized ? 'concurrent installs serialized (both exit 0)' : 'lock pair unobserved'
        ),
    assertionStep(
      'n7-relay-online-and-lock-released',
      n7OnlineOk && !n7LockAfter.lockExists,
      {
        relayId: n7RelayId,
        nonce: n7Nonce,
        record: n7Record ?? null,
        lockExists: n7LockAfter.lockExists,
        facts: n7LockAfter
      },
      `N7 relay is not online with its install nonce or the lock survived`
    )
  ]

  collectRelayEvidence(caseDir, {
    task: 'U183 R14c clean-container install negatives III',
    harness,
    steps
  })

  const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
    verdict: string | null
    validation: { ok: boolean; issues: unknown[] }
  }
  assert.equal(summary.validation.ok, true, JSON.stringify(summary.validation.issues))

  assert.ok(
    freshExitOk,
    `N5a expected exit 69/70, got ${freshRun.exitCode}: ${freshRun.stderr}`
  )
  assert.ok(freshNoOnline, `N5a left an online record: ${JSON.stringify(freshRecord)}`)
  assert.ok(freshNoService, `N5a left a live relay or lock: ${JSON.stringify(freshFacts)}`)
  assert.ok(firstOk, `N5b baseline install failed: ${firstInstall.stderr}`)
  assert.ok(
    upgradeRollbackOk,
    `N5b expected exit 70 + rollback=ok, got ${upgradeRun.exitCode}: ${upgradeRun.stderr}`
  )
  assert.ok(upgradeCurrentOk, `N5b current=${upgradeFacts.current}`)
  assert.ok(upgradeOnlineOk, `N5b record: ${JSON.stringify(upgradeRecord)}`)
  assert.ok(n7OnlineOk, `N7 record: ${JSON.stringify(n7Record)}`)

  if (concurrencyValid) {
    assert.equal(summary.verdict, 'pass', 'evidence summary verdict must be pass')
  } else {
    assert.equal(summary.verdict, null, 'INVALID concurrency evidence must not claim pass')
    console.log(
      `[u183-r14c] INVALID (N7 lock pair unobserved); evidence: ${caseDir}`
    )
    return
  }

  console.log(`[u183-r14c] PASS; evidence: ${caseDir}`)
})
