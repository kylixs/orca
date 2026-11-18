import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { buildHash, DEFAULT_ROUTE, parseHash } from '../../apps/web/router/routes.js'
import { registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M114b2 (FR-4.11): adding a host or a relay is a wizard, not a runbook — the
 * admin copies one `bash <(curl …)` line, and the script that answers carries
 * the platform address and the secret. So the endpoint must refuse everyone but
 * an admin, refuse a tokenless host request, and the web command must match it.
 */

const EVIDENCE = 'm114-relay-page'
const INTERNAL_TOKEN = 'm114-wizard-token'
const WEB_SOURCE = join(new URL('../../', import.meta.url).pathname, 'apps/web')

let api: Service
let adminToken = ''
let devToken = ''
// R15: tests serve extra bundle versions by writing here after startup.
let bundleDir = ''

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function mintHostToken(): Promise<string> {
  const res = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { token: string }).token
}

/** U115: the credential the copied one-liner carries, bound to the issuing admin. */
async function mintHostDownload(
  hostId?: string
): Promise<{ token: string; downloadToken: string }> {
  const res = await fetch(`${api.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: auth(adminToken),
    ...(hostId ? { body: JSON.stringify({ hostId }) } : {})
  })
  assert.equal(res.status, 201)
  return (await res.json()) as { token: string; downloadToken: string }
}

async function mintRelayDownload(): Promise<string> {
  const res = await fetch(`${api.url}/v1/relays/install-tokens`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { downloadToken: string }).downloadToken
}

/** Extracts the URL from the wizard command, i.e. what the target machine runs. */
function commandUrl(command: string): string {
  return /curl -fsSL "([^"]+)"/.exec(command)?.[1] ?? ''
}

/** U182: the copied one-liner must make a failed download observable. */
function expectedInstallCommand(url: string): string {
  const file = '${TMPDIR:-/tmp}/orca-install-$$.sh'
  return `curl -fsSL "${url}" -o "${file}" && bash "${file}" && rm -f "${file}" || { echo '安装失败：命令已失效或网络不可达，请让管理员重新生成'; false; } || exit 1`
}

/** A clean-host HOME with TLS stubs so the script skips openssl. */
function makeInstallHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
  mkdirSync(join(home, '.orca-cloud', 'tls'), { recursive: true })
  writeFileSync(join(home, '.orca-cloud', 'tls', 'host.crt'), 'stub')
  writeFileSync(join(home, '.orca-cloud', 'tls', 'host.key'), 'stub')
  // `hostname -I` is Linux-only; stub it so the clean-shell run is host-agnostic.
  mkdirSync(join(home, 'bin'))
  writeFileSync(
    join(home, 'bin', 'hostname'),
    '#!/usr/bin/env bash\ncase "$1" in -s|-I) echo orca-test-host ;; *) echo orca-test-host ;; esac\n',
    { mode: 0o755 }
  )
  // U182: the install script now resolves the host binary before writing env.
  // U181 P1-3: `orca-ide` is the portable name; `orca` stays for macOS fallback.
  writeFileSync(join(home, 'bin', 'orca'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(home, 'bin', 'orca-ide'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  return home
}

/** U182: a PATH containing only the tools the script needs — no systemctl,
 * no ipconfig, no real node unless asked for. Keeps the probes deterministic
 * on Linux CI and macOS (where the real PATH differs). */
const SPARSE_TOOLS = [
  'bash',
  'dirname',
  'mkdir',
  'chmod',
  'cat',
  'awk',
  'grep',
  'curl',
  'mktemp',
  'rm',
  'mv',
  // U181 P1-2/P1-3: readiness baseline and platform detection.
  'date',
  'uname',
  'node',
  'shasum',
  'sha256sum',
  // U183 R6: listing, extraction and activation.
  'tar',
  'find',
  'readlink',
  'ln',
  'cut',
  'sort',
  'tr',
  'head',
  // U183 R11a: unit content comparison skips identical rewrites.
  'cmp',
  // U187: legacy systemd degrades StartLimit/Restart in the rendered unit.
  'sed',
  // U183 R9: background launch and liveness settling.
  'nohup',
  'sleep',
  // U183 R10b: process identity (macOS has no /proc) and log tail on timeout.
  'ps',
  'tail'
]

function makeSparsePath(home: string, stubs: Record<string, string>, omit: string[] = []): string {
  const bin = join(home, 'sparse-bin')
  mkdirSync(bin, { recursive: true })
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  for (const name of SPARSE_TOOLS) {
    if (name in stubs || omit.includes(name)) {
      continue
    }
    const source = dirs.map((dir) => join(dir, name)).find((candidate) => existsSync(candidate))
    if (source) {
      symlinkSync(source, join(bin, name))
    }
  }
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body, { mode: 0o755 })
  }
  return bin
}

const HOSTNAME_STUB =
  '#!/usr/bin/env bash\ncase "$1" in -s) echo orca-test-host ;; -I) exit 1 ;; *) exit 0 ;; esac\n'

const ORCA_STUB = '#!/usr/bin/env bash\nexit 0\n'

/** H9a: a fake host-mode process that publishes the readiness file then stays
 * alive so the installer's `kill -0` liveness check passes. */
function makeHostStateHome(
  state: Record<string, unknown>,
  options: { stayAlive?: boolean } = {}
): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-install-h9a-'))
  mkdirSync(join(home, '.orca-cloud', 'tls'), { recursive: true })
  writeFileSync(join(home, '.orca-cloud', 'tls', 'host.crt'), 'stub')
  writeFileSync(join(home, '.orca-cloud', 'tls', 'host.key'), 'stub')
  mkdirSync(join(home, 'bin'))
  writeFileSync(join(home, 'bin', 'hostname'), HOSTNAME_STUB, { mode: 0o755 })
  // `"pid": 0` is a placeholder for the stub's own $$; a real pid (dead-pid
  // fixture) is written literally. The function form keeps `$$` literal.
  const json = JSON.stringify(state, null, 2).replace('"pid": 0', () => '"pid": $$')
  const body = `#!/usr/bin/env bash
case "$*" in
  *--preflight*) exit 0 ;;
esac
state="$HOME/.orca-cloud/profile/orca-cloud-host-state.json"
mkdir -p "$(dirname "$state")"
cat > "$state" <<JSON
${json}
JSON
${options.stayAlive === false ? 'exit 0' : 'exec sleep 60'}
`
  writeFileSync(join(home, 'bin', 'orca-ide'), body, { mode: 0o755 })
  return home
}

function killStateHost(home: string): void {
  try {
    const file = join(home, '.orca-cloud', 'profile', 'orca-cloud-host-state.json')
    const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid
    if (pid) {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // File or process already gone; nothing to clean up.
  }
}

/** U183 R4: the relay preflight asks node for its version via `-p`. */
function nodeStub(version: string): string {
  return `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo ${version}; exit 0; fi
if [ "$1" = "--version" ]; then echo v${version}; fi
exit 0
`
}

const NODE_2218_STUB = nodeStub('22.18.0')
const NODE_21_STUB = nodeStub('21.7.0')

/** U183 R9: answers the version probe, then stays alive like a real relay so
 * the installer's pid liveness check sees a running process. */
const NODE_2218_ALIVE_STUB = `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 22.18.0; exit 0; fi
if [ "$1" = "--version" ]; then echo v22.18.0; exit 0; fi
echo "relay-stub-started $$ $*"
exec sleep 60
`

/** U183 R9: a relay that dies immediately must surface as 69, not a fake pid. */
const NODE_2218_DIES_STUB = `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 22.18.0; exit 0; fi
if [ "$1" = "--version" ]; then echo v22.18.0; exit 0; fi
exit 1
`

/** U183 R9: stop the background relay started by a non-systemd install. */
function killRelayPid(relayRoot: string): void {
  try {
    const pid = Number(readFileSync(join(relayRoot, 'relay.pid'), 'utf8').trim())
    if (pid) {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // No pid file or the process is already gone.
  }
}

/** U183 R5: health answers 200, every download fails like a closed endpoint. */
const FAILING_CURL_STUB = `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "%{http_code}" ]; then echo 200; exit 0; fi
done
exit 22
`

/** U183 R5: health answers 200; the download writes tampered bytes. */
const TAMPERING_CURL_STUB = `#!/usr/bin/env bash
prev=""
out=""
for arg in "$@"; do
  if [ "$prev" = "-o" ] && [ "$arg" != "/dev/null" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -n "$out" ]; then printf 'tampered relay bundle' > "$out"; exit 0; fi
echo 200
`

/** U183 R10b/R11b: fake platform that records a relay announce and serves the
 * nonce back on /v1/internal/relays. Runs in its own process because the
 * installer runs through spawnSync, which would block an in-process server. */
const RELAY_PROOF_SERVER_SOURCE = `import { createServer } from 'node:http'
const staleMs = Number(process.env.PROOF_STALE_MS ?? 0)
const nonceSuffix = process.env.PROOF_NONCE_SUFFIX ?? ''
let id = ''
let nonce = ''
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  if (path === '/health') { res.statusCode = 200; res.end('ok'); return }
  if (path === '/v1/internal/relay-endpoint' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        id = parsed.id ?? ''
        nonce = (parsed.installNonce ?? '') + nonceSuffix
      } catch {}
      res.setHeader('content-type', 'application/json')
      res.end('{"ok":true}')
    })
    return
  }
  if (path === '/v1/internal/relays') {
    const relays = id
      ? [{ id, host: '', browserHost: '', installNonce: nonce, port: 18443, lastSeenAt: Date.now() - staleMs, order: 1, online: true }]
      : []
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ aliveMs: 30000, relays }))
    return
  }
  res.statusCode = 404
  res.end('not found')
})
server.listen(0, '127.0.0.1', () => console.log('[proof] listening on http://127.0.0.1:' + server.address().port))
`

let relayProofScriptPath = ''
function startRelayProofPlatform(staleMs = 0, nonceSuffix = ''): Promise<Service> {
  if (!relayProofScriptPath) {
    const dir = mkdtempSync(join(tmpdir(), 'orca-proof-platform-'))
    relayProofScriptPath = join(dir, 'proof-platform.mjs')
    writeFileSync(relayProofScriptPath, RELAY_PROOF_SERVER_SOURCE)
  }
  return spawnService(
    relayProofScriptPath,
    { PROOF_STALE_MS: String(staleMs), PROOF_NONCE_SUFFIX: nonceSuffix },
    /\[proof\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'relay-proof-platform'
  )
}

/** U183 R6: a real, extractable relay source tree for tar fixtures. */
function seedRelaySource(dir: string): void {
  mkdirSync(join(dir, 'apps/relay/src'), { recursive: true })
  mkdirSync(join(dir, 'packages/contract/src'), { recursive: true })
  writeFileSync(join(dir, 'VERSION'), '{"schemaVersion":1,"relayCodeVersion":"0.1.0"}\n')
  writeFileSync(join(dir, 'apps/relay/src/relay.ts'), `// relay ${dir}\n`)
  writeFileSync(join(dir, 'packages/contract/src/internal-fetch.ts'), '// internal-fetch\n')
}

function runTar(args: string[]): void {
  const proc = spawnSync('tar', args, { encoding: 'utf8' })
  assert.equal(proc.status, 0, proc.stderr)
}

/** Builds the real tgz + sha the install script downloads and unpacks. */
function buildBundle(
  mutate?: (dir: string) => void,
  tarArgs?: (dir: string, out: string) => string[]
): { bytes: Buffer; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-bundle-src-'))
  const out = join(mkdtempSync(join(tmpdir(), 'orca-bundle-out-')), 'bundle.tgz')
  seedRelaySource(dir)
  mutate?.(dir)
  runTar(tarArgs ? tarArgs(dir, out) : ['-czf', out, '-C', dir, 'VERSION', 'apps', 'packages'])
  const bytes = readFileSync(out)
  return { bytes, sha: createHash('sha256').update(bytes).digest('hex') }
}

/** U183 R5: a real content-addressed bundle whose bytes the script can verify. */
const BENIGN_BUNDLE = buildBundle()
const BUNDLE_BODY = BENIGN_BUNDLE.bytes
const BUNDLE_SHA = BENIGN_BUNDLE.sha

/** U183 R4: a relay root + entry that the preflight accepts. */
// U184: the default (bundle) script installs its own code, so a clean root is
// an empty writable dir — planting a repo checkout here masked that defect.
function makeRelayRoot(home: string): string {
  const relayRoot = join(home, 'orca-cloud')
  mkdirSync(relayRoot, { recursive: true })
  return relayRoot
}

/** U183 R7: KEY=VALUE relay.env, systemd EnvironmentFile syntax. */
function readRelayEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) {
      env[line.slice(0, at)] = line.slice(at + 1)
    }
  }
  return env
}

/** The generated host script for a fresh one-time token. */
async function fetchHostScript(): Promise<string> {
  const token = await mintHostToken()
  const res = await fetch(`${api.url}/install/host.sh?token=${token}`, {
    headers: auth(adminToken)
  })
  assert.equal(res.status, 200)
  return res.text()
}

async function fetchRelayScript(): Promise<string> {
  // Undici can reuse a keep-alive socket just as the API closes it; one retry
  // keeps a long test file from flaking on a reset before the request is sent.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${api.url}/install/relay.sh`, { headers: auth(adminToken) })
      assert.equal(res.status, 200)
      return await res.text()
    } catch (error) {
      if (attempt >= 1) throw error
    }
  }
}

