import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRelayBundle } from '../../scripts/build-relay-bundle.mjs'
import { evidenceDir, makeTlsCerts, spawnService, type Service } from './harness.ts'
import { startContainerHarness, type ContainerHarness } from './helpers/relay-container-harness.ts'
import {
  collectRelayEvidence,
  runRelayInstallInContainer,
  type RelayEvidenceStep
} from './helpers/relay-container-runner.ts'

/**
 * U183 R14d: clean-container negative e2e IV (N8, no systemd). The image lacks
 * systemctl, so the installer must take the wrapper branch: relay online now,
 * no systemd unit, and stdout must say it does not start at boot instead of
 * printing systemctl --user commands. A real docker restart then proves the
 * wrapper really is not re-spawned, so the message matches reality.
 */

const INTERNAL_TOKEN = 'u183-r14d-internal-token'
// Debian Node 24 with bash/curl/openssl and no systemd (same image as R13c).
const CONTAINER_IMAGE = process.env.ORCA_E2E_RELAY_IMAGE ?? 'orca-e2e-node24-bookworm:local'
const RELAY_ROOT = '$HOME/.orca-cloud/relay'
const SYSTEMD_UNIT = '$HOME/.config/systemd/user/orca-relay.service'
const RESTART_PROBE_ATTEMPTS = 50

let api: Service
let harness: ContainerHarness
let bundleSha = ''
let bundleDir = ''
let certsDir = ''
let adminToken = ''
let caseDir = ''

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }
}

function stamp(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

/** One deterministic assertion, shaped like an install step so the runner records it. */
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

function relayRecord(
  relays: { id: string; online: boolean; installNonce: string; lastSeenAt: number }[],
  id: string
): { id: string; online: boolean; installNonce: string; lastSeenAt: number } | undefined {
  return relays.find((relay) => relay.id === id)
}

/** Writes the INVALID evidence record for a setup that cannot exercise N8. */
function collectInvalid(reason: string): string {
  collectRelayEvidence(caseDir, {
    task: 'U183 R14d clean-container no-systemd branch',
    harness: { available: false, skipReason: reason },
    steps: [skippedStep('install-relay-one-liner', reason)]
  })
  const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
    verdict: string | null
    skipReason: string | null
    validation: { ok: boolean }
  }
  assert.equal(summary.verdict, null)
  assert.equal(summary.skipReason, reason)
  assert.equal(summary.validation.ok, true, 'INVALID evidence must still validate')
  console.log(`[u183-r14d] INVALID (${reason}); evidence: ${caseDir}`)
  return caseDir
}

async function containerRunning(name: string): Promise<boolean> {
  for (let attempt = 0; attempt < RESTART_PROBE_ATTEMPTS; attempt += 1) {
    const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], {
      encoding: 'utf8',
      timeout: 15_000
    })
    if (inspect.status === 0 && inspect.stdout.trim() === 'true') {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

before(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'u183-r14d-bundles-'))
  const built = await buildRelayBundle({ outDir: bundleDir })
  bundleSha = built.bundleSha256
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_RELAY_BUNDLE_DIR: bundleDir,
      ORCA_RELAY_BUNDLE_SHA: bundleSha
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'u183-r14d-api'
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
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u183-r14d' })
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

