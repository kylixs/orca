import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudSessionService } from './cloud-session-service'
import {
  registerCloudRuntimeEnvironment,
  removeCloudRuntimeEnvironment
} from './cloud-runtime-environment'
import { setActiveCloudSession } from './cloud-runtime-session'

/**
 * A cloud project registered as an ordinary runtime environment, then reached
 * through the same call the terminal and file panes use. Real platform process,
 * real TLS runtime, real Ed25519 tickets, one ticket per connection.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname
const ENV_ID_PREFIX = 'cloud-'

function makeTlsCerts(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-env-'))
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
    '/CN=dev-env',
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
let projectKey = ''
const userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-env-user-'))
const sessionUserData = mkdtempSync(join(tmpdir(), 'orca-cloud-env-session-'))

async function startPlatform(): Promise<Platform> {
  const proc: ChildProcess = spawn(process.execPath, ['cloud-platform/apps/api/src/server.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: 'env-token' },
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

function makeSession(): CloudSessionService {
  return new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
}

async function registerProject(): Promise<string> {
  const session = makeSession()
  await session.login('zhangsan', 'Passw0rd!')
  const project = (await session.listProjects()).find((entry) => entry.key === projectKey)
  if (!project) {
    throw new Error('project not visible to the user')
  }
  const prepared = await session.prepareProjectLink(project.id)
  if (!prepared.ok) {
    throw new Error(`prepare failed: ${prepared.code}`)
  }
  const environment = registerCloudRuntimeEnvironment(userDataPath, {
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    hostId: admission.host()!.hostId,
    link: prepared.link
  })
  setActiveCloudSession(session)
  return environment.id
}

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'env-admin' })
  })
  adminToken = readString(await adminRes.json(), 'accessToken') ?? ''

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
      ORCA_CLOUD_HOST_NAME: 'dev-env',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-env-host-')) }
  )!
  await admission.ready
  runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: sessionUserData,
    enableWebSocket: true,
    wsPort: 0,
    webSocketTls: makeTlsCerts(),
    upgradeAdmission: admission.admission
  })
  await runtime.start()
  admission.bindRuntime(runtime)
  await admission.client!.refresh()

  projectKey = 'env-svc'
  const projectRes = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: projectKey,
      name: projectKey,
      hostId: admission.host()!.hostId,
      path: '/srv/work/env-svc'
    })
  })
  projectId = readString(await projectRes.json(), 'id') ?? ''
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
  setActiveCloudSession(null)
  admission?.stop()
  await runtime?.stop()
  await platform?.stop()
})

describe('云端项目注册为运行时环境（真实平台 + 真实 TLS Runtime 升级准入）', () => {
  it('环境落地到 Orca 环境存储，并带 cloudProject 标记', async () => {
    const environmentId = await registerProject()
    expect(environmentId.startsWith(ENV_ID_PREFIX)).toBe(true)

    const { readEnvironmentStore } = await import('../../shared/runtime-environment-store-file')
    const environment = readEnvironmentStore(userDataPath).environments.find(
      (entry) => entry.id === environmentId
    )
    expect(environment?.cloudProject?.projectId).toBe(projectId)
    expect(environment?.name).toBe(projectKey)
    // The persisted pairing is only a placeholder; panes must not dial it directly.
    expect(environment?.endpoints.length).toBe(1)
  }, 30000)

  it('通过环境 id 调用真实 RPC：每次连接重新签发一次性票据', async () => {
    const environmentId = await registerProject()

    // Two calls in a row: the second would fail if a consumed ticket were reused.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await callRuntimeEnvironment(userDataPath, environmentId, 'status.get', {})
      expect(response.ok).toBe(true)
      if (!response.ok) {
        throw new Error(`status.get failed: ${response.error.code}`)
      }
      expect(typeof response.result).toBe('object')
    }
  }, 40000)

  it('没有平台会话时明确报 NOT_SIGNED_IN，而不是静默连默认地址', async () => {
    const environmentId = await registerProject()
    setActiveCloudSession(null)
    await expect(
      callRuntimeEnvironment(userDataPath, environmentId, 'status.get', {})
    ).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })
  }, 30000)

  it('设备被吊销后平台会话结束：环境调用明确报 SESSION_EXPIRED', async () => {
    const environmentId = await registerProject()
    const session = new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
    await session.login('zhangsan', 'Passw0rd!')
    setActiveCloudSession(session)
    expect((await callRuntimeEnvironment(userDataPath, environmentId, 'status.get', {})).ok).toBe(
      true
    )

    const relogin = await fetch(`${platform.url}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'zhangsan', password: 'Passw0rd!', deviceName: 'revoker' })
    })
    const revokeToken = readString(await relogin.json(), 'accessToken')
    if (revokeToken === null) {
      throw new Error('revoker login failed')
    }
    const revoke = await fetch(`${platform.url}/v1/me/devices/${session.currentDeviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${revokeToken}` }
    })
    expect(revoke.ok).toBe(true)
    await admission.client!.refresh()

    // Revoking a device ends its sessions, so no ticket can be minted at all:
    // the environment fails with an explicit code instead of a silent no-op.
    await expect(
      callRuntimeEnvironment(
        userDataPath,
        environmentId,
        'status.get',
        {},
        undefined,
        undefined,
        undefined,
        { signal: AbortSignal.timeout(20_000) }
      )
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  }, 60000)

  it('授权被收回后，下一次环境调用被平台拒绝：授权是按连接实时判定的', async () => {
    const environmentId = await registerProject()
    expect((await callRuntimeEnvironment(userDataPath, environmentId, 'status.get', {})).ok).toBe(
      true
    )

    await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: [] })
    })
    try {
      await expect(
        callRuntimeEnvironment(userDataPath, environmentId, 'status.get', {})
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    } finally {
      await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          subjectType: 'group',
          subjectId: 'team-payment',
          permissions: ['open', 'terminal', 'agent', 'file:read']
        })
      })
    }
  }, 40000)

  it('同一张票据只能握手一次：这就是每次按连接重签的原因', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const prepared = await session.prepareProjectLink(projectId)
    if (!prepared.ok) {
      throw new Error(`prepare failed: ${prepared.code}`)
    }
    const { pairingOfferFromCloudLink } = await import('../../shared/cloud-project-link-offer')
    const { subscribeRemoteRuntimeRequest } = await import('../../shared/remote-runtime-client')
    const offer = pairingOfferFromCloudLink(prepared.link)
    if (offer === null) {
      throw new Error('link is not a runtime offer')
    }
    const first = await subscribeRemoteRuntimeRequest(
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
    first.close()
    await expect(
      subscribeRemoteRuntimeRequest(
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
    ).rejects.toThrow(/upgrade rejected \(401, replayed\)/i)
  }, 30000)

  it('移除环境后不再可解析', async () => {
    const environmentId = await registerProject()
    expect(removeCloudRuntimeEnvironment(userDataPath, projectId)).toBe(true)
    await expect(
      callRuntimeEnvironment(userDataPath, environmentId, 'status.get', {})
    ).rejects.toThrow(/Unknown environment/)
  }, 30000)
})