/** U184: an empty `sha` opts into the legacy repo-checkout script. */
async function fetchRelayScriptRepoMode(): Promise<string> {
  const res = await fetch(`${api.url}/install/relay.sh?sha=`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  return res.text()
}

/**
 * U180: runs a generated script the way a clean host does — `bash -u`, a fresh
 * HOME, and no ORCA_* in the environment. Only PATH survives so curl/openssl/hostname
 * resolve; the platform's own 127.0.0.1 server is the /health stub.
 */
function runInstallScript(
  script: string,
  home = makeInstallHome(),
  envOverrides: Record<string, string> = {}
): {
  status: number | null
  stdout: string
  stderr: string
  home: string
} {
  const result = spawnSync('bash', ['-u'], {
    input: script,
    encoding: 'utf8',
    cwd: home,
    // A health check without a bounded curl must not hang the suite.
    timeout: 60_000,
    env: {
      PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      // H9a: legacy cases end before the host runs; only the self-check suite
      // waits. 0 disables the readiness poll.
      ORCA_HOST_STATE_TIMEOUT: '0',
      // U183 R10b: legacy cases do not run a relay that can announce itself.
      // The self-proof suite opts back in with a short timeout.
      ORCA_RELAY_PROOF_TIMEOUT: '0',
      ...envOverrides
    }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, home }
}

/** Raw Host header: fetch/undici may rewrite it, so use http.request. */
function fetchWithHost(
  path: string,
  host: string
): Promise<{
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}> {
  const url = new URL(path, api.url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host, authorization: `Bearer ${adminToken}` }
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

type AuditEvent = { eventType: string; actor: string | null; result: string; metadata: unknown }

async function auditEvents(query: string): Promise<AuditEvent[]> {
  const res = await fetch(`${api.url}/v1/audit/events?${query}`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  return ((await res.json()) as { events: AuditEvent[] }).events
}

/**
 * Loads the real front-end into a DOM whose fetch goes to the real platform and
 * whose `location.origin` is the platform URL — the same origin the wizard puts
 * into its one-liner, which is what makes the command copy-paste correct.
 */
function loadWizard(platformUrl: string) {
  const window = new Window({ url: `${platformUrl}/` })
  window.document.documentElement.innerHTML = readFileSync(join(WEB_SOURCE, 'index.html'), 'utf8')
    // The markup's script tags point at the server; app.js is injected by hand.
    .replace(/<script[\s\S]*?<\/script>/g, '')

  const realFetch = globalThis.fetch
  const fetchToPlatform: typeof fetch = (input, init) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    return realFetch(`${platformUrl}${path}`, init)
  }
  // app.js is an ES module; `new Function` has no import machinery, so the one
  // router import is stripped and its bindings injected below.
  const source = readFileSync(join(WEB_SOURCE, 'app.js'), 'utf8').replace(/^import .*$/m, '')
  new Function(
    'document',
    'localStorage',
    'fetch',
    'window',
    'navigator',
    'location',
    'confirm',
    'console',
    'setTimeout',
    'clearTimeout',
    'Date',
    'URL',
    'JSON',
    'Promise',
    'buildHash',
    'DEFAULT_ROUTE',
    'parseHash',
    source
  )(
    window.document,
    window.localStorage,
    fetchToPlatform,
    window,
    window.navigator,
    window.location,
    () => true,
    console,
    window.setTimeout.bind(window),
    window.clearTimeout.bind(window),
    Date,
    URL,
    JSON,
    Promise,
    buildHash,
    DEFAULT_ROUTE,
    parseHash
  )

  const wait = async (selector: string): Promise<string> => {
    for (let round = 0; round < 200; round += 1) {
      const found = window.document.querySelector(selector)
      if (found) return found.textContent ?? ''
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${selector}`)
  }
  const click = async (selector: string, waitFor: string): Promise<string> => {
    const button = window.document.querySelector<HTMLElement>(selector)
    if (!button) throw new Error(`missing ${selector}`)
    button.click()
    return wait(waitFor)
  }
  const login = async (): Promise<void> => {
    window.document.querySelector<HTMLInputElement>('#username')!.value = 'admin'
    window.document.querySelector<HTMLInputElement>('#password')!.value = 'Adm1n!'
    window.document
      .querySelector<HTMLFormElement>('#loginForm')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    for (let round = 0; round < 200; round += 1) {
      if (!window.document.querySelector<HTMLDivElement>('#view-app')?.hidden) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const nav = async (route: string, waitFor: string): Promise<string> => {
    const button = window.document.querySelector<HTMLElement>(`.nav-item[data-route="${route}"]`)
    if (!button) throw new Error(`no nav item for ${route}`)
    button.click()
    return wait(waitFor)
  }
  return { window, login, click, nav, text: (selector: string) => wait(selector) }
}

before(async () => {
  // U183 R5: serve one verified bundle so relay.sh carries the download steps.
  bundleDir = mkdtempSync(join(tmpdir(), 'orca-install-bundles-'))
  writeFileSync(join(bundleDir, `relay-bundle-${BUNDLE_SHA}.tgz`), BUNDLE_BODY)
  writeFileSync(
    join(bundleDir, `relay-bundle-${BUNDLE_SHA}.manifest.json`),
    JSON.stringify(
      {
        bundleSha256: BUNDLE_SHA,
        schemaVersion: 1,
        relayCodeVersion: '0.1.0',
        files: ['VERSION', 'apps/relay/src/relay.ts']
      },
      null,
      2
    )
  )
  api = await spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_RELAY_BUNDLE_DIR: bundleDir,
      ORCA_RELAY_BUNDLE_SHA: BUNDLE_SHA
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-install-wizard'
  )
  adminToken = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm114-wizard' })
  }).then((res) => res.json().then((body: { accessToken: string }) => body.accessToken))
  assert.notEqual(adminToken, '')
  devToken = await fetch(`${api.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'zhangsan',
      password: 'Passw0rd!',
      deviceName: 'm114-wizard-dev'
    })
  }).then((res) => res.json().then((body: { accessToken: string }) => body.accessToken))
  assert.notEqual(devToken, '')
}, 120_000)

after(async () => {
  await api?.stop()
})

describe('M114b2 向导式添加：脚本端点与 Web 命令', () => {
  test('管理员拉取 relay.sh：内嵌平台地址与内部控制令牌', async () => {
    const res = await fetch(`${api.url}/install/relay.sh`, { headers: auth(adminToken) })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/x-shellscript/)
    // U182: the body embeds a secret and must not be cached anywhere.
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const script = await res.text()
    assert.match(script, /^#!\/usr\/bin\/env bash/)
    assert.ok(
      script.includes(`ORCA_PLATFORM_URL='${api.url}'`),
      'platform address must be embedded'
    )
    assert.ok(
      script.includes(`ORCA_CLOUD_INTERNAL_TOKEN=${INTERNAL_TOKEN}`),
      'internal token must be embedded'
    )
    assert.match(script, /RELAY_PUBLIC_HOST/)
    // U183 R9: the launcher resolves node and runs the current release entry.
    assert.match(script, /command -v node/)
    assert.match(script, /\$ORCA_NODE_BIN \$ORCA_RELAY_ENTRY/)
    // U184: bundle installs carry their own code; no repo checkout on the target.
    assert.doesNotMatch(script, /未找到中继程序/)
    assert.match(
      script,
      /ORCA_RELAY_ENTRY="\$ORCA_RELAY_ROOT\/current\/apps\/relay\/src\/relay\.ts"/
    )
    saveEvidence(EVIDENCE, 'install-relay-script.txt', script)
  })

  test('管理员拉取 host.sh：缺令牌 400，有效令牌内嵌 env 与自签证书步骤', async () => {
    const missing = await fetch(`${api.url}/install/host.sh`, { headers: auth(adminToken) })
    assert.equal(missing.status, 400)
    assert.equal(
      ((await missing.json()) as { error?: { code: string } }).error?.code,
      'INSTALL_TOKEN_REQUIRED'
    )

    const used = await fetch(`${api.url}/install/host.sh?token=not-a-real-token`, {
      headers: auth(adminToken)
    })
    assert.equal(used.status, 401)

    const token = await mintHostToken()
    const res = await fetch(`${api.url}/install/host.sh?token=${token}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 200)
    const script = await res.text()
    assert.ok(script.includes(`ORCA_CLOUD_API_URL=${api.url}`))
    assert.ok(script.includes(`HOST_TOKEN=${token}`), 'the one-time token must be embedded')
    for (const variable of ['HOST_NAME=', 'ADVERTISE_HOST=', 'PROJECTS_ROOT=']) {
      assert.ok(script.includes(variable), `${variable} must be written`)
    }
    // The host binary reads only the ORCA_CLOUD_* names (U38 family): a script
    // that wrote just the bare aliases could never enrol a host.
    for (const variable of [
      `ORCA_CLOUD_HOST_TOKEN=${token}`,
      'ORCA_CLOUD_HOST_NAME=',
      'ORCA_CLOUD_ADVERTISE_HOST=',
      'ORCA_CLOUD_PROJECTS_ROOT=',
      'ORCA_CLOUD_TLS_CERT_PATH=',
      'ORCA_CLOUD_TLS_KEY_PATH='
    ]) {
      assert.ok(script.includes(variable), `${variable} must be written`)
    }
    assert.match(script, /openssl req -x509/)
    assert.match(script, /systemd|orca --host-mode/)
    saveEvidence(EVIDENCE, 'install-host-script.txt', script)
    saveEvidence(EVIDENCE, 'install-token-required.json', {
      missing: missing.status,
      invalid: used.status
    })
  })

  test('U180: host.sh 在干净 shell（无外部 ORCA_* env）中跑过健康检查', async () => {
    const health = await fetch(`${api.url}/health`)
    assert.equal(health.status, 200, 'the local platform must answer the health stub')

    const token = await mintHostToken()
    const res = await fetch(`${api.url}/install/host.sh?token=${token}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 200)
    const run = runInstallScript(await res.text())

    assert.doesNotMatch(run.stderr, /unbound variable/, run.stderr)
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /环境已就绪/)
    const envFile = readFileSync(join(run.home, '.orca-cloud', 'host.env'), 'utf8')
    assert.ok(envFile.includes(`ORCA_CLOUD_API_URL=${api.url}`))
  })

  test('U180: relay.sh 同样在干净 shell 中跑过健康检查', async () => {
    const res = await fetch(`${api.url}/install/relay.sh`, { headers: auth(adminToken) })
    assert.equal(res.status, 200)
    const home = makeInstallHome()
    // U182: the script verifies the relay entry it is about to print.
    const relayRoot = join(home, 'orca-cloud')
    const relayEntry = join(relayRoot, 'cloud-platform', 'apps', 'relay', 'src', 'relay.ts')
    mkdirSync(join(relayRoot, 'cloud-platform', 'apps', 'relay', 'src'), { recursive: true })
    writeFileSync(relayEntry, '')
    // U183 R9: an alive node keeps the background relay up for the pid check.
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })
    const run = runInstallScript(await res.text(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })
    try {
      assert.doesNotMatch(run.stderr, /unbound variable/, run.stderr)
      assert.equal(run.status, 0, run.stderr)
      assert.match(run.stdout, /环境已就绪/)
      // U183 R8: the relay env lives at <ROOT>/relay.env, beside the unit's file.
      const envFile = readFileSync(join(relayRoot, 'relay.env'), 'utf8')
      assert.ok(envFile.includes(`ORCA_CLOUD_API_URL=${api.url}`))
    } finally {
      killRelayPid(relayRoot)
    }
  })

  test('U182: 恶意 Host 不能注入安装脚本，执行后无副作用', async () => {
    const marker = join(tmpdir(), `orca-pwned-${process.pid}-${Date.now()}`)
    const payloads = [
      `evil"; touch ${marker}; echo "`,
      `evil$(touch ${marker})`,
      `evil\`touch ${marker}\``
    ]
    for (const host of payloads) {
      const token = await mintHostToken()
      const res = await fetchWithHost(`/install/host.sh?token=${token}`, host)
      assert.equal(res.status, 200, host)
      assert.ok(!res.body.includes(marker), 'the Host header must not reach the script')
      const syntax = spawnSync('bash', ['-n'], { input: res.body, encoding: 'utf8' })
      assert.equal(syntax.status, 0, `${host}: ${syntax.stderr}`)
      const run = runInstallScript(res.body)
      assert.equal(run.status, 0, run.stderr)
    }
    assert.equal(existsSync(marker), false, 'the injected command must not run')
  })

  test('U182: 重跑保留 TLS 路径；env 0600、目录 0700', async () => {
    const home = makeInstallHome()
    const firstToken = await mintHostToken()
    const first = await fetch(`${api.url}/install/host.sh?token=${firstToken}`, {
      headers: auth(adminToken)
    })
    assert.equal(first.status, 200)
    const run1 = runInstallScript(await first.text(), home)
    assert.equal(run1.status, 0, run1.stderr)

    // The rerun (new token, cert already present) used to drop both TLS lines,
    // silently downgrading the host listener to plaintext.
    const secondToken = await mintHostToken()
    const second = await fetch(`${api.url}/install/host.sh?token=${secondToken}`, {
      headers: auth(adminToken)
    })
    assert.equal(second.status, 200)
    const run2 = runInstallScript(await second.text(), home)
    assert.equal(run2.status, 0, run2.stderr)

    const envFile = join(home, '.orca-cloud', 'host.env')
    const env = readFileSync(envFile, 'utf8')
    assert.match(env, /^ORCA_CLOUD_TLS_CERT_PATH=.+$/m)
    assert.match(env, /^ORCA_CLOUD_TLS_KEY_PATH=.+$/m)
    assert.ok(env.includes(`ORCA_CLOUD_HOST_TOKEN=${secondToken}`))
    assert.equal(statSync(envFile).mode & 0o777, 0o600)
    assert.equal(statSync(join(home, '.orca-cloud')).mode & 0o777, 0o700)
  })

  test('U182: 健康检查对不可达地址快速失败', async () => {
    const token = await mintHostToken()
    const res = await fetch(`${api.url}/install/host.sh?token=${token}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 200)
    const script = (await res.text()).replace(
      `ORCA_CLOUD_API_URL=${api.url}`,
      'ORCA_CLOUD_API_URL=http://192.0.2.1:81'
    )
    assert.ok(script.includes('http://192.0.2.1:81'))
    assert.match(script, /--connect-timeout 5 --max-time 10/)
    const started = Date.now()
    const run = runInstallScript(script)
    const elapsed = Date.now() - started
    assert.equal(run.status, 68, run.stderr)
    assert.match(run.stderr, /健康检查失败（68 \/ HTTP/)
    assert.ok(elapsed < 15_000, `health check took ${elapsed}ms`)
  })

  test('U182: 无 hostname -I 且无替代地址 → fail-fast，不写空 ADVERTISE_HOST', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, { hostname: HOSTNAME_STUB, 'orca-ide': ORCA_STUB })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.equal(run.status, 78, run.stderr)
    assert.match(run.stderr, /无法自动探测本机地址（78）/)
    assert.match(run.stderr, /ADVERTISE_HOST/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'host.env')), false)
  })

  test('U182: 无 hostname -I 时回退 ipconfig getifaddr en0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    mkdirSync(join(home, '.orca-cloud', 'tls'), { recursive: true })
    writeFileSync(join(home, '.orca-cloud', 'tls', 'host.crt'), 'stub')
    writeFileSync(join(home, '.orca-cloud', 'tls', 'host.key'), 'stub')
    const bin = makeSparsePath(home, {
      hostname: HOSTNAME_STUB,
      ipconfig: '#!/usr/bin/env bash\n[ "$1" = getifaddr ] && echo 10.9.8.7\n',
      'orca-ide': ORCA_STUB
    })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.equal(run.status, 0, run.stderr)
    const env = readFileSync(join(home, '.orca-cloud', 'host.env'), 'utf8')
    assert.match(env, /^ADVERTISE_HOST=10\.9\.8\.7$/m)
    assert.match(env, /^ORCA_CLOUD_ADVERTISE_HOST=10\.9\.8\.7$/m)
  })

  test('U182: openssl 失败保留 stderr 并 exit 78', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, {
      hostname:
        '#!/usr/bin/env bash\ncase "$1" in -s|-I) echo orca-test-host ;; *) echo orca-test-host ;; esac\n',
      'orca-ide': ORCA_STUB,
      openssl: '#!/usr/bin/env bash\necho "openssl-stub-boom" >&2\nexit 1\n'
    })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.equal(run.status, 78, run.stderr)
    assert.match(run.stderr, /openssl-stub-boom/)
    assert.match(run.stderr, /自签 TLS 证书生成失败（78 /)
  })

  test('U182: OpenSSL 1.0.2 降级为临时 config 生成 SAN，不使用 -addext', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const marker = join(home, 'openssl-args.txt')
    const opensslStub = [
      '#!/usr/bin/env bash',
      'if [ "$1" = version ]; then echo "OpenSSL 1.0.2k-fips  26 Jan 2017"; exit 0; fi',
      `printf '%s\\n' "$@" > '${marker}'`,
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -keyout) printf key > "$2"; shift 2 ;;',
      '    -out) printf cert > "$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'exit 0'
    ].join('\n')
    const bin = makeSparsePath(home, {
      hostname:
        '#!/usr/bin/env bash\ncase "$1" in -s|-I) echo orca-test-host ;; *) echo orca-test-host ;; esac\n',
      'orca-ide': ORCA_STUB,
      openssl: opensslStub
    })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.equal(run.status, 0, run.stderr)
    const args = readFileSync(marker, 'utf8')
    assert.match(args, /-config/)
    assert.doesNotMatch(args, /-addext/)
  })

  test('U182: 无 systemctl 时打印 nohup 启动命令且安装成功', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    mkdirSync(join(home, '.orca-cloud', 'tls'), { recursive: true })
    writeFileSync(join(home, '.orca-cloud', 'tls', 'host.crt'), 'stub')
    writeFileSync(join(home, '.orca-cloud', 'tls', 'host.key'), 'stub')
    const bin = makeSparsePath(home, {
      hostname:
        '#!/usr/bin/env bash\ncase "$1" in -s|-I) echo orca-test-host ;; *) echo orca-test-host ;; esac\n',
      'orca-ide': ORCA_STUB
    })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /未检测到 systemctl/)
    // H10b: the nohup line launches the wrapper, which owns host.env + pid.
    assert.match(run.stdout, /启动脚本：.*run-host\.sh/)
    assert.match(run.stdout, /nohup setsid .*run-host\.sh/)
    assert.doesNotMatch(run.stdout, /systemctl --user enable/)
    const wrapper = readFileSync(join(home, '.orca-cloud', 'run-host.sh'), 'utf8')
    assert.match(wrapper, /^set -a$/m)
    assert.match(wrapper, /exec ".*orca-ide" --host-mode/)
  })

  describe('H9b: systemd 用户单元生成', () => {
    const UNIT_PATH = '.config/systemd/user/orca-host.service'
    const LEGACY_UNIT_PATH = '.config/systemd/user/orca-cloud-host.service'

    /** Logs every invocation so the test can prove the exact systemctl verbs. */
    const SYSTEMCTL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
exit 0
`
    const SYSTEMCTL_ENABLE_FAILS = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
case "$*" in *enable*) exit 1 ;; esac
exit 0
`
    const LOGINCTL_OK = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/loginctl.log"
exit 0
`
    const LOGINCTL_FAILS = `#!/usr/bin/env bash
echo "linger denied" >&2
exit 1
`

    // Sparse PATH has no real `hostname` fallback, so the bare invocation must
    // answer too (HOSTNAME_STUB only covers -s/-I).
    const ADVERTISING_HOSTNAME =
      '#!/usr/bin/env bash\ncase "$1" in -s) echo orca-test-host ;; *) echo orca-test-host ;; esac\n'

    function makeSystemdHome(stubs: Record<string, string>): string {
      const home = makeInstallHome()
      makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        'orca-ide': ORCA_STUB,
        ...stubs
      })
      return home
    }

    function pathOf(home: string): string {
      return join(home, 'sparse-bin')
    }

    test('写 orca-host.service：单元键齐全、StartLimit 300、RestartPreventExitStatus 只含 78', async () => {
      const home = makeSystemdHome({ systemctl: SYSTEMCTL_STUB, loginctl: LOGINCTL_OK })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: pathOf(home),
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 0, run.stderr)
      const unit = readFileSync(join(home, UNIT_PATH), 'utf8')
      assert.match(unit, /^\[Unit\]$/m)
      assert.match(unit, /^Description=Orca Cloud 宿主代理$/m)
      assert.match(unit, /^After=network-online\.target$/m)
      assert.match(unit, /^Wants=network-online\.target$/m)
      assert.match(unit, /^StartLimitIntervalSec=300$/m)
      assert.match(unit, /^StartLimitBurst=5$/m)
      assert.match(unit, /^EnvironmentFile=%h\/\.orca-cloud\/host\.env$/m)
      assert.match(unit, /^ExecStart=.+orca-ide --host-mode$/m)
      assert.match(unit, /^Restart=on-failure$/m)
      assert.match(unit, /^RestartSec=5$/m)
      assert.match(unit, /^RestartPreventExitStatus=78$/m)
      // Design v3: exit 3 was a dead configuration and must not come back.
      assert.doesNotMatch(unit, /RestartPreventExitStatus=.*3/)
      assert.match(unit, /^WantedBy=default\.target$/m)

      // Linger is best-effort and the unit is activated through systemctl.
      assert.match(readFileSync(join(home, 'loginctl.log'), 'utf8'), /enable-linger/)
      const calls = readFileSync(join(home, 'systemctl.log'), 'utf8')
      assert.match(calls, /--user daemon-reload/)
      assert.match(calls, /--user enable --now orca-host\.service/)
      // systemd owns the process; no nohup duplicate beside it.
      assert.doesNotMatch(run.stdout, /nohup .*--host-mode/)
      assert.match(run.stdout, /orca-host\.service/)
      // U181 P2-9: journald owns the logs; host.log does not exist here.
      assert.match(run.stdout, /journalctl --user -u orca-host\.service/)
      assert.doesNotMatch(run.stdout, /host\.log/)
      assert.equal(existsSync(join(home, LEGACY_UNIT_PATH)), false)
    })

    test('ORCA_ENV_FILE 覆盖：unit 指向自定义 EnvironmentFile', async () => {
      const home = makeSystemdHome({ systemctl: SYSTEMCTL_STUB, loginctl: LOGINCTL_OK })
      const customEnv = join(home, 'custom-config', 'host.env')
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: pathOf(home),
        ORCA_ENV_FILE: customEnv,
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 0, run.stderr)
      const unit = readFileSync(join(home, UNIT_PATH), 'utf8')
      assert.ok(unit.includes(`EnvironmentFile=${customEnv}`), unit)
      assert.equal(existsSync(customEnv), true)
    })

    test('旧 orca-cloud-host.service 在改名后被停用并删除', async () => {
      const home = makeSystemdHome({ systemctl: SYSTEMCTL_STUB, loginctl: LOGINCTL_OK })
      const legacyUnit = join(home, LEGACY_UNIT_PATH)
      mkdirSync(dirname(legacyUnit), { recursive: true })
      writeFileSync(legacyUnit, '[Unit]\nDescription=legacy\n')

      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: pathOf(home),
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 0, run.stderr)
      assert.equal(existsSync(legacyUnit), false)
      assert.equal(existsSync(join(home, UNIT_PATH)), true)
      const calls = readFileSync(join(home, 'systemctl.log'), 'utf8')
      assert.match(calls, /--user disable --now orca-cloud-host\.service/)
      assert.match(calls, /--user enable --now orca-host\.service/)
    })

    test('U187/H10b: systemd <229 剔除 StartLimit 并降级 Restart=no', async () => {
      const legacySystemctl = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
if [ "$1" = "--version" ]; then echo "systemd 219"; fi
exit 0
`
      const home = makeSystemdHome({ systemctl: legacySystemctl, loginctl: LOGINCTL_OK })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: pathOf(home),
        ORCA_HOST_STATE_TIMEOUT: '0'
      })
      assert.equal(run.status, 0, run.stderr)
      assert.match(run.stderr, /systemd 219 < 229/)
      const unit = readFileSync(join(home, UNIT_PATH), 'utf8')
      assert.doesNotMatch(unit, /StartLimit/)
      assert.match(unit, /^Restart=no$/m)
    })

    test('loginctl enable-linger 失败只告警，安装继续', async () => {
      const home = makeSystemdHome({ systemctl: SYSTEMCTL_STUB, loginctl: LOGINCTL_FAILS })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: pathOf(home),
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 0, run.stderr)
      assert.match(run.stderr, /loginctl enable-linger 失败/)
      assert.match(readFileSync(join(home, 'systemctl.log'), 'utf8'), /enable --now/)
    })

    test('systemctl enable --now 失败 → 退出码 69', async () => {
      const home = makeSystemdHome({
        systemctl: SYSTEMCTL_ENABLE_FAILS,
        loginctl: LOGINCTL_OK
      })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: pathOf(home),
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 69, run.stderr)
      assert.match(run.stderr, /systemd 用户服务安装失败（69）/)
    })

    test('非 systemd 路径不写用户单元，保持 nohup 语义', async () => {
      const home = makeSystemdHome({})
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: pathOf(home),
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 0, run.stderr)
      assert.equal(existsSync(join(home, UNIT_PATH)), false)
      assert.match(run.stdout, /nohup setsid .*run-host\.sh/)
      // U181 P2-9: without systemd the file tail stays the log source.
      assert.match(run.stdout, /host\.log/)
      assert.doesNotMatch(run.stdout, /journalctl/)
    })

    test('U181 P2-9: systemd 超时诊断走 journalctl，不指向 host.log', async () => {
      const now = Date.now()
      const home = makeInstallHome()
      const stateDir = join(home, '.orca-cloud', 'profile')
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(
        join(stateDir, 'orca-cloud-host-state.json'),
        JSON.stringify(
          {
            schemaVersion: 2,
            status: 'starting',
            hostId: null,
            platformUrl: api.url,
            startedAt: now,
            lastHeartbeatOk: false,
            lastHeartbeatAt: now,
            pid: 0
          },
          null,
          2
        )
      )
      const bin = makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        'orca-ide': ORCA_STUB,
        systemctl: SYSTEMCTL_STUB,
        loginctl: LOGINCTL_OK,
        journalctl: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/journalctl.log"
echo "journal-tail: orca-host"
`
      })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: bin,
        ORCA_HOST_STATE_TIMEOUT: '2'
      })

      assert.equal(run.status, 70, run.stderr)
      assert.match(run.stderr, /journalctl --user -u orca-host\.service/)
      assert.doesNotMatch(run.stderr, /host\.log/)
      assert.match(run.stderr, /journal-tail: orca-host/)
      assert.match(
        readFileSync(join(home, 'journalctl.log'), 'utf8'),
        /--user -u orca-host\.service -n 40 --no-pager/
      )
    })
  })

  describe('U181 P2-10: 已有凭据时的 --reenroll 提示', () => {
    const ADVERTISING_HOSTNAME =
      '#!/usr/bin/env bash\ncase "$1" in -s) echo orca-test-host ;; *) echo orca-test-host ;; esac\n'
    const SYSTEMCTL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
exit 0
`
    const LOGINCTL_OK = `#!/usr/bin/env bash
exit 0
`
    const CREDENTIAL_PATH = '.orca-cloud/profile/orca-cloud-host.json'

    test('重跑（已有 orca-cloud-host.json）→ 输出解析后的 --host-mode --reenroll', async () => {
      const home = makeInstallHome()
      mkdirSync(join(home, '.orca-cloud', 'profile'), { recursive: true })
      writeFileSync(join(home, CREDENTIAL_PATH), '{"hostId":"host_old"}')
      const bin = makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        'orca-ide': ORCA_STUB,
        systemctl: SYSTEMCTL_STUB,
        loginctl: LOGINCTL_OK
      })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: bin,
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 0, run.stderr)
      assert.match(run.stdout, /--host-mode --reenroll/)
      // The hint must be runnable: the resolved ORCA_CLI path, not a bare name.
      assert.ok(
        run.stdout.includes(`"${join(bin, 'orca-ide')}" --host-mode --reenroll`),
        run.stdout
      )
    })

    test('首次安装（凭据由本次运行写入）→ 不提示 --reenroll', async () => {
      const home = makeInstallHome()
      // enable --now writes the credential synchronously, before the output block.
      const systemctlWritesCredential = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
case "$*" in
  *enable*) mkdir -p "$HOME/.orca-cloud/profile"; : > "$HOME/.orca-cloud/profile/orca-cloud-host.json" ;;
esac
exit 0
`
      const bin = makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        'orca-ide': ORCA_STUB,
        systemctl: systemctlWritesCredential,
        loginctl: LOGINCTL_OK
      })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: bin,
        ORCA_HOST_STATE_TIMEOUT: '0'
      })

      assert.equal(run.status, 0, run.stderr)
      assert.equal(existsSync(join(home, CREDENTIAL_PATH)), true)
      assert.doesNotMatch(run.stdout, /--reenroll/)
    })
  })

  test('U182: 缺少 orca/orca-ide 时 fail-fast，不写配置', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, { hostname: HOSTNAME_STUB })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /未找到 Orca 宿主程序/)
    assert.match(run.stderr, /orca-ide/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'host.env')), false)
    assert.equal(run.status, 78, 'preflight failure keeps EX_CONFIG')
  })

  describe('U181 P1-3: CLI 路径解析', () => {
    const LINUX_UNAME = '#!/usr/bin/env bash\necho Linux\n'
    const DARWIN_UNAME = '#!/usr/bin/env bash\necho Darwin\n'
    const ADVERTISING_HOSTNAME =
      '#!/usr/bin/env bash\ncase "$1" in -s) echo orca-test-host ;; *) echo orca-test-host ;; esac\n'

    test('Linux 只有裸 orca（GNOME 桩）→ 78，且不写 env/unit', async () => {
      const home = makeInstallHome()
      const bin = makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        uname: LINUX_UNAME,
        orca: '#!/usr/bin/env bash\necho gnome-orca-should-not-run >&2\nexit 0\n',
        systemctl: '#!/usr/bin/env bash\nexit 0\n'
      })
      const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

      assert.equal(run.status, 78, run.stderr)
      assert.match(run.stderr, /未找到 Orca 宿主程序/)
      assert.doesNotMatch(run.stderr, /gnome-orca-should-not-run/)
      assert.equal(existsSync(join(home, '.orca-cloud', 'host.env')), false)
      assert.equal(existsSync(join(home, '.config/systemd/user/orca-host.service')), false)
    })

    test('macOS 可以回退裸 orca', async () => {
      const home = makeInstallHome()
      const bin = makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        uname: DARWIN_UNAME,
        orca: ORCA_STUB
      })
      const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

      assert.equal(run.status, 0, run.stderr)
      assert.equal(existsSync(join(home, '.orca-cloud', 'host.env')), true)
      // macOS has no user systemd; it must use the wrapper, never a unit name.
      assert.match(run.stdout, /run-host\.sh/)
      assert.doesNotMatch(run.stdout, /orca-cloud-host\.service/)
      assert.doesNotMatch(run.stdout, /orca-host\.service/)
    })

    test('ORCA_CLI 显式路径优先，即使 Linux 只有 GNOME orca', async () => {
      const home = makeInstallHome()
      const marker = join(home, 'gnome-orca-ran')
      const explicit = join(home, 'custom-orca-ide')
      writeFileSync(explicit, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
      const bin = makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        uname: LINUX_UNAME,
        orca: `#!/usr/bin/env bash\ntouch '${marker}'\nexit 0\n`,
        systemctl: '#!/usr/bin/env bash\nexit 0\n'
      })
      const run = runInstallScript(await fetchHostScript(), home, {
        PATH: bin,
        ORCA_CLI: explicit
      })

      assert.equal(run.status, 0, run.stderr)
      assert.equal(existsSync(marker), false, 'bare orca must never be selected')
      const unit = readFileSync(join(home, '.config/systemd/user/orca-host.service'), 'utf8')
      assert.equal(unit.includes(`ExecStart=${explicit} --host-mode`), true)
    })
  })

  describe('U181 P1-4: preflight 前置', () => {
    const ADVERTISING_HOSTNAME =
      '#!/usr/bin/env bash\ncase "$1" in -s) echo orca-test-host ;; *) echo orca-test-host ;; esac\n'

    function preflightHome(hostBody: string): { home: string; bin: string } {
      const home = makeInstallHome()
      const bin = makeSparsePath(home, {
        hostname: ADVERTISING_HOSTNAME,
        uname: '#!/usr/bin/env bash\necho Linux\n',
        'orca-ide': hostBody,
        systemctl: '#!/usr/bin/env bash\nexit 0\n'
      })
      return { home, bin }
    }

    test('配置失败 → 78，打印其 stdout/stderr，不写 env/unit', async () => {
      const { home, bin } = preflightHome(`#!/usr/bin/env bash
case "$*" in
  *--preflight*)
    echo '{"ok":false,"checks":[{"id":"config","ok":false,"detail":"missing ORCA_CLOUD_HOST_NAME"}]}'
    echo 'host mode preflight failed: config: missing ORCA_CLOUD_HOST_NAME' >&2
    exit 78 ;;
esac
exit 0
`)
      const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

      assert.equal(run.status, 78, run.stderr)
      assert.match(run.stderr, /"id":"config"/)
      assert.match(run.stderr, /host mode preflight failed/)
      assert.match(run.stderr, /宿主配置无效/)
      assert.equal(existsSync(join(home, '.orca-cloud', 'host.env')), false)
      assert.equal(existsSync(join(home, '.config/systemd/user/orca-host.service')), false)
    })

    test('运行时失败 → 64，不写 env/unit', async () => {
      const { home, bin } = preflightHome(`#!/usr/bin/env bash
case "$*" in
  *--preflight*)
    echo '{"ok":false,"checks":[{"id":"runtime","ok":false,"detail":"orcad slot unavailable"}]}'
    exit 78 ;;
esac
exit 0
`)
      const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

      assert.equal(run.status, 64, run.stderr)
      assert.match(run.stderr, /宿主运行时不可用/)
      assert.equal(existsSync(join(home, '.orca-cloud', 'host.env')), false)
      assert.equal(existsSync(join(home, '.config/systemd/user/orca-host.service')), false)
    })
  })

  describe('H9a: 安装脚本状态自证', () => {
    test('status=online、lastHeartbeatOk=true、hostId、存活 pid → 0', async () => {
      const now = Date.now()
      const home = makeHostStateHome({
        schemaVersion: 2,
        status: 'online',
        hostId: 'host_h9a',
        platformUrl: api.url,
        startedAt: now,
        lastHeartbeatOk: true,
        lastHeartbeatAt: now,
        pid: 0
      })
      try {
        const run = runInstallScript(await fetchHostScript(), home, {
          ORCA_HOST_STATE_TIMEOUT: '8'
        })
        assert.equal(run.status, 0, run.stderr)
        assert.match(run.stdout, /宿主已上线/)
        assert.match(run.stdout, /host_h9a/)
      } finally {
        killStateHost(home)
      }
    })

    test('status=starting 不算在线 → 70，打印状态摘录与日志路径', async () => {
      const now = Date.now()
      const home = makeHostStateHome({
        schemaVersion: 2,
        status: 'starting',
        hostId: null,
        platformUrl: api.url,
        startedAt: now,
        lastHeartbeatOk: false,
        lastHeartbeatAt: now,
        pid: 0
      })
      try {
        const run = runInstallScript(await fetchHostScript(), home, {
          ORCA_HOST_STATE_TIMEOUT: '2'
        })
        assert.equal(run.status, 70, run.stdout)
        assert.match(run.stderr, /状态文件摘录/)
        assert.match(run.stderr, /host\.log/)
      } finally {
        killStateHost(home)
      }
    })

    test('pid 不存在 → 70', async () => {
      const now = Date.now()
      const home = makeHostStateHome(
        {
          schemaVersion: 2,
          status: 'online',
          hostId: 'host_dead',
          platformUrl: api.url,
          startedAt: now,
          lastHeartbeatOk: true,
          lastHeartbeatAt: now,
          pid: 999999
        },
        { stayAlive: false }
      )
      const run = runInstallScript(await fetchHostScript(), home, {
        ORCA_HOST_STATE_TIMEOUT: '2'
      })
      assert.equal(run.status, 70, run.stdout)
    })

    test('宿主未写状态文件 → 70', async () => {
      const home = makeInstallHome()
      const run = runInstallScript(await fetchHostScript(), home, {
        ORCA_HOST_STATE_TIMEOUT: '1'
      })
      assert.equal(run.status, 70, run.stdout)
      assert.match(run.stderr, /状态文件不存在/)
    })

    // U181 P1-2: a stale `online` from an earlier process must never be success.
    test('startedAt 早于本次安装起点 → 70（防旧状态）', async () => {
      const now = Date.now()
      const home = makeHostStateHome({
        schemaVersion: 2,
        status: 'online',
        hostId: 'host_stale_start',
        platformUrl: api.url,
        startedAt: now - 3_600_000,
        lastHeartbeatOk: true,
        lastHeartbeatAt: now,
        pid: 0
      })
      try {
        const run = runInstallScript(await fetchHostScript(), home, {
          ORCA_HOST_STATE_TIMEOUT: '2'
        })
        assert.equal(run.status, 70, run.stdout)
        assert.match(run.stderr, /退出码 70/)
      } finally {
        killStateHost(home)
      }
    })

    test('lastHeartbeatAt 超过 30s → 70（心跳不新鲜）', async () => {
      const now = Date.now()
      const home = makeHostStateHome({
        schemaVersion: 2,
        status: 'online',
        hostId: 'host_stale_heartbeat',
        platformUrl: api.url,
        startedAt: now,
        lastHeartbeatOk: true,
        lastHeartbeatAt: now - 60_000,
        pid: 0
      })
      try {
        const run = runInstallScript(await fetchHostScript(), home, {
          ORCA_HOST_STATE_TIMEOUT: '2'
        })
        assert.equal(run.status, 70, run.stdout)
        assert.match(run.stderr, /退出码 70/)
      } finally {
        killStateHost(home)
      }
    })

    test('platformUrl 与本次平台不一致 → 70（跨平台复用）', async () => {
      const now = Date.now()
      const home = makeHostStateHome({
        schemaVersion: 2,
        status: 'online',
        hostId: 'host_other_platform',
        platformUrl: 'https://other-platform.example',
        startedAt: now,
        lastHeartbeatOk: true,
        lastHeartbeatAt: now,
        pid: 0
      })
      try {
        const run = runInstallScript(await fetchHostScript(), home, {
          ORCA_HOST_STATE_TIMEOUT: '2'
        })
        assert.equal(run.status, 70, run.stdout)
        assert.match(run.stderr, /退出码 70/)
      } finally {
        killStateHost(home)
      }
    })
  })

  test('U183 R4: relay 缺 node 时以 64 失败且不写配置', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, {}, ['node'])
    const run = runInstallScript(await fetchRelayScript(), home, { PATH: bin })
    assert.equal(run.status, 64, run.stderr)
    assert.match(run.stderr, /未找到 node/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
  })

  test('U183 R4: Node 21 以 64 失败且安装根无 release', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_21_STUB })
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })
    assert.equal(run.status, 64, run.stderr)
    assert.match(run.stderr, /版本过低.*21\.7\.0/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
    assert.equal(existsSync(join(relayRoot, 'releases')), false)
  })

  test('U184: 仓库模式缺入口以 78 失败，不假装安装', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, { node: NODE_2218_STUB })
    const script = await fetchRelayScriptRepoMode()
    assert.match(script, /cloud-platform\/apps\/relay\/src\/relay\.ts/)
    const run = runInstallScript(script, home, {
      PATH: bin,
      ORCA_RELAY_ROOT: join(home, 'missing-relay')
    })
    assert.equal(run.status, 78, run.stderr)
    assert.match(run.stderr, /未找到中继程序/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
  })

  test('U183 R4: 安装根不可写以 78 失败且不写配置', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root 可写任意目录')
      return
    }
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB })
    chmodSync(relayRoot, 0o500)
    try {
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      assert.equal(run.status, 78, run.stderr)
      assert.match(run.stderr, /安装根不可写/)
      assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
    } finally {
      chmodSync(relayRoot, 0o700)
    }
  })

  test('U183 R4: 平台健康检查失败以 68 失败，不写 env', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB })
    // Point this copy at a closed port to exercise health without stopping the API.
    const script = (await fetchRelayScript()).replaceAll(api.url, 'http://127.0.0.1:1')
    const run = runInstallScript(script, home, { PATH: bin, ORCA_RELAY_ROOT: relayRoot })
    assert.equal(run.status, 68, run.stderr)
    assert.match(run.stderr, /健康检查失败（68/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
    assert.equal(existsSync(join(relayRoot, 'releases')), false)
  })

  test('U183 R4: relay 无 systemctl 时打印 nohup 启动命令且安装成功', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })
    try {
      assert.equal(run.status, 0, run.stderr)
      assert.match(run.stdout, /未检测到 systemctl/)
      // U183 R9: the nohup line launches the wrapper, not the entry directly.
      assert.match(run.stdout, /nohup setsid .*run-relay\.sh/)
      // R5: the verified bundle lands at downloads/<sha>.tgz, no .part survives.
      assert.equal(existsSync(join(relayRoot, 'downloads', `${BUNDLE_SHA}.tgz`)), true)
      assert.equal(existsSync(join(relayRoot, 'downloads', `${BUNDLE_SHA}.tgz.part`)), false)
    } finally {
      killRelayPid(relayRoot)
    }
  })

  test('U183 R7: relay.env 原子写，含 nonce、稳定 RELAY_ID 与受管字段', async () => {
    const home = makeInstallHome()
    const relayRoot = makeRelayRoot(home)
    const script = await fetchRelayScript()
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })

    const first = runInstallScript(script, home, { PATH: bin, ORCA_RELAY_ROOT: relayRoot })
    assert.equal(first.status, 0, first.stderr)
    killRelayPid(relayRoot)
    const envFile = join(relayRoot, 'relay.env')
    assert.equal(statSync(envFile).mode & 0o777, 0o600)
    // Atomic write: mktemp + mv leaves no intermediate file visible.
    assert.deepEqual(
      readdirSync(relayRoot).filter((name) => name.startsWith('relay.env.')),
      []
    )
    const env = readRelayEnv(envFile)
    assert.match(env.ORCA_CLOUD_INSTALL_NONCE ?? '', /^[A-Za-z0-9_-]{1,128}$/)
    assert.equal(env.PORT, '18443')
    assert.match(env.ORCA_CLOUD_RELAY_ID ?? '', /^.+:18443$/)
    assert.equal(env.ORCA_CLOUD_API_URL, api.url)
    assert.equal(env.ORCA_RELAY_BUNDLE_SHA256, BUNDLE_SHA)
    assert.equal(env.ORCA_CLOUD_INTERNAL_TOKEN, INTERNAL_TOKEN)

    // A rerun is a fresh install: new nonce, same identity and managed keys.
    const second = runInstallScript(script, home, { PATH: bin, ORCA_RELAY_ROOT: relayRoot })
    assert.equal(second.status, 0, second.stderr)
    killRelayPid(relayRoot)
    const rerun = readRelayEnv(envFile)
    assert.notEqual(rerun.ORCA_CLOUD_INSTALL_NONCE, env.ORCA_CLOUD_INSTALL_NONCE)
    assert.match(rerun.ORCA_CLOUD_INSTALL_NONCE ?? '', /^[A-Za-z0-9_-]{1,128}$/)
    assert.equal(rerun.ORCA_CLOUD_RELAY_ID, env.ORCA_CLOUD_RELAY_ID)
    assert.equal(rerun.ORCA_CLOUD_API_URL, env.ORCA_CLOUD_API_URL)
    assert.equal(rerun.ORCA_RELAY_BUNDLE_SHA256, env.ORCA_RELAY_BUNDLE_SHA256)
    assert.equal(readdirSync(relayRoot).filter((n) => n.startsWith('relay.env.')).length, 0)
  })

  test('U183 R7: env 只经 mktemp + mv 落位，不直接截断 relay.env', async () => {
    const script = await fetchRelayScript()
    assert.match(script, /mktemp "\$\{ORCA_ENV_FILE\}\.XXXXXX"/)
    assert.match(script, /chmod 600 "\$ORCA_ENV_TMP"/)
    assert.match(script, /mv -f "\$ORCA_ENV_TMP" "\$ORCA_ENV_FILE"/)
    assert.doesNotMatch(script, />\s*"\$ORCA_ENV_FILE"/)
  })

  test('U183 R5: 脚本带受限下载参数、双 sha 探测与离线逃生口', async () => {
    const script = await fetchRelayScript()
    assert.match(script, /--connect-timeout 10 --max-time 120/)
    assert.match(script, /ORCA_RELAY_BUNDLE:-/)
    assert.match(script, /sha256sum|shasum/)
    assert.match(script, /manifest\.json/)
  })

  test('U183 R5: bundle 下载失败以 65 退出，不留临时文件与 env', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB, curl: FAILING_CURL_STUB })
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })
    assert.equal(run.status, 65, run.stderr)
    assert.match(run.stderr, /（65）/)
    assert.equal(existsSync(join(relayRoot, 'downloads', `${BUNDLE_SHA}.tgz.part`)), false)
    assert.equal(existsSync(join(relayRoot, 'downloads', `${BUNDLE_SHA}.tgz`)), false)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
  })

  test('U183 R5: sha256 与内嵌值不符以 66 退出并删除坏包', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB, curl: TAMPERING_CURL_STUB })
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })
    assert.equal(run.status, 66, run.stderr)
    assert.match(run.stderr, /（66）/)
    assert.equal(existsSync(join(relayRoot, 'downloads', `${BUNDLE_SHA}.tgz.part`)), false)
    assert.equal(existsSync(join(relayRoot, 'downloads', `${BUNDLE_SHA}.tgz`)), false)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
  })

  test('U183 R5: 清单 schema 与脚本内嵌值不符以 67 退出', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB })
    const script = (await fetchRelayScript()).replace(
      /^ORCA_RELAY_SCHEMA_VERSION=1$/m,
      'ORCA_RELAY_SCHEMA_VERSION=2'
    )
    const run = runInstallScript(script, home, { PATH: bin, ORCA_RELAY_ROOT: relayRoot })
    assert.equal(run.status, 67, run.stderr)
    assert.match(run.stderr, /（67）/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
  })

  test('U183 R5: ORCA_RELAY_BUNDLE 离线路径跳过下载且校验通过', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const offline = join(home, 'offline-bundle.tgz')
    writeFileSync(offline, BUNDLE_BODY)
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB, curl: FAILING_CURL_STUB })
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot,
      ORCA_RELAY_BUNDLE: offline
    })
    try {
      assert.equal(run.status, 0, run.stderr)
      assert.match(run.stdout, /离线 bundle/)
      assert.equal(existsSync(join(relayRoot, 'downloads')), false)
      assert.equal(existsSync(join(relayRoot, 'relay.env')), true)
    } finally {
      killRelayPid(relayRoot)
    }
  })

  test('U183 R5: 离线文件 sha 不符以 66 退出且不删除用户文件', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const offline = join(home, 'offline-bundle.tgz')
    writeFileSync(offline, 'tampered offline bundle')
    const bin = makeSparsePath(home, { node: NODE_2218_STUB })
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot,
      ORCA_RELAY_BUNDLE: offline
    })
    assert.equal(run.status, 66, run.stderr)
    assert.match(run.stderr, /（66）/)
    assert.equal(existsSync(offline), true)
    assert.equal(existsSync(join(home, '.orca-cloud', 'relay.env')), false)
  })

  describe('U183 R8: relay systemd 用户单元安装', () => {
    const RELAY_UNIT_PATH = '.config/systemd/user/orca-relay.service'
    /** Logs every invocation so the test can prove the exact systemctl verbs. */
    const RELAY_SYSTEMCTL_OK = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
exit 0
`
    const RELAY_SYSTEMCTL_ENABLE_FAILS = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
case "$*" in *enable*) exit 1 ;; esac
exit 0
`
    /** U187: systemd <229; StartLimit is unusable and must be dropped. */
    const RELAY_SYSTEMCTL_LEGACY = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
if [ "$1" = "--version" ]; then echo "systemd 219"; fi
exit 0
`

    function makeRelaySystemdHome(systemctl: string): {
      home: string
      relayRoot: string
      nodeBin: string
    } {
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, { node: NODE_2218_STUB, systemctl })
      return { home, relayRoot, nodeBin: join(bin, 'node') }
    }

    test('写 orca-relay.service：current 入口、绝对 env、无 78、enable --now', async () => {
      const { home, relayRoot, nodeBin } = makeRelaySystemdHome(RELAY_SYSTEMCTL_OK)
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: join(home, 'sparse-bin'),
        ORCA_RELAY_ROOT: relayRoot
      })

      assert.equal(run.status, 0, run.stderr)
      const unit = readFileSync(join(home, RELAY_UNIT_PATH), 'utf8')
      assert.match(unit, /^\[Unit\]$/m)
      assert.match(unit, /^Description=Orca Cloud 中继$/m)
      assert.match(unit, /^After=network-online\.target$/m)
      assert.match(unit, /^Wants=network-online\.target$/m)
      assert.match(unit, /^StartLimitIntervalSec=\d+$/m)
      assert.match(unit, /^StartLimitBurst=5$/m)
      assert.equal(unit.includes(`EnvironmentFile=${relayRoot}/relay.env`), true)
      assert.equal(
        unit.includes(`ExecStart=${nodeBin} ${relayRoot}/current/apps/relay/src/relay.ts`),
        true
      )
      assert.match(unit, /^Restart=on-failure$/m)
      assert.match(unit, /^RestartSec=2$/m)
      assert.match(unit, /^Type=simple$/m)
      assert.equal(unit.includes(`WorkingDirectory=${relayRoot}/current`), true)
      // 78 is the install-script code; the relay unit must never restart-block on it.
      assert.doesNotMatch(unit, /RestartPreventExitStatus/)
      assert.match(unit, /^WantedBy=default\.target$/m)

      const calls = readFileSync(join(home, 'systemctl.log'), 'utf8')
      assert.match(calls, /--user daemon-reload/)
      assert.match(calls, /--user enable --now orca-relay\.service/)
      // systemd owns the process; no nohup duplicate beside it.
      assert.doesNotMatch(run.stdout, /nohup .*relay\.ts/)
    })

    test('U187: systemd <229 剔除 StartLimit 并降级 Restart=no', async () => {
      const { home, relayRoot } = makeRelaySystemdHome(RELAY_SYSTEMCTL_LEGACY)
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: join(home, 'sparse-bin'),
        ORCA_RELAY_ROOT: relayRoot
      })
      assert.equal(run.status, 0, run.stderr)
      assert.match(run.stderr, /systemd 219 < 229/)
      const unit = readFileSync(join(home, RELAY_UNIT_PATH), 'utf8')
      assert.doesNotMatch(unit, /StartLimit/)
      assert.match(unit, /^Restart=no$/m)
    })

    test('systemctl enable --now 失败 → 69 relay_service_install_failed', async () => {
      const { home, relayRoot } = makeRelaySystemdHome(RELAY_SYSTEMCTL_ENABLE_FAILS)
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: join(home, 'sparse-bin'),
        ORCA_RELAY_ROOT: relayRoot
      })

      assert.equal(run.status, 69, run.stderr)
      assert.match(run.stderr, /relay_service_install_failed/)
    })

    test('非 systemd 路径不写 relay 单元，保持 nohup 语义', async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      try {
        assert.equal(run.status, 0, run.stderr)
        assert.equal(existsSync(join(home, RELAY_UNIT_PATH)), false)
        // U183 R9: the nohup path now launches the wrapper, which owns the pid.
        assert.match(run.stdout, /nohup setsid .*run-relay\.sh/)
      } finally {
        killRelayPid(relayRoot)
      }
    })
  })

  describe('U183 R9: 非 systemd relay wrapper 与 pid', () => {
    function makeRelayLaunchHome(node: string): {
      home: string
      relayRoot: string
      bin: string
      nodeBin: string
    } {
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, { node })
      return { home, relayRoot, bin, nodeBin: join(bin, 'node') }
    }

    test('写 run-relay.sh：source relay.env、exec node relay.ts、chmod 700', async () => {
      const { home, relayRoot, bin, nodeBin } = makeRelayLaunchHome(NODE_2218_ALIVE_STUB)
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      try {
        assert.equal(run.status, 0, run.stderr)
        const wrapperPath = join(relayRoot, 'run-relay.sh')
        assert.equal(statSync(wrapperPath).mode & 0o777, 0o700)
        const wrapper = readFileSync(wrapperPath, 'utf8')
        assert.match(wrapper, /^set -eu$/m)
        assert.match(wrapper, /^set -a$/m)
        assert.equal(wrapper.includes(`. "${relayRoot}/relay.env"`), true)
        assert.match(wrapper, /^set \+a$/m)
        assert.equal(
          wrapper.includes(`exec "${nodeBin}" "${relayRoot}/current/apps/relay/src/relay.ts"`),
          true
        )
      } finally {
        killRelayPid(relayRoot)
      }
    })

    test('后台启动：pid 文件是运行中的实际 node 进程，日志重定向', async () => {
      const { home, relayRoot, bin } = makeRelayLaunchHome(NODE_2218_ALIVE_STUB)
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      try {
        assert.equal(run.status, 0, run.stderr)
        const pid = Number(readFileSync(join(relayRoot, 'relay.pid'), 'utf8').trim())
        assert.ok(Number.isInteger(pid) && pid > 0, `bad pid: ${pid}`)
        assert.doesNotThrow(() => process.kill(pid, 0), 'the recorded pid must be alive')

        const log = readFileSync(join(relayRoot, 'relay.log'), 'utf8')
        // The stub prints its own $$ — it must match the recorded pid, proving
        // the file holds the node process, not the nohup/setsid wrapper.
        const started = /relay-stub-started (\d+) (.*)/.exec(log)
        assert.ok(started, `missing start marker: ${log}`)
        assert.equal(Number(started[1]), pid)
        assert.match(started[2], /current\/apps\/relay\/src\/relay\.ts/)

        assert.match(run.stdout, /不随开机自启/)
        assert.match(run.stdout, /nohup setsid .*run-relay\.sh/)
        assert.match(run.stdout, /run-relay\.sh/)
      } finally {
        killRelayPid(relayRoot)
      }
    })

    test('中继启动即退出 → 69 relay_start_failed 且不留 pid', async () => {
      const { home, relayRoot, bin } = makeRelayLaunchHome(NODE_2218_DIES_STUB)
      const run = runInstallScript(await fetchRelayScript(), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      assert.equal(run.status, 69, run.stderr)
      assert.match(run.stderr, /relay_start_failed/)
      assert.equal(existsSync(join(relayRoot, 'relay.pid')), false)
      assert.equal(existsSync(join(relayRoot, 'run-relay.sh')), true)
    })

    test('U186: 仓库模式 launcher 指向仓库入口，不回落到 current', async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const repoEntry = join(relayRoot, 'cloud-platform', 'apps', 'relay', 'src', 'relay.ts')
      mkdirSync(dirname(repoEntry), { recursive: true })
      writeFileSync(repoEntry, '')
      const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })
      const run = runInstallScript(await fetchRelayScriptRepoMode(), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot,
        ORCA_RELAY_ALLOW_UNVERIFIED: '1'
      })
      try {
        assert.equal(run.status, 0, run.stderr)
        assert.match(run.stderr, /警告：使用未校验的中继目录/)
        const wrapper = readFileSync(join(relayRoot, 'run-relay.sh'), 'utf8')
        assert.equal(wrapper.includes(`exec "${join(bin, 'node')}" "${repoEntry}"`), true)
        assert.doesNotMatch(wrapper, /current\/apps\/relay/)
      } finally {
        killRelayPid(relayRoot)
      }
    })

    test('U188: 仓库模式未给 ALLOW_UNVERIFIED 时以 78 拒绝', async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const repoEntry = join(relayRoot, 'cloud-platform', 'apps', 'relay', 'src', 'relay.ts')
      mkdirSync(dirname(repoEntry), { recursive: true })
      writeFileSync(repoEntry, '')
      const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })
      const run = runInstallScript(await fetchRelayScriptRepoMode(), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      assert.equal(run.status, 78, run.stderr)
      assert.match(run.stderr, /ORCA_RELAY_ALLOW_UNVERIFIED=1/)
      assert.equal(existsSync(join(relayRoot, 'relay.env')), false)
    })
  })

  describe('U183 R10b: relay 安装自证', () => {
    /** Fake platform in its own process: the installer runs through spawnSync,
     * which would block an in-process server's event loop. It records the
     * relay's announce and serves that nonce back on the internal list. */
    const PROOF_SERVER_SOURCE = RELAY_PROOF_SERVER_SOURCE

    let proofScriptPath = ''
    before(() => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-proof-platform-'))
      proofScriptPath = join(dir, 'proof-platform.mjs')
      writeFileSync(proofScriptPath, PROOF_SERVER_SOURCE)
    })

    function startProof(staleMs = 0, nonceSuffix = ''): Promise<Service> {
      return spawnService(
        proofScriptPath,
        { PROOF_STALE_MS: String(staleMs), PROOF_NONCE_SUFFIX: nonceSuffix },
        /\[proof\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
        'relay-proof-platform'
      )
    }

    /** Wrapper branch: announce like relay.ts does, then stay alive with the
     * entry name in argv so the installer's cmdline check sees relay.ts. */
    function relayProofNodeStub(): string {
      return `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 22.18.0; exit 0; fi
if [ "$1" = "--version" ]; then echo v22.18.0; exit 0; fi
curl -sS -X POST -H 'content-type: application/json' -d "{\\"id\\":\\"$ORCA_CLOUD_RELAY_ID\\",\\"port\\":$PORT,\\"installNonce\\":\\"$ORCA_CLOUD_INSTALL_NONCE\\"}" "$ORCA_CLOUD_API_URL/v1/internal/relay-endpoint" >/dev/null 2>&1 || true
exec -a relay.ts sleep 60
`
    }

    /** systemd branch: MainPID is a live process named relay.ts after it
     * announces the current nonce (read from the unit's EnvironmentFile). */
    const SYSTEMCTL_PROOF_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
case "$*" in
  *"show -p MainPID --value orca-relay.service"*)
    if [ ! -s "$HOME/relay-mainpid" ]; then
      (
        . "$ORCA_RELAY_ROOT/relay.env"
        curl -sS -X POST -H 'content-type: application/json' -d "{\\"id\\":\\"$ORCA_CLOUD_RELAY_ID\\",\\"port\\":$PORT,\\"installNonce\\":\\"$ORCA_CLOUD_INSTALL_NONCE\\"}" "$ORCA_CLOUD_API_URL/v1/internal/relay-endpoint" >/dev/null 2>&1 || true
      )
      ( exec -a relay.ts sleep 60 ) >/dev/null 2>&1 &
      echo $! > "$HOME/relay-mainpid"
    fi
    cat "$HOME/relay-mainpid"
    exit 0 ;;
esac
exit 0
`

    /** systemd branch with a MainPID that cannot be alive. */
    const SYSTEMCTL_DEAD_MAINPID = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/systemctl.log"
case "$*" in
  *"show -p MainPID --value orca-relay.service"*) echo 999999; exit 0 ;;
esac
exit 0
`

    function killMainPid(home: string): void {
      try {
        process.kill(Number(readFileSync(join(home, 'relay-mainpid'), 'utf8').trim()), 'SIGKILL')
      } catch {
        // Already gone.
      }
    }

    async function runProofScript(
      home: string,
      relayRoot: string,
      bin: string,
      platformUrl: string,
      extraEnv: Record<string, string> = {}
    ): Promise<ReturnType<typeof runInstallScript>> {
      const offline = join(home, 'proof-bundle.tgz')
      writeFileSync(offline, BUNDLE_BODY)
      // The fake platform answers /health and the relay list; the bundle is
      // supplied offline so only self-proof talks to it.
      const script = (await fetchRelayScript()).replaceAll(api.url, platformUrl)
      return runInstallScript(script, home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot,
        ORCA_RELAY_BUNDLE: offline,
        ORCA_RELAY_PROOF_TIMEOUT: '5',
        ORCA_RELAY_PROOF_INTERVAL: '0.2',
        ...extraEnv
      })
    }

    test('pid 文件 + nonce 匹配 online → 0（打印自证通过）', async () => {
      const proof = await startProof()
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, { node: relayProofNodeStub() })
      try {
        const run = await runProofScript(home, relayRoot, bin, proof.url)
        assert.equal(run.status, 0, run.stderr)
        assert.match(run.stdout, /中继自证通过/)
      } finally {
        killRelayPid(relayRoot)
        await proof.stop()
      }
    })

    test('systemd MainPID + nonce 匹配 online → 0', async () => {
      const proof = await startProof()
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, {
        node: NODE_2218_STUB,
        systemctl: SYSTEMCTL_PROOF_STUB
      })
      try {
        const run = await runProofScript(home, relayRoot, bin, proof.url)
        assert.equal(run.status, 0, run.stderr)
        assert.match(run.stdout, /中继自证通过/)
        assert.match(readFileSync(join(home, 'systemctl.log'), 'utf8'), /show -p MainPID/)
      } finally {
        killMainPid(home)
        await proof.stop()
      }
    })

    test('MainPID 进程已死 → 70 且打印 pid 状态', async () => {
      const proof = await startProof()
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, {
        node: NODE_2218_STUB,
        systemctl: SYSTEMCTL_DEAD_MAINPID
      })
      try {
        const run = await runProofScript(home, relayRoot, bin, proof.url, {
          ORCA_RELAY_PROOF_TIMEOUT: '2'
        })
        assert.equal(run.status, 70, run.stdout)
        assert.match(run.stderr, /pid=999999/)
        assert.match(run.stderr, /relay_not_online_timeout/)
      } finally {
        await proof.stop()
      }
    })

    test('online 但 nonce 不符 → 等待超时后 70（旧进程不能冒名）', async () => {
      const proof = await startProof(0, '-stale')
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, { node: relayProofNodeStub() })
      try {
        const run = await runProofScript(home, relayRoot, bin, proof.url, {
          ORCA_RELAY_PROOF_TIMEOUT: '2'
        })
        assert.equal(run.status, 70, run.stdout)
        assert.match(run.stderr, /relay_not_online_timeout/)
        assert.match(run.stderr, /installNonce/)
      } finally {
        killRelayPid(relayRoot)
        await proof.stop()
      }
    })

    test('lastSeenAt 偏离平台时钟 >5s → 70（时钟偏差夹具）', async () => {
      const proof = await startProof(20_000)
      const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
      const relayRoot = makeRelayRoot(home)
      const bin = makeSparsePath(home, { node: relayProofNodeStub() })
      try {
        const run = await runProofScript(home, relayRoot, bin, proof.url, {
          ORCA_RELAY_PROOF_TIMEOUT: '2'
        })
        assert.equal(run.status, 70, run.stdout)
        assert.match(run.stderr, /relay_not_online_timeout/)
      } finally {
        killRelayPid(relayRoot)
        await proof.stop()
      }
    })
  })

  test('开发者拉取脚本 403，拒绝与成功都写入 install_script 审计且不含令牌明文', async () => {
    const token = await mintHostToken()
    for (const path of [`/install/host.sh?token=${token}`, '/install/relay.sh']) {
      const res = await fetch(`${api.url}${path}`, { headers: auth(devToken) })
      assert.equal(res.status, 403, path)
      assert.equal(
        ((await res.json()) as { error?: { code: string } }).error?.code,
        'PERMISSION_DENIED'
      )
    }

    const events = await auditEvents('eventType=install_script&limit=50')
    assert.ok(
      events.some((event) => event.actor === 'zhangsan' && event.result === 'denied'),
      'the refused attempt must be recorded'
    )
    const successes = events.filter((event) => event.result === 'success')
    assert.ok(successes.length >= 2, 'both script kinds must record their own disclosure')
    const successTypes = successes.map((event) => (event.metadata as { type: string }).type)
    for (const kind of ['host', 'relay']) {
      assert.ok(successTypes.includes(kind), `${kind} disclosure must be recorded`)
    }
    assert.ok(
      successes.every((event) => !JSON.stringify(event.metadata).includes(token)),
      'no token plaintext in the audit metadata'
    )
    assert.ok(
      successes.every(
        (event) => typeof (event.metadata as { tokenEmbedded: boolean }).tokenEmbedded === 'boolean'
      )
    )
    saveEvidence(EVIDENCE, 'install-wizard.json', {
      admin: { relayScript: 200, hostScript: 200, missingToken: 400, invalidToken: 401 },
      developer: { status: 403, errorCode: 'PERMISSION_DENIED' },
      audit: {
        deniedRecorded: true,
        successTypes: ['host', 'relay'],
        tokenPlaintextRecorded: false
      }
    })
  })

  test('Web 向导命令照抄可执行：download 令牌免登录，二次使用 401', async () => {
    const wizard = loadWizard(api.url)
    await wizard.login()
    assert.equal(wizard.window.location.origin, api.url)

    const hostCmd = await wizard
      .nav('hosts', '#registerHostBtn')
      .then(() => wizard.click('#registerHostBtn', '#generateHostTokenBtn'))
      .then(() => wizard.click('#generateHostTokenBtn', '#installCmd'))
    const hostDownload = /download=([\w-]+)/.exec(hostCmd)?.[1] ?? ''
    const token = /token=([\w-]+)/.exec(hostCmd)?.[1] ?? ''
    assert.notEqual(hostDownload, '', 'the wizard must embed a download token')
    assert.notEqual(token, '', 'the wizard must embed a registration token')
    assert.equal(
      hostCmd,
      expectedInstallCommand(`${api.url}/install/host.sh?download=${hostDownload}&token=${token}`)
    )
    // U182: `bash <(curl …)` exits 0 on a failed download; the copied command
    // must instead fail visibly and tell the admin to regenerate it.
    assert.match(hostCmd, /\|\| \{ echo '.*请让管理员重新生成'; false; \} \|\| exit 1$/)
    assert.ok(hostCmd.includes('|| exit 1'))
    // The exact URL the admin copies must answer WITHOUT any Authorization header:
    // that is what `curl -fsSL` on the target machine actually sends.
    const hostUrl = commandUrl(hostCmd)
    const hostFetch = await fetch(hostUrl)
    assert.equal(hostFetch.status, 200)
    assert.match(hostFetch.headers.get('content-type') ?? '', /text\/x-shellscript/)
    assert.ok((await hostFetch.text()).includes(`HOST_TOKEN=${token}`))
    // One-time: the same command reused must not hand out the script again.
    const hostReplay = await fetch(hostUrl)
    assert.equal(hostReplay.status, 401)

    await wizard.nav('relays', '#addRelayBtn')
    const relayCmd = await wizard.click('#addRelayBtn', '#relayInstallCmd')
    const relayDownload = /download=([\w-]+)/.exec(relayCmd)?.[1] ?? ''
    assert.notEqual(relayDownload, '', 'the relay wizard must embed a download token')
    assert.equal(
      relayCmd,
      expectedInstallCommand(`${api.url}/install/relay.sh?download=${relayDownload}`)
    )
    assert.doesNotMatch(relayCmd, /token=/, 'the internal token must not travel in the URL')
    const relayUrl = commandUrl(relayCmd)
    const relayFetch = await fetch(relayUrl)
    assert.equal(relayFetch.status, 200)
    assert.ok((await relayFetch.text()).includes(`ORCA_CLOUD_INTERNAL_TOKEN=${INTERNAL_TOKEN}`))
    const relayReplay = await fetch(relayUrl)
    assert.equal(relayReplay.status, 401)

    saveEvidence(EVIDENCE, 'install-wizard-web.json', {
      origin: api.url,
      hostCmd,
      relayCmd,
      hostScriptVerbatim: 200,
      hostReplay: 401,
      relayScriptVerbatim: 200,
      relayReplay: 401
    })
  }, 120_000)

  test('download 令牌按 kind 隔离并绑定 hostId；无效令牌可回退 Bearer', async () => {
    // A relay token must not fetch the host script, even with a valid host
    // registration token alongside: kind is part of the grant.
    const relayDownload = await mintRelayDownload()
    const freshHostToken = await mintHostToken()
    const relayOnHost = await fetch(
      `${api.url}/install/host.sh?download=${relayDownload}&token=${freshHostToken}`
    )
    assert.equal(relayOnHost.status, 401)

    // Conversely, a host token must not fetch relay.sh (which embeds the
    // platform internal token for every relay).
    const hostOnly = await mintHostDownload()
    const hostOnRelay = await fetch(
      `${api.url}/install/relay.sh?download=${hostOnly.downloadToken}`
    )
    assert.equal(hostOnRelay.status, 401)

    // A host-bound download token only works for that host id.
    const host = await registerHost({
      apiUrl: api.url,
      adminToken,
      name: `wizard-bound-${Date.now()}`,
      directAddr: '127.0.0.1:19091',
      relayTarget: '127.0.0.1:19091'
    })
    const bound = await mintHostDownload(host.hostId)
    const wrongHost = await fetch(
      `${api.url}/install/host.sh?download=${bound.downloadToken}&token=${bound.token}&hostId=host_other`
    )
    assert.equal(wrongHost.status, 401, 'a bound token must not serve another host')
    const rightHost = await fetch(
      `${api.url}/install/host.sh?download=${bound.downloadToken}&token=${bound.token}&hostId=${host.hostId}`
    )
    assert.equal(rightHost.status, 200)
    const burnt = await fetch(
      `${api.url}/install/host.sh?download=${bound.downloadToken}&token=${bound.token}&hostId=${host.hostId}`
    )
    assert.equal(burnt.status, 401)

    // Existing API clients keep using Bearer; an unusable download token falls
    // back to it rather than locking them out.
    const bearerFallback = await fetch(`${api.url}/install/relay.sh?download=not-a-token`, {
      headers: auth(adminToken)
    })
    assert.equal(bearerFallback.status, 200)
    const anonymous = await fetch(`${api.url}/install/relay.sh?download=not-a-token`)
    assert.equal(anonymous.status, 401)

    saveEvidence(EVIDENCE, 'install-wizard-token-scope.json', {
      relayOnHost: 401,
      hostOnRelay: 401,
      wrongHostId: 401,
      rightHostId: 200,
      burntAfterUse: 401,
      bearerFallback: 200,
      anonymousInvalid: 401
    })
  }, 120_000)

  test('过期 download 令牌 401：host 与 relay 一致', async () => {
    const shortApi = await spawnService(
      'apps/api/src/server.ts',
      { PORT: '0', INTERNAL_TOKEN, ORCA_CLOUD_INSTALL_DOWNLOAD_TTL_MS: '25' },
      /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
      'api-install-download-expiry'
    )
    try {
      const access = await fetch(`${shortApi.url}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'u115-expiry' })
      }).then((res) => res.json().then((body: { accessToken: string }) => body.accessToken))
      const mint = (path: string) =>
        fetch(`${shortApi.url}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${access}` }
        }).then((res) => res.json() as Promise<Record<string, string>>)
      const host = await mint('/v1/hosts/tokens')
      const relay = await mint('/v1/relays/install-tokens')
      await new Promise((resolve) => setTimeout(resolve, 60))
      // The host script also needs its registration token; only the download
      // credential is expected to be expired here.
      const expiredHost = await fetch(
        `${shortApi.url}/install/host.sh?download=${host.downloadToken}&token=${host.token}`
      )
      assert.equal(expiredHost.status, 401)
      const expiredRelay = await fetch(
        `${shortApi.url}/install/relay.sh?download=${relay.downloadToken}`
      )
      assert.equal(expiredRelay.status, 401)
      saveEvidence(EVIDENCE, 'install-download-expiry.json', {
        ttlMs: 25,
        hostExpired: 401,
        relayExpired: 401
      })
    } finally {
      await shortApi.stop()
    }
  }, 120_000)
})

