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
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../shared/terminal-stream-protocol'
import {
  REPO_ROOT,
  connectCloudSession,
  makeSelfSignedTls,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type Platform
} from './cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { CloudConnectClient } from './cloud-connect-client'
import { readTicketClaims } from './cloud-connect-response'
import { installRealPtyController } from './cloud-terminal-e2e-fixture'
import { ensureCloudWorkspace } from './cloud-workspace-ensure'
import { TERMINAL_MULTIPLEX_WORKSPACE_SCOPE_ERROR } from './cloud-terminal-multiplex-boundary'

/**
 * W9A-7: the desktop workspace terminal pane drives `terminal.multiplex`, so a
 * cloud session has to get that transport — with the workspace boundary moved
 * into it. These drive the real stack (platform + TLS runtime + real PTY) with
 * real binary frames: an in-workspace subscribe must carry a live echo, and a
 * subscribe naming the shared checkout's PTY must be refused and audited.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'w9a7-multiplex')
const PROJECT_KEY = 'multiplex-scope-project'
const ECHO_MARKER = 'ORCA_W9A7_MULTIPLEX_ECHO_OK'
const IN_SCOPE_STREAM = 7
const OUT_OF_SCOPE_STREAM = 3

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), `${JSON.stringify(content, null, 2)}\n`)
}

type AuditEvent = { eventType: string; method?: string; denial?: string; reason?: string }

let platform: Platform
let admission: CloudRuntimeAdmission
let service: OrcaRuntimeService
let cloudRuntime: { stop: () => Promise<void> } | null = null
let desktop: CloudConnectClient
let endpoint = ''
let serverPublicKeyB64 = ''
let projectId = ''
let workspacePath = ''
let sharedCheckoutHandle = ''
let auditEvents: AuditEvent[] = []

beforeAll(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orca-cloud-multiplex-scope-')))
  const projectRoot = join(base, 'payment-service')
  mkdirSync(projectRoot, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: projectRoot })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: projectRoot })
  writeFileSync(join(projectRoot, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: projectRoot })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: projectRoot })

  const dataDir = mkdtempSync(join(tmpdir(), 'orca-cloud-multiplex-scope-data-'))
  installFakeAppEnvironment({ getPath: () => dataDir })
  const store = createSqliteTestStore(Store, { dataFile: join(dataDir, 'orca-data.json') })
  store.addRepo({
    id: 'repo-multiplex-scope',
    path: projectRoot,
    displayName: 'payment-service',
    badgeColor: 'gray',
    addedAt: 1
  })
  store.updateSettings({ workspaceDir: join(base, 'host-workspaces') })
  store.flushOrThrow()
  service = new OrcaRuntimeService(store)
  installRealPtyController(service)

  platform = await startPlatform()
  const admin = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'multiplex-scope-admin'
    })
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
      ORCA_CLOUD_HOST_NAME: 'dev-multiplex-scope',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-multiplex-scope-host-')) }
  )
  if (!started) {
    throw new Error('cloud admission not enabled')
  }
  admission = started
  await admission.ready

  const cloud = await startCloudRuntime({
    admission: admission.admission,
    connectionGate: admission.connectionGate,
    userDataPrefix: 'orca-cloud-multiplex-scope-',
    service,
    tls: makeSelfSignedTls('dev-multiplex-scope'),
    methods: [...ALL_RPC_METHODS, ...MANAGED_WORKTREE_METHODS]
  })
  admission.bindRuntime(cloud.runtime)
  await admission.client!.refresh()
  // Mirrors attachCloudRuntime's production wiring; captured locally so the test
  // can prove a boundary refusal reached the security log.
  cloud.runtime.setCloudHostAudit((event) => {
    auditEvents.push({
      eventType: event.eventType,
      method: event.method,
      denial: event.denial,
      reason: event.reason
    })
  })
  cloudRuntime = cloud.runtime
  endpoint = cloud.endpoint
  serverPublicKeyB64 = cloud.serverPublicKeyB64

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

  // The out-of-bounds target: the host's own shell in the shared checkout, owned
  // by the host desktop (owner scope), outside the ticket's workspace root.
  const shared = await service.createTerminal(`path:${projectRoot}`, {
    title: 'w9a7-shared-checkout'
  })
  sharedCheckoutHandle = shared.handle
}, 60_000)

afterAll(async () => {
  desktop?.close()
  admission?.client?.stop()
  await cloudRuntime?.stop()
  await platform?.stop()
  await closeTestStores()
})

/** Another connection of the signed-in device: a fresh ticket, the entry-chain shape. */
async function openEntrySocket(
  transport: {
    onStreamEvent?: (result: unknown) => void
    onBinaryFrame?: (bytes: Uint8Array<ArrayBufferLike>) => void
  } = {}
): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const prepared = await desktop.prepareProjectLink(projectId)
  const identity = desktop.deviceIdentity()
  const claims = readTicketClaims(prepared.ticket.credential)
  if (claims.deviceToken === null) {
    throw new Error('ticket carries no device token')
  }
  const connection = await connectCloudSession(
    endpoint,
    serverPublicKeyB64,
    {
      accessToken: '',
      deviceId: identity.deviceId,
      devicePubKey: desktop.devicePubKeyB64,
      deviceKeys: identity.keyPair,
      deviceToken: claims.deviceToken,
      credential: prepared.ticket.credential,
      projectId
    },
    5000,
    { tlsRejectUnauthorized: false, ...transport }
  )
  if (connection.status !== 'authenticated') {
    throw new Error(`entry socket refused: ${JSON.stringify(connection.close)}`)
  }
  return connection
}

