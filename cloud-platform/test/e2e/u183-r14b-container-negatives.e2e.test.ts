import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRelayBundle } from '../../scripts/build-relay-bundle.mjs'
import { evidenceDir, makeTlsCerts, spawnService, type Service } from './harness.ts'
import { startContainerHarness, type ContainerHarness } from './helpers/relay-container-harness.ts'
import {
  classifyRelayExitCode,
  collectRelayEvidence,
  runRelayInstallInContainer,
  type RelayEvidenceStep
} from './helpers/relay-container-runner.ts'

/**
 * U183 R14b: clean-container negative e2e II. N2 makes /health answer 500 (the
 * endpoint is reachable but unhealthy) so the installer must exit 68, not treat
 * a non-2xx as online; N6 corrupts the embedded internal token so self-proof
 * gets 401 and exits 70 without a rollback attempt. N2 uses the 500 branch
 * rather than a closed port because it pins the "reachable but non-2xx" rule
 * instead of the trivially-unreachable 000 branch.
 */

const INTERNAL_TOKEN = 'u183-r14b-internal-token'
const WRONG_INTERNAL_TOKEN = 'u183-r14b-wrong-internal-token'
// Debian Node 24 with bash/curl/openssl (same image as R13c/R14a).
const NODE_IMAGE = process.env.ORCA_E2E_RELAY_IMAGE ?? 'orca-e2e-node24-bookworm:local'
const N2_ROOT = '$HOME/.orca-cloud/relay-n2'
const N6_ROOT = '$HOME/.orca-cloud/relay-n6'

let api: Service
let harness: ContainerHarness
let bundleSha = ''
let bundleDir = ''
let certsDir = ''
let adminToken = ''
let caseDir = ''
let health500: Server | null = null
let health500Port = 0

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

/** Fails when any install artifact, lock, or relay process survives under `root`. */
function sideEffectCheckCommand(root: string): string {
  return [
    `root="${root}"`,
    'fail=0',
    'for p in relay.env releases current relay.pid .install.lock; do',
    '  if [ -e "$root/$p" ] || [ -L "$root/$p" ]; then echo "unexpected:$p"; fail=1; fi',
    'done',
    'for f in /proc/[0-9]*/cmdline; do',
    // The bracket keeps this checker's own cmdline from matching the pattern.
    `  if tr '\\0' ' ' < "$f" 2>/dev/null | grep -Eq 'relay[.]ts'; then echo "unexpected-process:$f"; fail=1; fi`,
    'done',
    'echo "--- install root listing ---"',
    'ls -A "$root" 2>/dev/null || echo "<root absent>"',
    'exit $fail'
  ].join('\n')
}

/** Host endpoint that answers 500 on /health and 404 elsewhere; reachable from the container. */
async function startHealth500Endpoint(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"ok":false}\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, port }
}

async function createInstallUrl(): Promise<string> {
  const res = await fetch(`${api.url}/v1/relays/install-tokens`, {
    method: 'POST',
    headers: authHeaders()
  })
  const text = await res.text()
  assert.equal(res.status, 201, text)
  const { downloadToken } = JSON.parse(text) as { downloadToken: string }
  assert.ok(harness.platformUrl, 'harness platform URL must be available')
  return `${harness.platformUrl}/install/relay.sh?download=${encodeURIComponent(downloadToken)}`
}

function writeCaseJson(name: string, value: unknown): void {
  writeFileSync(join(caseDir, name), `${JSON.stringify(value, null, 2)}\n`)
}

