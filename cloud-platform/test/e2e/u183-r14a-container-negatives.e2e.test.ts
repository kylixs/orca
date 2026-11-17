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
  classifyRelayExitCode,
  collectRelayEvidence,
  runRelayInstallInContainer,
  type RelayEvidenceStep
} from './helpers/relay-container-runner.ts'

/**
 * U183 R14a: clean-container negative e2e, reusing the R13c TLS/evidence setup.
 * N1 tampered offline bundle -> 66; N3 missing bundle URL -> 65 (never 67/70);
 * N4 target without Node -> 64. Every case asserts the exit code and that no
 * install side effect (env/release/current/pid/process) was left behind.
 */

const INTERNAL_TOKEN = 'u183-r14a-internal-token'
// Node 24 + bash/curl/openssl for the module/checksum cases (same image as R13c).
const NODE_IMAGE = process.env.ORCA_E2E_RELAY_IMAGE ?? 'orca-e2e-node24-bookworm:local'
// Pre-existing image without node; bash/curl/openssl present, so the harness is available.
const NO_NODE_IMAGE = process.env.ORCA_E2E_NO_NODE_IMAGE ?? 'jlc-deb12:rust'
const N1_ROOT = '$HOME/.orca-cloud/relay-n1'
const N3_ROOT = '$HOME/.orca-cloud/relay-n3'
const N4_ROOT = '$HOME/.orca-cloud/relay-n4'

let api: Service
let nodeHarness: ContainerHarness
let noNodeHarness: ContainerHarness
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

/** Fails when any install artifact, lock, or relay process survives under `root`. */
function sideEffectCheckCommand(root: string, checkParts: boolean): string {
  const lines = [
    `root="${root}"`,
    'fail=0',
    'for p in relay.env releases current relay.pid .install.lock; do',
    '  if [ -e "$root/$p" ] || [ -L "$root/$p" ]; then echo "unexpected:$p"; fail=1; fi',
    'done'
  ]
  if (checkParts) {
    lines.push(
      'if [ -d "$root/downloads" ]; then',
      `  leftover="$(find "$root/downloads" -name '*.part' -print 2>/dev/null)"`,
      '  if [ -n "$leftover" ]; then echo "unexpected-part:$leftover"; fail=1; fi',
      'fi'
    )
  }
  lines.push(
    'for f in /proc/[0-9]*/cmdline; do',
    // The bracket keeps this checker's own cmdline from matching the pattern.
    `  if tr '\\0' ' ' < "$f" 2>/dev/null | grep -Eq 'relay[.]ts'; then echo "unexpected-process:$f"; fail=1; fi`,
    'done',
    'echo "--- install root listing ---"',
    'ls -A "$root" 2>/dev/null || echo "<root absent>"',
    'exit $fail'
  )
  return lines.join('\n')
}

