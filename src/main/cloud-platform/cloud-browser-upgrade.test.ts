import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headerText } from '../../shared/http-header-text'
import { readString } from '../../shared/json-fields'
import {
  REPO_ROOT,
  cloudDeviceProtocol,
  connectCloudSession,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type CloudSession,
  type Platform
} from './cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudConnectClient } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'

/**
 * M46: a client that cannot set request headers — a browser — still has to prove
 * the device binding. The key rides as `orca-device.<base64url>` in the same
 * `Sec-WebSocket-Protocol` header as the credential, and the host compares it with
 * the key the platform signed into the ticket before the E2EE handshake starts.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm46-browser-upgrade')
const PROJECT_KEY = 'm46-browser-project'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

type UpgradeAttempt = { status: number; reject: string | undefined }

/** Opens the upgrade with no device header, exactly as a browser would. */
function attemptUpgrade(protocols: string[]): Promise<UpgradeAttempt> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(cloud.endpoint, protocols, {
      rejectUnauthorized: false,
      handshakeTimeout: 5000
    })
    ws.once('unexpected-response', (_request, response) => {
      resolve({
        status: response.statusCode ?? 0,
        reject: headerText(response.headers['x-orca-reject'])
      })
      ws.terminate()
    })
    ws.once('open', () => {
      ws.close()
      reject(new Error('expected the upgrade to be refused'))
    })
    ws.once('error', reject)
  })
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let projectId = ''
let adminToken = ''
let desktop: CloudConnectClient

function browserSession(client: CloudConnectClient, credential: string): CloudSession {
  const deviceToken = readTicketClaims(credential).deviceToken
  if (deviceToken === null) {
    throw new Error('ticket has no device token')
  }
  return {
    accessToken: '',
    deviceId: client.currentDeviceId,
    devicePubKey: client.devicePubKeyB64,
    deviceKeys: client.deviceKeyPair(),
    deviceToken,
    credential,
    projectId
  }
}

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'm46-admin' })
  })
  adminToken = readString(await adminRes.json(), 'accessToken') ?? ''
  if (adminToken === '') {
    throw new Error('admin login failed')
  }
  const tokenRes = await fetch(`${platform.url}/v1/hosts/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` }
  })
  const hostToken = readString(await tokenRes.json(), 'token')
  if (hostToken === null) {
    throw new Error('host token missing')
  }

  const started = startCloudRuntimeAdmission(
    {
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_HOST_TOKEN: hostToken,
      ORCA_CLOUD_HOST_NAME: 'dev-browser',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-m46-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-m46-',
    tls: makeSelfSignedTls('dev-browser')
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()

  const create = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key: PROJECT_KEY,
      name: PROJECT_KEY,
      hostId: admission.host()!.hostId,
      path: mkdtempSync(join(tmpdir(), 'orca-m46-project-'))
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  projectId = readString(await create.json(), 'id') ?? ''
  await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read']
    })
  })

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
})

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

describe('无自定义头的浏览器客户端（真实平台 + 真实 TLS Runtime）', () => {
  it('M46-1 设备公钥只走子协议：升级通过，E2EE 握手后 status.get 有真实响应', async () => {
    const ticket = await desktop.requestTicket(projectId)
    const connection = await connectCloudSession(
      cloud.endpoint,
      cloud.serverPublicKeyB64,
      browserSession(desktop, ticket.credential),
      5000,
      { deviceKeyIn: 'subprotocol', tlsRejectUnauthorized: false }
    )
    expect(connection.status).toBe('authenticated')
    if (connection.status !== 'authenticated') {
      throw new Error(`upgrade refused: ${connection.close.code} ${connection.close.reason}`)
    }
    const reply = await connection.rpc('status.get')
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    if (reply.ok) {
      expect(reply.result).toBeTruthy()
    }
    connection.ws.close()

    saveEvidence('m46-1-subprotocol-upgrade.json', {
      credentialHeaderPresent: false,
      protocols: [
        'orca-runtime',
        'orca-cred.<ticket>',
        cloudDeviceProtocol(desktop.devicePubKeyB64)
      ],
      reply
    })
  }, 30000)

  it('M46-2 子协议里的设备公钥与票据不同：升级被 401 device_mismatch 拒绝', async () => {
    const ticket = await desktop.requestTicket(projectId)
    const strangerKey = Buffer.from(randomBytes(32)).toString('base64')
    const outcome = await attemptUpgrade([
      'orca-runtime',
      `orca-cred.${ticket.credential}`,
      cloudDeviceProtocol(strangerKey)
    ])
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('device_mismatch')
    saveEvidence('m46-2-wrong-device-key.json', outcome)
  }, 30000)

  it('M46-3 两种形式都不带：升级被 401 device_pubkey_missing 拒绝', async () => {
    const ticket = await desktop.requestTicket(projectId)
    const outcome = await attemptUpgrade(['orca-runtime', `orca-cred.${ticket.credential}`])
    expect(outcome.status).toBe(401)
    expect(outcome.reject).toBe('device_pubkey_missing')
    saveEvidence('m46-3-missing-device-key.json', outcome)
  }, 30000)
})
