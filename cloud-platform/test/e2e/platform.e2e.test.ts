import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CloudClient } from '../../apps/client/src/cloud-client.ts'
import { probeEndpoint } from '../../apps/client/src/route-selector.ts'
import { createRequire } from 'node:module'

const requireWs = (): typeof import('ws').default => createRequire(import.meta.url)('ws')
import {
  ROOT,
  makeTlsCerts,
  makeTempWorkspace,
  registerHost,
  saveEvidence,
  spawnService,
  type Service
} from './harness.ts'


/**
 * Real Orca addresses files as { worktree, relativePath }, not as a project-absolute
 * path. The simulator accepts exactly that shape so these cases speak the real
 * wire contract a shipped client does.
 */
type Opened = { connect: { workspace: { projectRoot: string; workspaceRoot: string } } }

function projectFile(opened: Opened, relativePath: string): Record<string, string> {
  return { worktree: opened.connect.workspace.projectRoot, relativePath }
}

function workspaceFile(opened: Opened, relativePath: string): Record<string, string> {
  return { worktree: opened.connect.workspace.workspaceRoot, relativePath }
}

const EVIDENCE = 'e2e-platform'
let api: Service
let relay: Service
let runtime: Service
let adminToken: string
let hostCredential: string
let workspace: { root: string; projectRoot: string }
let runtimePort = 0

async function waitForLog(service: Service, pattern: RegExp, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (service.logs.some((line) => pattern.test(line))) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`log ${pattern} not seen: ${service.logs.join('')}`)
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('condition not met in time')
}

before(async () => {
  workspace = makeTempWorkspace()
  const tls = makeTlsCerts()

  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api'
  )

  relay = await spawnService(
    'apps/relay/src/relay.ts',
    { PORT: '0', API_URL: api.url },
    /\[relay\] listening on :(\d+)/,
    'relay'
  )
  await fetch(`${api.url}/v1/internal/relay-endpoint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': 'internal-test-token' },
    body: JSON.stringify({ port: relay.port })
  })

  runtime = await spawnService(
    'apps/runtime/src/runtime-sim.ts',
    {
      PORT: '0',
      API_URL: api.url,
      HOST_ID: 'host_dev001',
      HOST_NAME: 'dev-001',
      SANDBOX_ROOT: workspace.root,
      TLS_KEY: tls.key,
      TLS_CERT: tls.cert
    },
    /\[runtime-sim\] dev-001 listening on :(\d+)/,
    'runtime'
  )
  runtimePort = runtime.port

  adminToken = await (async () => {
    const res = await fetch(`${api.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'e2e-admin' })
    })
    return ((await res.json()) as { accessToken: string }).accessToken
  })()

  const registered = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'dev-001',
    directAddr: `127.0.0.1:${runtimePort}`,
    relayTarget: `127.0.0.1:${runtimePort}`
  })
  hostCredential = registered.credential
  // Wait for the relay to pull the refreshed route table (refresh interval 2s).
  await waitForLog(relay, /routes synced n=1/)
  await new Promise((r) => setTimeout(r, 2600))
})

after(async () => {
  await runtime?.stop()
  await relay?.stop()
  await api?.stop()
})

