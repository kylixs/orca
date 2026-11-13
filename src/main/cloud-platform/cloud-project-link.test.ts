import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pairingOfferFromCloudLink } from '../../shared/cloud-project-link-offer'
import { readString } from '../../shared/json-fields'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudSessionService } from './cloud-session-service'

/**
 * Opening a project has to enter the existing Orca workspace, not a parallel
 * client. That means a cloud ticket must be expressible as Orca's pairing offer,
 * and the renderer's own remote-runtime client must be able to attach with it.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname

function makeTlsCerts(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-link-'))
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
    '/CN=dev-link',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost'
  ])
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') }
}

type Platform = { url: string; stop: () => Promise<void> }
let platform: Platform
let adminToken = ''
let admission: CloudRuntimeAdmission
let runtime: OrcaRuntimeRpcServer
let projectId = ''

async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: 'link-token' },
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
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'link-admin' })
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

  admission = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-link',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-link-host-')) }
  )!
  await admission.ready
  runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-link-rt-')),
    enableWebSocket: true,
    wsPort: 0,
    webSocketTls: makeTlsCerts(),
    upgradeAdmission: admission.admission
  })
  await runtime.start()
  admission.bindRuntime(runtime)
  await admission.client!.refresh()

  const projectRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: 'link-svc',
      name: 'link-svc',
      hostId: admission.host()!.hostId,
      path: '/srv/work/link-svc'
    })
  })
  projectId = readString(await projectRes.json(), 'id') ?? projectId
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read']
    })
  })
  await new Promise((r) => setTimeout(r, 1200))
})

afterAll(async () => {
  admission?.stop()
  await runtime?.stop()
  await platform?.stop()
})

function makeSession(): CloudSessionService {
  return new CloudSessionService({
    apiUrl: platform.url,
    tlsRejectUnauthorized: false
  })
}

describe('云端项目进入 Orca 工作区（真实平台 + 真实 Runtime + 现有远程客户端）', () => {
  it('项目链接可转成 Orca 配对凭证，且不消耗凭证（预处理不开连接）', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const prepared = await session.prepareProjectLink(projectId)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) {
      throw new Error(`prepare failed: ${prepared.code}`)
    }
    expect(prepared.link.offer.endpoint.startsWith('wss://')).toBe(true)
    expect(prepared.link.offer.scope).toBe('runtime')
    expect(prepared.link.offer.deviceToken.length).toBeGreaterThan(0)
    expect(prepared.link.workspaceRoot).toContain('/srv/work/link-svc')
    // Preparation must not burn the single-use ticket: no socket was opened.
    expect(session.connectedProjectIds).toEqual([])
  }, 20000)

  it('现有远程客户端用该链接完成 E2EE 并跑通 RPC', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const prepared = await session.prepareProjectLink(projectId)
    if (!prepared.ok) {
      throw new Error(`prepare failed: ${prepared.code}`)
    }

    // The stock renderer path, given only the cloud upgrade options: this is the
    // same call the terminal pane makes against a paired host.
    const offer = pairingOfferFromCloudLink(prepared.link)
    if (offer === null) {
      throw new Error('link is not a runtime offer')
    }
    const received: unknown[] = []
    const subscription = await subscribeRemoteRuntimeRequest(
      offer,
      'status.get',
      {},
      8000,
      {
        onResponse: (response) => received.push(response),
        onError: (error) => received.push(error)
      },
      {
        cloudUpgrade: prepared.link.cloudUpgrade,
        clientKeyPair: session.deviceKeyPair() ?? undefined
      }
    )
    await new Promise((r) => setTimeout(r, 800))
    subscription.close()
    expect(received.length).toBeGreaterThan(0)
    // A real status.get reply, not a client-side failure object.
    expect(received[0]).toHaveProperty('result')
  }, 30000)

  it('订阅通道（终端/流式）同样可经云端链接建立', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const prepared = await session.prepareProjectLink(projectId)
    if (!prepared.ok) {
      throw new Error(`prepare failed: ${prepared.code}`)
    }

    const offer = pairingOfferFromCloudLink(prepared.link)
    if (offer === null) {
      throw new Error('link is not a runtime offer')
    }
    const subscription = await subscribeRemoteRuntimeRequest(
      offer,
      'status.get',
      {},
      8000,
      { onResponse: () => undefined, onError: () => undefined },
      {
        cloudUpgrade: prepared.link.cloudUpgrade,
        clientKeyPair: session.deviceKeyPair() ?? undefined
      }
    )
    expect(subscription.requestId.length).toBeGreaterThan(0)
    subscription.close()
  }, 30000)

  it('不带升级凭证时被主机拒绝：证明准入真的在起作用', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const prepared = await session.prepareProjectLink(projectId)
    if (!prepared.ok) {
      throw new Error(`prepare failed: ${prepared.code}`)
    }

    // Same offer, no cloudUpgrade: the host has no ticket to verify and must
    // refuse, otherwise the passing tests above would prove nothing.
    const offer = pairingOfferFromCloudLink(prepared.link)
    if (offer === null) {
      throw new Error('link is not a runtime offer')
    }
    await expect(
      subscribeRemoteRuntimeRequest(offer, 'status.get', {}, 5000, {
        onResponse: () => undefined,
        onError: () => undefined
      })
    ).rejects.toThrow()
  }, 20000)

  it('主机未上报 E2EE 公钥时返回明确错误，而不是握手超时', async () => {
    // A ticket whose host key was never reported cannot drive an E2EE session.
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const prepared = await session.prepareProjectLink(projectId)
    if (!prepared.ok) {
      throw new Error(`prepare failed: ${prepared.code}`)
    }
    // Same ticket, but the host never reported a key: the link must refuse it.
    const ticket = {
      credential: prepared.link.cloudUpgrade.credential,
      expiresIn: prepared.link.expiresIn,
      host: {
        id: 'dev-link',
        name: 'dev-link',
        fingerprint: '',
        tlsFingerprint: '',
        e2eePublicKeyB64: '',
        capabilities: ['pty']
      },
      endpoints: { direct: [], relay: [] },
      workspace: {
        projectRoot: prepared.link.workspaceRoot,
        workspaceRoot: prepared.link.workspaceRoot,
        defaultBranch: 'main'
      }
    }
    const { buildCloudProjectLink } = await import('./cloud-pairing-offer')
    const link = buildCloudProjectLink({
      ticket,
      endpoint: { priority: 1, url: 'wss://127.0.0.1:1' },
      route: 'direct'
    })
    expect(link).toBeNull()
  }, 20000)
})
