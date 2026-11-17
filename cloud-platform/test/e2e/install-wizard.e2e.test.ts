import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  writeFileSync(join(home, 'bin', 'orca'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
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
  'curl',
  'mktemp',
  'rm',
  'node'
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

/** The generated host script for a fresh one-time token. */
async function fetchHostScript(): Promise<string> {
  const token = await mintHostToken()
  const res = await fetch(`${api.url}/install/host.sh?token=${token}`, {
    headers: auth(adminToken)
  })
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
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', INTERNAL_TOKEN },
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
    assert.ok(script.includes(`ORCA_CLOUD_API_URL=${api.url}`), 'platform address must be embedded')
    assert.ok(
      script.includes(`ORCA_CLOUD_INTERNAL_TOKEN=${INTERNAL_TOKEN}`),
      'internal token must be embedded'
    )
    assert.match(script, /RELAY_PUBLIC_HOST/)
    // U182: the printed start command uses the resolved node/entry paths.
    assert.match(script, /command -v node/)
    assert.match(script, /\$ORCA_NODE_BIN \$ORCA_RELAY_ENTRY/)
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
    const run = runInstallScript(await res.text(), home, { ORCA_RELAY_ROOT: relayRoot })

    assert.doesNotMatch(run.stderr, /unbound variable/, run.stderr)
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /环境已就绪/)
    const envFile = readFileSync(join(run.home, '.orca-cloud', 'relay.env'), 'utf8')
    assert.ok(envFile.includes(`ORCA_CLOUD_API_URL=${api.url}`))
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
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /平台健康检查失败/)
    assert.ok(elapsed < 15_000, `health check took ${elapsed}ms`)
  })

  test('U182: 无 hostname -I 且无替代地址 → fail-fast，不写空 ADVERTISE_HOST', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, { hostname: HOSTNAME_STUB, orca: ORCA_STUB })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /无法自动探测本机地址/)
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
      orca: ORCA_STUB
    })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.equal(run.status, 0, run.stderr)
    const env = readFileSync(join(home, '.orca-cloud', 'host.env'), 'utf8')
    assert.match(env, /^ADVERTISE_HOST=10\.9\.8\.7$/m)
    assert.match(env, /^ORCA_CLOUD_ADVERTISE_HOST=10\.9\.8\.7$/m)
  })

  test('U182: openssl 失败保留 stderr 并 exit 1', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, {
      hostname:
        '#!/usr/bin/env bash\ncase "$1" in -s|-I) echo orca-test-host ;; *) echo orca-test-host ;; esac\n',
      orca: ORCA_STUB,
      openssl: '#!/usr/bin/env bash\necho "openssl-stub-boom" >&2\nexit 1\n'
    })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /openssl-stub-boom/)
    assert.match(run.stderr, /自签 TLS 证书生成失败/)
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
      orca: ORCA_STUB,
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
      orca: ORCA_STUB
    })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /未检测到 systemctl/)
    assert.match(run.stdout, /nohup .*--host-mode/)
    assert.doesNotMatch(run.stdout, /systemctl --user enable/)
  })

  test('U182: 缺少 orca/orca-ide 时 fail-fast，不写配置', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, { hostname: HOSTNAME_STUB })
    const run = runInstallScript(await fetchHostScript(), home, { PATH: bin })

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /未找到 Orca 宿主程序/)
    assert.match(run.stderr, /orca-ide/)
    assert.equal(existsSync(join(home, '.orca-cloud', 'host.env')), false)
  })

  test('U182: relay 缺 node 时 fail-fast', async () => {
    const res = await fetch(`${api.url}/install/relay.sh`, { headers: auth(adminToken) })
    assert.equal(res.status, 200)
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, {}, ['node'])
    const run = runInstallScript(await res.text(), home, { PATH: bin })

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /未找到 node/)
  })

  test('U182: relay 缺中继代码时 fail-fast，不假装安装', async () => {
    const res = await fetch(`${api.url}/install/relay.sh`, { headers: auth(adminToken) })
    assert.equal(res.status, 200)
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const bin = makeSparsePath(home, { node: '#!/usr/bin/env bash\nexit 0\n' })
    const run = runInstallScript(await res.text(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: join(home, 'missing-relay')
    })

    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /未找到中继程序/)
  })

  test('U182: relay 无 systemctl 时打印 nohup 启动命令且安装成功', async () => {
    const res = await fetch(`${api.url}/install/relay.sh`, { headers: auth(adminToken) })
    assert.equal(res.status, 200)
    const home = mkdtempSync(join(tmpdir(), 'orca-install-'))
    const relayRoot = join(home, 'orca-cloud')
    mkdirSync(join(relayRoot, 'cloud-platform', 'apps', 'relay', 'src'), { recursive: true })
    writeFileSync(join(relayRoot, 'cloud-platform', 'apps', 'relay', 'src', 'relay.ts'), '')
    const bin = makeSparsePath(home, { node: '#!/usr/bin/env bash\nexit 0\n' })
    const run = runInstallScript(await res.text(), home, {
      PATH: bin,
      ORCA_RELAY_ROOT: relayRoot
    })

    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /未检测到 systemctl/)
    assert.match(run.stdout, /nohup .*relay\.ts/)
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
      .then(() => wizard.click('#registerHostBtn', '#installCmd'))
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