before(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'u183-r14b-bundles-'))
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
    'u183-r14b-api'
  )
  const certs = makeTlsCerts({
    commonName: 'host.docker.internal',
    subjectAltName: 'DNS:host.docker.internal',
    trustAnchor: true
  })
  certsDir = certs.dir
  harness = await startContainerHarness({
    platformPort: api.port,
    image: NODE_IMAGE,
    tls: { key: certs.key, cert: certs.cert }
  })

  if (harness.available) {
    const login = await fetch(`${api.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u183-r14b' })
    })
    const loginText = await login.text()
    assert.equal(login.status, 200, loginText)
    adminToken = (JSON.parse(loginText) as { accessToken: string }).accessToken
  }
})

after(async () => {
  await harness?.stop()
  await api?.stop()
  if (health500) {
    await new Promise<void>((resolve) => health500?.close(() => resolve()))
  }
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

test('U183 R14b: unhealthy platform and bad internal token fail closed', async () => {
  caseDir = evidenceDir(`u183-r14b-${stamp()}`)

  const capabilities = {
    image: harness.image,
    dockerVersion: harness.dockerVersion,
    ...harness.capabilities
  }
  writeFileSync(join(caseDir, 'capabilities.json'), `${JSON.stringify(capabilities, null, 2)}\n`)

  if (!harness.available) {
    const reason = harness.skipReason ?? 'docker-unavailable'
    collectRelayEvidence(caseDir, {
      task: 'U183 R14b clean-container install negatives II',
      harness: { available: false, skipReason: reason },
      steps: [skippedStep('n2-health-500', reason), skippedStep('n6-wrong-internal-token', reason)]
    })
    const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
      verdict: string | null
      validation: { ok: boolean }
    }
    assert.equal(summary.verdict, null)
    assert.equal(summary.validation.ok, true, 'INVALID evidence must still validate')
    console.log(`[u183-r14b] INVALID (${reason}); evidence: ${caseDir}`)
    return
  }

  const platformUrl = harness.platformUrl
  assert.ok(platformUrl, 'harness platform URL must be available')

  // ---- N2: reachable /health returning 500 -> 68, no install side effects ----
  const endpoint = await startHealth500Endpoint()
  health500 = endpoint.server
  health500Port = endpoint.port
  const unhealthyUrl = `http://host.docker.internal:${health500Port}`
  // The endpoint must really be reachable from inside the container and answer 500.
  const healthProbe = await harness.execInContainer(
    `curl -sS --connect-timeout 5 --max-time 10 -o /tmp/n2-health-body -w 'status=%{http_code}\\n' '${unhealthyUrl}/health' || true; ` +
      'cat /tmp/n2-health-body 2>/dev/null || true'
  )
  const n2InstallUrl = await createInstallUrl()
  const n2Prep = await harness.execInContainer(
    `curl -fsSL '${n2InstallUrl}' -o /tmp/n2-install.sh && ` +
      `sed -i "s#^ORCA_PLATFORM_URL=.*#ORCA_PLATFORM_URL='${unhealthyUrl}'#" /tmp/n2-install.sh && ` +
      `grep '^ORCA_PLATFORM_URL=' /tmp/n2-install.sh`
  )
  const n2Run = await runRelayInstallInContainer({
    harness,
    installCommand: `ORCA_RELAY_ROOT=${N2_ROOT} bash /tmp/n2-install.sh`,
    timeoutMs: 120_000
  })
  const n2SideEffects = await harness.execInContainer(sideEffectCheckCommand(N2_ROOT))
  writeCaseJson('n2.json', {
    unhealthyUrl,
    healthProbe: {
      exitCode: healthProbe.exitCode,
      stdout: healthProbe.stdout,
      stderr: healthProbe.stderr
    },
    command: `ORCA_RELAY_ROOT=${N2_ROOT} bash /tmp/n2-install.sh`,
    prepare: { exitCode: n2Prep.exitCode, stdout: n2Prep.stdout, stderr: n2Prep.stderr },
    install: n2Run,
    classification: classifyRelayExitCode(n2Run.exitCode ?? -1),
    sideEffects: {
      exitCode: n2SideEffects.exitCode,
      stdout: n2SideEffects.stdout,
      stderr: n2SideEffects.stderr
    }
  })

  const n2HealthVisible = healthProbe.stdout.includes('status=500')
  const n2Prepared =
    n2Prep.exitCode === 0 && n2Prep.stdout.includes(`ORCA_PLATFORM_URL='${unhealthyUrl}'`)
  const n2ExitOk = n2Run.exitCode === 68 && classifyRelayExitCode(68) === 'platform-unreachable'
  const n2MessageOk = n2Run.stderr.includes('平台健康检查失败') && n2Run.stderr.includes('HTTP 500')
  const n2SideEffectsOk = n2SideEffects.exitCode === 0

  // ---- N6: wrong internal token -> 401, self-proof exits 70, no rollback ----
  const n6InstallUrl = await createInstallUrl()
  const n6Prep = await harness.execInContainer(
    `curl -fsSL '${n6InstallUrl}' -o /tmp/n6-install.sh && ` +
      `sed -i "s#^ORCA_CLOUD_INTERNAL_TOKEN=.*#ORCA_CLOUD_INTERNAL_TOKEN='${WRONG_INTERNAL_TOKEN}'#" /tmp/n6-install.sh && ` +
      `grep '^ORCA_CLOUD_INTERNAL_TOKEN=' /tmp/n6-install.sh`
  )
  const n6Run = await runRelayInstallInContainer({
    harness,
    installCommand: `ORCA_RELAY_ROOT=${N6_ROOT} ORCA_RELAY_PROOF_TIMEOUT=30 bash /tmp/n6-install.sh`,
    timeoutMs: 120_000
  })
  // Independent record of the platform's 401 for the corrupted token.
  const n6Probe = await harness.execInContainer(
    `status="$(curl -sS --connect-timeout 5 --max-time 10 -o /tmp/n6-401-body -w '%{http_code}' ` +
      `-H 'x-internal-token: ${WRONG_INTERNAL_TOKEN}' '${platformUrl}/v1/internal/relays' 2>/dev/null || true)"; ` +
      `printf 'status=%s\\n' "$status"; cat /tmp/n6-401-body 2>/dev/null || true`
  )
  const n6StateBeforeCleanup = await harness.execInContainer(
    `root="${N6_ROOT}"; echo "--- root ---"; ls -A "$root" 2>/dev/null || echo '<root absent>'; ` +
      `echo "--- current ---"; readlink "$root/current" 2>/dev/null || echo '<no current>'; ` +
      `echo "--- pid ---"; cat "$root/relay.pid" 2>/dev/null || echo '<no pid>'; ` +
      `pid="$(cat "$root/relay.pid" 2>/dev/null | tr -d '[:space:]')"; ` +
      `if [ -n "$pid" ]; then echo "--- cmdline ---"; tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true; fi`
  )
  // Precise teardown by the wrapper pid the installer recorded, then prove no relay lives on.
  const n6Cleanup = await harness.execInContainer(
    `root="${N6_ROOT}"; pid="$(cat "$root/relay.pid" 2>/dev/null | tr -d '[:space:]')"; ` +
      `printf 'pid=%s\\n' "\${pid:-<empty>}"; ` +
      'if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; ' +
      'i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done; ' +
      'kill -9 "$pid" 2>/dev/null || true; fi; ' +
      'rm -f "$root/relay.pid"; fail=0; ' +
      'for f in /proc/[0-9]*/cmdline; do ' +
      `  if tr '\\0' ' ' < "$f" 2>/dev/null | grep -Eq 'relay[.]ts'; then echo "unexpected-process:$f"; fail=1; fi; ` +
      'done; echo "cleanup-done"; exit $fail'
  )
  writeCaseJson('n6.json', {
    command: `ORCA_RELAY_ROOT=${N6_ROOT} ORCA_RELAY_PROOF_TIMEOUT=30 bash /tmp/n6-install.sh`,
    prepare: { exitCode: n6Prep.exitCode, stdout: n6Prep.stdout, stderr: n6Prep.stderr },
    install: n6Run,
    classification: classifyRelayExitCode(n6Run.exitCode ?? -1),
    platform401Probe: {
      exitCode: n6Probe.exitCode,
      stdout: n6Probe.stdout,
      stderr: n6Probe.stderr
    },
    stateBeforeCleanup: {
      exitCode: n6StateBeforeCleanup.exitCode,
      stdout: n6StateBeforeCleanup.stdout,
      stderr: n6StateBeforeCleanup.stderr
    },
    cleanup: {
      exitCode: n6Cleanup.exitCode,
      stdout: n6Cleanup.stdout,
      stderr: n6Cleanup.stderr
    }
  })

  const n6Prepared =
    n6Prep.exitCode === 0 &&
    n6Prep.stdout.includes(`ORCA_CLOUD_INTERNAL_TOKEN='${WRONG_INTERNAL_TOKEN}'`)
  const n6ExitOk = n6Run.exitCode === 70
  const n6MessageOk =
    n6Run.stderr.includes('内部令牌不匹配') && n6Run.stderr.includes('请让管理员重新生成')
  const n6NoRollback = !n6Run.stderr.includes('rollback=')
  const n6Platform401 = n6Probe.stdout.includes('status=401')
  const n6CleanupOk = n6Cleanup.exitCode === 0

  const steps: RelayEvidenceStep[] = [
    assertionStep(
      'n2-prepare-unhealthy-platform-url',
      n2HealthVisible && n2Prepared,
      { unhealthyUrl, healthProbe, prepare: n2Prep },
      `container could not see HTTP 500 on /health or the URL rewrite failed (exit ${n2Prep.exitCode})`
    ),
    assertionStep(
      'n2-health-500-exit-68',
      n2ExitOk && n2MessageOk,
      {
        expectedExitCode: 68,
        actualExitCode: n2Run.exitCode,
        classification: classifyRelayExitCode(n2Run.exitCode ?? -1),
        stdout: n2Run.stdout,
        stderr: n2Run.stderr
      },
      `unhealthy platform produced exit ${n2Run.exitCode} (wanted 68) or the wrong message`
    ),
    assertionStep(
      'n2-health-500-no-side-effects',
      n2SideEffectsOk,
      n2SideEffects,
      'unhealthy platform left relay.env/releases/current/pid/lock or a relay process behind'
    ),
    assertionStep(
      'n6-rewrite-internal-token',
      n6Prepared,
      { wrongToken: WRONG_INTERNAL_TOKEN, prepare: n6Prep },
      `install script missing the rewritten internal token (exit ${n6Prep.exitCode})`
    ),
    assertionStep(
      'n6-wrong-token-exit-70',
      n6ExitOk,
      {
        expectedExitCode: 70,
        actualExitCode: n6Run.exitCode,
        classification: classifyRelayExitCode(n6Run.exitCode ?? -1),
        stdout: n6Run.stdout,
        stderr: n6Run.stderr
      },
      `bad internal token produced exit ${n6Run.exitCode}, expected 70`
    ),
    assertionStep(
      'n6-wrong-token-message',
      n6MessageOk,
      { stderr: n6Run.stderr },
      'stderr is missing 内部令牌不匹配 or the admin-regenerate hint'
    ),
    assertionStep(
      'n6-wrong-token-no-rollback',
      n6NoRollback,
      { stderr: n6Run.stderr },
      'a credential failure attempted a rollback (rollback= appeared)'
    ),
    assertionStep(
      'n6-platform-401-recorded',
      n6Platform401,
      { wrongToken: WRONG_INTERNAL_TOKEN, probe: n6Probe },
      `platform did not answer 401 for the corrupted token: ${n6Probe.stdout.trim()}`
    ),
    assertionStep(
      'n6-relay-process-cleanup',
      n6CleanupOk,
      { stateBeforeCleanup: n6StateBeforeCleanup, cleanup: n6Cleanup },
      `cleanup left a relay.ts process behind: ${n6Cleanup.stdout}`
    )
  ]

  collectRelayEvidence(caseDir, {
    task: 'U183 R14b clean-container install negatives II',
    harness,
    steps
  })

  const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
    verdict: string | null
    validation: { ok: boolean; issues: unknown[] }
  }
  assert.equal(summary.verdict, 'pass', 'evidence summary verdict must be pass')
  assert.equal(summary.validation.ok, true, JSON.stringify(summary.validation.issues))

  assert.ok(n2HealthVisible, `health endpoint not visible as 500: ${healthProbe.stdout}`)
  assert.ok(n2Prepared, `N2 prepare failed: ${n2Prep.stderr}`)
  assert.ok(n2ExitOk, `N2 expected exit 68, got ${n2Run.exitCode}: ${n2Run.stderr}`)
  assert.ok(n2MessageOk, `N2 stderr missing health failure details: ${n2Run.stderr}`)
  assert.ok(n2SideEffectsOk, n2SideEffects.stdout)
  assert.ok(n6Prepared, `N6 prepare failed: ${n6Prep.stderr}`)
  assert.ok(n6ExitOk, `N6 expected exit 70, got ${n6Run.exitCode}: ${n6Run.stderr}`)
  assert.ok(n6MessageOk, `N6 stderr missing token mismatch/hint: ${n6Run.stderr}`)
  assert.ok(n6NoRollback, `N6 rollback marker appeared: ${n6Run.stderr}`)
  assert.ok(n6Platform401, `N6 platform probe: ${n6Probe.stdout}`)
  assert.ok(n6CleanupOk, `N6 cleanup: ${n6Cleanup.stdout}`)

  console.log(`[u183-r14b] PASS; evidence: ${caseDir}`)
})
