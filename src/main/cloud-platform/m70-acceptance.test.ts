import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import {
  DEFAULT_INTERNAL_TOKEN,
  REPO_ROOT,
  connectCloudSession,
  openPlatformSession,
  startCloudRuntime,
  startPlatform,
  type CloudConnection,
  type CloudRuntime,
  type Platform
} from './cloud-session-e2e-harness'
import { createCloudAgentClient } from './cloud-agent-client'
import { installCloudAccessGuard } from '../startup/cloud-runtime-admission'
import type { DeviceRegistry } from '../runtime/device-registry'

/**
 * M70: AC-09 had a platform check but no test proving an existing session survives.
 * Real platform process, real runtime admission, real encrypted RPC.
 */

const EVIDENCE_DIR = join(REPO_ROOT, 'cloud-platform', 'evidence', 'm70-acceptance')

function saveEvidence(file: string, content: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, file), JSON.stringify(content, null, 2))
}

let platform: Platform
let client: ReturnType<typeof createCloudAgentClient>
let cloud: CloudRuntime
let adminToken = ''
let registry: DeviceRegistry | null = null

async function loginAdmin(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'Adm1n!',
      deviceName: 'm70-admin'
    })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('admin login failed')
  }
  return token
}

beforeAll(async () => {
  platform = await startPlatform()
  adminToken = await loginAdmin()
  client = createCloudAgentClient({
    apiUrl: platform.url,
    internalToken: DEFAULT_INTERNAL_TOKEN,
    hostId: 'host_dev001',
    hostName: 'dev-001'
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
          publicKeyB64: decision.payload.devicePubKey,
          project: decision.payload.project,
          permissions: decision.payload.perms,
          projectRoot: decision.payload.projectRoot,
          workspaceRoot: decision.payload.workspaceRoot
        })
      }
      return decision
    },
    connectionGate: client.connectionGate,
    userDataPrefix: 'orca-m70-maintenance-'
  })
  registry = cloud.runtime.getDeviceRegistry()
  installCloudAccessGuard(cloud.runtime, client)
})

afterAll(async () => {
  client?.stop()
  await cloud?.runtime.stop()
  await platform?.stop()
})

async function connect(): Promise<Extract<CloudConnection, { status: 'authenticated' }>> {
  const session = await openPlatformSession(platform, {
    projectKey: 'payment-service',
    deviceName: `m70-maint-${Math.random().toString(16).slice(2, 8)}`
  })
  const connection = await connectCloudSession(cloud.endpoint, cloud.serverPublicKeyB64, session)
  if (connection.status !== 'authenticated') {
    throw new Error(`expected authenticated, got close ${connection.close.code}`)
  }
  return connection
}

describe('M70 AC-09 主机维护模式', () => {
  it('新连接被 409 HOST_MAINTENANCE 拒绝，已建立会话 RPC 继续可用', async () => {
    const connection = await connect()
    try {
      const before = await connection.rpc('status.get')
      expect(before.ok).toBe(true)

      const entered = await fetch(`${platform.url}/v1/hosts/host_dev001/maintenance`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({ enabled: true, reason: 'M70 内核升级' })
      })
      expect(entered.status).toBe(200)

      const refused = await openPlatformSession(platform, {
        projectKey: 'payment-service',
        deviceName: 'm70-maint-refused'
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      expect(refused).toContain('HOST_MAINTENANCE')

      const after = await connection.rpc('status.get')
      expect(after.ok).toBe(true)

      saveEvidence('ac-09-maintenance.json', {
        before,
        maintenanceStatus: entered.status,
        newConnectionError: refused,
        after,
        existingSessionSurvived: after.ok
      })
    } finally {
      connection.ws.close()
      await fetch(`${platform.url}/v1/hosts/host_dev001/maintenance`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify({ enabled: false })
      })
    }
  }, 40_000)
})