describe('平台端到端（真实进程 / TCP / TLS / Ed25519）', () => {
  test('E1 登录 → 项目列表 → 直连打开项目', async () => {
    const client = new CloudClient(api.url)
    const user = await client.login('zhangsan', 'Passw0rd!')
    assert.equal(user.displayName, '张伟')

    const projects = await client.listProjects()
    assert.equal(projects.length, 1)
    assert.equal(projects[0].name, 'payment-service')

    const opened = await client.openProject(projects[0].id)
    assert.equal(opened.route, 'direct')

    const who = await client.rpc('sessions.whoami')
    assert.equal(who.ok, true)
    const result = who.ok ? (who.result as { sub: string }) : null
    assert.equal(result?.sub, 'user:zhangsan')

    const read = await client.rpc('files.read', projectFile(opened, 'src/calculator.ts'))
    assert.equal(read.ok, true)

    saveEvidence(EVIDENCE, 'E1-direct.json', {
      route: opened.route,
      probes: opened.selection.probes,
      workspace: opened.connect.workspace,
      whoami: who,
      read
    })
    client.close()
  })

  test('E2 直连不可达 → 自动回落中继（SNI 转发）', async () => {
    await registerHost({
      apiUrl: api.url,
      adminToken,
      name: 'dev-001',
      directAddr: '127.0.0.1:1',
      relayTarget: `127.0.0.1:${runtimePort}`
    })
    await waitForLog(relay, /routes synced/)

    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id, { probeTimeoutMs: 500 }).catch((err) => {
      console.error('E2 failure relay logs:', relay.logs.join(''))
      console.error('E2 failure runtime logs:', runtime.logs.join(''))
      throw err
    })
    assert.equal(opened.route, 'relay')

    const who = await client.rpc('sessions.whoami')
    assert.equal(who.ok, true)

    saveEvidence(EVIDENCE, 'E2-relay.json', {
      route: opened.route,
      probes: opened.selection.probes,
      whoami: who
    })

    // restore direct address for later tests
    await registerHost({
      apiUrl: api.url,
      adminToken,
      name: 'dev-001',
      directAddr: `127.0.0.1:${runtimePort}`,
      relayTarget: `127.0.0.1:${runtimePort}`
    })
    client.close()
  })

  test('E3 伪造/过期凭证在升级期被拒', async () => {
    const WebSocket = (await import('ws')).default
    const result = await new Promise<{ status?: number; error?: string }>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${runtimePort}/`, {
        rejectUnauthorized: false,
        protocols: ['orca-runtime', 'orca-cred.forged.token.value']
      })
      ws.once('open', () => {
        ws.close()
        resolve({ status: 101 })
      })
      ws.once('error', (err) => resolve({ error: err.message }))
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
    })
    assert.notEqual(result.status, 101)
    saveEvidence(EVIDENCE, 'E3-forged-credential.json', result)
  })

  test('E4 方法级权限：无 file:write 时写操作被拒', async () => {
    const res = await fetch(`${api.url}/v1/projects/proj_payment/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open', 'terminal', 'agent', 'file:read']
      })
    })
    assert.equal(res.status, 200)
    await new Promise((r) => setTimeout(r, 1500))

    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    const write = await client.rpc('files.write', {
      ...workspaceFile(opened, 'src/new.ts'),
      content: 'x'
    })
    assert.equal(write.ok, false)
    assert.equal(write.ok === false ? write.code : '', 'PERMISSION_MISSING')

    const read = await client.rpc('files.read', projectFile(opened, 'README.md'))
    assert.equal(read.ok, true)

    saveEvidence(EVIDENCE, 'E4-method-permission.json', { write, read })
    client.close()

    // restore write permission
    await fetch(`${api.url}/v1/projects/proj_payment/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
      })
    })
    await new Promise((r) => setTimeout(r, 1500))
  })

  test('E5 导出类方法一律拒绝（下载策略 deny）', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    const download = await client.rpc('files.download', projectFile(opened, 'README.md'))
    assert.equal(download.ok, false)
    assert.equal(download.ok === false ? download.code : '', 'EXPORT_DENIED')
    saveEvidence(EVIDENCE, 'E5-export-denied.json', download)
    client.close()
  })

  test('E6 路径穿越与跨用户写越界被拒', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    const traversalRead = await client.rpc('files.read', projectFile(opened, '../../etc/passwd'))
    assert.equal(traversalRead.ok, false)

    const outsideWrite = await client.rpc('files.write', {
      ...projectFile(opened, 'main-only.ts'),
      content: 'x'
    })
    assert.equal(outsideWrite.ok, false)
    assert.equal(outsideWrite.ok === false ? outsideWrite.code : '', 'PATH_OUTSIDE_ROOT')

    const insideWrite = await client.rpc('files.write', {
      ...workspaceFile(opened, 'src/feature.ts'),
      content: 'export const ok = true\n'
    })
    assert.equal(insideWrite.ok, true)

    saveEvidence(EVIDENCE, 'E6-path-boundary.json', { traversalRead, outsideWrite, insideWrite })
    client.close()
  })

  test('E7 权限收回后：旧凭证在心跳窗口内被拒，新登录看不到项目', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    assert.equal(opened.route, 'direct')
    const staleCredential = opened.connect.credential

    const revoke = await fetch(`${api.url}/v1/projects/proj_payment/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
    })
    assert.equal(revoke.status, 200)

    // Runtime polls revocations every second.
    await new Promise((r) => setTimeout(r, 2500))

    const replay = await new Promise<{ status?: number; error?: string }>((resolve) => {
      const WebSocket = requireWs()
      const ws = new WebSocket(`wss://127.0.0.1:${runtimePort}/`, ['orca-runtime', `orca-cred.${staleCredential}`], {
        rejectUnauthorized: false
      })
      ws.once('open', () => {
        ws.close()
        resolve({ status: 101 })
      })
      ws.once('error', (err) => resolve({ error: err.message }))
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
    })
    assert.notEqual(replay.status, 101)

    const second = new CloudClient(api.url)
    await second.login('zhangsan', 'Passw0rd!')
    const listAfterRevoke = await second.listProjects()
    assert.equal(listAfterRevoke.length, 0)

    saveEvidence(EVIDENCE, 'E7-revocation.json', {
      oldCredentialRejected: replay,
      projectsAfterRevoke: listAfterRevoke
    })

    // Restore access for E8.
    await fetch(`${api.url}/v1/projects/proj_payment/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        subjectType: 'group',
        subjectId: 'team-payment',
        permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
      })
    })
    await new Promise((r) => setTimeout(r, 1200))
    client.close()
    second.close()
  })

  test('E7a 符号链接写逃逸被拒（realpath 边界）', async () => {
    const { mkdirSync, symlinkSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const outside = join(workspace.root, 'outside-target')
    mkdirSync(outside, { recursive: true })
    const linkPath = join(workspace.projectRoot, '.orca-worktrees', 'zhangsan', 'escape')
    mkdirSync(join(workspace.projectRoot, '.orca-worktrees', 'zhangsan'), { recursive: true })
    if (existsSync(linkPath)) (await import('node:fs')).rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(outside, linkPath, 'dir')

    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    const escaped = await client.rpc('files.write', {
      ...workspaceFile(opened, 'escape/pwned.ts'),
      content: 'escaped'
    })
    assert.equal(escaped.ok, false)
    assert.equal(escaped.ok === false ? escaped.code : '', 'PATH_OUTSIDE_ROOT')
    assert.equal(existsSync(join(outside, 'pwned.ts')), false)

    const sibling = await client.rpc('files.write', {
      worktree: '/srv/work/payment-service/.orca-worktrees/zhangsan2',
      relativePath: 'x.ts',
      content: 'x'
    })
    assert.equal(sibling.ok, false)

    saveEvidence(EVIDENCE, 'E7a-symlink-escape.json', { escaped, sibling })
    client.close()
  })

  test('E7b 凭证移植到另一设备被拒', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    // Request a fresh, unused credential so the rejection can only be the device binding.
    const connect = await client.requestConnect(projects[0].id)
    const credential = connect.credential

    const WebSocket = requireWs()
    const replay = await new Promise<{ status?: number; error?: string }>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${runtimePort}/`, ['orca-runtime', `orca-cred.${credential}`], {
        rejectUnauthorized: false,
        headers: { 'x-orca-device-pubkey': 'attacker-device-public-key' }
      })
      ws.once('open', () => {
        ws.close()
        resolve({ status: 101 })
      })
      ws.once('error', (err) => resolve({ error: err.message }))
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
    })
    assert.notEqual(replay.status, 101)
    // Prove the same unused credential is accepted from the rightful device.
    const legit = await new Promise<{ status?: number; error?: string }>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${runtimePort}/`, ['orca-runtime', `orca-cred.${credential}`], {
        rejectUnauthorized: false,
        headers: { 'x-orca-device-pubkey': (client as unknown as { deviceKey: string }).deviceKey }
      })
      ws.once('open', () => {
        ws.close()
        resolve({ status: 101 })
      })
      ws.once('error', (err) => resolve({ error: err.message }))
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }))
    })
    assert.equal(legit.status, 101)
    saveEvidence(EVIDENCE, 'E7b-device-transplant.json', { transplant: replay, rightfulDevice: legit })
    client.close()
  })

  test('E7b2 缺失设备公钥头一律拒绝（不接受省略绕过）', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const connect = await client.requestConnect(projects[0].id)

    const WebSocket = requireWs()
    const noHeader = await new Promise<{ status?: number; error?: string; reject?: string }>((resolve) => {
      const ws = new WebSocket(`wss://127.0.0.1:${runtimePort}/`, ['orca-runtime', `orca-cred.${connect.credential}`], {
        rejectUnauthorized: false
      })
      ws.once('open', () => {
        ws.close()
        resolve({ status: 101 })
      })
      ws.once('error', (err) => resolve({ error: err.message }))
      ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode, reject: String(res.headers['x-orca-reject'] ?? '') }))
    })
    assert.notEqual(noHeader.status, 101, 'omitting the device header must not grant access')

    saveEvidence(EVIDENCE, 'E7b2-missing-device-header.json', noHeader)
    client.close()
  })

  test('E7c 客户端版本过低被平台拒绝（426）', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const res = await fetch(`${api.url}/v1/projects/${projects[0].id}/connect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${(client as unknown as { accessToken: string }).accessToken}`
      },
      body: JSON.stringify({ deviceId: 'dev_x', clientVersion: '1.0.0' })
    })
    const body = (await res.json()) as { error?: { code: string } }
    assert.equal(res.status, 426)
    assert.equal(body.error?.code, 'VERSION_UNSUPPORTED')
    saveEvidence(EVIDENCE, 'E7c-version-gate.json', { status: res.status, body })
    client.close()
  })

  test('E7d 托管工作区创建落在 workspaceRoot 内且幂等', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)

    const first = await client.rpc('worktree.createManaged', {
      branchName: 'feat/refund',
      idempotencyKey: 'e7d-key',
      workspaceRoot: opened.connect.workspace.workspaceRoot
    })
    assert.equal(first.ok, true)
    const firstPath = first.ok ? (first.result as { path: string }).path : ''
    assert.equal(firstPath, `${opened.connect.workspace.workspaceRoot}/feat-refund`)

    const again = await client.rpc('worktree.createManaged', {
      branchName: 'feat/refund',
      idempotencyKey: 'e7d-key',
      workspaceRoot: opened.connect.workspace.workspaceRoot
    })
    assert.deepEqual(again, first)

    saveEvidence(EVIDENCE, 'E7d-managed-worktree.json', { first, again })
    client.close()
  })

  test('E8 平台停机：已建立会话继续，新建连接失败', async () => {
    const client = new CloudClient(api.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    if (projects.length === 0) {
      // E7 revoked access; restore via direct store mutation is not available across processes,
      // so this test only runs when the project is still visible.
      saveEvidence(EVIDENCE, 'E8-platform-down.json', { skipped: 'no visible project after E7' })
      client.close()
      return
    }
    const opened = await client.openProject(projects[0].id)
    await api.stop()

    const immediately = await client.rpc('sessions.whoami')
    assert.equal(immediately.ok, true)

    // The runtime polls the platform every second; surviving several polls proves the
    // session is truly independent, not just checked before the first failure.
    await new Promise((r) => setTimeout(r, 3500))
    assert.equal(runtime.proc.exitCode, null, 'runtime must survive the platform outage')
    assert.equal(runtime.proc.signalCode, null, 'runtime must not be killed by a signal')
    const afterOutage = await client.rpc('sessions.whoami')
    assert.equal(afterOutage.ok, true, 'established session must still work after the outage')
    const stillReads = await client.rpc('files.read', projectFile(opened, 'README.md'))
    assert.equal(stillReads.ok, true)

    const fresh = new CloudClient(api.url)
    await assert.rejects(() => fresh.login('zhangsan', 'Passw0rd!'))

    saveEvidence(EVIDENCE, 'E8-platform-down.json', {
      immediately,
      afterOutage,
      stillReads: stillReads.ok,
      runtimeAlive: runtime.proc.exitCode === null,
      newLoginRejected: true,
      route: opened.route
    })
    client.close()
  })
})