describe('U183 R6: tar 安全检查、解包与原子激活', () => {
  function withSha(script: string, sha: string): string {
    return script.replace(/^ORCA_RELAY_BUNDLE_SHA256=.*$/m, `ORCA_RELAY_BUNDLE_SHA256=${sha}`)
  }

  async function runOfflineBundle(bundle: { bytes: Buffer; sha: string }) {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bundlePath = join(home, 'offline-bundle.tgz')
    writeFileSync(bundlePath, bundle.bytes)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB, curl: FAILING_CURL_STUB })
    const script = withSha(await fetchRelayScript(), bundle.sha)
    const run = runInstallScript(script, home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot,
      ORCA_RELAY_BUNDLE: bundlePath
    })
    return { ...run, home, relayRoot }
  }

  test('生成脚本含类型白名单、空目录解包参数与原子切换', async () => {
    const script = await fetchRelayScript()
    assert.match(script, /tar -tvzf/)
    assert.match(script, /ORCA_RELAY_TAR_TYPES/)
    assert.match(script, /--no-same-owner --no-same-permissions/)
    assert.match(script, /--no-overwrite-dir/)
    assert.match(script, /\.tmp-\$\$/)
    assert.match(script, /mv -T/)
    assert.match(script, /previous/)
  })

  test('U183 R6: symlink 条目的恶意包以 67 退出且无 releases 残留', async () => {
    const bundle = buildBundle((dir) =>
      symlinkSync('/etc/passwd', join(dir, 'apps/relay/evil-link'))
    )
    const run = await runOfflineBundle(bundle)
    assert.equal(run.status, 67, run.stderr)
    assert.match(run.stderr, /（67）/)
    assert.equal(existsSync(join(run.relayRoot, 'releases')), false)
    assert.equal(existsSync(join(run.relayRoot, 'relay.env')), false)
  })

  test('U183 R6: 绝对路径条目的恶意包以 67 退出', async () => {
    const bundle = buildBundle(undefined, (dir, out) => [
      '-cPzf',
      out,
      '-C',
      dir,
      join(dir, 'VERSION'),
      join(dir, 'apps'),
      join(dir, 'packages')
    ])
    const run = await runOfflineBundle(bundle)
    assert.equal(run.status, 67, run.stderr)
    assert.match(run.stderr, /绝对路径|67/)
    assert.equal(existsSync(join(run.relayRoot, 'releases')), false)
  })

  test('U183 R6: .. 条目的恶意包以 67 退出', async () => {
    const bundle = buildBundle(undefined, (dir, out) => [
      '-czf',
      out,
      '-C',
      join(dir, 'apps'),
      '../VERSION'
    ])
    const run = await runOfflineBundle(bundle)
    assert.equal(run.status, 67, run.stderr)
    assert.match(run.stderr, /\.\.|67/)
    assert.equal(existsSync(join(run.relayRoot, 'releases')), false)
  })

  test('U183 R6: 缺少必需文件的包以 67 退出且无 releases 残留', async () => {
    const bundle = buildBundle((dir) => rmSync(join(dir, 'apps/relay/src/relay.ts')))
    const run = await runOfflineBundle(bundle)
    assert.equal(run.status, 67, run.stderr)
    assert.match(run.stderr, /缺少必需文件.*（67）/)
    const releases = join(run.relayRoot, 'releases')
    assert.deepEqual(existsSync(releases) ? readdirSync(releases) : [], [])
  })

  test('U183 R6: 良性包解包正确，current 指向、previous 保留', async () => {
    const second = buildBundle((dir) =>
      writeFileSync(join(dir, 'apps/relay/src/relay.ts'), '// relay v2\n')
    )
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB, curl: FAILING_CURL_STUB })
    const script = await fetchRelayScript()
    const run = (bundle: { bytes: Buffer; sha: string }) => {
      const path = join(home, `bundle-${bundle.sha.slice(0, 8)}.tgz`)
      writeFileSync(path, bundle.bytes)
      const result = runInstallScript(withSha(script, bundle.sha), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot,
        ORCA_RELAY_BUNDLE: path
      })
      killRelayPid(relayRoot)
      return result
    }

    const first = run(BENIGN_BUNDLE)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${BENIGN_BUNDLE.sha}`)
    assert.equal(statSync(join(relayRoot, 'current', 'apps/relay/src/relay.ts')).isFile(), true)
    assert.equal(existsSync(join(relayRoot, 'previous')), false)

    const upgrade = run(second)
    assert.equal(upgrade.status, 0, upgrade.stderr)
    assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${second.sha}`)
    assert.equal(readlinkSync(join(relayRoot, 'previous')), `releases/${BENIGN_BUNDLE.sha}`)
    assert.deepEqual(
      readdirSync(join(relayRoot, 'releases')).filter((name) => name.includes('.tmp-')),
      []
    )
  })

  test('U183 R6: 同 sha 重跑跳过解包且不覆盖 previous', async () => {
    const first = buildBundle()
    const second = buildBundle((dir) =>
      writeFileSync(join(dir, 'apps/relay/src/relay.ts'), '// relay v2\n')
    )
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB, curl: FAILING_CURL_STUB })
    const script = await fetchRelayScript()
    const run = (bundle: { bytes: Buffer; sha: string }) => {
      const path = join(home, `bundle-${bundle.sha.slice(0, 8)}.tgz`)
      writeFileSync(path, bundle.bytes)
      const result = runInstallScript(withSha(script, bundle.sha), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot,
        ORCA_RELAY_BUNDLE: path
      })
      killRelayPid(relayRoot)
      return result
    }
    assert.equal(run(first).status, 0)
    assert.equal(run(second).status, 0)
    const rerun = run(second)
    assert.equal(rerun.status, 0, rerun.stderr)
    assert.match(rerun.stdout, /跳过解包/)
    assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${second.sha}`)
    assert.equal(readlinkSync(join(relayRoot, 'previous')), `releases/${first.sha}`)
  })
})

describe('U183 R11a: 安装锁、同 sha 幂等与 previous 规则', () => {
  const RELAY_UNIT_PATH = '.config/systemd/user/orca-relay.service'
  const SYSTEMCTL_OK = '#!/usr/bin/env bash\nexit 0\n'

  function withSha(script: string, sha: string): string {
    return script.replace(/^ORCA_RELAY_BUNDLE_SHA256=.*$/m, `ORCA_RELAY_BUNDLE_SHA256=${sha}`)
  }

  function makeSystemdHome(): { home: string; relayRoot: string; bin: string } {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB, systemctl: SYSTEMCTL_OK })
    return { home, relayRoot, bin }
  }

  function runBundle(
    script: string,
    home: string,
    bin: string,
    relayRoot: string,
    bundle: { bytes: Buffer; sha: string }
  ) {
    const path = join(home, `r11a-${bundle.sha.slice(0, 8)}.tgz`)
    writeFileSync(path, bundle.bytes)
    return runInstallScript(withSha(script, bundle.sha), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot,
      ORCA_RELAY_BUNDLE: path
    })
  }

  test('生成脚本用 mkdir 原子锁并以 75 relay_install_busy 拒绝并发安装', async () => {
    const script = await fetchRelayScript()
    assert.match(script, /ORCA_RELAY_LOCK_DIR="\$ORCA_RELAY_ROOT\/\.install\.lock"/)
    assert.match(script, /mkdir "\$ORCA_RELAY_LOCK_DIR"/)
    assert.match(script, /relay_install_busy/)
    assert.match(script, /exit 75/)
    assert.match(script, /trap orca_relay_lock_release EXIT/)

    const { home, relayRoot, bin } = makeSystemdHome()
    mkdirSync(join(relayRoot, '.install.lock'))
    writeFileSync(join(relayRoot, '.install.lock', 'pid'), `${process.pid}\n`)
    const run = runInstallScript(script, home, { PATH: bin, ORCA_RELAY_ROOT: relayRoot })
    assert.equal(run.status, 75, run.stderr)
    assert.match(run.stderr, /relay_install_busy/)
    assert.equal(existsSync(join(relayRoot, '.install.lock')), true)
  })

  test('死 pid 的残留锁被清理，安装继续', async () => {
    const { home, relayRoot, bin } = makeSystemdHome()
    const dead = spawnSync('bash', ['-c', 'exit 0'])
    mkdirSync(join(relayRoot, '.install.lock'))
    writeFileSync(join(relayRoot, '.install.lock', 'pid'), `${dead.pid}\n`)

    const run = runBundle(await fetchRelayScript(), home, bin, relayRoot, BENIGN_BUNDLE)
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /清理残留安装锁/)
    assert.equal(existsSync(join(relayRoot, '.install.lock')), false)
  })

  test('同 sha 重跑：不覆盖 previous、不重写 unit、仍刷新 nonce', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB, systemctl: SYSTEMCTL_OK })
    const script = await fetchRelayScript()
    const second = buildBundle((dir) =>
      writeFileSync(join(dir, 'apps/relay/src/relay.ts'), '// relay v2\n')
    )

    assert.equal(runBundle(script, home, bin, relayRoot, BENIGN_BUNDLE).status, 0)
    assert.equal(runBundle(script, home, bin, relayRoot, second).status, 0)
    const unit = join(home, RELAY_UNIT_PATH)
    const before = statSync(unit, { bigint: true })
    const nonceBefore = readRelayEnv(join(relayRoot, 'relay.env')).ORCA_CLOUD_INSTALL_NONCE
    await new Promise((resolve) => setTimeout(resolve, 20))

    const rerun = runBundle(script, home, bin, relayRoot, second)
    assert.equal(rerun.status, 0, rerun.stderr)
    assert.match(rerun.stdout, /跳过下载/)
    assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${second.sha}`)
    assert.equal(readlinkSync(join(relayRoot, 'previous')), `releases/${BENIGN_BUNDLE.sha}`)
    const after = statSync(unit, { bigint: true })
    assert.equal(after.ino, before.ino)
    assert.equal(after.mtimeNs, before.mtimeNs)
    assert.match(rerun.stdout, /跳过重写/)
    assert.notEqual(
      readRelayEnv(join(relayRoot, 'relay.env')).ORCA_CLOUD_INSTALL_NONCE,
      nonceBefore
    )
  })

  test('失败路径经 EXIT trap 释放安装锁', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_STUB, curl: FAILING_CURL_STUB })
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot,
      ORCA_RELAY_BUNDLE: join(home, 'missing-offline-bundle.tgz')
    })
    assert.equal(run.status, 65, run.stderr)
    assert.equal(existsSync(join(relayRoot, '.install.lock')), false)
  })
})

