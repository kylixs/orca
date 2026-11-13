import { describe, expect, it } from 'vitest'
import type { CloudConnectionEvent } from '../../shared/cloud-platform-ipc'
import {
  CloudConnectClient,
  type CloudConnectOptions,
  type CloudConnectTicket,
  type CloudDeviceIdentity,
  type CloudProject,
  type CloudRpcResult
} from './cloud-connect-client'
import { CloudSessionService } from './cloud-session-service'

/**
 * M53 routing contract: one platform login, one socket per project. These use a
 * fake factory so each call can be attributed to the client it reached.
 */

const SESSION_IDENTITY: CloudDeviceIdentity = {
  accessToken: 'access-token',
  deviceId: 'device-1',
  keyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) }
}

const PROJECTS: CloudProject[] = [
  {
    id: 'project-a',
    key: 'alpha',
    name: 'Alpha',
    hostName: 'dev-host',
    hostStatus: 'online',
    permissions: ['open'],
    status: 'ready',
    provisioningError: null
  },
  {
    id: 'project-b',
    key: 'beta',
    name: 'Beta',
    hostName: 'dev-host',
    hostStatus: 'online',
    permissions: ['open'],
    status: 'ready',
    provisioningError: null
  }
]

function ticketFor(projectId: string): CloudConnectTicket {
  return {
    credential: 'header.payload.signature',
    expiresIn: 300,
    host: {
      id: 'host-1',
      name: 'dev-host',
      fingerprint: 'fingerprint',
      tlsFingerprint: 'tls',
      e2eePublicKeyB64: '',
      capabilities: ['pty']
    },
    endpoints: { direct: [], relay: [] },
    workspace: {
      projectRoot: `/srv/${projectId}`,
      workspaceRoot: `/srv/${projectId}/.orca-worktrees/zhangsan`,
      defaultBranch: 'main'
    }
  }
}

class FakeClient extends CloudConnectClient {
  readonly identityUsed: CloudDeviceIdentity | undefined
  readonly rpcCalls: { method: string; params: Record<string, unknown> }[] = []
  closed = false
  private activeProjectId = ''
  private dropListener: ((code: number, reason: string) => void) | null = null

  constructor(options: CloudConnectOptions, identity?: CloudDeviceIdentity) {
    super(options, identity)
    this.identityUsed = identity
  }

  override deviceIdentity(): CloudDeviceIdentity {
    return this.identityUsed ?? SESSION_IDENTITY
  }

  override get currentDeviceId(): string {
    return this.deviceIdentity().deviceId
  }

  override get ticketDevicePubKey(): string | null {
    return 'shared-device-pub-key'
  }

  override async login(): Promise<{ displayName: string; permissions: string[] }> {
    return { displayName: '张伟', permissions: ['open'] }
  }

  override async listProjects(): Promise<CloudProject[]> {
    return PROJECTS
  }

  override async openProject(
    projectId: string
  ): Promise<{ route: 'direct' | 'relay'; ticket: CloudConnectTicket }> {
    this.activeProjectId = projectId
    return { route: 'direct', ticket: ticketFor(projectId) }
  }

  override rpc(method: string, params: Record<string, unknown> = {}): Promise<CloudRpcResult> {
    this.rpcCalls.push({ method, params })
    return Promise.resolve({ ok: true, result: { projectId: this.activeProjectId, method } })
  }

  override close(): void {
    this.closed = true
  }

  override onClose(listener: (code: number, reason: string) => void): void {
    this.dropListener = listener
  }

  /** Simulates the host dropping this socket. */
  drop(code: number, reason: string): void {
    this.dropListener?.(code, reason)
  }
}

type Harness = {
  session: CloudSessionService
  created: FakeClient[]
}

function makeHarness(): Harness {
  const created: FakeClient[] = []
  const session = new CloudSessionService(
    { apiUrl: 'http://platform.invalid' },
    {
      createClient: (options, identity) => {
        const client = new FakeClient(options, identity)
        created.push(client)
        return client
      }
    }
  )
  return { session, created }
}

