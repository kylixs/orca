import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
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
 * U183 R13c: clean-container forward e2e. A bundle-aware platform runs on this
 * host, the R13a container reaches it through the forwarder, and the one-liner
 * the admin copies installs the relay and proves it online. Node is a documented
 * target prerequisite (§6.4), so an image without Node >=22.18 is INVALID with
 * skipReason=node-unavailable — never a stubbed pass.
 */

const INTERNAL_TOKEN = 'u183-r13c-internal-token'
const NODE_FLOOR = { major: 22, minor: 18 }
const RELAY_ROOT = '$HOME/.orca-cloud/relay'
// Debian Node 24 with bash/curl/openssl; slim images omit curl and openssl.
// Built from node:24-bookworm-slim + apt-get install curl openssl ca-certificates.
const CONTAINER_IMAGE = process.env.ORCA_E2E_RELAY_IMAGE ?? 'orca-e2e-node24-bookworm:local'

let api: Service
let harness: ContainerHarness
let bundleSha = ''
let bundleDir = ''
let certsDir = ''
let adminToken = ''

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }
}

function nodeFloorSatisfied(version: string | null): boolean {
  if (!version) {
    return false
  }
  const match = /^v?(\d+)\.(\d+)/.exec(version)
  if (!match) {
    return false
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > NODE_FLOOR.major || (major === NODE_FLOOR.major && minor >= NODE_FLOOR.minor)
}

function stamp(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

function skippedInstall(reason: string): RelayEvidenceStep {
  return {
    name: 'install-relay-one-liner',
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

/** One deterministic assertion, shaped like an install step so R13b can record it. */
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

before(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), 'u183-r13c-bundles-'))
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
    'u183-r13c-api'
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
})

after(async () => {
  await harness?.stop()
  await api?.stop()
  if (certsDir) {
    rmSync(certsDir, { recursive: true, force: true })
  }
})