describe('U183 R11b: 升级、自动回滚与 N-1 保留', () => {
  function withSha(script: string, sha: string): string {
    return script.replace(/^ORCA_RELAY_BUNDLE_SHA256=.*$/m, `ORCA_RELAY_BUNDLE_SHA256=${sha}`)
  }

  /** Wrapper branch stub. `CRASH` in the active release entry makes it exit,
   * modelling a bundle that unpacks but never comes online. `force-crash`
   * makes even the rolled-back release fail. */
  function relayNodeStub(options: { announce?: boolean } = {}): string {
    const announce =
      options.announce === false
        ? ''
        : `curl -sS -X POST -H 'content-type: application/json' -d "{\\"id\\":\\"$ORCA_CLOUD_RELAY_ID\\",\\"port\\":$PORT,\\"installNonce\\":\\"$ORCA_CLOUD_INSTALL_NONCE\\"}" "$ORCA_CLOUD_API_URL/v1/internal/relay-endpoint" >/dev/null 2>&1 || true`
    return `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 22.18.0; exit 0; fi
if [ "$1" = "--version" ]; then echo v22.18.0; exit 0; fi
if [ -f "$HOME/force-crash" ]; then exit 1; fi
if grep -q 'CRASH' "$ORCA_RELAY_ROOT/current/apps/relay/src/relay.ts" 2>/dev/null; then exit 1; fi
${announce}
exec -a relay.ts sleep 60
`
  }

  function makeR11bHome(node: string): { home: string; relayRoot: string; bin: string } {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node })
    return { home, relayRoot, bin }
  }

  function runBundle(
    script: string,
    home: string,
    bin: string,
    relayRoot: string,
    platformUrl: string,
    bundle: { bytes: Buffer; sha: string },
    extraEnv: Record<string, string> = {}
  ): ReturnType<typeof runInstallScript> {
    const offline = join(home, `r11b-${bundle.sha.slice(0, 8)}.tgz`)
    writeFileSync(offline, bundle.bytes)
    return runInstallScript(withSha(script.replaceAll(api.url, platformUrl), bundle.sha), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot,
      ORCA_RELAY_BUNDLE: offline,
      ORCA_RELAY_PROOF_TIMEOUT: '5',
      ORCA_RELAY_PROOF_INTERVAL: '0.2',
      ORCA_RELAY_ROLLBACK_PROOF_TIMEOUT: '2',
      ...extraEnv
    })
  }

  const V2_BUNDLE = buildBundle((dir) =>
    writeFileSync(join(dir, 'apps/relay/src/relay.ts'), '// relay v2\n')
  )
  const V3_BUNDLE = buildBundle((dir) =>
    writeFileSync(join(dir, 'apps/relay/src/relay.ts'), '// relay v3\n')
  )
  const CRASH_BUNDLE = buildBundle((dir) =>
    writeFileSync(join(dir, 'apps/relay/src/relay.ts'), '// CRASH relay v2\n')
  )

  test('生成脚本：重启服务、清理旧 release、回滚标记', async () => {
    const script = await fetchRelayScript()
    assert.match(script, /systemctl --user restart orca-relay\.service/)
    assert.match(script, /rollback=ok/)
    assert.match(script, /rollback=failed/)
    assert.match(script, /orca_relay_prune_releases/)
    assert.match(script, /ORCA_RELAY_RELEASES_DIR/)
  })

  test('升级成功：releases 只保留 current+previous，非 sha 条目不动', async () => {
    const proof = await startRelayProofPlatform()
    const { home, relayRoot, bin } = makeR11bHome(relayNodeStub())
    const script = await fetchRelayScript()
    try {
      assert.equal(runBundle(script, home, bin, relayRoot, proof.url, BENIGN_BUNDLE).status, 0)
      assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${BENIGN_BUNDLE.sha}`)
      assert.equal(runBundle(script, home, bin, relayRoot, proof.url, V2_BUNDLE).status, 0)

      // Only this script's sha-named release dirs may be pruned.
      mkdirSync(join(relayRoot, 'releases', 'not-a-sha'), { recursive: true })
      mkdirSync(join(relayRoot, 'releases', 'f'.repeat(64)), { recursive: true })
      writeFileSync(join(relayRoot, 'releases', 'keep-me'), 'operator note')

      const upgrade = runBundle(script, home, bin, relayRoot, proof.url, V3_BUNDLE)
      assert.equal(upgrade.status, 0, upgrade.stderr)
      assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${V3_BUNDLE.sha}`)
      assert.equal(readlinkSync(join(relayRoot, 'previous')), `releases/${V2_BUNDLE.sha}`)
      assert.deepEqual(
        readdirSync(join(relayRoot, 'releases')).sort(),
        ['f'.repeat(64), V2_BUNDLE.sha, V3_BUNDLE.sha, 'keep-me', 'not-a-sha'].sort()
      )
      assert.match(upgrade.stdout, /清理旧 release/)
    } finally {
      killRelayPid(relayRoot)
      await proof.stop()
    }
  })

  test('自证超时：回滚 current→previous、重启并再次自证，70 rollback=ok', async () => {
    const proof = await startRelayProofPlatform()
    const { home, relayRoot, bin } = makeR11bHome(relayNodeStub())
    const script = await fetchRelayScript()
    try {
      assert.equal(runBundle(script, home, bin, relayRoot, proof.url, BENIGN_BUNDLE).status, 0)
      const upgrade = runBundle(script, home, bin, relayRoot, proof.url, CRASH_BUNDLE)
      assert.equal(upgrade.status, 70, upgrade.stderr)
      assert.match(upgrade.stderr, /rollback=ok/)
      assert.match(upgrade.stderr, /已回滚到/)
      assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${BENIGN_BUNDLE.sha}`)
      assert.equal(readlinkSync(join(relayRoot, 'previous')), `releases/${BENIGN_BUNDLE.sha}`)
    } finally {
      killRelayPid(relayRoot)
      await proof.stop()
    }
  })

  test('回滚后仍不上线：70 且打印尝试回滚与回滚失败两条日志', async () => {
    const proof = await startRelayProofPlatform()
    const { home, relayRoot, bin } = makeR11bHome(relayNodeStub())
    const script = await fetchRelayScript()
    try {
      assert.equal(runBundle(script, home, bin, relayRoot, proof.url, BENIGN_BUNDLE).status, 0)
      writeFileSync(join(home, 'force-crash'), '1')
      const upgrade = runBundle(script, home, bin, relayRoot, proof.url, V2_BUNDLE)
      assert.equal(upgrade.status, 70, upgrade.stderr)
      const lines = upgrade.stderr.split('\n')
      assert.ok(
        lines.some((line) => line.includes('尝试回滚')),
        upgrade.stderr
      )
      assert.ok(
        lines.some((line) => line.includes('rollback=failed')),
        upgrade.stderr
      )
      assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${BENIGN_BUNDLE.sha}`)
    } finally {
      killRelayPid(relayRoot)
      await proof.stop()
    }
  })

  test('同 sha 重跑失败不回滚（无假回滚）', async () => {
    const proof = await startRelayProofPlatform()
    const { home, relayRoot, bin } = makeR11bHome(relayNodeStub())
    const script = await fetchRelayScript()
    try {
      assert.equal(runBundle(script, home, bin, relayRoot, proof.url, BENIGN_BUNDLE).status, 0)
      assert.equal(runBundle(script, home, bin, relayRoot, proof.url, V2_BUNDLE).status, 0)

      // A relay that starts but never announces the fresh nonce: self-proof
      // times out, yet a same-sha rerun must leave current untouched.
      const silentBin = makeSparsePath(mkdtempSync(join(tmpdir(), 'orca-silent-')), {
        node: relayNodeStub({ announce: false })
      })
      const rerun = runBundle(script, home, silentBin, relayRoot, proof.url, V2_BUNDLE, {
        ORCA_RELAY_PROOF_TIMEOUT: '2'
      })
      assert.equal(rerun.status, 70, rerun.stderr)
      assert.doesNotMatch(rerun.stderr, /rollback=ok/)
      assert.equal(readlinkSync(join(relayRoot, 'current')), `releases/${V2_BUNDLE.sha}`)
    } finally {
      killRelayPid(relayRoot)
      await proof.stop()
    }
  })
})