async function signedIn(): Promise<Harness> {
  const harness = makeHarness()
  await harness.session.login('zhangsan', 'Passw0rd!')
  return harness
}

describe('云端会话多项目路由（伪造客户端）', () => {
  it('打开两个项目后各自 RPC 命中自己的客户端', async () => {
    const { session, created } = await signedIn()
    expect((await session.openProject('project-a')).ok).toBe(true)
    expect((await session.openProject('project-b')).ok).toBe(true)
    // created[0] is the platform session; the project sockets follow in order.
    const clientA = created[1]
    const clientB = created[2]
    expect(clientA.closed).toBe(false)
    expect(clientB.closed).toBe(false)

    const fromA = await session.rpc('status.get', {}, 'project-a')
    const fromB = await session.rpc('status.get', {}, 'project-b')
    expect(fromA).toEqual({ ok: true, result: { projectId: 'project-a', method: 'status.get' } })
    expect(fromB).toEqual({ ok: true, result: { projectId: 'project-b', method: 'status.get' } })
    expect(clientA.rpcCalls).toEqual([{ method: 'status.get', params: {} }])
    expect(clientB.rpcCalls).toEqual([{ method: 'status.get', params: {} }])

    // Both sockets forked the one registered device identity.
    expect(clientA.identityUsed).toBe(SESSION_IDENTITY)
    expect(clientB.identityUsed).toBe(SESSION_IDENTITY)
    expect(session.connectionIdentities()).toEqual([
      { projectId: 'project-a', route: 'direct', devicePubKey: 'shared-device-pub-key' },
      { projectId: 'project-b', route: 'direct', devicePubKey: 'shared-device-pub-key' }
    ])
  })

  it('关闭一个项目不影响另一个，重新打开仍复用设备身份', async () => {
    const { session, created } = await signedIn()
    await session.openProject('project-a')
    await session.openProject('project-b')
    const clientA = created[1]
    const clientB = created[2]

    expect(session.closeProject('project-a')).toEqual({ ok: true })
    expect(clientA.closed).toBe(true)
    expect(clientB.closed).toBe(false)
    expect(session.isProjectConnected('project-a')).toBe(false)
    expect(session.isProjectConnected('project-b')).toBe(true)
    expect(await session.rpc('status.get', {}, 'project-a')).toEqual({
      ok: false,
      code: 'NOT_CONNECTED'
    })
    expect((await session.rpc('status.get', {}, 'project-b')).ok).toBe(true)

    expect((await session.openProject('project-a')).ok).toBe(true)
    expect(created[3].identityUsed).toBe(SESSION_IDENTITY)
  })

  it('登出关闭全部连接并清空会话', async () => {
    const { session, created } = await signedIn()
    await session.openProject('project-a')
    await session.openProject('project-b')

    expect(session.logout().status).toBe('signed-out')
    expect(created[1].closed).toBe(true)
    expect(created[2].closed).toBe(true)
    expect(session.connectedProjectIds).toEqual([])
    expect(await session.rpc('status.get', {}, 'project-a')).toEqual({
      ok: false,
      code: 'NOT_SIGNED_IN'
    })
  })

  it('断线事件只标记对应项目，另一个仍可继续 RPC', async () => {
    const { session, created } = await signedIn()
    await session.openProject('project-a')
    await session.openProject('project-b')
    const events: CloudConnectionEvent[] = []
    session.onConnectionChanged((event) => events.push(event))

    created[1].drop(4403, 'session_revoked')

    expect(events).toEqual([
      { projectId: 'project-a', route: 'direct', closeCode: 4403, reason: 'session_revoked' }
    ])
    expect(session.isProjectConnected('project-a')).toBe(false)
    expect(session.isProjectConnected('project-b')).toBe(true)
    expect((await session.rpc('status.get', {}, 'project-b')).ok).toBe(true)
  })

  it('主动关闭不产生断线事件', async () => {
    const { session } = await signedIn()
    await session.openProject('project-a')
    const events: CloudConnectionEvent[] = []
    session.onConnectionChanged((event) => events.push(event))

    session.closeProject('project-a')
    expect(events).toEqual([])
  })
})