test('U183 R13c: one-liner installs a clean-container relay and proves it online', async () => {
  const dir = evidenceDir(`u183-r13c-${stamp()}`)
  const capabilities = {
    required: '>=22.18',
    image: harness.image,
    dockerVersion: harness.dockerVersion,
    ...harness.capabilities
  }
  writeFileSync(join(dir, 'node-probe.json'), `${JSON.stringify(capabilities, null, 2)}\n`)
  if (harness.available) {
    // Raw in-container probe: the boolean above must be traceable to a command.
    const rawProbe = await harness.execInContainer('node --version')
    writeFileSync(
      join(dir, 'node-probe.raw.json'),
      `${JSON.stringify({ command: 'node --version', ...rawProbe }, null, 2)}\n`
    )
  }

  const nodeOk = harness.available && nodeFloorSatisfied(harness.capabilities.nodeVersion)
  const setupSkipReason = !harness.available
    ? (harness.skipReason ?? 'docker-unavailable')
    : nodeOk
      ? null
      : 'node-unavailable'

  if (setupSkipReason) {
    const evidence = collectRelayEvidence(dir, {
      task: 'U183 R13c clean-container relay install',
      harness: {
        available: harness.available,
        ...(harness.skipReason ? { skipReason: harness.skipReason } : {})
      },
      steps: [skippedInstall(setupSkipReason)]
    })
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as {
      verdict: string | null
      skipReason: string | null
      validation: { ok: boolean }
    }
    assert.equal(evidence.verdict, null)
    assert.equal(summary.verdict, null)
    assert.equal(summary.skipReason, setupSkipReason)
    assert.equal(summary.validation.ok, true, 'INVALID evidence must still validate')
    console.log(`[u183-r13c] INVALID (${setupSkipReason}); evidence: ${dir}`)
    return
  }

  const login = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u183-r13c' })
  })
  // Read once: the assertion message would otherwise consume the body.
  const loginText = await login.text()
  assert.equal(login.status, 200, loginText)
  adminToken = (JSON.parse(loginText) as { accessToken: string }).accessToken

  const tokenRes = await fetch(`${api.url}/v1/relays/install-tokens`, {
    method: 'POST',
    headers: authHeaders()
  })
  const tokenText = await tokenRes.text()
  assert.equal(tokenRes.status, 201, tokenText)
  const downloadToken = (JSON.parse(tokenText) as { downloadToken: string }).downloadToken
  const installUrl = `${harness.platformUrl}/install/relay.sh?download=${encodeURIComponent(downloadToken)}`
  const oneLiner = `curl -fsSL "${installUrl}" -o "\${TMPDIR:-/tmp}/orca-install-$$.sh" && bash "\${TMPDIR:-/tmp}/orca-install-$$.sh" && rm -f "\${TMPDIR:-/tmp}/orca-install-$$.sh"`

  const install = await runRelayInstallInContainer({
    harness,
    installCommand: oneLiner,
    timeoutMs: 180_000
  })

  const envRead = await harness.execInContainer(`cat "${RELAY_ROOT}/relay.env" 2>/dev/null || true`)
  const relayId = readEnvValue(envRead.stdout, 'ORCA_CLOUD_RELAY_ID')
  const envNonce = readEnvValue(envRead.stdout, 'ORCA_CLOUD_INSTALL_NONCE')
  writeFileSync(join(dir, 'relay-env.redacted.txt'), redactEnv(envRead.stdout))

  const relaysRes = await fetch(`${api.url}/v1/relays`, { headers: authHeaders() })
  const relaysBody = (await relaysRes.json()) as {
    relays: { id: string; online: boolean; installNonce: string; lastSeenAt: number }[]
  }
  writeFileSync(join(dir, 'relays.json'), `${JSON.stringify(relaysBody, null, 2)}\n`)
  const record = relayRecord(relaysBody.relays, relayId)

  const currentRead = await harness.execInContainer(
    `readlink "${RELAY_ROOT}/current" 2>/dev/null || true`
  )
  writeFileSync(join(dir, 'current-link.txt'), currentRead.stdout)

  const processRead = await harness.execInContainer(
    `pid="$(cat "${RELAY_ROOT}/relay.pid" 2>/dev/null)"; printf 'pid=%s\\n' "$pid"; ` +
      `kill -0 "$pid" 2>/dev/null || exit 1; printf 'alive=1\\n'; ` +
      `tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null`
  )
  writeFileSync(
    join(dir, 'process.json'),
    `${JSON.stringify({ exitCode: processRead.exitCode, stdout: processRead.stdout }, null, 2)}\n`
  )

  const releasesTree = await harness.execInContainer(`ls -1 "${RELAY_ROOT}/releases" 2>/dev/null`)
  writeFileSync(join(dir, 'releases-tree.txt'), releasesTree.stdout)

  const logTail = await harness.execInContainer(
    `tail -n 50 "${RELAY_ROOT}/relay.log" 2>/dev/null || true`
  )
  writeFileSync(join(dir, 'relay-log-tail.txt'), logTail.stdout)

  const logCheck = await harness.execInContainer(
    `log="${RELAY_ROOT}/relay.log"; [ -f "$log" ] || { echo 'relay.log missing'; exit 1; }; ` +
      `if grep -Eiq 'unhandled|uncaught' "$log"; then grep -Ein 'unhandled|uncaught' "$log"; exit 1; fi; ` +
      `echo 'no unhandled error'`
  )

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
  const logOk = logCheck.exitCode === 0

  const steps: RelayEvidenceStep[] = [
    { name: 'install-relay-one-liner', ...install },
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
      'relay-log-clean',
      logOk,
      { exitCode: logCheck.exitCode, stdout: logCheck.stdout, stderr: logCheck.stderr },
      'relay.log is missing or contains an unhandled error'
    )
  ]

  collectRelayEvidence(dir, {
    task: 'U183 R13c clean-container relay install',
    harness,
    steps
  })

  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as {
    verdict: string | null
    validation: { ok: boolean; issues: unknown[] }
  }
  // (6) evidence must record a pass and pass the integrity gate.
  assert.equal(summary.verdict, 'pass', 'evidence summary verdict must be pass')
  assert.equal(summary.validation.ok, true, JSON.stringify(summary.validation.issues))

  // (1)-(5) in order; all evidence is already on disk even when one fails.
  assert.ok(installOk, `installer exited ${install.exitCode}: ${install.stderr}`)
  assert.ok(relayOk, `platform record: ${JSON.stringify(record)}; envNonce: ${envNonce}`)
  assert.ok(currentOk, `current=${currentRead.stdout.trim()}`)
  assert.ok(processOk, processRead.stdout)
  assert.ok(logOk, `${logCheck.stdout}${logCheck.stderr}`)
})
