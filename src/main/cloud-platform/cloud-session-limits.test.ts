import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DeviceRegistry } from '../runtime/device-registry'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { createCloudAgentClient } from './cloud-agent-client'
import { createCloudSessionLimits } from './cloud-session-limits'
import {
  DEFAULT_INTERNAL_TOKEN,
  REPO_ROOT,
  connectCloudSession,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'

/**
 * Design §8.4: at most 3 live sessions per user per project and 32 per host.
 * The cap has to be enforced where the sockets are — the platform never sees
 * them — so these cases drive a real runtime, real tickets, and real handshakes.
 * A session is one client device (every ticket it mints carries its deviceId),
 * not one socket; the pure-accounting cases below pin that grouping.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm33-session-limits')

/**
 * W9A-6: the §8.4 session is the client device, not the socket. One entry chain
 * holds several sockets (project socket, one per stream, one per short RPC), all
 * minted from one device, so they must fit inside a single session slot — while
 * a fourth device and an unbounded fan-out stay refused.
 */
describe('会话槽按逻辑会话（设备）记账，socket 只受散发上限约束', () => {
  const user = 'user:zhangsan'
  const project = 'proj_payment'
  const socket = (device: string, token: string) => ({ user, project, token, device })

  it('W9A6-U1 同一设备的多条 socket 记 1 个会话：入口链并发连接互不挤占', () => {
    const limits = createCloudSessionLimits({ perDeviceSockets: 4 })
    for (const token of ['t-project', 't-terminal', 't-watch', 't-rpc']) {
      expect(limits.tryOpen(socket('dev-desktop', token))).toBe(true)
    }
    expect(limits.activeSessionCountFor(user, project)).toBe(1)
    expect(limits.activeFor(user, project)).toBe(4)
  })

  it('W9A6-U2 第 4 台设备仍被拒绝；释放一路后恢复', () => {
    const limits = createCloudSessionLimits()
    for (const device of ['dev-a', 'dev-b', 'dev-c']) {
      expect(limits.tryOpen(socket(device, `t-${device}`))).toBe(true)
    }
    expect(limits.tryOpen(socket('dev-d', 't-dev-d'))).toBe(false)
    expect(limits.activeSessionCountFor(user, project)).toBe(3)
    limits.release('t-dev-b')
    expect(limits.tryOpen(socket('dev-d', 't-dev-d'))).toBe(true)
    expect(limits.activeSessionCountFor(user, project)).toBe(3)
  })

  it('W9A6-U3 单设备散发超上限仍拒绝，与设备数无关', () => {
    const limits = createCloudSessionLimits({ perDeviceSockets: 2 })
    expect(limits.tryOpen(socket('dev-a', 't-1'))).toBe(true)
    expect(limits.tryOpen(socket('dev-a', 't-2'))).toBe(true)
    expect(limits.tryOpen(socket('dev-a', 't-3'))).toBe(false)
    // A refused socket took no slot, so the next open is not penalised.
    expect(limits.activeFor(user, project)).toBe(2)
    limits.release('t-1')
    expect(limits.tryOpen(socket('dev-a', 't-3'))).toBe(true)
  })

  it('W9A6-U4 同 token 重开替换不叠占；主机上限仍按 socket 计', () => {
    const limits = createCloudSessionLimits({ perDeviceSockets: 4 })
    expect(limits.tryOpen(socket('dev-a', 't-1'))).toBe(true)
    expect(limits.tryOpen(socket('dev-a', 't-1'))).toBe(true)
    expect(limits.activeFor(user, project)).toBe(1)

    const hostBounded = createCloudSessionLimits({ perHost: 2, perDeviceSockets: 4 })
    expect(hostBounded.tryOpen(socket('dev-a', 'h-1'))).toBe(true)
    expect(hostBounded.tryOpen(socket('dev-b', 'h-2'))).toBe(true)
    expect(hostBounded.tryOpen(socket('dev-c', 'h-3'))).toBe(false)
    expect(hostBounded.activeCount()).toBe(2)
  })
})

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

async function waitForCount(read: () => number, expected: number): Promise<number> {
  const deadline = Date.now() + 5000
  let value = read()
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    value = read()
  }
  return value
}