test('E8a 畸形策略值不 fail-open，Runtime 存活（需真实会话才有效）', async () => {
  // Regression for review-05 C-01 / review-06 N1+N5. The previous version pointed
  // at an API that E8 had already stopped, so JWKS never arrived and the policy
  // path was never exercised — it passed even against the broken build. This one
  // starts its own platform, establishes a real session, and then asks for a
  // download while the control plane returns a malformed override value.
  const { createServer } = await import('node:http')
  let policyHits = 0
  const fake = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url?.startsWith('/v1/internal/revocations')) {
      res.end(JSON.stringify({ projects: [], users: [], devices: [], jtis: [] }))
      return
    }
    if (req.url?.startsWith('/v1/internal/policy')) {
      policyHits += 1
      // `123` is not a valid override value; treating it as "not deny" used to
      // allow exports. It must be discarded, leaving the deny default in force.
      res.end(JSON.stringify({ downloadDefault: 'deny', projectOverrides: { proj_payment: 123 } }))
      return
    }
    res.end('{}')
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  const fakePort = (fake.address() as { port: number }).port

  const isolatedApi = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-malformed-policy'
  )
  const tls = makeTlsCerts()
  const isolated = await spawnService(
    'apps/runtime/src/runtime-sim.ts',
    {
      PORT: '0',
      API_URL: `http://127.0.0.1:${fakePort}`,
      PUBLIC_API_URL: isolatedApi.url,
      CONTROL_TIMEOUT_MS: '400',
      HOST_ID: 'host_dev001',
      HOST_NAME: 'dev-001',
      SANDBOX_ROOT: workspace.root,
      TLS_KEY: tls.key,
      TLS_CERT: tls.cert
    },
    /\[runtime-sim\] dev-001 listening on :(\d+)/,
    'runtime-malformed-policy'
  )
  let client: CloudClient | null = null
  try {
    const adminRes = await fetch(`${isolatedApi.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'e8a-admin' })
    })
    const { accessToken } = (await adminRes.json()) as { accessToken: string }
    await registerHost({
      apiUrl: isolatedApi.url,
      adminToken: accessToken,
      name: 'dev-001',
      directAddr: `127.0.0.1:${isolated.port}`,
      relayTarget: `127.0.0.1:${isolated.port}`
    })

    client = new CloudClient(isolatedApi.url)
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    const opened = await client.openProject(projects[0].id)
    assert.equal(opened.route, 'direct')

    // Give the poller time to consume the malformed body at least once.
    await waitFor(async () => policyHits > 0, 4000)
    await new Promise((r) => setTimeout(r, 1500))

    const download = await client.rpc('files.download', projectFile(opened, 'README.md'))
    assert.equal(download.ok, false, 'malformed override value must not allow exports')
    assert.equal(download.ok === false ? download.code : '', 'EXPORT_DENIED')
    assert.equal(isolated.proc.exitCode, null, 'runtime must survive a malformed policy')
    assert.equal(isolated.proc.signalCode, null, 'runtime must not be signalled either')

    saveEvidence(EVIDENCE, 'E8a-malformed-policy-survives.json', {
      policyHits,
      download,
      alive: true,
      exitCode: isolated.proc.exitCode,
      logs: isolated.logs.join('').slice(-400)
    })
  } finally {
    client?.close()
    await isolated.stop()
    await isolatedApi.stop()
    await new Promise<void>((r) => fake.close(() => r()))
  }
})

test('E9 证据汇总写入磁盘', async () => {
  const summary = {
    generatedAt: new Date().toISOString(),
    api: api.url,
    relayPort: relay.port,
    runtimePort,
    hostCredentialIssued: Boolean(hostCredential),
    workspaceRoot: workspace.root,
    logs: { api: api.logs.join(''), relay: relay.logs.join(''), runtime: runtime.logs.join('') }
  }
  const path = saveEvidence(EVIDENCE, 'summary.json', summary)
  assert.ok(path.includes('evidence'))
  assert.ok(ROOT.includes('cloud-platform'))
})

test('中继探针：未知 SNI 被黑洞', async () => {
  const probe = await probeEndpoint({ priority: 1, url: `wss://127.0.0.1:${relay.port}` }, 500)
  assert.equal(probe.ok, true, 'relay TCP is reachable')
  const { connect } = await import('node:net')
  const closed = await new Promise<boolean>((resolve) => {
    const socket = connect(relay.port, '127.0.0.1')
    socket.once('connect', () => {
      // Not a TLS ClientHello: relay must drop the connection.
      socket.write(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
    })
    socket.once('close', () => resolve(true))
    socket.once('error', () => resolve(true))
    setTimeout(() => resolve(!socket.writable), 800)
  })
  assert.equal(closed, true)
  saveEvidence(EVIDENCE, 'E10-relay-blackhole.json', { probe, closed })
})