describe('U183 R15: 下载缓存只保留 current/previous', () => {
  async function fetchRelayScriptForSha(sha: string): Promise<string> {
    const res = await fetch(`${api.url}/install/relay.sh?sha=${sha}`, {
      headers: auth(adminToken)
    })
    assert.equal(res.status, 200)
    return res.text()
  }

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

  const V2_BUNDLE = buildBundle((dir) =>
    writeFileSync(join(dir, 'apps/relay/src/relay.ts'), '// relay v2\n')
  )

  test('生成脚本含缓存清理函数与 7 天 .part 清理', async () => {
    const script = await fetchRelayScript()
    assert.match(script, /orca_relay_prune_downloads/)
    assert.match(script, /-mtime \+7/)
  })

  test('成功后只留 current/previous 的 tgz，旧 .part 过期清理，非本脚本文件不动', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })
    const downloads = join(relayRoot, 'downloads')
    mkdirSync(downloads, { recursive: true })
    const stale = join(downloads, `${'a'.repeat(64)}.tgz`)
    writeFileSync(stale, 'stale')
    const oldPart = join(downloads, `${BUNDLE_SHA}.tgz.part`)
    writeFileSync(oldPart, 'old')
    const old = new Date(Date.now() - 8 * 86400_000)
    utimesSync(oldPart, old, old)
    const freshPart = join(downloads, 'fresh.part')
    writeFileSync(freshPart, 'fresh')
    const note = join(downloads, 'operator.txt')
    writeFileSync(note, 'keep')
    const run = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })
    try {
      assert.equal(run.status, 0, run.stderr)
      assert.equal(existsSync(stale), false)
      assert.match(run.stdout, /清理无主 bundle 缓存/)
      assert.equal(existsSync(join(downloads, `${BUNDLE_SHA}.tgz`)), true)
      assert.equal(existsSync(oldPart), false)
      assert.equal(existsSync(freshPart), true)
      assert.equal(existsSync(note), true)
    } finally {
      killRelayPid(relayRoot)
    }
  })

  test('升级后保留 current 与 previous 的 tgz，重跑命中缓存', async () => {
    serveBundle(V2_BUNDLE)
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = makeRelayRoot(home)
    const bin = makeSparsePath(home, { node: NODE_2218_ALIVE_STUB })
    const downloads = join(relayRoot, 'downloads')
    const first = runInstallScript(await fetchRelayScript(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })
    try {
      assert.equal(first.status, 0, first.stderr)
      const second = runInstallScript(await fetchRelayScriptForSha(V2_BUNDLE.sha), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      assert.equal(second.status, 0, second.stderr)
      assert.deepEqual(
        readdirSync(downloads)
          .filter((name) => name.endsWith('.tgz'))
          .sort(),
        [`${BUNDLE_SHA}.tgz`, `${V2_BUNDLE.sha}.tgz`].sort()
      )
      // A missing current link forces the acquire path; the kept tgz is reused.
      unlinkSync(join(relayRoot, 'current'))
      const rerun = runInstallScript(await fetchRelayScriptForSha(V2_BUNDLE.sha), home, {
        PATH: bin,
        ORCA_RELAY_ROOT: relayRoot
      })
      assert.equal(rerun.status, 0, rerun.stderr)
      assert.match(rerun.stdout, /复用已下载 bundle/)
    } finally {
      killRelayPid(relayRoot)
    }
  })
})