/** Production wiring: caps default to the design values. */
describe('每用户每项目并发上限 3（真实平台 + 真实 Runtime）', () => {
  let platform: Platform
  let admission: CloudRuntimeAdmission
  let cloud: CloudRuntime

  beforeAll(async () => {
    platform = await startPlatform()
    const started = startCloudRuntimeAdmission({
      ORCA_CLOUD_API_URL: platform.url,
      ORCA_CLOUD_INTERNAL_TOKEN: DEFAULT_INTERNAL_TOKEN,
      ORCA_CLOUD_HOST_ID: 'host_dev001',
      ORCA_CLOUD_HOST_NAME: 'dev-001'
    })
    if (!started) {
      throw new Error('cloud admission not enabled')
    }
    // Poll-mode contract: env identity, client live immediately, no enrolment round-trip.
    expect(started.client).not.toBeNull()
    admission = started
    const client = started.client
    if (!client) {
      throw new Error('cloud client missing')
    }
    await client.refresh()
    cloud = await startCloudRuntime({
      admission: started.admission,
      connectionGate: started.connectionGate,
      userDataPrefix: 'orca-cloud-cap-'
    })
    started.bindRuntime(cloud.runtime)
  })

  afterAll(async () => {
    admission?.client?.stop()
    await cloud?.runtime.stop()
    await platform?.stop()
  })

  it('M33-1 三个会话可建立，第四个被 4431 关闭；关闭一个后新会话可建立', async () => {
    const live: WebSocket[] = []
    for (let index = 0; index < 3; index += 1) {
      const session = await openPlatformSession(platform, { deviceName: `cap-a-${index}` })
      const connection = await connectCloudSession(
        cloud.endpoint,
        cloud.serverPublicKeyB64,
        session
      )
      expect(connection.status, `session ${index} must be admitted`).toBe('authenticated')
      if (connection.status === 'authenticated') {
        live.push(connection.ws)
      }
    }
    const client = admission.client
    if (!client) {
      throw new Error('cloud client missing')
    }
    expect(client.activeSessionCount()).toBe(3)

    const fourth = await openPlatformSession(platform, { deviceName: 'cap-a-fourth' })
    const refused = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, fourth)
    expect(refused.status).toBe('refused')
    if (refused.status === 'refused') {
      expect(refused.close.code).toBe(4431)
    }
    expect(client.activeSessionCount()).toBe(3)

    live[0]?.close()
    expect(await waitForCount(() => client.activeSessionCount(), 2)).toBe(2)

    // The freed slot is reusable: the limit is on live sessions, not on tickets.
    const replacement = await openPlatformSession(platform, { deviceName: 'cap-a-replacement' })
    const accepted = await connectCloudSession(
      cloud.endpoint,
      cloud.serverPublicKeyB64,
      replacement
    )
    expect(accepted.status).toBe('authenticated')
    if (accepted.status === 'authenticated') {
      live.push(accepted.ws)
    }
    expect(client.activeSessionCount()).toBe(3)

    saveEvidence('m33-1-per-user-project.json', {
      liveAfterThree: 3,
      fourthCloseCode: refused.status === 'refused' ? refused.close.code : null,
      activeAfterRelease: 3
    })

    for (const ws of live) {
      ws.close()
    }
    expect(await waitForCount(() => client.activeSessionCount(), 0)).toBe(0)
  }, 40000)
})

/** Host cap with a lowered threshold so the case stays fast; the code path is the production one. */
describe('每主机并发上限（超限返回 4431，释放后可再连）', () => {
  const HOST_CAP = 4
  let platform: Platform
  let cloud: CloudRuntime
  let client: ReturnType<typeof createCloudAgentClient>
  let registry: DeviceRegistry | null = null

  beforeAll(async () => {
    platform = await startPlatform()
    client = createCloudAgentClient({
      apiUrl: platform.url,
      internalToken: DEFAULT_INTERNAL_TOKEN,
      hostId: 'host_dev001',
      hostName: 'dev-001',
      maxSessionsPerHost: HOST_CAP
    })
    await client.refresh()
    cloud = await startCloudRuntime({
      admission: (headers) => {
        const decision = client.admit(headers)
        if (decision.ok) {
          registry?.adoptCloudDevice({
            deviceId: decision.payload.deviceId,
            token: decision.payload.deviceToken,
            name: decision.payload.sub,
            publicKeyB64: decision.payload.devicePubKey
          })
        }
        return decision
      },
      connectionGate: client.connectionGate,
      userDataPrefix: 'orca-cloud-host-cap-'
    })
    registry = cloud.runtime.getDeviceRegistry()
  })

  afterAll(async () => {
    client?.stop()
    await cloud?.runtime.stop()
    await platform?.stop()
  })

  it('M33-2 两个用户各两路占满主机，第五路被 4431 关闭，释放一路后恢复', async () => {
    const live: WebSocket[] = []
    const identities = [
      { username: 'zhangsan', password: 'Passw0rd!' },
      { username: 'zhangsan', password: 'Passw0rd!' },
      { username: 'admin', password: 'Adm1n!' },
      { username: 'admin', password: 'Adm1n!' }
    ]
    for (const [index, identity] of identities.entries()) {
      const session = await openPlatformSession(platform, {
        ...identity,
        deviceName: `host-cap-${index}`
      })
      const connection = await connectCloudSession(
        cloud.endpoint,
        cloud.serverPublicKeyB64,
        session
      )
      expect(connection.status, `connection ${index} must be admitted`).toBe('authenticated')
      if (connection.status === 'authenticated') {
        live.push(connection.ws)
      }
    }
    expect(client.activeSessionCount()).toBe(HOST_CAP)

    const fifth = await openPlatformSession(platform, { deviceName: 'host-cap-fifth' })
    const refused = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, fifth)
    expect(refused.status).toBe('refused')
    if (refused.status === 'refused') {
      expect(refused.close.code).toBe(4431)
    }

    live[2]?.close()
    expect(await waitForCount(() => client.activeSessionCount(), HOST_CAP - 1)).toBe(HOST_CAP - 1)

    const recovered = await openPlatformSession(platform, { deviceName: 'host-cap-recovered' })
    const accepted = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, recovered)
    expect(accepted.status).toBe('authenticated')
    if (accepted.status === 'authenticated') {
      live.push(accepted.ws)
    }
    expect(client.activeSessionCount()).toBe(HOST_CAP)

    saveEvidence('m33-2-per-host.json', {
      hostCap: HOST_CAP,
      fifthCloseCode: refused.status === 'refused' ? refused.close.code : null,
      activeAfterRecovery: client.activeSessionCount()
    })

    for (const ws of live) {
      ws.close()
    }
    expect(await waitForCount(() => client.activeSessionCount(), 0)).toBe(0)
  }, 60000)
})