test('U183 R14d: no-systemd container installs via wrapper and does not claim boot autostart', async () => {
  caseDir = evidenceDir(`u183-r14d-${stamp()}`)
  writeFileSync(
    join(caseDir, 'capabilities.json'),
    `${JSON.stringify(
      {
        image: harness.image,
        dockerVersion: harness.dockerVersion,
        ...harness.capabilities
      },
      null,
      2
    )}\n`
  )

  if (!harness.available) {
    collectInvalid(harness.skipReason ?? 'docker-unavailable')
    return
  }
  const containerName = harness.containerName
  const platformUrl = harness.platformUrl
  assert.ok(containerName, 'harness must expose a container name')
  assert.ok(platformUrl, 'harness platform URL must be available')

  // N8 only means anything on an image without systemd; prove it in-container.
  const systemctlProbe = await harness.execInContainer(
    `if command -v systemctl >/dev/null 2>&1; then ` +
      `echo "systemctl=$(command -v systemctl)"; ` +
      `systemctl --version 2>/dev/null | head -n 1 || true; ` +
      `else echo 'systemctl=absent'; fi`
  )
  writeFileSync(
    join(caseDir, 'systemctl-probe.txt'),
    `exit=${systemctlProbe.exitCode}\n${systemctlProbe.stdout}${systemctlProbe.stderr}`
  )
  const noSystemd =
    systemctlProbe.exitCode === 0 && systemctlProbe.stdout.includes('systemctl=absent')
  if (!noSystemd) {
    collectInvalid('systemctl-present-in-container')
    return
  }

  const tokenRes = await fetch(`${api.url}/v1/relays/install-tokens`, {
    method: 'POST',
    headers: authHeaders()
  })
  const tokenText = await tokenRes.text()
  assert.equal(tokenRes.status, 201, tokenText)
  const downloadToken = (JSON.parse(tokenText) as { downloadToken: string }).downloadToken
  const installUrl = `${platformUrl}/install/relay.sh?download=${encodeURIComponent(downloadToken)}`
  const oneLiner = `curl -fsSL "${installUrl}" -o "\${TMPDIR:-/tmp}/orca-install-$$.sh" && bash "\${TMPDIR:-/tmp}/orca-install-$$.sh" && rm -f "\${TMPDIR:-/tmp}/orca-install-$$.sh"`

  const install = await runRelayInstallInContainer({
    harness,
    installCommand: oneLiner,
    timeoutMs: 180_000
  })

  const envRead = await harness.execInContainer(`cat "${RELAY_ROOT}/relay.env" 2>/dev/null || true`)
  const relayId = readEnvValue(envRead.stdout, 'ORCA_CLOUD_RELAY_ID')
  const envNonce = readEnvValue(envRead.stdout, 'ORCA_CLOUD_INSTALL_NONCE')
  writeFileSync(join(caseDir, 'relay-env.redacted.txt'), redactEnv(envRead.stdout))

  const relaysRes = await fetch(`${api.url}/v1/relays`, { headers: authHeaders() })
  const relaysBody = (await relaysRes.json()) as {
    relays: { id: string; online: boolean; installNonce: string; lastSeenAt: number }[]
  }
  writeFileSync(join(caseDir, 'relays.json'), `${JSON.stringify(relaysBody, null, 2)}\n`)
  const record = relayRecord(relaysBody.relays, relayId)

  const currentRead = await harness.execInContainer(
    `readlink "${RELAY_ROOT}/current" 2>/dev/null || true`
  )
  writeFileSync(join(caseDir, 'current-link.txt'), currentRead.stdout)

  const processRead = await harness.execInContainer(
    `pid="$(cat "${RELAY_ROOT}/relay.pid" 2>/dev/null)"; printf 'pid=%s\\n' "$pid"; ` +
      `kill -0 "$pid" 2>/dev/null || exit 1; printf 'alive=1\\n'; ` +
      `tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null`
  )
  writeFileSync(
    join(caseDir, 'process.json'),
    `${JSON.stringify({ exitCode: processRead.exitCode, stdout: processRead.stdout }, null, 2)}\n`
  )

  const wrapperProbe = await harness.execInContainer(
    `w="${RELAY_ROOT}/run-relay.sh"; ` +
      `if [ ! -f "$w" ]; then echo 'exists=0'; exit 1; fi; ` +
      `echo 'exists=1'; echo "mode=$(stat -c '%a' "$w")"; head -n 1 "$w"`
  )
  writeFileSync(
    join(caseDir, 'wrapper-probe.txt'),
    `exit=${wrapperProbe.exitCode}\n${wrapperProbe.stdout}${wrapperProbe.stderr}`
  )

  const unitProbe = await harness.execInContainer(
    `u="${SYSTEMD_UNIT}"; if [ -e "$u" ]; then echo 'exists=1'; ls -l "$u"; else echo 'exists=0'; fi`
  )
  writeFileSync(
    join(caseDir, 'systemd-unit-probe.txt'),
    `exit=${unitProbe.exitCode}\n${unitProbe.stdout}${unitProbe.stderr}`
  )

  // Restart the real container; a wrapper-started relay must not come back.
  const restart = spawnSync('docker', ['restart', containerName], {
    encoding: 'utf8',
    timeout: 60_000
  })
  const restartRecord = {
    command: `docker restart ${containerName}`,
    status: restart.status,
    stdout: restart.stdout ?? '',
    stderr: restart.stderr ?? '',
    error: restart.error ? restart.error.message : null
  }
  let restartStep: RelayEvidenceStep
  if (restart.status !== 0) {
    restartStep = skippedStep(
      'relay-not-auto-started-after-restart',
      `docker restart unavailable: ${restartRecord.error ?? (restartRecord.stderr.trim() || `exit ${restart.status}`)}`
    )
  } else if (!(await containerRunning(containerName))) {
    // The harness runs with --rm; if Docker removed it there is nothing to exec.
    restartStep = skippedStep(
      'relay-not-auto-started-after-restart',
      'container-unavailable-after-restart'
    )
  } else {
    const postRestart = await harness.execInContainer(
      `alive=0; ` +
        // The bracket keeps this checker's own cmdline from matching the pattern.
        `for f in /proc/[0-9]*/cmdline; do ` +
        `  if tr '\\0' ' ' < "$f" 2>/dev/null | grep -Eq 'relay[.]ts'; then echo "relay-process:$f"; alive=1; fi; ` +
        `done; ` +
        `pid="$(cat "${RELAY_ROOT}/relay.pid" 2>/dev/null | tr -d '[:space:]')"; ` +
        `printf 'recorded-pid=%s\\n' "\${pid:-<empty>}"; ` +
        `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo 'recorded-pid-alive=1'; else echo 'recorded-pid-alive=0'; fi; ` +
        `if [ "$alive" = 0 ]; then echo 'no-relay-after-restart'; fi; exit $alive`
    )
    writeFileSync(
      join(caseDir, 'restart-after.json'),
      `${JSON.stringify(
        {
          restart: restartRecord,
          postRestart: {
            exitCode: postRestart.exitCode,
            stdout: postRestart.stdout,
            stderr: postRestart.stderr
          }
        },
        null,
        2
      )}\n`
    )
    restartStep = assertionStep(
      'relay-not-auto-started-after-restart',
      postRestart.exitCode === 0 && postRestart.stdout.includes('no-relay-after-restart'),
      {
        restart: restartRecord,
        postRestart: {
          exitCode: postRestart.exitCode,
          stdout: postRestart.stdout,
          stderr: postRestart.stderr
        }
      },
      `a relay.ts process survived docker restart: ${postRestart.stdout}${postRestart.stderr}`
    )
  }
  if (restartStep.skipped) {
    writeFileSync(
      join(caseDir, 'restart-after.json'),
      `${JSON.stringify({ restart: restartRecord, skipped: restartStep.skipReason }, null, 2)}\n`
    )
  }

  const installOk = install.exitCode === 0
  const relayOk =
    record !== undefined &&
    record.online === true &&
    envNonce.length > 0 &&
    record.installNonce === envNonce
  const currentOk = currentRead.stdout.trim() === `releases/${bundleSha}`
  const processOk =
    processRead.exitCode === 0 &&
    processRead.stdout.includes('alive=1') &&
    processRead.stdout.includes('relay.ts')
  const wrapperOk =
    wrapperProbe.exitCode === 0 &&
    wrapperProbe.stdout.includes('exists=1') &&
    wrapperProbe.stdout.includes('mode=700')
  const unitAbsent = unitProbe.exitCode === 0 && unitProbe.stdout.includes('exists=0')
  const noSystemctlUserCommand = !/systemctl\s+--user/.test(install.stdout)
  const noAutostartMessage =
    install.stdout.includes('未检测到 systemctl') &&
    install.stdout.includes('不随开机自启') &&
    install.stdout.includes('run-relay.sh')

  const steps: RelayEvidenceStep[] = [
    {
      name: 'container-lacks-systemctl',
      exitCode: 0,
      classification: 'ok',
      stdout: `${JSON.stringify({ probe: systemctlProbe }, null, 2)}\n`,
      stderr: '',
      durationMs: 0,
      timedOut: false,
      skipped: false
    },
    { name: 'install-relay-one-liner', ...install },
    { name: 'relay-not-auto-started-after-restart', ...restartStep },
    assertionStep(
      'relay-online-and-nonce-match',
      relayOk,
      { relayId, envNonce, platformRecord: record ?? null, status: relaysRes.status },
      `relay id=${relayId || '<empty>'} is not online with the install nonce from relay.env`
    ),
    assertionStep(
      'current-points-to-release',
      currentOk,
      { expected: `releases/${bundleSha}`, actual: currentRead.stdout.trim() },
      `current does not point at releases/${bundleSha}`
    ),
    assertionStep(
      'relay-process-alive',
      processOk,
      { exitCode: processRead.exitCode, stdout: processRead.stdout },
      'relay pid is missing, dead, or its cmdline does not run relay.ts'
    ),
    assertionStep(
      'wrapper-installed-mode-700',
      wrapperOk,
      { exitCode: wrapperProbe.exitCode, stdout: wrapperProbe.stdout, stderr: wrapperProbe.stderr },
      'run-relay.sh is missing or not chmod 700'
    ),
    assertionStep(
      'no-systemd-user-unit',
      unitAbsent,
      { exitCode: unitProbe.exitCode, stdout: unitProbe.stdout, stderr: unitProbe.stderr },
      `${SYSTEMD_UNIT} must not exist in the no-systemd branch`
    ),
    assertionStep(
      'stdout-has-no-systemctl-user-instructions',
      noSystemctlUserCommand,
      { stdout: install.stdout },
      'install stdout printed a systemctl --user command in the wrapper branch'
    ),
    assertionStep(
      'stdout-says-not-autostart',
      noAutostartMessage,
      { stdout: install.stdout },
      'install stdout is missing 未检测到 systemctl / 不随开机自启 / run-relay.sh'
    )
  ]

  collectRelayEvidence(caseDir, {
    task: 'U183 R14d clean-container no-systemd branch',
    harness,
    steps
  })

  const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
    verdict: string | null
    skipReason: string | null
    validation: { ok: boolean; issues: unknown[] }
  }
  assert.equal(summary.validation.ok, true, JSON.stringify(summary.validation.issues))

  // Assert every observable first, so a restart-support skip cannot mask a real defect.
  assert.ok(installOk, `installer exited ${install.exitCode}: ${install.stderr}`)
  assert.ok(relayOk, `platform record: ${JSON.stringify(record)}; envNonce: ${envNonce}`)
  assert.ok(currentOk, `current=${currentRead.stdout.trim()}`)
  assert.ok(processOk, processRead.stdout)
  assert.ok(wrapperOk, `${wrapperProbe.stdout}${wrapperProbe.stderr}`)
  assert.ok(unitAbsent, `systemd unit present: ${unitProbe.stdout}`)
  assert.ok(noSystemctlUserCommand, `stdout: ${install.stdout}`)
  assert.ok(noAutostartMessage, `stdout: ${install.stdout}`)
  if (summary.skipReason) {
    console.log(`[u183-r14d] INVALID (${summary.skipReason}); evidence: ${caseDir}`)
    return
  }
  assert.equal(summary.verdict, 'pass', 'evidence summary verdict must be pass')
  assert.equal(
    restartStep.exitCode,
    0,
    `restart check failed: ${restartStep.stderr || restartStep.skipReason || '<no detail>'}`
  )

  console.log(`[u183-r14d] PASS; evidence: ${caseDir}`)
})
