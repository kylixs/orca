import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { createServer as createHttpServer } from 'node:http'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  chooseRoute,
  CloudConnectClient,
  probeEndpoint,
  type CloudEndpoint
} from './cloud-connect-client'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'

/**
 * The desktop path end to end: log in to a real platform, list projects, probe
 * the direct address without spending the ticket, upgrade with the ticket over
 * real TLS, complete the E2EE handshake, and run an encrypted RPC.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname

function makeTlsCerts(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-connect-'))
  const key = join(dir, 'server.key')
  const cert = join(dir, 'server.crt')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '1',
    '-subj',
    '/CN=dev-connect',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

type Platform = { url: string; stop: () => Promise<void> }
let platform: Platform
let adminToken = ''
let host: { admission: CloudRuntimeAdmission; runtime: OrcaRuntimeRpcServer; port: number }
let projectId = ''

async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: 'connect-token' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('platform did not start')), 15_000)
    let buffer = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /\[api\] listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.once('exit', (code) => reject(new Error(`platform exited ${code}`)))
  })
  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve()
          return
        }
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
      })
  }
}

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'connect-admin' })
  })
  adminToken = readString(await adminRes.json(), 'accessToken') ?? adminToken

  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  const admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-connect',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-connect-host-')) }
  )!
  await admission.ready

  const tls = makeTlsCerts()
  const runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-connect-rt-')),
    enableWebSocket: true,
    wsPort: 0,
    webSocketTls: tls,
    upgradeAdmission: admission.admission
  })
  await runtime.start()
  admission.bindRuntime(runtime)
  const port = Number(new URL(runtime.getWebSocketEndpoint()!).port)
  host = { admission, runtime, port }

  // The heartbeat reports the bound port; give it one beat before binding a project.
  await admission.client!.refresh()

  const projectRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'connect-svc',
      name: 'connect-svc',
      hostId: admission.host()!.hostId,
      path: '/srv/work/connect-svc'
    })
  })
  expect(projectRes.status).toBe(201)
  projectId = readString(await projectRes.json(), 'id') ?? projectId
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
})

afterAll(async () => {
  host?.admission.stop()
  await host?.runtime.stop()
  await platform?.stop()
})

describe('桌面端云端连接（真实平台 + 真实 TLS Runtime + E2EE）', () => {
  it('登录 → 项目列表 → 直连打开 → 加密 RPC', async () => {
    const client = new CloudConnectClient({
      apiUrl: platform.url,
      tlsRejectUnauthorized: false
    })
    const user = await client.login('zhangsan', 'Passw0rd!')
    expect(user.displayName).toBe('张伟')

    const projects = await client.listProjects()
    expect(projects.map((p) => p.key)).toContain('connect-svc')

    const opened = await client.openProject(projectId)
    expect(opened.route).toBe('direct')
    expect(new URL(opened.ticket.endpoints.direct[0].url).port).toBe(String(host.port))

    // A real Orca method: the point is that an encrypted RPC reaches the dispatcher.
    const status = await client.rpc('status.get')
    expect(status.ok).toBe(true)
    client.close()
  }, 30000)

  it('无权项目对用户不可见（统一 404，不泄露存在性）', async () => {
    const client = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
    await client.login('zhangsan', 'Passw0rd!')
    const projects = await client.listProjects()
    // A project the platform knows but the user has no grant for.
    const adminOnly = await fetch(`${platform.url}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        key: 'admin-only-svc',
        name: 'admin-only-svc',
        hostId: host.admission.host()!.hostId,
        path: '/srv/work/admin-only-svc'
      })
    })
    const hidden = readString(await adminOnly.json(), 'id')
    if (hidden === null) {
      throw new Error('project id missing')
    }
    expect(projects.some((p) => p.id === hidden)).toBe(false)
    await expect(client.requestTicket(hidden)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    client.close()
  }, 20000)

  it('直连不可达时回落中继；两者都不可达时明确报错', async () => {
    const closed = createHttpServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
    const address = closed.address()
    if (address === null || typeof address === 'string') {
      throw new Error('unexpected server address')
    }
    const closedPort = address.port
    await new Promise<void>((r) => closed.close(() => r()))

    const deadDirect: CloudEndpoint = { priority: 1, url: `wss://127.0.0.1:${closedPort}` }
    const liveRelay: CloudEndpoint = { priority: 99, url: `wss://127.0.0.1:${host.port}`, sni: 'x' }
    const reachable = await chooseRoute({ direct: [deadDirect], relay: [liveRelay] }, (url) =>
      probeEndpoint(url, 300)
    )
    expect(reachable.choice?.route).toBe('relay')
    // The dead direct address is recorded before the relay that worked.
    expect(reachable.probes[0]?.route).toBe('direct')
    expect(reachable.probes[0]?.ok).toBe(false)
    expect(reachable.probes.at(-1)?.ok).toBe(true)

    const nothing = await chooseRoute({ direct: [deadDirect], relay: [liveRelay] }, () =>
      Promise.resolve(false)
    )
    expect(nothing.choice).toBeNull()

    // Direct wins whenever it answers, even if the relay is also up.
    const direct = await chooseRoute({ direct: [liveRelay], relay: [liveRelay] }, () =>
      Promise.resolve(true)
    )
    expect(direct.choice?.route).toBe('direct')
  })

  it('凭证被吊销后，已建立的加密会话收到 4403', async () => {
    const client = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
    await client.login('zhangsan', 'Passw0rd!')
    await client.openProject(projectId)
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      client.onClose((code, reason) => resolve({ code, reason }))
    )

    // The renderer never holds a token: revoke through a separate login by the
    // same user, even though the device was minted by this client's session.
    const relogin = await fetch(`${platform.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'zhangsan', password: 'Passw0rd!', deviceName: 'revoker' })
    })
    const revokeToken = readString(await relogin.json(), 'accessToken')
    if (revokeToken === null) {
      throw new Error('revoker login failed')
    }
    const revoke = await fetch(`${platform.url}/v1/me/devices/${client.currentDeviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${revokeToken}` }
    })
    expect(revoke.ok).toBe(true)
    await host.admission.client!.refresh()

    const result = await Promise.race([
      closed,
      new Promise<{ code: number; reason: string }>((resolve) =>
        setTimeout(() => resolve({ code: -1, reason: 'timeout' }), 5000)
      )
    ])
    expect(result.code).toBe(4403)
    client.close()
  }, 30000)
})
