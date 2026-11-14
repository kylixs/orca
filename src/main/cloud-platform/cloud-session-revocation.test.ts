import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERNAL_TOKEN,
  connectCloudSession,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'

/**
 * The full cloud path on the real runtime: the platform issues the ticket, the host
 * adopts the device from it, the E2EE handshake completes with the platform's
 * device token, and a platform-side revocation closes the live socket with 4403.
 */

let platform: Platform
let admission: CloudRuntimeAdmission
let cloud: CloudRuntime

function cloudClient(): NonNullable<CloudRuntimeAdmission['client']> {
  if (!admission.client) {
    throw new Error('cloud client missing')
  }
  return admission.client
}

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
  await cloudClient().refresh()
  cloud = await startCloudRuntime({
    admission: started.admission,
    connectionGate: started.connectionGate,
    userDataPrefix: 'orca-cloud-revoke-'
  })
  started.bindRuntime(cloud.runtime)
})

afterAll(async () => {
  admission?.client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

async function openLiveSession(): Promise<{
  session: Awaited<ReturnType<typeof openPlatformSession>>
  ws: WebSocket
  close: Promise<{ code: number; reason: string }>
}> {
  const session = await openPlatformSession(platform)
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected an authenticated session, got ${connection.close.code}`)
  }
  return { session, ws: connection.ws, close: connection.close }
}

describe('云端会话：设备登记与撤销关闭（真实平台 + 真实 Runtime）', () => {
  it('准入时用凭证里的设备身份登记到 DeviceRegistry，E2EE 握手成功', async () => {
    const { session, ws } = await openLiveSession()
    const adopted = cloud.runtime.getDeviceRegistry()?.getDevice(session.deviceId)
    expect(adopted?.token).toBe(session.deviceToken)
    ws.close()
  }, 20000)

  it('平台吊销设备后，已建立的连接在下一轮轮询内被 4403 关闭', async () => {
    const { session, ws, close } = await openLiveSession()
    expect(ws.readyState).toBe(WebSocket.OPEN)

    const revoke = await fetch(`${platform.url}/v1/me/devices/${session.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${session.accessToken}` }
    })
    expect(revoke.ok).toBe(true)

    await cloudClient().refresh()
    const closed = await Promise.race([
      close,
      new Promise<{ code: number; reason: string }>((resolve) =>
        setTimeout(() => resolve({ code: -1, reason: 'timeout' }), 5000)
      )
    ])
    expect(closed.code).toBe(4403)
  }, 25000)

  it('未被吊销的会话不因他人吊销而被关闭', async () => {
    const keep = await openLiveSession()
    const victim = await openLiveSession()

    await fetch(`${platform.url}/v1/me/devices/${victim.session.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${victim.session.accessToken}` }
    })
    await cloudClient().refresh()
    await new Promise((resolve) => setTimeout(resolve, 800))

    expect(keep.ws.readyState).toBe(WebSocket.OPEN)
    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(victim.ws.readyState)
    keep.ws.close()
    victim.ws.close()
  }, 25000)
})
