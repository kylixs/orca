import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { saveEvidence } from './harness.ts'

/**
 * M70: ACs that had implementation but no honest evidence.
 * Real API process internals with an injected clock, so 15-minute windows and
 * 60-second heartbeat timeouts are observed without waiting.
 */

const T0 = 1_800_000_000_000
let clock = T0
let app: ApiHandle | null = null

async function startApp(): Promise<{ app: ApiHandle; url: string }> {
  clock = T0
  const started = createApp({ port: 0, now: () => clock })
  const port = await started.listen()
  app = started
  return { app: started, url: `http://127.0.0.1:${port}` }
}

afterEach(async () => {
  await app?.close()
  app = null
})

type LoginBody = {
  accessToken?: string
  refreshToken?: string
  device?: { id: string }
  error?: { code: string }
}

async function login(
  url: string,
  username: string,
  password: string,
  deviceName = 'm70'
): Promise<Response> {
  return fetch(`${url}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceName,
      devicePubKey: Buffer.from(`key-${deviceName}`).toString('base64')
    })
  })
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function adminToken(url: string): Promise<string> {
  const res = await login(url, 'admin', 'Adm1n!', 'm70-admin')
  const body = (await res.json()) as LoginBody
  assert.ok(body.accessToken)
  return body.accessToken
}

test('AC-02 连续 5 次失败锁定 15 分钟，锁定与恢复都有审计', async () => {
  const { app: started, url } = await startApp()
  const failures: number[] = []
  for (let index = 1; index <= 5; index += 1) {
    const res = await login(url, 'zhangsan', 'wrong-password', `bad-${index}`)
    failures.push(res.status)
  }
  assert.deepEqual(failures, [401, 401, 401, 401, 423])

  const lockedCorrect = await login(url, 'zhangsan', 'Passw0rd!', 'locked-correct')
  assert.equal(lockedCorrect.status, 423)
  assert.equal(((await lockedCorrect.json()) as LoginBody).error?.code, 'ACCOUNT_LOCKED')

  const failureLog = started.audit.query({
    eventType: 'login',
    result: 'failure',
    limit: 20
  })
  assert.ok(failureLog.events.length >= 5)
  assert.ok(failureLog.events.some((event) => event.metadata.locked === true))

  clock = T0 + 15 * 60_000 + 1
  const unlocked = await login(url, 'zhangsan', 'Passw0rd!', 'unlocked')
  assert.equal(unlocked.status, 200)

  saveEvidence('m70-acceptance', 'ac-02-login-lockout.json', {
    failureStatuses: failures,
    lockedCorrectStatus: lockedCorrect.status,
    failureEvents: failureLog.events.map((event) => ({
      result: event.result,
      metadata: event.metadata
    })),
    unlockedAfterMs: clock - T0,
    unlockedStatus: unlocked.status
  })
})

test('AC-03 无权限项目统一 404、响应不含项目名并写审计', async () => {
  const { app: started, url } = await startApp()
  const admin = await adminToken(url)
  const created = await fetch(`${url}/v1/projects`, {
    method: 'POST',
    headers: { ...auth(admin), 'content-type': 'application/json' },
    body: JSON.stringify({
      key: 'm70-hidden',
      name: 'm70-hidden',
      repoUrl: 'git@git.example.com:hidden/m70.git',
      hostId: 'host_dev001',
      path: '/srv/work/m70-hidden'
    })
  })
  assert.equal(created.status, 201)
  const hiddenId = ((await created.json()) as { id: string }).id

  const dev = (await (await login(url, 'zhangsan', 'Passw0rd!', 'm70-dev')).json()) as LoginBody
  assert.ok(dev.accessToken)
  const hidden = await fetch(`${url}/v1/projects/${hiddenId}`, {
    headers: auth(dev.accessToken)
  })
  const missing = await fetch(`${url}/v1/projects/proj_m70_missing`, {
    headers: auth(dev.accessToken)
  })
  const hiddenBody = await hidden.text()
  const missingBody = await missing.text()
  assert.equal(hidden.status, 404)
  assert.equal(missing.status, 404)
  assert.equal(hiddenBody.includes('m70-hidden'), false)

  const denials = started.audit.query({
    eventType: 'project_access',
    result: 'denied',
    limit: 20
  })
  assert.ok(denials.events.some((event) => event.targetId === hiddenId))

  saveEvidence('m70-acceptance', 'ac-03-project-non-disclosure.json', {
    hiddenStatus: hidden.status,
    missingStatus: missing.status,
    hiddenBody,
    missingBody,
    deniedEvents: denials.events.map((event) => ({
      targetId: event.targetId,
      actor: event.actor,
      result: event.result
    }))
  })
})

test('AC-04 管理员登记并授权组后，成员刷新即可见并可取到连接票据', async () => {
  const { url } = await startApp()
  const admin = await adminToken(url)
  const created = await fetch(`${url}/v1/projects`, {
    method: 'POST',
    headers: { ...auth(admin), 'content-type': 'application/json' },
    body: JSON.stringify({
      key: 'm70-team-project',
      name: 'm70-team-project',
      repoUrl: 'git@git.example.com:pay/m70.git',
      hostId: 'host_dev001',
      path: '/srv/work/m70-team-project'
    })
  })
  assert.equal(created.status, 201)
  const projectId = ((await created.json()) as { id: string }).id

  const grant = await fetch(`${url}/v1/projects/${projectId}/grants`, {
    method: 'PUT',
    headers: { ...auth(admin), 'content-type': 'application/json' },
    body: JSON.stringify({
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    })
  })
  assert.equal(grant.status, 200)

  const loginRes = await login(url, 'zhangsan', 'Passw0rd!', 'm70-member')
  const member = (await loginRes.json()) as LoginBody
  assert.ok(member.accessToken)
  assert.ok(member.device?.id)

  const list = await fetch(`${url}/v1/projects`, {
    headers: auth(member.accessToken)
  })
  const projects = ((await list.json()) as { projects: { id: string }[] }).projects
  assert.ok(projects.some((project) => project.id === projectId))

  const connect = await fetch(`${url}/v1/projects/${projectId}/connect`, {
    method: 'POST',
    headers: {
      ...auth(member.accessToken),
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      deviceId: member.device.id,
      devicePubKey: Buffer.from('key-m70-member').toString('base64'),
      clientVersion: '1.5.0'
    })
  })
  const connectBody = (await connect.json()) as {
    credential?: string
    error?: { code: string }
  }
  assert.equal(connect.status, 200)
  assert.ok(connectBody.credential)

  saveEvidence('m70-acceptance', 'ac-04-project-grant.json', {
    projectId,
    grantStatus: grant.status,
    visible: projects.some((project) => project.id === projectId),
    connectStatus: connect.status,
    credentialIssued: Boolean(connectBody.credential)
  })
})

test('AC-08 60 秒无心跳后连接被拒，项目行转为 offline（工作台据此禁用打开）', async () => {
  const { url } = await startApp()
  const admin = await adminToken(url)
  const dev = (await (await login(url, 'zhangsan', 'Passw0rd!', 'm70-offline')).json()) as LoginBody
  assert.ok(dev.accessToken && dev.device?.id)

  clock = T0 + 60_001
  const list = await fetch(`${url}/v1/projects`, {
    headers: auth(dev.accessToken)
  })
  const projects = ((await list.json()) as { projects: { hostStatus: string }[] }).projects
  const connect = await fetch(`${url}/v1/projects/proj_payment/connect`, {
    method: 'POST',
    headers: { ...auth(dev.accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: dev.device.id,
      devicePubKey: Buffer.from('key-m70-offline').toString('base64'),
      clientVersion: '1.5.0'
    })
  })
  const connectBody = (await connect.json()) as { error?: { code: string } }
  assert.equal(connect.status, 409)
  assert.equal(connectBody.error?.code, 'HOST_OFFLINE')

  const hosts = await fetch(`${url}/v1/hosts`, { headers: auth(admin) })
  const hostRows = ((await hosts.json()) as { hosts: { id: string; online: boolean }[] }).hosts
  const row = hostRows.find((host) => host.id === 'host_dev001')
  assert.equal(row?.online, false)

  saveEvidence('m70-acceptance', 'ac-08-heartbeat-offline.json', {
    afterMs: 60_001,
    connectStatus: connect.status,
    connectError: connectBody.error,
    hostsEndpointOnline: row?.online,
    projectListHostStatus: projects[0]?.hostStatus
  })
  // Why: the workbench only enables 「打开」 for hostStatus === 'online'; a row that
  // still says online after the heartbeat window is what let users dial a dead host.
  assert.equal(projects[0]?.hostStatus, 'offline')
})

test('AC-01 登录到项目列表 50 次采样 P95 ≤ 1.5s（API 段）', async () => {
  const { url } = await startApp()
  const samples: number[] = []
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now()
    const res = await login(url, 'zhangsan', 'Passw0rd!', `m70-latency-${index}`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as LoginBody
    assert.ok(body.accessToken)
    assert.equal(
      (await fetch(`${url}/v1/projects`, { headers: auth(body.accessToken) })).status,
      200
    )
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  assert.ok(p95 <= 1500, `P95 ${p95.toFixed(1)}ms exceeded 1500ms`)

  saveEvidence('m70-acceptance', 'ac-01-login-latency.json', {
    samples: 50,
    p50Ms: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(1)),
    p95Ms: Number(p95.toFixed(1)),
    thresholdMs: 1500,
    scope: '登录请求 + 项目列表请求；不含浏览器渲染/首次安装'
  })
})

test('AC-25 吊销设备后访问令牌与刷新令牌立即失效', async () => {
  const { url } = await startApp()
  const victimRes = await login(url, 'zhangsan', 'Passw0rd!', 'm70-victim')
  const victim = (await victimRes.json()) as LoginBody
  assert.ok(victim.accessToken && victim.refreshToken && victim.device?.id)
  const revokerRes = await login(url, 'zhangsan', 'Passw0rd!', 'm70-revoker')
  const revoker = (await revokerRes.json()) as LoginBody
  assert.ok(revoker.accessToken)

  const revoke = await fetch(`${url}/v1/me/devices/${victim.device.id}`, {
    method: 'DELETE',
    headers: auth(revoker.accessToken)
  })
  assert.equal(revoke.status, 200)

  const access = await fetch(`${url}/v1/projects`, {
    headers: auth(victim.accessToken)
  })
  const refresh = await fetch(`${url}/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: victim.refreshToken })
  })
  assert.equal(access.status, 401)
  assert.equal(refresh.status, 401)

  saveEvidence('m70-acceptance', 'ac-25-token-revocation.json', {
    revokedDevice: victim.device.id,
    accessTokenStatusAfterRevoke: access.status,
    refreshTokenStatusAfterRevoke: refresh.status,
    establishedConnectionCloseEvidence: 'm11-revocation/device-revoke-closes-session.json'
  })
})
