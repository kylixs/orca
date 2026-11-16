import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readString } from '../../shared/json-fields'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  startCloudRuntimeAdmission,
  type CloudRuntimeAdmission
} from '../startup/cloud-runtime-admission'
import { makeSelfSignedTls, startPlatform, type Platform } from './cloud-platform-server-process'
import { CloudSessionService } from './cloud-session-service'

/**
 * The renderer-facing session. It must never expose a token or device key, and a
 * revoked connection must leave the UI state honest rather than "still open".
 */

let platform: Platform
let adminToken = ''
let admission: CloudRuntimeAdmission
let runtime: OrcaRuntimeRpcServer
let projectId = ''
let restrictedProjectId = ''

async function createProject(key: string, grants: string[]): Promise<string> {
  const res = await fetch(`${platform.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      key,
      name: key,
      hostId: admission.host()!.hostId,
      path: `/srv/work/${key}`
    })
  })
  expect(res.status).toBe(201)
  const id = readString(await res.json(), 'id')
  if (id === null) {
    throw new Error('project id missing')
  }
  await fetch(`${platform.url}/v1/projects/${id}/grants`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ subjectType: 'group', subjectId: 'team-payment', permissions: grants })
  })
  return id
}

beforeAll(async () => {
  platform = await startPlatform()
  const adminRes = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Adm1n!', deviceName: 'session-admin' })
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
      ORCA_CLOUD_HOST_NAME: 'dev-session',
      ORCA_CLOUD_ADVERTISE_HOST: '127.0.0.1'
    },
    { userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-session-host-')) }
  )!
  await admission.ready

  runtime = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-cloud-session-rt-')),
    enableWebSocket: true,
    wsPort: 0,
    webSocketTls: makeSelfSignedTls('dev-session'),
    upgradeAdmission: admission.admission
  })
  await runtime.start()
  admission.bindRuntime(runtime)
  await admission.client!.refresh()

  // This one may export; the other may not — the UI hint has to distinguish them.
  projectId = await createProject('session-svc', [
    'open',
    'terminal',
    'agent',
    'file:read',
    'file:write',
    'download'
  ])
  restrictedProjectId = await createProject('session-restricted', ['open', 'terminal'])
  // Grant changes revoke tickets issued up to now; mint later.
  await new Promise((r) => setTimeout(r, 1200))
})

afterAll(async () => {
  admission?.stop()
  await runtime?.stop()
  await platform?.stop()
})

function makeSession(): CloudSessionService {
  return new CloudSessionService({ apiUrl: platform.url, tlsRejectUnauthorized: false })
}

describe('云端会话服务（渲染进程可见面）', () => {
  it('登录后只暴露展示信息，不携带令牌或设备密钥', async () => {
    const session = makeSession()
    const state = await session.login('zhangsan', 'Passw0rd!')
    expect(state.status).toBe('signed-in')
    if (state.status !== 'signed-in') {
      throw new Error('expected signed-in state')
    }
    expect(state.displayName).toBe('张伟')
    const serialized = JSON.stringify(state)
    expect(serialized).not.toMatch(/accessToken|credential|devicePubKey|deviceToken|refreshToken/)
    expect(serialized).not.toContain('eyJ')
  })

  it('项目列表标记下载受限，未登录时读取报错', async () => {
    const signedOut = makeSession()
    await expect(signedOut.listProjects()).rejects.toMatchObject({ code: 'NOT_SIGNED_IN' })

    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const projects = await session.listProjects()
    expect(projects.find((p) => p.id === projectId)?.downloadRestricted).toBe(false)
    expect(projects.find((p) => p.id === restrictedProjectId)?.downloadRestricted).toBe(true)
  })

  it('打开项目返回选路与工作区根，RPC 走加密通道', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const opened = await session.openProject(projectId)
    expect(opened).toMatchObject({ ok: true, route: 'direct' })
    if (!opened.ok) {
      throw new Error('expected open to succeed')
    }
    expect(opened.workspaceRoot).toContain('/srv/work/session-svc')
    expect(opened.capabilities.length).toBeGreaterThan(0)

    const status = await session.rpc('status.get', {}, projectId)
    expect(status.ok).toBe(true)
    // The workspace view renders this reply; it must be a real object, not null.
    if (!status.ok) {
      throw new Error(`status.get failed: ${status.code}`)
    }
    expect(typeof status.result).toBe('object')
  }, 20000)

  it('主机公钥被替换：打开返回 FINGERPRINT_MISMATCH 与两个指纹，确认后才重新固定', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-m81-trust-'))
    const session = new CloudSessionService({
      apiUrl: platform.url,
      tlsRejectUnauthorized: false,
      userDataPath
    })
    await session.login('zhangsan', 'Passw0rd!')

    const first = await session.openProject(projectId)
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) {
      throw new Error('expected first open to succeed')
    }
    const realFingerprint = first.hostFingerprint
    expect(realFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)

    const host = admission.host()!
    const realKey = runtime.getE2EEPublicKey()
    const rogueKey = Buffer.alloc(32, 9).toString('base64')
    const advertise = (key: string): Promise<Response> =>
      fetch(`${platform.url}/v1/hosts/${host.hostId}/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${host.credential}` },
        body: JSON.stringify({ status: 'online', e2eePublicKeyB64: key })
      })

    // The platform now hands out a different host key (AC-29's substitution case).
    expect((await advertise(rogueKey)).status).toBe(200)
    session.closeProject(projectId)

    const refused = await session.openProject(projectId)
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      throw new Error('expected a refusal')
    }
    expect(refused.code).toBe('FINGERPRINT_MISMATCH')
    expect(refused.hostKey?.hostId).toBe(host.hostId)
    expect(refused.hostKey?.pinnedFingerprint).toBe(realFingerprint)
    expect(refused.hostKey?.seenFingerprint).not.toBe(realFingerprint)

    // Re-verification is explicit and consumes the pending key exactly once.
    expect(session.trustHostKey(host.hostId)).toEqual({ ok: true })
    expect(session.trustHostKey(host.hostId)).toEqual({ ok: false, code: 'HOST_KEY_NOT_PENDING' })

    // Back to the real key: the pin is now the rogue one, so this is a second
    // mismatch, and re-verifying again restores the original pin.
    expect((await advertise(realKey!)).status).toBe(200)
    const second = await session.openProject(projectId)
    expect(second.ok).toBe(false)
    if (second.ok) {
      throw new Error('expected a second refusal')
    }
    expect(second.hostKey?.pinnedFingerprint).toBe(refused.hostKey?.seenFingerprint)
    expect(second.hostKey?.seenFingerprint).toBe(realFingerprint)
    expect(session.trustHostKey(host.hostId)).toEqual({ ok: true })

    const reopened = await session.openProject(projectId)
    expect(reopened).toMatchObject({ ok: true })
    if (!reopened.ok) {
      throw new Error('expected reopen to succeed')
    }
    expect(reopened.hostFingerprint).toBe(realFingerprint)
  }, 60000)

  it('吊销后向渲染进程推送关闭事件，并清空当前项目', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    const opened = await session.openProject(projectId)
    expect(opened.ok).toBe(true)

    const events: { closeCode: number | null; reason: string | null; projectId: string | null }[] =
      []
    session.onConnectionChanged((event) =>
      events.push({ closeCode: event.closeCode, reason: event.reason, projectId: event.projectId })
    )

    const deviceId = session.currentDeviceId
    // The renderer never holds a token, so revocation comes from a separate
    // login by the same user — devices are per-user, not per-session.
    const revoke = await fetch(`${platform.url}/v1/me/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await userTokenForOwnDevice()}` }
    })
    expect(revoke.ok).toBe(true)
    await admission.client!.refresh()

    await new Promise((r) => setTimeout(r, 1500))
    expect(events.some((event) => event.closeCode === 4403)).toBe(true)
    expect(session.isProjectConnected(projectId)).toBe(false)
  }, 25000)

  it('返回工作台只关闭项目连接：会话仍在，可再次打开', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    expect((await session.openProject(projectId)).ok).toBe(true)
    expect((await session.rpc('status.get', {}, projectId)).ok).toBe(true)

    expect(session.closeProject(projectId)).toEqual({ ok: true })
    expect(await session.rpc('status.get', {}, projectId)).toEqual({
      ok: false,
      code: 'NOT_CONNECTED'
    })
    expect(session.getState().status).toBe('signed-in')

    // The token and device keys survived, so reopening needs no second login.
    const reopened = await session.openProject(projectId)
    expect(reopened.ok).toBe(true)
    expect((await session.rpc('status.get', {}, projectId)).ok).toBe(true)
  }, 25000)

  it('登出后状态回到未登录', async () => {
    const session = makeSession()
    await session.login('zhangsan', 'Passw0rd!')
    expect(session.getState().status).toBe('signed-in')
    expect(session.logout().status).toBe('signed-out')
    expect(await session.rpc('status.get', {}, projectId)).toEqual({
      ok: false,
      code: 'NOT_SIGNED_IN'
    })
  })
})

/** The device belongs to the session's own login; a fresh login sees it in its device list. */
async function userTokenForOwnDevice(): Promise<string> {
  const res = await fetch(`${platform.url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'zhangsan', password: 'Passw0rd!', deviceName: 'revoker' })
  })
  const token = readString(await res.json(), 'accessToken')
  if (token === null) {
    throw new Error('revoker login failed')
  }
  return token
}
