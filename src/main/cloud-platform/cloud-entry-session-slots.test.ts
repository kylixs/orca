import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readField, readString } from '../../shared/json-fields'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ALL_RPC_METHODS } from '../runtime/rpc/methods'
import { MANAGED_WORKTREE_METHODS } from '../runtime/rpc/methods/worktree-create-managed'
import {
  REPO_ROOT,
  connectCloudSession,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type CloudSession,
  type Platform
} from './cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudConnectClient, type CloudConnectTicket } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'
import { installRealPtyController } from './cloud-terminal-e2e-fixture'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'

/**
 * W9A-6: the desktop entry chain holds several cloud sockets at once — the
 * project socket, one per stream (terminal, file watch) and one per short RPC —
 * and every socket presents its own single-use ticket. §8.4's "3 sessions per
 * user per project" means three clients working, not three sockets, so these
 * cases drive the real burst through real tickets and handshakes: one device's
 * chain must be admitted in full (and carry a live terminal echo), while a
 * fourth device still meets the cap.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'w9a6-session-slots')
const PROJECT_KEY = 'entry-slot-project'
const ECHO_MARKER = 'ORCA_W9A6_ECHO_OK'

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), `${JSON.stringify(content, null, 2)}\n`)
}

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime
let desktop: CloudConnectClient
let projectId = ''
let workspacePath = ''

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-entry-slots-')))
  const projectRoot = join(base, 'payment-service')
  mkdirSync(projectRoot, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: projectRoot })
  writeFileSync(join(projectRoot, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: projectRoot })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: projectRoot })

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-entry-slots-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-entry-slots',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  const service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'entry-slots-admin' })
  })
  const adminToken = readString(await admin.json(), 'accessToken')
  if (adminToken === null) {
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
      ORCA_CLOUD_HOST_NAME: 'dev-entry-slots',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-entry-slots-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-entry-slots-',
    service,
    tls: makeSelfSignedTls('dev-entry-slots'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
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
      path: projectRoot
    })
  })
  expect(create.status, await create.clone().text()).toBe(201)
  projectId = readString(await create.json(), 'id') ?? ''
  const grant = await fetch(`${platform.url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'file:read', 'file:write']
    })
  })
  expect(grant.status).toBe(200)

  desktop = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  await desktop.login('zhangsan', 'Passw0rd!')
  const ensured = await ensureCloudWorkspace(desktop, projectId)
  if (!ensured.ok) {
    throw new Error(`workspace ensure failed: ${ensured.code} ${ensured.message ?? ''}`)
  }
  workspacePath = ensured.workspacePath
}, 60_000)

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
  await closeTestStores()
})

/** An admitted connection, or a failure naming the close that refused it. */
function authenticated(
  connection: CloudConnection,
  label: string
): Extract<CloudConnection, { status: 'authenticated' }> {
  if (connection.status !== 'authenticated') {
    throw new Error(`${label} was refused: ${JSON.stringify(connection.close)}`)
  }
  return connection
}

/**
 * Another connection of the same signed-in device: a fresh single-use ticket,
 * the same device keys — the shape of every entry-chain connection.
 */
async function openEntrySocket(
  onStreamEvent?: (result: unknown) => void
): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const prepared = await desktop.prepareProjectLink(projectId)
  const connection = await connectCloudSession(
    cloud.endpoint,
    cloud.serverPublicKeyB64,
    sessionWithTicket(prepared.ticket),
    5000,
    { tlsRejectUnauthorized: false, ...(onStreamEvent ? { onStreamEvent } : {}) }
  )
  return authenticated(connection, 'an entry socket')
}

function sessionWithTicket(ticket: CloudConnectTicket): CloudSession {
  const identity = desktop.deviceIdentity()
  const claims = readTicketClaims(ticket.credential)
  if (claims.deviceToken === null) {
    throw new Error('ticket carries no device token')
  }
  return {
    accessToken: '',
    deviceId: identity.deviceId,
    devicePubKey: desktop.devicePubKeyB64,
    deviceKeys: identity.keyPair,
    deviceToken: claims.deviceToken,
    credential: ticket.credential,
    projectId
  }
}

