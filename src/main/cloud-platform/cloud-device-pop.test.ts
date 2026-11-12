import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair } from '../../shared/e2ee-crypto'
import { readString } from '../../shared/json-fields'
import { pairingOfferFromCloudLink } from '../../shared/cloud-project-link-offer'
import { subscribeRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudSessionService } from './cloud-session-service'

/**
 * Device proof of possession.
 *
 * The platform binds each ticket to the device key registered at login. Comparing
 * the announced `x-orca-device-pubkey` header with the ticket only checks a claim:
 * anyone who copies the ticket can echo it. Completing the E2EE handshake with that
 * key is the proof, so the host requires the handshake key to equal the ticket's.
 */

const REPO_ROOT = new URL('../../..', import.meta.url).pathname

function makeTlsCerts(): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-pop-'))
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
    '/CN=dev-pop',
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
    env: { ...process.env, PORT: '0', INTERNAL_TOKEN: 'pop-token' },
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

async function preparedLink(session: CloudSessionService) {
  const prepared = await session.prepareProjectLink(projectId)
  if (!prepared.ok) {
    throw new Error(`prepare failed: ${prepared.code}`)
  }
  const offer = pairingOfferFromCloudLink(prepared.link)
  if (offer === null) {
    throw new Error('link is not a runtime offer')
  }
  return { offer, cloudUpgrade: prepared.link.cloudUpgrade }
}

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'pop-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-pop',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-pop-host-')) }
  )!
  await admission.ready
  runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-pop-rt-')),
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
      key: 'pop-svc',
      name: 'pop-svc',
      hostId: admission.host()!.hostId,
      path: '/srv/work/pop-svc'
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
  admission?.stop()
  await runtime?.stop()
  await platform?.stop()
})

describe('设备公钥持有证明（真实平台 + 真实 TLS Runtime）', () => {
  it('用平台登记的设备密钥握手：成功并拿到真实响应', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const { offer, cloudUpgrade } = await preparedLink(session)
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
      { cloudUpgrade, clientKeyPair: session.deviceKeyPair() ?? undefined }
    )
    await new Promise((r) => setTimeout(r, 600))
    subscription.close()
    expect(received.length).toBeGreaterThan(0)
    expect(received[0]).toHaveProperty('result')
  }, 30000)

  it('持有票据但换一对密钥：主机拒绝（票据不是持有证明）', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const { offer, cloudUpgrade } = await preparedLink(session)
    const events: string[] = []

    await expect(
      subscribeRemoteRuntimeRequest(
        offer,
        'status.get',
        {},
        8000,
        {
          onResponse: () => events.push('response'),
          onError: (error) => events.push(`${error.code}:${error.message}`)
        },
        // A valid ticket and the matching header, but not the device's secret.
        { cloudUpgrade, clientKeyPair: generateKeyPair() }
      )
    ).rejects.toThrow(/different device key than the cloud ticket names/)
    // The host must not have answered anything over the unproven session.
    expect(events).not.toContain('response')
  }, 30000)

  it('主机把票据里的设备公钥登记下来，供后续握手比对', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const { offer, cloudUpgrade } = await preparedLink(session)
    const subscription = await subscribeRemoteRuntimeRequest(
      offer,
      'status.get',
      {},
      8000,
      { onResponse: () => undefined, onError: () => undefined },
      { cloudUpgrade, clientKeyPair: session.deviceKeyPair() ?? undefined }
    )
    subscription.close()

    const registry = runtime.getDeviceRegistry()
    if (!registry) {
      throw new Error('runtime has no device registry')
    }
    const device = registry.validateToken(offer.deviceToken)
    expect(device?.publicKeyB64).toBe(cloudUpgrade.devicePubKey)
    const keyPair = session.deviceKeyPair()
    if (!keyPair) {
      throw new Error('session has no device key pair')
    }
    expect(device?.publicKeyB64).toBe(Buffer.from(keyPair.publicKey).toString('base64'))
  }, 30000)
})