async function createInstallUrl(harness: ContainerHarness): Promise<string> {
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
  bundleDir = mkdtempSync(join(tmpdir(), 'u183-r14a-bundles-'))
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
    'u183-r14a-api'
  )
  const certs = makeTlsCerts({
    commonName: 'host.docker.internal',
    subjectAltName: 'DNS:host.docker.internal',
    trustAnchor: true
  })
  certsDir = certs.dir
  const tls = { key: certs.key, cert: certs.cert }
  nodeHarness = await startContainerHarness({ platformPort: api.port, image: NODE_IMAGE, tls })
  noNodeHarness = await startContainerHarness({
    platformPort: api.port,
    image: NO_NODE_IMAGE,
    tls
  })

  if (nodeHarness.available) {
    const login = await fetch(`${api.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u183-r14a' })
    })
    const loginText = await login.text()
    assert.equal(login.status, 200, loginText)
    adminToken = (JSON.parse(loginText) as { accessToken: string }).accessToken
  }
})

after(async () => {
  await nodeHarness?.stop()
  await noNodeHarness?.stop()
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

test('U183 R14a: install negatives fail closed without side effects', async () => {
  caseDir = evidenceDir(`u183-r14a-${stamp()}`)

  const capabilities = {
    nodeImage: nodeHarness.image,
    noNodeImage: noNodeHarness.image,
    dockerVersion: nodeHarness.dockerVersion,
    node: nodeHarness.capabilities,
    noNode: noNodeHarness.capabilities
  }
  writeFileSync(join(caseDir, 'capabilities.json'), `${JSON.stringify(capabilities, null, 2)}\n`)

  if (!nodeHarness.available || !noNodeHarness.available) {
    const reason = !nodeHarness.available
      ? (nodeHarness.skipReason ?? 'docker-unavailable')
      : (noNodeHarness.skipReason ?? 'no-node-image-unavailable')
    collectRelayEvidence(caseDir, {
      task: 'U183 R14a clean-container install negatives',
      harness: { available: false, skipReason: reason },
      steps: [
        skippedStep('n1-tampered-bundle', reason),
        skippedStep('n3-missing-bundle-url', reason),
        skippedStep('n4-target-without-node', reason)
      ]
    })
    const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
      verdict: string | null
      validation: { ok: boolean }
    }
    assert.equal(summary.verdict, null)
    assert.equal(summary.validation.ok, true, 'INVALID evidence must still validate')
    console.log(`[u183-r14a] INVALID (${reason}); evidence: ${caseDir}`)
    return
  }

  const platformUrl = nodeHarness.platformUrl
  assert.ok(platformUrl, 'node harness platform URL must be available')
  const bundleUrl = `${platformUrl}/install/relay-bundle/${bundleSha}.tgz`

  // ---- N1: tampered offline bundle -> 66, no env/release/current/process ----
  const n1InstallUrl = await createInstallUrl(nodeHarness)
  const n1Prep = await nodeHarness.execInContainer(
    `curl -fsSL '${n1InstallUrl}' -o /tmp/n1-install.sh && ` +
      `curl -fsSL '${bundleUrl}' -o /tmp/n1-tampered.tgz && ` +
      `printf 'tampered\\n' >> /tmp/n1-tampered.tgz && ` +
      `sha256sum /tmp/n1-tampered.tgz`
  )
  const n1Run = await runRelayInstallInContainer({
    harness: nodeHarness,
    installCommand:
      `ORCA_RELAY_BUNDLE=/tmp/n1-tampered.tgz ORCA_RELAY_ROOT=${N1_ROOT} ` +
      'bash /tmp/n1-install.sh',
    timeoutMs: 120_000
  })
  const n1SideEffects = await nodeHarness.execInContainer(sideEffectCheckCommand(N1_ROOT, false))
  writeCaseJson('n1.json', {
    bundleUrl,
    command: `ORCA_RELAY_BUNDLE=/tmp/n1-tampered.tgz ORCA_RELAY_ROOT=${N1_ROOT} bash /tmp/n1-install.sh`,
    prepare: { exitCode: n1Prep.exitCode, stdout: n1Prep.stdout, stderr: n1Prep.stderr },
    install: n1Run,
    classification: classifyRelayExitCode(n1Run.exitCode ?? -1),
    sideEffects: {
      exitCode: n1SideEffects.exitCode,
      stdout: n1SideEffects.stdout,
      stderr: n1SideEffects.stderr
    }
  })

  const n1Prepared = n1Prep.exitCode === 0 && /^[0-9a-f]{64}/m.test(n1Prep.stdout)
  const n1ExitOk = n1Run.exitCode === 66 && classifyRelayExitCode(66) === 'checksum'
  const n1SideEffectsOk = n1SideEffects.exitCode === 0

  // ---- N3: bundle URL 404 -> 65, no env/release and no .part leftover ----
  const n3InstallUrl = await createInstallUrl(nodeHarness)
  const missingBundleUrl = `${platformUrl}/install/relay-bundle/${'0'.repeat(64)}.tgz`
  const n3Prep = await nodeHarness.execInContainer(
    `curl -fsSL '${n3InstallUrl}' -o /tmp/n3-install.sh && ` +
      `sed -i "s#^ORCA_RELAY_BUNDLE_URL=.*#ORCA_RELAY_BUNDLE_URL='${missingBundleUrl}'#" /tmp/n3-install.sh && ` +
      `grep '^ORCA_RELAY_BUNDLE_URL=' /tmp/n3-install.sh`
  )
  const n3Run = await runRelayInstallInContainer({
    harness: nodeHarness,
    installCommand: `ORCA_RELAY_ROOT=${N3_ROOT} bash /tmp/n3-install.sh`,
    timeoutMs: 120_000
  })
  const n3SideEffects = await nodeHarness.execInContainer(sideEffectCheckCommand(N3_ROOT, true))
  writeCaseJson('n3.json', {
    missingBundleUrl,
    command: `ORCA_RELAY_ROOT=${N3_ROOT} bash /tmp/n3-install.sh`,
    prepare: { exitCode: n3Prep.exitCode, stdout: n3Prep.stdout, stderr: n3Prep.stderr },
    install: n3Run,
    classification: classifyRelayExitCode(n3Run.exitCode ?? -1),
    sideEffects: {
      exitCode: n3SideEffects.exitCode,
      stdout: n3SideEffects.stdout,
      stderr: n3SideEffects.stderr
    }
  })

  const n3Prepared =
    n3Prep.exitCode === 0 && n3Prep.stdout.includes(`ORCA_RELAY_BUNDLE_URL='${missingBundleUrl}'`)
  const n3ExitOk = n3Run.exitCode === 65 && classifyRelayExitCode(65) === 'unavailable'
  const n3SideEffectsOk = n3SideEffects.exitCode === 0

  // ---- N4: target without node -> 64 before any install-root write ----
  const noNodeUrl = await createInstallUrl(noNodeHarness)
  const n4Prep = await noNodeHarness.execInContainer(
    `curl -fsSL '${noNodeUrl}' -o /tmp/n4-install.sh`
  )
  const n4NodeProbe = await noNodeHarness.execInContainer('node --version')
  const n4Run = await runRelayInstallInContainer({
    harness: noNodeHarness,
    installCommand: `ORCA_RELAY_ROOT=${N4_ROOT} bash /tmp/n4-install.sh`,
    timeoutMs: 120_000
  })
  const n4SideEffects = await noNodeHarness.execInContainer(
    `if [ -e "$HOME/.orca-cloud" ]; then echo 'unexpected:$HOME/.orca-cloud'; ` +
      'find "$HOME/.orca-cloud" -maxdepth 3; exit 1; fi; ' +
      'echo "<install root absent>"; ' +
      'for f in /proc/[0-9]*/cmdline; do ' +
      `  if tr '\\0' ' ' < "$f" 2>/dev/null | grep -Eq 'relay[.]ts'; then echo "unexpected-process:$f"; exit 1; fi; ` +
      'done'
  )
  writeCaseJson('n4.json', {
    command: `ORCA_RELAY_ROOT=${N4_ROOT} bash /tmp/n4-install.sh`,
    nodeProbe: {
      exitCode: n4NodeProbe.exitCode,
      stdout: n4NodeProbe.stdout,
      stderr: n4NodeProbe.stderr
    },
    prepare: { exitCode: n4Prep.exitCode, stdout: n4Prep.stdout, stderr: n4Prep.stderr },
    install: n4Run,
    classification: classifyRelayExitCode(n4Run.exitCode ?? -1),
    sideEffects: {
      exitCode: n4SideEffects.exitCode,
      stdout: n4SideEffects.stdout,
      stderr: n4SideEffects.stderr
    }
  })

  const n4Prepared = n4Prep.exitCode === 0 && n4NodeProbe.exitCode !== 0
  const n4ExitOk = n4Run.exitCode === 64 && classifyRelayExitCode(64) === 'usage'
  const n4SideEffectsOk = n4SideEffects.exitCode === 0

  const steps: RelayEvidenceStep[] = [
    assertionStep(
      'n1-prepare-tampered-offline-bundle',
      n1Prepared,
      { bundleUrl, prepare: n1Prep },
      `could not download the signed bundle or tamper it (exit ${n1Prep.exitCode})`
    ),
    assertionStep(
      'n1-tampered-bundle-exit-66',
      n1ExitOk,
      {
        expectedExitCode: 66,
        actualExitCode: n1Run.exitCode,
        classification: classifyRelayExitCode(n1Run.exitCode ?? -1),
        stdout: n1Run.stdout,
        stderr: n1Run.stderr
      },
      `tampered bundle produced exit ${n1Run.exitCode}, expected 66 (checksum)`
    ),
    assertionStep(
      'n1-tampered-bundle-no-side-effects',
      n1SideEffectsOk,
      n1SideEffects,
      'tampered bundle left relay.env/releases/current/pid/lock or a relay process behind'
    ),
    assertionStep(
      'n3-rewrite-bundle-url-to-missing-path',
      n3Prepared,
      { missingBundleUrl, prepare: n3Prep },
      `install script missing the rewritten bundle URL (exit ${n3Prep.exitCode})`
    ),
    assertionStep(
      'n3-missing-bundle-exit-65',
      n3ExitOk,
      {
        expectedExitCode: 65,
        actualExitCode: n3Run.exitCode,
        classification: classifyRelayExitCode(n3Run.exitCode ?? -1),
        stdout: n3Run.stdout,
        stderr: n3Run.stderr
      },
      `missing bundle produced exit ${n3Run.exitCode}, expected 65 (unavailable)`
    ),
    assertionStep(
      'n3-missing-bundle-no-side-effects',
      n3SideEffectsOk,
      n3SideEffects,
      'missing bundle left relay.env/releases/current/pid/lock, a .part, or a relay process behind'
    ),
    assertionStep(
      'n4-no-node-exit-64',
      n4Prepared && n4ExitOk,
      {
        expectedExitCode: 64,
        actualExitCode: n4Run.exitCode,
        classification: classifyRelayExitCode(n4Run.exitCode ?? -1),
        nodeProbe: n4NodeProbe,
        stdout: n4Run.stdout,
        stderr: n4Run.stderr
      },
      `no-node target produced exit ${n4Run.exitCode}, expected 64 (usage)`
    ),
    assertionStep(
      'n4-no-node-no-side-effects',
      n4SideEffectsOk,
      n4SideEffects,
      'no-node install wrote to the install root or left a relay process behind'
    )
  ]

  collectRelayEvidence(caseDir, {
    task: 'U183 R14a clean-container install negatives',
    harness: nodeHarness,
    steps
  })

  const summary = JSON.parse(readFileSync(join(caseDir, 'summary.json'), 'utf8')) as {
    verdict: string | null
    validation: { ok: boolean; issues: unknown[] }
  }
  assert.equal(summary.verdict, 'pass', 'evidence summary verdict must be pass')
  assert.equal(summary.validation.ok, true, JSON.stringify(summary.validation.issues))

  assert.ok(n1Prepared, `N1 prepare failed: ${n1Prep.stderr}`)
  assert.ok(n1ExitOk, `N1 expected exit 66, got ${n1Run.exitCode}: ${n1Run.stderr}`)
  assert.ok(n1SideEffectsOk, n1SideEffects.stdout)
  assert.ok(n3Prepared, `N3 prepare failed: ${n3Prep.stderr}`)
  assert.ok(n3ExitOk, `N3 expected exit 65, got ${n3Run.exitCode}: ${n3Run.stderr}`)
  assert.ok(n3SideEffectsOk, n3SideEffects.stdout)
  assert.ok(n4Prepared, `N4 prepare failed: ${n4Prep.stderr}`)
  assert.ok(n4ExitOk, `N4 expected exit 64, got ${n4Run.exitCode}: ${n4Run.stderr}`)
  assert.ok(n4SideEffectsOk, n4SideEffects.stdout)

  console.log(`[u183-r14a] PASS; evidence: ${caseDir}`)
})