/** A second device: a new login registers a new device, as a second client would. */
async function openSecondDeviceSocket(): Promise<CloudConnection> {
  const client = new CloudConnectClient({ apiUrl: platform.url, tlsRejectUnauthorized: false })
  try {
    await client.login('zhangsan', 'Passw0rd!')
    const prepared = await client.prepareProjectLink(projectId)
    const identity = client.deviceIdentity()
    const claims = readTicketClaims(prepared.ticket.credential)
    if (claims.deviceToken === null) {
      throw new Error('ticket carries no device token')
    }
    return await connectCloudSession(
      cloud.endpoint,
      cloud.serverPublicKeyB64,
      {
        accessToken: '',
        deviceId: identity.deviceId,
        devicePubKey: client.devicePubKeyB64,
        deviceKeys: identity.keyPair,
        deviceToken: claims.deviceToken,
        credential: prepared.ticket.credential,
        projectId
      },
      5000,
      { tlsRejectUnauthorized: false }
    )
  } finally {
    client.close()
  }
}

async function waitForSocketCount(expected: number): Promise<number> {
  const read = () => admission.client?.activeSessionCount() ?? -1
  const deadline = Date.now() + 5000
  let value = read()
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    value = read()
  }
  return value
}

describe('入口链会话槽（真实平台 + 真实 TLS Runtime + 真实 PTY）', () => {
  it('W9A6-1 同一设备的入口链多路连接并存，终端建立且输入回显可达', async () => {
    // Socket 1 is live already: the project socket `ensureWorkspace` left open.
    const chunks: string[] = []
    const terminalSocket = await openEntrySocket((event) => {
      const chunk = readString(event, 'chunk')
      if (readString(event, 'type') === 'data' && chunk !== null) {
        chunks.push(chunk)
      }
    })
    const watchSocket = await openEntrySocket()
    // The socket that 4431-closed before the fix: one more short entry RPC.
    const rpcSocket = await openEntrySocket()
    expect(admission.client?.activeSessionCount()).toBe(4)

    // The A4 shape: the terminal is created on a short socket and its stream is
    // read on the terminal socket — separate connections, one session.
    const created = await rpcSocket.rpc('terminal.create', {
      worktree: `path:${workspacePath}`,
      title: 'w9a6-entry-pane'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const terminal =
      created.ok && created.result !== null
        ? readString(readField(created.result, 'terminal'), 'handle')
        : null
    if (terminal === null) {
      throw new Error('terminal handle missing')
    }
    // The stream stays open, so the call settles only when the host ends it.
    void terminalSocket.rpc('terminal.subscribe', { terminal })
    const typed = await terminalSocket.rpc('terminal.send', {
      terminal,
      text: `echo ${ECHO_MARKER}\r`
    })
    expect(typed.ok, JSON.stringify(typed)).toBe(true)
    const deadline = Date.now() + 15_000
    while (!chunks.some((chunk) => chunk.includes(ECHO_MARKER))) {
      if (Date.now() > deadline) {
        throw new Error(`terminal echo never arrived; saw ${JSON.stringify(chunks.slice(-5))}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    saveEvidence('w9a6-1-entry-burst.json', {
      socketsAdmitted: 4,
      terminalHandle: terminal,
      echoMarker: ECHO_MARKER,
      streamFrameCount: chunks.length
    })

    watchSocket.ws.close()
    rpcSocket.ws.close()
    terminalSocket.ws.close()
  }, 60_000)

  it('W9A6-2 第四台设备仍被 4431 关闭；释放一路后可再建立', async () => {
    // The desktop device holds session one; each login below registers another.
    const first = await openEntrySocket()
    const second = authenticated(await openSecondDeviceSocket(), 'the second device')
    const third = authenticated(await openSecondDeviceSocket(), 'the third device')
    const fourth = await openSecondDeviceSocket()
    expect(fourth.status).toBe('refused')
    if (fourth.status === 'refused') {
      expect(fourth.close.code).toBe(4431)
    }
    saveEvidence('w9a6-2-fourth-device.json', {
      fourthCloseCode: fourth.status === 'refused' ? fourth.close.code : null,
      sessionsBeforeRelease: admission.client?.activeSessionCount()
    })

    third.ws.close()
    expect(await waitForSocketCount(3), 'the released slot must free').toBe(3)
    const replacement = authenticated(await openSecondDeviceSocket(), 'the replacement device')
    replacement.ws.close()
    second.ws.close()
    first.ws.close()
  }, 60_000)
})