function subscribeFrame(streamId: number, terminal: string): Uint8Array<ArrayBufferLike> {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Subscribe,
    streamId: 0,
    seq: 1,
    payload: encodeTerminalStreamJson({
      streamId,
      terminal,
      client: { id: 'w9a7-desktop', type: 'desktop' },
      viewport: { cols: 120, rows: 40 }
    })
  })
}

function inputFrame(streamId: number, text: string): Uint8Array<ArrayBufferLike> {
  return encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Input,
    streamId,
    seq: 0,
    payload: encodeTerminalStreamText(text)
  })
}

/** Human-readable view of the binary frames a stream produced, for failures and evidence. */
function describeFrames(frames: Uint8Array<ArrayBufferLike>[]): { opcode: number; text: string }[] {
  return frames.flatMap((bytes) => {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return [{ opcode: -1, text: '<undecodable>' }]
    }
    return [{ opcode: frame.opcode, text: decodeTerminalStreamText(frame.payload).slice(0, 400) }]
  })
}

async function waitFor(probe: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe()) {
    if (Date.now() > deadline) {
      throw new Error(message)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('云会话的 terminal.multiplex（真实平台 + 真实 TLS Runtime + 真实 PTY）', () => {
  it('W9A7-1 工作区内订阅放行：信封 ready、快照帧到达、输入回显经流返回', async () => {
    const events: unknown[] = []
    const frames: Uint8Array<ArrayBufferLike>[] = []
    const socket = await openEntrySocket({
      onStreamEvent: (result) => events.push(result),
      onBinaryFrame: (bytes) => frames.push(bytes)
    })

    // The envelope W9A-6 saw refused (`forbidden: not available to cloud sessions`).
    void socket.rpc('terminal.multiplex', {})
    await waitFor(
      () => events.some((event) => readString(event, 'type') === 'ready'),
      'the multiplex envelope never became ready',
      10_000
    )

    const created = await socket.rpc('terminal.create', {
      worktree: `path:${workspacePath}`,
      title: 'w9a7-multiplex-pane'
    })
    expect(created.ok, JSON.stringify(created)).toBe(true)
    const terminal =
      created.ok && created.result !== null
        ? readString(readField(created.result, 'terminal'), 'handle')
        : null
    if (terminal === null) {
      throw new Error('terminal handle missing')
    }

    socket.sendBinaryFrame(subscribeFrame(IN_SCOPE_STREAM, terminal))
    await waitFor(
      () =>
        frames.some(
          (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.SnapshotStart
        ),
      `no snapshot arrived for the in-scope subscribe; saw ${JSON.stringify(describeFrames(frames))}`
    )

    socket.sendBinaryFrame(inputFrame(IN_SCOPE_STREAM, `echo ${ECHO_MARKER}\r`))
    await waitFor(
      () =>
        frames.some((bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          return (
            frame?.opcode === TerminalStreamOpcode.Output &&
            decodeTerminalStreamText(frame.payload).includes(ECHO_MARKER)
          )
        }),
      'the echo never came back over the multiplex stream'
    )

    saveEvidence('w9a7-1-in-scope-multiplex.json', {
      terminalHandle: terminal,
      streamId: IN_SCOPE_STREAM,
      frameCount: frames.length,
      opcodes: describeFrames(frames).map((entry) => entry.opcode),
      echoMarker: ECHO_MARKER
    })
    socket.ws.close()
  }, 60_000)

  it('W9A7-2 跨工作区 PTY 目标被拒：流错误 + 流结束 + path_denied 审计', async () => {
    const events: unknown[] = []
    const frames: Uint8Array<ArrayBufferLike>[] = []
    const auditBefore = auditEvents.length
    const socket = await openEntrySocket({
      onStreamEvent: (result) => events.push(result),
      onBinaryFrame: (bytes) => frames.push(bytes)
    })
    void socket.rpc('terminal.multiplex', {})
    await waitFor(
      () => events.some((event) => readString(event, 'type') === 'ready'),
      'the multiplex envelope never became ready',
      10_000
    )

    socket.sendBinaryFrame(subscribeFrame(OUT_OF_SCOPE_STREAM, sharedCheckoutHandle))
    await waitFor(
      () => events.some((event) => readString(event, 'type') === 'end'),
      `the out-of-scope subscribe was not ended; frames: ${JSON.stringify(describeFrames(frames))}`
    )
    const errorText = describeFrames(frames)
      .filter((entry) => entry.opcode === TerminalStreamOpcode.Error)
      .map((entry) => entry.text)
      .join('')
    expect(errorText).toBe(TERMINAL_MULTIPLEX_WORKSPACE_SCOPE_ERROR)
    // No snapshot may leak for a stream the boundary refused.
    expect(
      frames.some(
        (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.SnapshotStart
      )
    ).toBe(false)

    const denial = auditEvents
      .slice(auditBefore)
      .find((event) => event.method === 'terminal.multiplex')
    expect(denial, 'the boundary refusal must reach the security audit').toMatchObject({
      eventType: 'path_denied',
      denial: 'PATH_OUTSIDE_ROOT'
    })

    saveEvidence('w9a7-2-cross-workspace-denied.json', {
      targetedHandle: sharedCheckoutHandle,
      streamId: OUT_OF_SCOPE_STREAM,
      streamError: errorText,
      audit: denial
    })
    socket.ws.close()
  }, 60_000)
})
