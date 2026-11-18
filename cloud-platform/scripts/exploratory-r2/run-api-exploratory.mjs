#!/usr/bin/env node
/**
 * Exploratory API probe for the cloud-dev-platform (read-only + reversible).
 *
 * Replays the case list in ./api-paths.md against a live platform and writes:
 *   cloud-platform/evidence/exploratory-r2/api.json       findings + summary
 *   cloud-platform/evidence/exploratory-r2/api-raw.json   every case + response
 *
 * Env:
 *   ORCA_LOCAL_ENV_ROOT       default ~/orca-local-env (holds tls/ca.pem)
 *   ORCA_LOCAL_PLATFORM_URL   default https://127.0.0.1:18787
 *   ORCA_R2_SKIP_TIMING=1     skip the 58s/62s handoff boundary sleeps
 *
 * Cleanup: every probe project is archived, every probe host revoked, and the
 * global policy is restored to its pre-run value. Revoked hosts/archived
 * projects remain in the in-memory store as inert records (documented).
 */
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const EVIDENCE_DIR = path.join(ROOT, 'cloud-platform/evidence/exploratory-r2')
const ENV_ROOT = process.env.ORCA_LOCAL_ENV_ROOT || path.join(os.homedir(), 'orca-local-env')
const BASE = process.env.ORCA_LOCAL_PLATFORM_URL || 'https://127.0.0.1:18787'
const CA = fs.readFileSync(path.join(ENV_ROOT, 'tls/ca.pem'))
const STAMP = Date.now().toString(36)
const SKIP_TIMING = process.env.ORCA_R2_SKIP_TIMING === '1'

const ADMIN = { username: 'admin', password: 'Adm1n!' }
const DEV = { username: 'zhangsan', password: 'Passw0rd!' }
const LIMITED = { username: 'lisi', password: 'Passw0rd!' }

const cases = []
const findings = []
const ctx = { temp: { projectIds: [], hostIds: [] } }
let baseline = null

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function brief(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return (text ?? '').replace(/\s+/g, ' ').slice(0, 360)
}

function request(method, pathname, { token, body, headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const base = new URL(BASE)
    const outgoing = { ...headers }
    if (token) outgoing.authorization = `Bearer ${token}`
    let payload
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      outgoing['content-type'] = outgoing['content-type'] ?? 'application/json'
      outgoing['content-length'] = Buffer.byteLength(payload)
    }
    const req = https.request(
      {
        host: base.hostname,
        port: base.port,
        method,
        path: pathname,
        headers: outgoing,
        ca: CA,
        timeout: timeoutMs
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          try {
            json = JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

async function login(account, extra = {}) {
  const res = await request('POST', '/v1/auth/login', {
    body: {
      username: account.username,
      password: account.password,
      deviceName: 'r2-probe',
      ...extra
    }
  })
  if (res.status !== 200 || !res.json?.accessToken) {
    throw new Error(`login ${account.username} failed: ${res.status} ${brief(res.text)}`)
  }
  return res.json
}

function record(caseRow, finding) {
  cases.push(caseRow)
  if (finding) findings.push(finding)
}

/**
 * Runs one probe and records both the case and (on mismatch) a finding.
 * `check` receives the response and returns true on the expected behaviour.
 */
async function probe({
  id,
  area,
  sev,
  method,
  pathname,
  token,
  body,
  headers,
  op,
  expected,
  check,
  note
}) {
  let res
  try {
    res = await request(method, pathname, { token, body, headers })
  } catch (error) {
    record(
      {
        id,
        area,
        method,
        path: pathname,
        status: null,
        expected,
        actual: `network error: ${error.message}`,
        ok: false,
        note
      },
      {
        id,
        level: sev,
        endpoint: `${method} ${pathname}`,
        operation: op,
        expected,
        actual: `network error: ${error.message}`,
        evidence: { requestBody: brief(body) },
        note
      }
    )
    return null
  }
  let ok = false
  let why = ''
  try {
    const verdict = check(res)
    ok = verdict === true || verdict?.ok === true
    why = verdict?.why ?? ''
  } catch (error) {
    why = `check error: ${error.message}`
  }
  const code = res.json?.error?.code ?? null
  record(
    {
      id,
      area,
      method,
      path: pathname,
      status: res.status,
      errorCode: code,
      expected,
      actual: ok
        ? 'matches'
        : `HTTP ${res.status}${code ? ` ${code}` : ''}${why ? ` (${why})` : ''}`,
      ok,
      note
    },
    ok
      ? null
      : {
          id,
          level: sev,
          endpoint: `${method} ${pathname}`,
          operation: op,
          expected,
          actual: `HTTP ${res.status}${code ? ` ${code}` : ''}${why ? ` — ${why}` : ''}`,
          evidence: { requestBody: brief(body), responseBody: brief(res.text) },
          note
        }
  )
  return res
}

const isStatus = (status) => (res) => res.status === status
const isError = (status, code) => (res) => res.status === status && res.json?.error?.code === code
const has = (fn) => (res) => {
  try {
    return fn(res) === true
  } catch {
    return false
  }
}

function manualCase({ id, area, sev, op, expected, actual, ok, note, request: reqInfo }) {
  record(
    { id, area, expected, actual: ok ? 'matches' : actual, ok, note },
    ok || sev === null
      ? null
      : {
          id,
          level: sev,
          endpoint: reqInfo?.endpoint ?? op,
          operation: op,
          expected,
          actual,
          evidence: { requestBody: brief(reqInfo?.body) },
          note
        }
  )
}

/**
 * The shared local platform may be touched by another operator/agent while the
 * probe runs. Wait (do not mutate) for the seed host to return to `online`
 * before phases whose expectations depend on it.
 */
async function waitForSeedHostOnline(label, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await request('GET', '/v1/hosts', { token: ctx.admin })
    const host = (res.json?.hosts ?? []).find((entry) => entry.id === ctx.hostDev02?.id)
    if (host?.online === true) return true
    if (Date.now() >= deadline) {
      manualCase({
        id: `ENV-${label}`,
        area: 'environment',
        sev: 'P3',
        op: `等待 dev-local-02 在线 (${label})`,
        expected: 'online',
        actual: `status=${host?.status} online=${host?.online}`,
        ok: false,
        note: '外部操作介入或宿主心跳中断，后续用例可能级联失败'
      })
      return false
    }
    await sleep(3000)
  }
}

async function refreshH1() {
  if (!ctx.h1.credential) return null
  return request('POST', `/v1/hosts/${ctx.h1.id}/heartbeat`, {
    token: ctx.h1.credential,
    body: { status: 'online', directAddrs: ['127.0.0.1:19999'] }
  })
}

function findProject(list, id) {
  return (list?.projects ?? []).find((project) => project.id === id)
}

async function main() {
  // ---------------------------------------------------------------- baseline
  const adminLogin = await login(ADMIN, { deviceName: 'r2-admin', devicePubKey: 'r2-admin-pub' })
  const devLogin = await login(DEV, { deviceName: 'r2-dev', devicePubKey: 'r2-dev-pub' })
  const limitedLogin = await login(LIMITED, { deviceName: 'r2-lisi', devicePubKey: 'r2-lisi-pub' })
  ctx.admin = adminLogin.accessToken
  ctx.dev = devLogin.accessToken
  ctx.lisi = limitedLogin.accessToken
  ctx.adminUserId = adminLogin.user.id
  ctx.devUserId = devLogin.user.id
  ctx.lisiUserId = limitedLogin.user.id
  ctx.lisiDeviceId = limitedLogin.device.id
  ctx.adminDeviceId = adminLogin.device.id
  ctx.adminDevicePubKey = 'r2-admin-pub'

  const projectsRes = await request('GET', '/v1/projects', { token: ctx.admin })
  const hostsRes = await request('GET', '/v1/hosts', { token: ctx.admin })
  const policyRes = await request('GET', '/v1/policies/download', { token: ctx.admin })
  baseline = {
    capturedAt: new Date().toISOString(),
    projects: projectsRes.json?.projects ?? [],
    hosts: hostsRes.json?.hosts ?? [],
    policy: policyRes.json ?? null
  }
  ctx.hostDev02 = baseline.hosts.find((host) => host.name === 'dev-local-02')
  ctx.hostDev03 = baseline.hosts.find((host) => host.name === 'dev-local-03')

  // ------------------------------------------------------------------- auth
  await probe({
    id: 'A1',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/login',
    body: {},
    op: '登录：缺全部字段',
    expected: '401 或 423（空账号锁定后），不得 500',
    check: (res) => res.status === 401 || res.status === 423
  })
  await probe({
    id: 'A2a',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/login',
    body: { username: DEV.username, password: 'wrong-password' },
    op: '登录：真实账号错误密码一次',
    expected: '401 INVALID_CREDENTIALS',
    check: isError(401, 'INVALID_CREDENTIALS')
  })
  await probe({
    id: 'A2b',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/login',
    body: { ...DEV, deviceName: 'r2-dev-again' },
    op: '登录：一次失败后正确登录应清零计数',
    expected: '200',
    check: isStatus(200)
  })
  const ghost = `r2-ghost-${STAMP}`
  const lockStatuses = []
  for (let i = 0; i < 5; i += 1) {
    const res = await request('POST', '/v1/auth/login', {
      body: { username: ghost, password: 'x' }
    })
    lockStatuses.push(res.status)
  }
  const sixth = await request('POST', '/v1/auth/login', {
    body: { username: ghost, password: 'x' }
  })
  manualCase({
    id: 'A3',
    area: 'auth',
    sev: 'P3',
    op: '登录锁定：不存在账号连续 5 次失败',
    expected: '前 4 次 401，第 5/6 次 423 ACCOUNT_LOCKED',
    actual: JSON.stringify({ first: lockStatuses, sixth: sixth.status }),
    ok:
      lockStatuses.slice(0, 4).every((s) => s === 401) &&
      lockStatuses[4] === 423 &&
      sixth.status === 423,
    request: { endpoint: 'POST /v1/auth/login', body: { username: ghost } }
  })
  await probe({
    id: 'A4',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/login',
    body: '{not-json',
    op: '登录：畸形 JSON',
    expected: '401 INVALID_CREDENTIALS 或 423（不得 500）',
    check: (res) => res.status === 401 || res.status === 423
  })
  await probe({
    id: 'A5',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/login',
    body: { username: '不存在的用户', password: 'x' },
    op: '登录：Unicode 用户名',
    expected: '401 或 423（重复运行锁定后），不得 500',
    check: (res) => res.status === 401 || res.status === 423
  })
  await probe({
    id: 'A6',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/login',
    body: { username: 'x'.repeat(5000), password: 'x' },
    op: '登录：超长用户名 5000',
    expected: '401 或 423（重复运行锁定后），不得 500',
    check: (res) => res.status === 401 || res.status === 423
  })

  const [concurrentA, concurrentB] = await Promise.all([
    request('POST', '/v1/auth/login', { body: { ...DEV, deviceName: 'r2-concurrent-a' } }),
    request('POST', '/v1/auth/login', { body: { ...DEV, deviceName: 'r2-concurrent-b' } })
  ])
  manualCase({
    id: 'A7',
    area: 'auth',
    sev: 'P2',
    op: '并发登录：同一开发者两个会话',
    expected: '两个 200，token 与 device 互异，互不撤销',
    actual: JSON.stringify({ a: concurrentA.status, b: concurrentB.status }),
    ok:
      concurrentA.status === 200 &&
      concurrentB.status === 200 &&
      concurrentA.json?.accessToken !== concurrentB.json?.accessToken &&
      concurrentA.json?.device?.id !== concurrentB.json?.device?.id
  })
  ctx.concurrentDev = concurrentA.json
  ctx.concurrentDevB = concurrentB.json

  const foreignDeviceLogin = await request('POST', '/v1/auth/login', {
    body: { ...DEV, deviceName: 'r2-foreign-device', deviceId: ctx.adminDeviceId }
  })
  manualCase({
    id: 'A8',
    area: 'auth',
    sev: 'P1',
    op: '登录：携带他人 deviceId',
    expected: '忽略外来设备，返回新设备且不改动 admin 设备',
    actual: `HTTP ${foreignDeviceLogin.status} device=${foreignDeviceLogin.json?.device?.id}`,
    ok:
      foreignDeviceLogin.status === 200 && foreignDeviceLogin.json?.device?.id !== ctx.adminDeviceId
  })
  const adminDevices = await request('GET', '/v1/me/devices', { token: ctx.admin })
  manualCase({
    id: 'A8b',
    area: 'auth',
    sev: 'P1',
    op: '登录后 admin 设备归属未被篡改',
    expected: 'admin 设备仍在 admin 名下',
    actual: JSON.stringify(adminDevices.json?.devices),
    ok: (adminDevices.json?.devices ?? []).some((device) => device.id === ctx.adminDeviceId)
  })
  const ownDeviceLogin = await request('POST', '/v1/auth/login', {
    body: { ...DEV, deviceName: 'r2-own-device', deviceId: ctx.concurrentDev.device.id }
  })
  manualCase({
    id: 'A9',
    area: 'auth',
    sev: 'P3',
    op: '登录：携带本人有效 deviceId',
    expected: '复用同一设备 id',
    actual: `HTTP ${ownDeviceLogin.status} device=${ownDeviceLogin.json?.device?.id}`,
    ok:
      ownDeviceLogin.status === 200 &&
      ownDeviceLogin.json?.device?.id === ctx.concurrentDev.device.id
  })

  const refreshLogin = await login(DEV, { deviceName: 'r2-refresh' })
  const refreshed = await request('POST', '/v1/auth/refresh', {
    body: { refreshToken: refreshLogin.refreshToken }
  })
  const refreshedMe = refreshed.json?.accessToken
    ? await request('GET', '/v1/me', { token: refreshed.json.accessToken })
    : null
  manualCase({
    id: 'A10',
    area: 'auth',
    sev: 'P3',
    op: 'refresh 正常流转',
    expected: '200 新 token，新 access 可用',
    actual: `HTTP ${refreshed.status} me=${refreshedMe?.status}`,
    ok: refreshed.status === 200 && refreshedMe?.status === 200
  })
  const replay = await request('POST', '/v1/auth/refresh', {
    body: { refreshToken: refreshLogin.refreshToken }
  })
  const revokedAccess = refreshed.json?.accessToken
    ? await request('GET', '/v1/me', { token: refreshed.json.accessToken })
    : null
  manualCase({
    id: 'A11',
    area: 'auth',
    sev: 'P2',
    op: 'refresh 旧 token 重放',
    expected: '401 SESSION_EXPIRED 且该会话被撤销（新 access 也失效）',
    actual: `replay=${replay.status}/${replay.json?.error?.code} newAccess=${revokedAccess?.status}`,
    ok:
      replay.status === 401 &&
      replay.json?.error?.code === 'SESSION_EXPIRED' &&
      revokedAccess?.status === 401
  })
  await probe({
    id: 'A12a',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/refresh',
    body: {},
    op: 'refresh：缺 refreshToken',
    expected: '401 SESSION_EXPIRED',
    check: isError(401, 'SESSION_EXPIRED')
  })
  await probe({
    id: 'A12b',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/refresh',
    body: { refreshToken: 12345 },
    op: 'refresh：错误类型',
    expected: '401 SESSION_EXPIRED',
    check: isError(401, 'SESSION_EXPIRED')
  })

  const logoutLogin = await login(DEV, { deviceName: 'r2-logout' })
  const logout = await request('POST', '/v1/auth/logout', { token: logoutLogin.accessToken })
  const afterLogout = await request('GET', '/v1/me', { token: logoutLogin.accessToken })
  const refreshAfterLogout = await request('POST', '/v1/auth/refresh', {
    body: { refreshToken: logoutLogin.refreshToken }
  })
  manualCase({
    id: 'A13',
    area: 'auth',
    sev: 'P3',
    op: '登出：access/refresh 立即失效',
    expected: 'logout 200，随后 me 401、refresh 401',
    actual: `${logout.status}/${afterLogout.status}/${refreshAfterLogout.status}`,
    ok: logout.status === 200 && afterLogout.status === 401 && refreshAfterLogout.status === 401
  })
  await probe({
    id: 'A13b',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/logout',
    op: '登出：无 token',
    expected: '200 幂等',
    check: isStatus(200)
  })

  const concurrentRefreshLogin = await login(DEV, { deviceName: 'r2-refresh-race' })
  const [refreshRaceA, refreshRaceB] = await Promise.all([
    request('POST', '/v1/auth/refresh', {
      body: { refreshToken: concurrentRefreshLogin.refreshToken }
    }),
    request('POST', '/v1/auth/refresh', {
      body: { refreshToken: concurrentRefreshLogin.refreshToken }
    })
  ])
  const raceStatuses = [refreshRaceA.status, refreshRaceB.status].sort()
  manualCase({
    id: 'A14',
    area: 'auth',
    sev: 'P2',
    op: '并发 refresh：同一 refreshToken 两路',
    expected: '恰好一个 200、一个 401（轮换原子）',
    actual: JSON.stringify(raceStatuses),
    ok: raceStatuses[0] === 200 && raceStatuses[1] === 401
  })
  await probe({
    id: 'A15',
    area: 'auth',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/auth/login',
    op: '登录端点的错误方法',
    expected: '404（或 405）',
    check: isStatus(404)
  })
  await probe({
    id: 'A16',
    area: 'auth',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/auth/login',
    body: { username: '', password: '' },
    op: '登录：空串账号密码',
    expected: '401 或 423（空账号锁定后）',
    check: (res) => res.status === 401 || res.status === 423
  })

  // ------------------------------------------------------------------ hosts
  // Token issuance.
  const tokenCreate = await request('POST', '/v1/hosts/tokens', { token: ctx.admin })
  manualCase({
    id: 'H1',
    area: 'hosts',
    sev: 'P3',
    op: '签发一次性宿主令牌',
    expected: '201 token + expiresIn=86400',
    actual: `HTTP ${tokenCreate.status} expiresIn=${tokenCreate.json?.expiresIn}`,
    ok:
      tokenCreate.status === 201 &&
      typeof tokenCreate.json?.token === 'string' &&
      tokenCreate.json?.expiresIn === 86400
  })
  await probe({
    id: 'H2',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/hosts/tokens',
    token: ctx.dev,
    op: '开发者签发宿主令牌',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  await probe({
    id: 'H3',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/hosts/tokens',
    op: '无会话签发宿主令牌',
    expected: '401 SESSION_EXPIRED',
    check: isError(401, 'SESSION_EXPIRED')
  })

  const h1Name = `r2-host-${STAMP}`
  const h1Root = `/tmp/exploratory-r2-${STAMP}`
  const h1Body = {
    name: h1Name,
    fingerprint: `probe:${STAMP}`,
    tlsFingerprint: `probe:tls:${STAMP}`,
    e2eePublicKeyB64: `probe-e2ee-${STAMP}`,
    orcaVersion: 'probe-0.0.1',
    protocolVersion: 3,
    networkZone: 'probe',
    directAddrs: ['127.0.0.1:19999'],
    runtimeCapabilities: ['pty'],
    projectsRoot: h1Root,
    projectDirs: ['seed-dir']
  }
  const h1Register = await request('POST', '/v1/hosts/register', {
    token: tokenCreate.json.token,
    body: h1Body
  })
  ctx.h1 = {
    id: h1Register.json?.hostId,
    name: h1Name,
    credential: h1Register.json?.credential
  }
  if (ctx.h1.id) ctx.temp.hostIds.push(ctx.h1.id)
  manualCase({
    id: 'H5',
    area: 'hosts',
    sev: 'P2',
    op: '注册合法测试宿主',
    expected: '201 hostId + credential + policyVersion',
    actual: `HTTP ${h1Register.status} hostId=${ctx.h1.id}`,
    ok: h1Register.status === 201 && Boolean(ctx.h1.id) && typeof ctx.h1.credential === 'string'
  })
  await probe({
    id: 'H6',
    area: 'hosts',
    sev: 'P2',
    method: 'POST',
    pathname: '/v1/hosts/register',
    token: tokenCreate.json.token,
    body: h1Body,
    op: '一次性注册令牌重复使用',
    expected: '401 HOST_TOKEN_INVALID',
    check: isError(401, 'HOST_TOKEN_INVALID')
  })
  await probe({
    id: 'H4',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/hosts/register',
    token: 'not-a-token',
    body: { name: `r2-bad-${STAMP}` },
    op: '注册：无效令牌',
    expected: '401 HOST_TOKEN_INVALID',
    check: isError(401, 'HOST_TOKEN_INVALID')
  })

  // Empty-name enrollment: a token alone must not mint an unnamed host.
  const emptyToken = (await request('POST', '/v1/hosts/tokens', { token: ctx.admin })).json?.token
  const emptyRegister = await request('POST', '/v1/hosts/register', { token: emptyToken, body: {} })
  const hostsAfterEmpty = await request('GET', '/v1/hosts', { token: ctx.admin })
  const emptyHost = (hostsAfterEmpty.json?.hosts ?? []).find((host) => host.name === '')
  if (emptyHost?.id) ctx.temp.hostIds.push(emptyHost.id)
  manualCase({
    id: 'H7',
    area: 'hosts',
    sev: 'P3',
    op: '注册：仅令牌、缺 name 等全部字段',
    expected: '400 拒绝（name 为必填业务标识）',
    actual: `HTTP ${emptyRegister.status} hostId=${emptyRegister.json?.hostId} name='' accepted=${Boolean(emptyHost)}`,
    ok: emptyRegister.status >= 400 && !emptyHost,
    request: { endpoint: 'POST /v1/hosts/register', body: {} }
  })

  // Malformed directAddrs: must be a 4xx and must not burn the one-time token.
  const burnToken = (await request('POST', '/v1/hosts/tokens', { token: ctx.admin })).json?.token
  const burnRegister = await request('POST', '/v1/hosts/register', {
    token: burnToken,
    body: { name: `r2-burn-${STAMP}`, directAddrs: [123] }
  })
  const burnRetry = await request('POST', '/v1/hosts/register', {
    token: burnToken,
    body: { name: `r2-burn-${STAMP}`, directAddrs: ['127.0.0.1:19998'] }
  })
  const hostsAfterBurn = await request('GET', '/v1/hosts', { token: ctx.admin })
  const burnHost = (hostsAfterBurn.json?.hosts ?? []).find(
    (host) => host.name === `r2-burn-${STAMP}`
  )
  if (burnHost?.id) ctx.temp.hostIds.push(burnHost.id)
  manualCase({
    id: 'H8',
    area: 'hosts',
    sev: 'P2',
    op: '注册：directAddrs 元素非字符串',
    expected: '400 输入错误，且一次性令牌保持未使用',
    actual: `register=${burnRegister.status}/${burnRegister.json?.error?.code} retrySameToken=${burnRetry.status} hostCreated=${Boolean(burnHost)}`,
    ok: burnRegister.status === 400 && burnRetry.status === 201,
    request: {
      endpoint: 'POST /v1/hosts/register',
      body: { name: `r2-burn-${STAMP}`, directAddrs: [123] }
    }
  })

  // Re-registration with a non-numeric protocolVersion should not be stored as NaN.
  const reregToken = (await request('POST', '/v1/hosts/tokens', { token: ctx.admin })).json?.token
  const rereg = await request('POST', '/v1/hosts/register', {
    token: reregToken,
    body: { ...h1Body, protocolVersion: 'not-a-number' }
  })
  if (rereg.json?.credential) ctx.h1.credential = rereg.json.credential
  const hostsAfterRereg = await request('GET', '/v1/hosts', { token: ctx.admin })
  const h1View = (hostsAfterRereg.json?.hosts ?? []).find((host) => host.id === ctx.h1.id)
  manualCase({
    id: 'H44',
    area: 'hosts',
    sev: 'P3',
    op: '重注册：protocolVersion 非数字',
    expected: '400 拒绝或回落为合法整数',
    actual: `HTTP ${rereg.status} stored=${JSON.stringify(h1View?.protocolVersion)}`,
    ok: rereg.status === 400 || Number.isInteger(h1View?.protocolVersion),
    request: { endpoint: 'POST /v1/hosts/register', body: { protocolVersion: 'not-a-number' } }
  })

  // Heartbeat basics.
  await probe({
    id: 'H10',
    area: 'hosts',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/heartbeat`,
    token: 'wrong-credential',
    body: {},
    op: '心跳：错误主机凭证',
    expected: '401 HOST_CREDENTIAL_INVALID',
    check: isError(401, 'HOST_CREDENTIAL_INVALID')
  })
  await probe({
    id: 'H11',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/heartbeat`,
    token: ctx.h1.credential,
    body: { status: 'online', directAddrs: ['127.0.0.1:19999'] },
    op: '心跳：合法',
    expected: '200 policyVersion/revoked',
    check: isStatus(200)
  })
  await probe({
    id: 'H12',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/heartbeat`,
    token: ctx.h1.credential,
    body: { status: 'banana' },
    op: '心跳：任意 status 字符串',
    expected: '忽略或拒绝该值',
    check: isStatus(200)
  })
  const hostsAfterBanana = await request('GET', '/v1/hosts', { token: ctx.admin })
  const bananaView = (hostsAfterBanana.json?.hosts ?? []).find((host) => host.id === ctx.h1.id)
  manualCase({
    id: 'H12b',
    area: 'hosts',
    sev: 'P3',
    op: '心跳：status="banana" 后被静默改写为 offline',
    expected: '非法 status 应被拒绝而非按 offline 落库',
    actual: `stored status=${bananaView?.status}`,
    ok: bananaView?.status !== 'offline',
    request: { endpoint: `POST /v1/hosts/${ctx.h1.id}/heartbeat`, body: { status: 'banana' } }
  })
  // Restore liveness so the host can accept project creation below.
  await request('POST', `/v1/hosts/${ctx.h1.id}/heartbeat`, {
    token: ctx.h1.credential,
    body: { status: 'online', directAddrs: ['127.0.0.1:19999'] }
  })

  // Host-linked projects are needed before the bad-heartbeat test.
  ctx.t2 = (
    await request('POST', '/v1/projects', {
      token: ctx.admin,
      body: {
        key: `r2-t2-${STAMP}`,
        name: 'r2-t2-secret',
        hostId: ctx.h1.id,
        path: `${h1Root}/secret-app`,
        repoUrl: 'https://probe-user:S3cretProbe@git.example.com/team/repo.git',
        defaultBranch: 'main'
      }
    })
  ).json
  if (ctx.t2?.id) ctx.temp.projectIds.push(ctx.t2.id)
  ctx.t6 = (
    await request('POST', '/v1/projects', {
      token: ctx.admin,
      body: {
        key: `r2-t6-${STAMP}`,
        name: 'r2-t6',
        hostId: ctx.h1.id,
        path: `${h1Root}/bad-addr-app`
      }
    })
  ).json
  if (ctx.t6?.id) ctx.temp.projectIds.push(ctx.t6.id)
  await refreshH1()

  // A repoUrl may embed credentials (the audit omits it for that reason); a
  // non-admin project member with only `open` must not receive it.
  await request('PUT', `/v1/projects/${ctx.t2.id}/grants`, {
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: ['open'] }
  })
  const devProjectList = await request('GET', '/v1/projects', { token: ctx.dev })
  const devProjectDetail = await request('GET', `/v1/projects/${ctx.t2.id}`, { token: ctx.dev })
  const exposedList = findProject(devProjectList.json, ctx.t2.id)?.repoUrl ?? ''
  const exposedDetail = devProjectDetail.json?.repoUrl ?? ''
  manualCase({
    id: 'PX1',
    area: 'projects',
    sev: 'P2',
    op: '含凭据的 repoUrl 暴露给仅有 open 的普通用户',
    expected: '非管理员 projectView 不返回含凭据的 repoUrl',
    actual: `list=${exposedList} detail=${exposedDetail}`,
    ok: !exposedList.includes('S3cretProbe') && !exposedDetail.includes('S3cretProbe'),
    request: { endpoint: `GET /v1/projects + GET /v1/projects/${ctx.t2.id}`, body: null }
  })

  // Bad directAddrs on a heartbeat: expected 4xx, must not mutate host state.
  const badHeartbeat = await request('POST', `/v1/hosts/${ctx.h1.id}/heartbeat`, {
    token: ctx.h1.credential,
    body: { status: 'online', directAddrs: [123] }
  })
  const hostsAfterBadBeat = await request('GET', '/v1/hosts', { token: ctx.admin })
  const badBeatHost = (hostsAfterBadBeat.json?.hosts ?? []).find((host) => host.id === ctx.h1.id)
  const projectsAfterBadBeat = await request('GET', '/v1/projects', { token: ctx.admin })
  manualCase({
    id: 'H14',
    area: 'hosts',
    sev: 'P1',
    op: '心跳：directAddrs 元素非字符串',
    expected: '400 拒绝且不落库，不应影响其它端点',
    actual: `heartbeat=${badHeartbeat.status}/${badHeartbeat.json?.error?.code} stored=${JSON.stringify(badBeatHost?.directAddrs)} projectList=${projectsAfterBadBeat.status}`,
    ok: badHeartbeat.status === 400 && projectsAfterBadBeat.status === 200,
    request: { endpoint: `POST /v1/hosts/${ctx.h1.id}/heartbeat`, body: { directAddrs: [123] } }
  })
  // Recover the host so later probes run against a clean state.
  const recovery = await request('POST', `/v1/hosts/${ctx.h1.id}/heartbeat`, {
    token: ctx.h1.credential,
    body: { status: 'online', directAddrs: ['127.0.0.1:19999'] }
  })
  const projectsAfterRecovery = await request('GET', '/v1/projects', { token: ctx.admin })
  manualCase({
    id: 'H17',
    area: 'hosts',
    sev: 'P3',
    op: '坏心跳后的恢复',
    expected: '合法心跳 200，项目列表恢复 200',
    actual: `heartbeat=${recovery.status} projectList=${projectsAfterRecovery.status}`,
    ok: recovery.status === 200 && projectsAfterRecovery.status === 200
  })

  // projectsRoot boundaries.
  await probe({
    id: 'H18',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/heartbeat`,
    token: ctx.h1.credential,
    body: { projectsRoot: 'relative/path' },
    op: '心跳：非法 projectsRoot（相对路径）',
    expected: '200 且明确告知被拒绝（projectsRootRejected）',
    check: has(
      (res) => res.status === 200 && res.json?.projectsRootRejected === 'PROJECTS_ROOT_CONFLICT'
    )
  })
  await probe({
    id: 'H19',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/heartbeat`,
    token: ctx.h1.credential,
    body: { projectsRoot: `/tmp/r2-other-${STAMP}` },
    op: '心跳：有活跃项目时变更 projectsRoot',
    expected: '200 + projectsRootRejected',
    check: has(
      (res) => res.status === 200 && res.json?.projectsRootRejected === 'PROJECTS_ROOT_CONFLICT'
    )
  })

  // Maintenance state machine + host grant delegation.
  await probe({
    id: 'H21',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/maintenance`,
    token: ctx.admin,
    body: { enabled: true, reason: 'r2-probe' },
    op: '维护：管理员开启',
    expected: '200 status=maintenance',
    check: has((res) => res.status === 200 && res.json?.status === 'maintenance')
  })
  await probe({
    id: 'H22',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/heartbeat`,
    token: ctx.h1.credential,
    body: { status: 'online' },
    op: '维护中主机心跳：status=online 不应退出维护',
    expected: '200 + maintenance.reason 且状态保持',
    check: has((res) => res.status === 200 && res.json?.maintenance?.reason === 'r2-probe')
  })
  await probe({
    id: 'H23',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/maintenance`,
    token: ctx.admin,
    body: { enabled: 'false' },
    op: '维护：enabled 为字符串 "false"',
    expected: '400 拒绝或按 false 处理',
    check: isStatus(400)
  })
  await probe({
    id: 'H24',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/maintenance`,
    token: ctx.admin,
    body: { enabled: false },
    op: '维护：管理员关闭',
    expected: '200 status=online',
    check: has((res) => res.status === 200 && res.json?.status === 'online')
  })
  await probe({
    id: 'H25',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/maintenance`,
    token: ctx.dev,
    body: { enabled: true },
    op: '维护：未授权开发者',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  await probe({
    id: 'H26',
    area: 'hosts',
    sev: 'P2',
    method: 'PUT',
    pathname: `/v1/hosts/${ctx.h1.id}/grants`,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: ['maintain'] },
    op: '宿主授权：委派 maintain',
    expected: '200',
    check: isStatus(200)
  })
  await probe({
    id: 'H27',
    area: 'hosts',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/maintenance`,
    token: ctx.dev,
    body: { enabled: true, reason: 'delegated-probe' },
    op: '维护：持有 maintain 的开发者',
    expected: '200 status=maintenance',
    check: has((res) => res.status === 200 && res.json?.status === 'maintenance')
  })
  await probe({
    id: 'H24b',
    area: 'hosts',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/maintenance`,
    token: ctx.admin,
    body: { enabled: false },
    op: '维护：恢复在线',
    expected: '200 status=online',
    check: has((res) => res.status === 200 && res.json?.status === 'online')
  })
  const staleReason = await request('GET', `/v1/projects/${ctx.t6.id}`, { token: ctx.admin })
  manualCase({
    id: 'H24c',
    area: 'hosts',
    sev: 'P3',
    op: '退出维护后 projectView 仍携带陈旧维护原因',
    expected: 'hostStatus=online 时不返回 hostMaintenanceReason',
    actual: `hostStatus=${staleReason.json?.hostStatus} reason=${staleReason.json?.hostMaintenanceReason ?? 'absent'}`,
    ok: !staleReason.json?.hostMaintenanceReason,
    request: { endpoint: `GET /v1/projects/${ctx.t6.id}`, body: null }
  })
  await probe({
    id: 'H29',
    area: 'hosts',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/hosts/${ctx.h1.id}/grants`,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: ['root'] },
    op: '宿主授权：非法权限位',
    expected: '400 HOST_GRANT_PERMISSION_INVALID',
    check: isError(400, 'HOST_GRANT_PERMISSION_INVALID')
  })
  await probe({
    id: 'H30',
    area: 'hosts',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/hosts/${ctx.h1.id}/grants`,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: 'no-such-user', permissions: ['view'] },
    op: '宿主授权：不存在用户',
    expected: '400 USER_NOT_FOUND',
    check: isError(400, 'USER_NOT_FOUND')
  })
  await probe({
    id: 'H31',
    area: 'hosts',
    sev: 'P3',
    method: 'GET',
    pathname: `/v1/hosts/${ctx.h1.id}/grants`,
    token: ctx.admin,
    op: '宿主授权：管理员列表',
    expected: '200 grants 含 maintain 行',
    check: isStatus(200)
  })
  await probe({
    id: 'H32',
    area: 'hosts',
    sev: 'P3',
    method: 'GET',
    pathname: `/v1/hosts/${ctx.h1.id}/grants`,
    token: ctx.dev,
    op: '宿主授权：开发者读取列表',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })

  // Provision policy + self-service on the probe host.
  await probe({
    id: 'H33',
    area: 'hosts',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/hosts/${ctx.h1.id}/provision-policy`,
    token: ctx.admin,
    body: { mode: 'nope' },
    op: '自助策略：非法 mode',
    expected: '400 HOST_PROVISION_POLICY_INVALID',
    check: isError(400, 'HOST_PROVISION_POLICY_INVALID')
  })
  await probe({
    id: 'H34',
    area: 'hosts',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/hosts/${ctx.h1.id}/provision-policy`,
    token: ctx.admin,
    body: { mode: 'restricted' },
    op: '自助策略：restricted',
    expected: '200',
    check: isStatus(200)
  })
  await refreshH1()
  const availableRestricted = await request('GET', '/v1/hosts/available', { token: ctx.dev })
  const h1Available = (availableRestricted.json?.hosts ?? []).find((host) => host.id === ctx.h1.id)
  manualCase({
    id: 'H36',
    area: 'hosts',
    sev: 'P2',
    op: 'restricted 主机对开发者不可自助',
    expected: 'provisionAllowed=false',
    actual: JSON.stringify(h1Available),
    ok: h1Available?.provisionAllowed === false
  })
  await probe({
    id: 'H35',
    area: 'hosts',
    sev: 'P2',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: {
      name: 'restricted-self',
      key: `r2-restricted-${STAMP}`,
      dir: 'restricted-app',
      hostId: ctx.h1.id
    },
    op: 'restricted 主机上开发者自助建项目',
    expected: '403 HOST_PROVISION_FORBIDDEN',
    check: isError(403, 'HOST_PROVISION_FORBIDDEN')
  })
  await probe({
    id: 'H37',
    area: 'hosts',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/hosts/${ctx.h1.id}/provision-policy`,
    token: ctx.admin,
    body: { mode: 'open' },
    op: '自助策略：open',
    expected: '200',
    check: isStatus(200)
  })

  // --------------------------------------------------------------- projects
  const validationBase = {
    key: `r2-val-${STAMP}`,
    name: 'valid',
    hostId: ctx.hostDev02.id,
    path: `/srv/work/r2-val-${STAMP}`
  }
  await probe({
    id: 'P1',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.admin,
    body: { ...validationBase, hostId: undefined },
    op: '建项目：缺 hostId',
    expected: '400 HOST_NOT_FOUND',
    check: isError(400, 'HOST_NOT_FOUND')
  })
  await probe({
    id: 'P2',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.admin,
    body: { ...validationBase, hostId: 'host_missing' },
    op: '建项目：未知 hostId',
    expected: '400 HOST_NOT_FOUND',
    check: isError(400, 'HOST_NOT_FOUND')
  })
  await probe({
    id: 'P3',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.admin,
    body: { ...validationBase, hostId: ctx.hostDev01?.id ?? 'host_dev001' },
    op: '建项目：离线主机',
    expected: '409 HOST_OFFLINE',
    check: isError(409, 'HOST_OFFLINE')
  })
  const keyCases = [
    ['P4a', 'UPPER', '大写 key'],
    ['P4b', '项目', 'Unicode key'],
    ['P4c', '../etc', '穿越片段 key'],
    ['P4d', 'a'.repeat(65), '65 字符 key'],
    ['P4e', '', '空 key'],
    ['P4f', '.', '单点 key'],
    ['P4g', '..', '双点 key'],
    ['P4h', 'trailing.', '结尾点 key']
  ]
  for (const [id, key, label] of keyCases) {
    await probe({
      id,
      area: 'projects',
      sev: 'P3',
      method: 'POST',
      pathname: '/v1/projects',
      token: ctx.admin,
      body: { ...validationBase, key },
      op: `建项目：${label}`,
      expected: '400 PROJECT_KEY_INVALID',
      check: isError(400, 'PROJECT_KEY_INVALID')
    })
  }
  await probe({
    id: 'P5',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.admin,
    body: { ...validationBase, name: 'n'.repeat(201) },
    op: '建项目：名称 201 字符',
    expected: '400 PROJECT_NAME_INVALID',
    check: isError(400, 'PROJECT_NAME_INVALID')
  })
  const pathCases = [
    ['P6', 'relative/path', '相对路径'],
    ['P7', '/srv/work/../etc', '含 .. 段'],
    ['P8', '/srv//work', '重复分隔符'],
    ['P9', '/srv/work/', '结尾分隔符'],
    ['P10', '/srv/work/\u0001x', '控制字符']
  ]
  for (const [id, pathValue, label] of pathCases) {
    await probe({
      id,
      area: 'projects',
      sev: 'P3',
      method: 'POST',
      pathname: '/v1/projects',
      token: ctx.admin,
      body: { ...validationBase, path: pathValue },
      op: `建项目：${label}`,
      expected: '400 PROJECT_PATH_INVALID',
      check: isError(400, 'PROJECT_PATH_INVALID')
    })
  }
  const repoCases = [
    ['P11', '-oProxyCommand=x', '短横线开头'],
    ['P12', 'ext::sh -c id', 'ext:: 传输'],
    ['P13', { url: 'x' }, '对象类型'],
    ['P14', `https://x/${'a'.repeat(4090)}`, '超长 4097']
  ]
  for (const [id, repoUrl, label] of repoCases) {
    await probe({
      id,
      area: 'projects',
      sev: 'P3',
      method: 'POST',
      pathname: '/v1/projects',
      token: ctx.admin,
      body: { ...validationBase, repoUrl },
      op: `建项目：repoUrl ${label}`,
      expected: '400 REPO_URL_INVALID',
      check: isError(400, 'REPO_URL_INVALID')
    })
  }
  const branchCases = [
    ['P15', '-main', '短横线开头'],
    ['P16', 'a..b', '含 ..'],
    ['P17', 'b'.repeat(201), '超长 201']
  ]
  for (const [id, defaultBranch, label] of branchCases) {
    await probe({
      id,
      area: 'projects',
      sev: 'P3',
      method: 'POST',
      pathname: '/v1/projects',
      token: ctx.admin,
      body: { ...validationBase, defaultBranch },
      op: `建项目：分支 ${label}`,
      expected: '400 BRANCH_INVALID',
      check: isError(400, 'BRANCH_INVALID')
    })
  }

  await waitForSeedHostOnline('project-create')
  const t1Spec = {
    key: `r2-t1-${STAMP}`,
    name: 'r2-t1',
    hostId: ctx.hostDev02.id,
    path: `/srv/work/r2-t1-${STAMP}`,
    defaultBranch: 'main'
  }
  const t1Res = await request('POST', '/v1/projects', { token: ctx.admin, body: t1Spec })
  ctx.t1 = t1Res.json
  if (ctx.t1?.id) ctx.temp.projectIds.push(ctx.t1.id)
  manualCase({
    id: 'P18',
    area: 'projects',
    sev: 'P3',
    op: '建项目：合法（无 repoUrl）',
    expected: '201 status=ready repoUrl=""',
    actual: `HTTP ${t1Res.status} status=${ctx.t1?.status}`,
    ok: t1Res.status === 201 && ctx.t1?.status === 'ready' && ctx.t1?.repoUrl === ''
  })
  await probe({
    id: 'P19',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.admin,
    body: t1Spec,
    op: '建项目：重复 key 幂等边界',
    expected: '409 PROJECT_EXISTS',
    check: isError(409, 'PROJECT_EXISTS')
  })
  await probe({
    id: 'P20',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.admin,
    body: { ...t1Spec, key: `r2-t1b-${STAMP}` },
    op: '建项目：同路径不同 key',
    expected: '409 PROJECT_PATH_TAKEN',
    check: isError(409, 'PROJECT_PATH_TAKEN')
  })
  const t5Res = await request('POST', '/v1/projects', {
    token: ctx.admin,
    body: {
      key: `r2-t5-${STAMP}`,
      name: '项目名称-探针',
      hostId: ctx.hostDev02.id,
      path: `/srv/work/工作-${STAMP}`,
      defaultBranch: 'main'
    }
  })
  ctx.t5 = t5Res.json
  if (ctx.t5?.id) ctx.temp.projectIds.push(ctx.t5.id)
  manualCase({
    id: 'P21',
    area: 'projects',
    sev: 'P3',
    op: '建项目：Unicode 名称与路径',
    expected: '201（名称/路径允许 Unicode）',
    actual: `HTTP ${t5Res.status}`,
    ok: t5Res.status === 201
  })

  // Updates.
  // The project access gate returns 404 to a developer without `open`, before the
  // admin-only update check can run; grant open so this probes the 403 path.
  await request('PUT', `/v1/projects/${ctx.t1.id}/grants`, {
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: ['open'] }
  })
  await probe({
    id: 'P22',
    area: 'projects',
    sev: 'P2',
    method: 'PUT',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.dev,
    body: { defaultBranch: 'feature/x' },
    op: '更新项目：开发者冒充管理员',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  await probe({
    id: 'P23',
    area: 'projects',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    body: { path: '/srv/work/other' },
    op: '更新项目：path 不可变',
    expected: '400 PROJECT_FIELD_IMMUTABLE',
    check: isError(400, 'PROJECT_FIELD_IMMUTABLE')
  })
  await probe({
    id: 'P24',
    area: 'projects',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    body: { hostId: ctx.hostDev03.id },
    op: '更新项目：hostId 不可变',
    expected: '400 PROJECT_FIELD_IMMUTABLE',
    check: isError(400, 'PROJECT_FIELD_IMMUTABLE')
  })
  await probe({
    id: 'P25',
    area: 'projects',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    body: { repoUrl: '-x' },
    op: '更新项目：非法 repoUrl',
    expected: '400 REPO_URL_INVALID',
    check: isError(400, 'REPO_URL_INVALID')
  })
  await probe({
    id: 'P26',
    area: 'projects',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    body: { defaultBranch: '-x' },
    op: '更新项目：非法分支',
    expected: '400 BRANCH_INVALID',
    check: isError(400, 'BRANCH_INVALID')
  })
  const branchUpdate = await request('PUT', `/v1/projects/${ctx.t1.id}`, {
    token: ctx.admin,
    body: { defaultBranch: 'feature/r2-probe' }
  })
  manualCase({
    id: 'P27',
    area: 'projects',
    sev: 'P3',
    op: '更新项目：合法分支',
    expected: '200 defaultBranch=feature/r2-probe',
    actual: `HTTP ${branchUpdate.status} branch=${branchUpdate.json?.defaultBranch}`,
    ok: branchUpdate.status === 200 && branchUpdate.json?.defaultBranch === 'feature/r2-probe'
  })
  await probe({
    id: 'P28',
    area: 'projects',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    body: { name: 'renamed-by-probe', unknownField: true },
    op: '更新项目：未知字段/name',
    // U237 D1: name/unknownField are not updatable, so the body has neither
    // repoUrl nor defaultBranch and is now refused instead of returning 200.
    expected: '400 PROJECT_UPDATE_INVALID（原 200，U237 D1 必填 repoUrl/defaultBranch）',
    check: isError(400, 'PROJECT_UPDATE_INVALID')
  })

  // Archive / restore lifecycle.
  await probe({
    id: 'P29',
    area: 'projects',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t1.id}/archive`,
    token: ctx.dev,
    op: '归档项目：无权限开发者',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'P30',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t1.id}/archive`,
    token: ctx.admin,
    op: '归档项目：管理员',
    expected: '200 status=archived',
    check: has((res) => res.status === 200 && res.json?.status === 'archived')
  })
  await probe({
    id: 'P31',
    area: 'projects',
    sev: 'P3',
    method: 'GET',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    op: '归档后读取',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'P32',
    area: 'projects',
    sev: 'P3',
    method: 'PUT',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    body: { defaultBranch: 'feature/x' },
    op: '归档后更新',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'P33',
    area: 'projects',
    sev: 'P3',
    method: 'GET',
    pathname: `/v1/projects/${ctx.t1.id}/grants`,
    token: ctx.admin,
    op: '归档后读取授权',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'P34',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t1.id}/restore`,
    token: ctx.admin,
    op: '恢复项目',
    expected: '200 status=ready',
    check: has((res) => res.status === 200 && res.json?.status === 'ready')
  })
  await probe({
    id: 'P35',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t1.id}/archive`,
    token: ctx.admin,
    op: '再次归档',
    expected: '200 status=archived',
    check: has((res) => res.status === 200 && res.json?.status === 'archived')
  })
  const t4Res = await request('POST', '/v1/projects', {
    token: ctx.admin,
    body: {
      key: t1Spec.key,
      name: 'r2-t4-key-reuse',
      hostId: ctx.hostDev02.id,
      path: `/srv/work/r2-t4-${STAMP}`
    }
  })
  ctx.t4 = t4Res.json
  if (ctx.t4?.id) ctx.temp.projectIds.push(ctx.t4.id)
  manualCase({
    id: 'P36',
    area: 'projects',
    sev: 'P3',
    op: '归档后 key 被释放，可复用',
    expected: '201',
    actual: `HTTP ${t4Res.status} ${t4Res.json?.error?.code ?? ''}`,
    ok: t4Res.status === 201
  })
  await probe({
    id: 'P37',
    area: 'projects',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t1.id}/restore`,
    token: ctx.admin,
    op: '恢复项目：key 冲突',
    expected: '409 PROJECT_KEY_TAKEN',
    check: isError(409, 'PROJECT_KEY_TAKEN')
  })
  await probe({
    id: 'P38',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t4.id}/archive`,
    token: ctx.admin,
    op: '归档冲突项目',
    expected: '200',
    check: isStatus(200)
  })
  await probe({
    id: 'P39',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t1.id}/restore`,
    token: ctx.admin,
    op: '冲突解除后恢复',
    expected: '200 status=ready',
    check: has((res) => res.status === 200 && res.json?.status === 'ready')
  })
  await probe({
    id: 'P40',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/proj_missing/archive',
    token: ctx.admin,
    op: '归档不存在项目',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'P41',
    area: 'projects',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/projects/proj_missing',
    token: ctx.admin,
    op: '读取不存在项目',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'P42',
    area: 'projects',
    sev: 'P3',
    method: 'GET',
    pathname: `/v1/projects/${ctx.t1.id}/open`,
    token: ctx.admin,
    op: '未知项目动作',
    expected: '404 NOT_FOUND',
    check: isError(404, 'NOT_FOUND')
  })
  await request('POST', `/v1/projects/${ctx.t5.id}/archive`, { token: ctx.admin })
  const adminArchived = await request('GET', '/v1/projects?includeArchived=1', { token: ctx.admin })
  const devArchived = await request('GET', '/v1/projects?includeArchived=1', { token: ctx.dev })
  manualCase({
    id: 'P43',
    area: 'projects',
    sev: 'P3',
    op: '管理员 includeArchived=1 可见归档行',
    expected: '包含已归档项目',
    actual: `found=${Boolean(findProject(adminArchived.json, ctx.t5.id))}`,
    ok: Boolean(findProject(adminArchived.json, ctx.t5.id))
  })
  manualCase({
    id: 'P44',
    area: 'projects',
    sev: 'P3',
    op: '开发者 includeArchived=1 仍不可见归档行',
    expected: '不包含已归档项目',
    actual: `found=${Boolean(findProject(devArchived.json, ctx.t5.id))}`,
    ok: !findProject(devArchived.json, ctx.t5.id)
  })
  const p45 = await probe({
    id: 'P45',
    area: 'projects',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.admin,
    body: {
      ...t1Spec,
      key: `r2-dl-${STAMP}`,
      path: `/srv/work/r2-dl-${STAMP}`,
      downloadPolicy: 'banana'
    },
    op: '建项目：非法 downloadPolicy',
    // 与项目/全局 policy PUT 同码（D2），不再使用从未存在的 DOWNLOAD_POLICY_INVALID。
    expected: '400 明确拒绝（而非静默按 deny）',
    check: isError(400, 'POLICY_INVALID')
  })
  if (p45?.status === 201 && p45.json?.id) ctx.temp.projectIds.push(p45.json.id)

  // ---------------------------------------------------------------- grants
  const grantsPath = `/v1/projects/${ctx.t1.id}/grants`
  await probe({
    id: 'G1',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: ['root'] },
    op: '项目授权：非法权限位',
    expected: '400 GRANT_PERMISSION_INVALID',
    check: isError(400, 'GRANT_PERMISSION_INVALID')
  })
  await probe({
    id: 'G2',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: ['open', 'root'] },
    op: '项目授权：合法+非法混合',
    expected: '400 GRANT_PERMISSION_INVALID',
    check: isError(400, 'GRANT_PERMISSION_INVALID')
  })
  await probe({
    id: 'G3',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: 'no-such-user', permissions: ['open'] },
    op: '项目授权：不存在用户',
    expected: '400 USER_NOT_FOUND',
    check: isError(400, 'USER_NOT_FOUND')
  })
  await probe({
    id: 'G4',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'group', subjectId: 'no-such-group', permissions: ['open'] },
    op: '项目授权：不存在组',
    expected: '400 GROUP_NOT_FOUND',
    check: isError(400, 'GROUP_NOT_FOUND')
  })
  await probe({
    id: 'G5',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: '', permissions: ['open'] },
    op: '项目授权：空主体',
    expected: '400 USER_NOT_FOUND',
    check: isError(400, 'USER_NOT_FOUND')
  })
  const allBits = ['open', 'terminal', 'agent', 'file:read', 'file:write', 'browser', 'download']
  await probe({
    id: 'G6',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: allBits },
    op: '项目授权：全部 7 个权限位（用用户名）',
    expected: '200',
    check: isStatus(200)
  })
  const grantsAfterG6 = await request('GET', grantsPath, { token: ctx.admin })
  const devGrant = (grantsAfterG6.json?.grants ?? []).find(
    (grant) => grant.subjectId === ctx.devUserId
  )
  manualCase({
    id: 'G7',
    area: 'grants',
    sev: 'P3',
    op: '授权行按用户 id 落库并回显 username',
    expected: 'subjectId=用户 id 且 username=zhangsan',
    actual: JSON.stringify(devGrant),
    ok: devGrant?.username === DEV.username && devGrant?.subjectId === ctx.devUserId
  })
  await probe({
    id: 'G13',
    area: 'grants',
    sev: 'P2',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.dev,
    body: { subjectType: 'user', subjectId: ctx.devUserId, permissions: allBits },
    op: '开发者冒充管理员写项目授权',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  await probe({
    id: 'G8',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: {
      subjectType: 'user',
      subjectId: DEV.username,
      permissions: ['open', 'open', 'terminal']
    },
    op: '项目授权：重复权限位',
    expected: '200（按集合语义去重）',
    check: isStatus(200)
  })
  const dupGrant = await request('GET', grantsPath, { token: ctx.admin })
  const dupRow = (dupGrant.json?.grants ?? []).find((grant) => grant.subjectId === ctx.devUserId)
  manualCase({
    id: 'G8b',
    area: 'grants',
    sev: 'P3',
    op: '重复权限位是否原样落库',
    expected: '落库去重',
    actual: JSON.stringify(dupRow?.permissions),
    ok: JSON.stringify(dupRow?.permissions) === JSON.stringify(['open', 'terminal'])
  })
  const badPermissions = await request('PUT', grantsPath, {
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: 'open' }
  })
  const afterBadPermissions = await request('GET', grantsPath, { token: ctx.admin })
  const stillGranted = (afterBadPermissions.json?.grants ?? []).some(
    (grant) => grant.subjectId === ctx.devUserId
  )
  manualCase({
    id: 'G9',
    area: 'grants',
    sev: 'P2',
    op: '项目授权：permissions 类型错误（字符串）',
    expected: '400 GRANT_PERMISSION_INVALID 且既有授权保留',
    actual: `HTTP ${badPermissions.status} ${badPermissions.json?.error?.code ?? ''} grantStillPresent=${stillGranted}`,
    ok: badPermissions.status === 400 && stillGranted,
    request: {
      endpoint: `PUT ${grantsPath}`,
      body: { subjectType: 'user', subjectId: DEV.username, permissions: 'open' }
    }
  })
  manualCase({
    id: 'G9b',
    area: 'grants',
    sev: null,
    op: '类型错误是否导致既有授权被静默撤销（与 G9 同根因）',
    expected: '既有授权保留',
    actual: `grantStillPresent=${stillGranted}`,
    ok: stillGranted
  })
  await probe({
    id: 'G11',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'role', subjectId: ctx.devUserId, permissions: ['open'] },
    op: '项目授权：非法 subjectType 被当作 user',
    expected: '400 GRANT_SUBJECT_TYPE_INVALID',
    check: isError(400, 'GRANT_SUBJECT_TYPE_INVALID')
  })
  await probe({
    id: 'G12',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'group', subjectId: 'team-payment', permissions: ['open', 'file:read'] },
    op: '项目授权：组',
    expected: '200',
    check: isStatus(200)
  })
  await probe({
    id: 'G15',
    area: 'grants',
    sev: 'P2',
    method: 'GET',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.lisi,
    op: '无授权用户读取项目',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'G14',
    area: 'grants',
    sev: 'P2',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.lisi,
    body: { subjectType: 'user', subjectId: ctx.lisiUserId, permissions: ['open'] },
    op: '无授权用户写项目授权',
    expected: '404（不泄露项目存在）',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await probe({
    id: 'G16',
    area: 'grants',
    sev: 'P3',
    method: 'GET',
    pathname: `/v1/projects/${ctx.t1.id}`,
    token: ctx.admin,
    op: '管理员无显式授权读取项目',
    expected: '200',
    check: isStatus(200)
  })
  await probe({
    id: 'G10',
    area: 'grants',
    sev: 'P3',
    method: 'PUT',
    pathname: grantsPath,
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: ctx.devUserId, permissions: [] },
    op: '项目授权：空数组撤销',
    expected: '200 且行删除',
    check: isStatus(200)
  })
  const afterRevoke = await request('GET', grantsPath, { token: ctx.admin })
  manualCase({
    id: 'G10b',
    area: 'grants',
    sev: 'P3',
    op: '空数组撤销后授权行为空',
    expected: '无 zhangsan 行',
    actual: JSON.stringify(afterRevoke.json?.grants),
    ok: !(afterRevoke.json?.grants ?? []).some((grant) => grant.subjectId === ctx.devUserId)
  })

  // -------------------------------------------------------------- policies
  const globalBaseline = baseline.policy ?? {
    downloadDefault: 'allow',
    readRatePerHour: { calls: 600, bytes: 67108864 }
  }
  await probe({
    id: 'Y1',
    area: 'policies',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/policies/download',
    token: ctx.admin,
    op: '读取全局策略',
    expected: '200 含 downloadDefault/readRatePerHour/version',
    check: isStatus(200)
  })
  await probe({
    id: 'Y2',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: '/v1/policies/download',
    token: ctx.admin,
    body: { downloadDefault: 'deny' },
    op: '全局策略：改为 deny',
    expected: '200 downloadDefault=deny',
    check: has((res) => res.status === 200 && res.json?.downloadDefault === 'deny')
  })
  await probe({
    id: 'Y3',
    area: 'policies',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/policies/download',
    token: ctx.admin,
    op: '全局策略回读',
    expected: 'downloadDefault=deny',
    check: has((res) => res.json?.downloadDefault === 'deny')
  })
  await probe({
    id: 'Y4',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: '/v1/policies/download',
    token: ctx.admin,
    body: { downloadDefault: globalBaseline.downloadDefault },
    op: '全局策略恢复',
    expected: '200',
    check: isStatus(200)
  })
  await probe({
    id: 'Y5',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: '/v1/policies/download',
    token: ctx.admin,
    body: {
      downloadDefault: globalBaseline.downloadDefault,
      readRatePerHour: { calls: 1, bytes: 1 }
    },
    op: '全局限速边界：1/1',
    expected: '200 且保存 1/1',
    check: has(
      (res) =>
        res.status === 200 &&
        res.json?.readRatePerHour?.calls === 1 &&
        res.json?.readRatePerHour?.bytes === 1
    )
  })
  const rateCases = [
    ['Y8', { calls: 0, bytes: 1 }, 'calls=0'],
    ['Y9', { calls: -1, bytes: 1 }, 'calls=-1'],
    ['Y10', { calls: 1.5, bytes: 1 }, 'calls=1.5'],
    ['Y11', { calls: 'abc', bytes: 1 }, 'calls="abc"'],
    ['Y12', null, 'null（全局不可清空）']
  ]
  for (const [id, readRatePerHour, label] of rateCases) {
    await probe({
      id,
      area: 'policies',
      sev: 'P3',
      method: 'PUT',
      pathname: '/v1/policies/download',
      token: ctx.admin,
      body: { downloadDefault: globalBaseline.downloadDefault, readRatePerHour },
      op: `全局限速：${label}`,
      expected: '400 POLICY_INVALID',
      check: isError(400, 'POLICY_INVALID')
    })
  }
  await probe({
    id: 'Y13',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: '/v1/policies/download',
    token: ctx.admin,
    body: {
      downloadDefault: globalBaseline.downloadDefault,
      readRatePerHour: { calls: 1e300, bytes: 1e300 }
    },
    op: '全局限速：1e300',
    expected: '400（超出安全整数范围）',
    check: isError(400, 'POLICY_INVALID')
  })
  await probe({
    id: 'Y14',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: '/v1/policies/download',
    token: ctx.admin,
    body: { downloadDefault: 'banana' },
    op: '全局策略：非法 downloadDefault',
    expected: '400 明确拒绝（而非静默 deny）',
    check: isError(400, 'POLICY_INVALID')
  })
  await probe({
    id: 'Y15',
    area: 'policies',
    sev: 'P2',
    method: 'PUT',
    pathname: '/v1/policies/download',
    token: ctx.dev,
    body: { downloadDefault: 'allow' },
    op: '开发者写全局策略',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  // Restore the global rate accepted above (1/1) to the baseline afterwards.
  const projectPolicyPath = `/v1/projects/${ctx.t1.id}/policy`
  await probe({
    id: 'Y16',
    area: 'policies',
    sev: 'P3',
    method: 'GET',
    pathname: projectPolicyPath,
    token: ctx.admin,
    op: '项目策略：继承全局',
    expected: '200 effective=全局值',
    check: isStatus(200)
  })
  await probe({
    id: 'Y17',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: projectPolicyPath,
    token: ctx.admin,
    body: { downloadPolicy: 'deny' },
    op: '项目策略：覆写 deny',
    expected: '200 downloadPolicy=deny',
    check: has((res) => res.status === 200 && res.json?.downloadPolicy === 'deny')
  })
  await probe({
    id: 'Y18',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: projectPolicyPath,
    token: ctx.admin,
    body: { inherit: true },
    op: '项目策略：inherit 往返',
    expected: '200',
    check: isStatus(200)
  })
  await probe({
    id: 'Y19',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: projectPolicyPath,
    token: ctx.admin,
    body: { readRatePerHour: { calls: 2, bytes: 2048 } },
    op: '项目限速：设置 2/2048',
    // U237 D2: downloadPolicy is required unless inherit:true; a rate-only body
    // used to be coerced to deny and returned 200.
    expected: '400 POLICY_INVALID（原 200，U237 D2 缺 downloadPolicy）',
    check: isError(400, 'POLICY_INVALID')
  })
  await probe({
    id: 'Y20',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: projectPolicyPath,
    token: ctx.admin,
    body: { readRatePerHour: null },
    op: '项目限速：null 清除覆写',
    // U237 D2: same required-field rule as Y19; clearing a rate alone is no
    // longer a valid project-policy write.
    expected: '400 POLICY_INVALID（原 200，U237 D2 缺 downloadPolicy）',
    check: isError(400, 'POLICY_INVALID')
  })
  await probe({
    id: 'Y21',
    area: 'policies',
    sev: 'P3',
    method: 'PUT',
    pathname: projectPolicyPath,
    token: ctx.admin,
    // U260: the missing downloadPolicy used to make this 400 come from the D2
    // required-field check, so the rate branch was never exercised.
    body: { downloadPolicy: 'allow', readRatePerHour: { calls: 0, bytes: 1 } },
    op: '项目限速：非法值',
    expected: '400 POLICY_INVALID（读取限速必须是大于 0 的 calls/bytes）',
    check: has(
      (res) =>
        res.status === 400 &&
        res.json?.error?.code === 'POLICY_INVALID' &&
        typeof res.json?.error?.message === 'string' &&
        res.json.error.message.includes('读取限速')
    )
  })
  await probe({
    id: 'Y22',
    area: 'policies',
    sev: 'P2',
    method: 'PUT',
    pathname: projectPolicyPath,
    token: ctx.dev,
    body: { downloadPolicy: 'allow' },
    op: '开发者写项目策略',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  const archivedPolicy = await request('GET', `/v1/projects/${ctx.t5.id}/policy`, {
    token: ctx.admin
  })
  manualCase({
    id: 'Y23',
    area: 'policies',
    sev: 'P3',
    op: '归档项目策略读取',
    expected: '404 PROJECT_NOT_FOUND',
    actual: `HTTP ${archivedPolicy.status} ${archivedPolicy.json?.error?.code ?? ''}`,
    ok: archivedPolicy.status === 404
  })

  // Restore baseline global rate now.
  await request('PUT', '/v1/policies/download', {
    token: ctx.admin,
    body: {
      downloadDefault: globalBaseline.downloadDefault,
      readRatePerHour: globalBaseline.readRatePerHour ?? { calls: 600, bytes: 67108864 }
    }
  })

  // ----------------------------------------------------------- self-service
  await probe({
    id: 'S1',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: 'x', dir: 'd', hostId: ctx.hostDev02.id, path: '/etc' },
    op: '自助建项目：显式 path',
    expected: '400 PROJECT_PATH_FORBIDDEN',
    check: isError(400, 'PROJECT_PATH_FORBIDDEN')
  })
  await probe({
    id: 'S2',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: '', dir: 'd', hostId: ctx.hostDev02.id },
    op: '自助建项目：空名称',
    expected: '400 PROJECT_NAME_INVALID',
    check: isError(400, 'PROJECT_NAME_INVALID')
  })
  await probe({
    id: 'S3',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: 'n'.repeat(201), dir: 'd', hostId: ctx.hostDev02.id },
    op: '自助建项目：名称 201',
    expected: '400 PROJECT_NAME_INVALID',
    check: isError(400, 'PROJECT_NAME_INVALID')
  })
  await probe({
    id: 'S4',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: '中文名', dir: 'd', hostId: ctx.hostDev02.id },
    op: '自助建项目：中文名派生 key 为空',
    expected: '400 PROJECT_KEY_INVALID',
    check: isError(400, 'PROJECT_KEY_INVALID')
  })
  const dirCases = [
    ['S5', '..', 'dir=..'],
    ['S6', 'a/b', 'dir 含分隔符'],
    ['S7', '.', 'dir=.'],
    ['S8', '/abs', 'dir 绝对路径']
  ]
  for (const [id, dir, label] of dirCases) {
    await probe({
      id,
      area: 'self-service',
      sev: 'P3',
      method: 'POST',
      pathname: '/v1/projects/self',
      token: ctx.dev,
      body: { name: `self-${id}-${STAMP}`, dir, hostId: ctx.hostDev02.id },
      op: `自助建项目：${label}`,
      expected: '400 INVALID_DIR',
      check: isError(400, 'INVALID_DIR')
    })
  }
  await probe({
    id: 'S9',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: 'x', dir: 'd', hostId: ctx.hostDev02.id, repoUrl: 'ext::sh -c id' },
    op: '自助建项目：非法 repoUrl',
    expected: '400 REPO_URL_INVALID',
    check: isError(400, 'REPO_URL_INVALID')
  })
  await probe({
    id: 'S10',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: 'x', dir: 'd', hostId: ctx.hostDev01?.id ?? 'host_dev001' },
    op: '自助建项目：无 projectsRoot 主机',
    expected: '409 HOST_NOT_PROVISIONABLE',
    check: isError(409, 'HOST_NOT_PROVISIONABLE')
  })
  await probe({
    id: 'S11',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: 'x', dir: 'd', hostId: 'host_missing' },
    op: '自助建项目：未知主机',
    expected: '400 HOST_NOT_FOUND',
    check: isError(400, 'HOST_NOT_FOUND')
  })
  await probe({
    id: 'S12',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: { name: `self-nohost-${STAMP}`, dir: 'd' },
    op: '自助建项目：多台可建主机时未指定',
    expected: '409 HOST_REQUIRED',
    check: isError(409, 'HOST_REQUIRED')
  })
  await probe({
    id: 'S15',
    area: 'self-service',
    sev: 'P2',
    method: 'POST',
    pathname: '/v1/projects',
    token: ctx.dev,
    body: { ...t1Spec, key: `r2-devc-${STAMP}`, path: `/srv/work/r2-devc-${STAMP}` },
    op: '开发者走管理员建项目端点',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  await waitForSeedHostOnline('self-service')
  const selfSpec = {
    name: `self-probe-${STAMP}`,
    key: `r2-self-${STAMP}`,
    dir: `self-app-${STAMP}`,
    hostId: ctx.hostDev02.id
  }
  const t3Res = await request('POST', '/v1/projects/self', { token: ctx.dev, body: selfSpec })
  ctx.t3 = t3Res.json
  if (ctx.t3?.id) ctx.temp.projectIds.push(ctx.t3.id)
  manualCase({
    id: 'S13',
    area: 'self-service',
    sev: 'P3',
    op: '自助建项目：合法',
    expected: '201 且自动授予创建者 open/terminal/agent/file:*',
    actual: `HTTP ${t3Res.status} perms=${JSON.stringify(t3Res.json?.permissions)}`,
    ok:
      t3Res.status === 201 &&
      ['open', 'terminal', 'agent', 'file:read', 'file:write'].every((bit) =>
        (t3Res.json?.permissions ?? []).includes(bit)
      )
  })
  await probe({
    id: 'S14',
    area: 'self-service',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/projects/self',
    token: ctx.dev,
    body: selfSpec,
    op: '自助建项目：重复 key',
    expected: '409 PROJECT_KEY_TAKEN',
    check: isError(409, 'PROJECT_KEY_TAKEN')
  })
  await probe({
    id: 'S16',
    area: 'self-service',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t3.id}/archive`,
    token: ctx.dev,
    op: '创建者归档自助项目',
    expected: '200 status=archived',
    check: has((res) => res.status === 200 && res.json?.status === 'archived')
  })
  await probe({
    id: 'S17',
    area: 'self-service',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t3.id}/restore`,
    token: ctx.dev,
    op: '创建者恢复自助项目',
    expected: '200 status=ready',
    check: has((res) => res.status === 200 && res.json?.status === 'ready')
  })

  // Self-service on the probe host under the open policy (T7).
  await refreshH1()
  const t7Res = await request('POST', '/v1/projects/self', {
    token: ctx.dev,
    body: {
      name: `self-h1-${STAMP}`,
      key: `r2-selfh1-${STAMP}`,
      dir: `self-h1-${STAMP}`,
      hostId: ctx.h1.id
    }
  })
  ctx.t7 = t7Res.json
  if (ctx.t7?.id) ctx.temp.projectIds.push(ctx.t7.id)
  manualCase({
    id: 'H38',
    area: 'hosts',
    sev: 'P3',
    op: 'open 主机上开发者自助建项目',
    expected: '201',
    actual: `HTTP ${t7Res.status} ${t7Res.json?.error?.code ?? ''}`,
    ok: t7Res.status === 201
  })

  // -------------------------------------------------------------- handoff
  await waitForSeedHostOnline('handoff')
  // Handoff redemption checks the grant predicate for every caller, admins
  // included (seed data grants admin explicitly). Grant open to exercise mint.
  await request('PUT', `/v1/projects/${ctx.t1.id}/grants`, {
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: ctx.adminUserId, permissions: ['open'] }
  })
  const t1Path = `/v1/projects/${ctx.t1.id}/web-handoff`
  const mintWeb = await request('POST', t1Path, { token: ctx.admin, body: {} })
  manualCase({
    id: 'D1',
    area: 'handoff',
    sev: 'P3',
    op: '签发 web 交接码',
    expected: '201 web-index 入口 + expiresIn=60',
    actual: `HTTP ${mintWeb.status} url=${brief(mintWeb.json?.url)} expiresIn=${mintWeb.json?.expiresIn}`,
    ok:
      mintWeb.status === 201 &&
      String(mintWeb.json?.url).includes('/web-index.html') &&
      mintWeb.json?.expiresIn === 60
  })
  const mintAdmin = await request('POST', t1Path, { token: ctx.admin, body: { surface: 'admin' } })
  manualCase({
    id: 'D2',
    area: 'handoff',
    sev: 'P3',
    op: '签发 admin surface 交接码',
    expected: '201 cloud-admin.html + embed=1&project=<id>',
    actual: `HTTP ${mintAdmin.status} url=${brief(mintAdmin.json?.url)}`,
    ok:
      mintAdmin.status === 201 &&
      String(mintAdmin.json?.url).includes('cloud-admin.html') &&
      String(mintAdmin.json?.url).includes('embed=1') &&
      String(mintAdmin.json?.url).includes(`project=${ctx.t1.id}`)
  })
  const mintBogusSurface = await request('POST', t1Path, {
    token: ctx.admin,
    body: { surface: 'bogus' }
  })
  manualCase({
    id: 'D3',
    area: 'handoff',
    sev: 'P3',
    op: '未知 surface 回落 web 形态',
    expected: '201 web-index',
    actual: `HTTP ${mintBogusSurface.status}`,
    ok:
      mintBogusSurface.status === 201 &&
      String(mintBogusSurface.json?.url).includes('/web-index.html')
  })
  await probe({
    id: 'D4',
    area: 'handoff',
    sev: 'P3',
    method: 'POST',
    pathname: t1Path,
    token: ctx.lisi,
    op: '无 open 权限签发交接码',
    expected: '404 PROJECT_NOT_FOUND（不泄露项目存在）',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await request('POST', `/v1/projects/${ctx.t1.id}/archive`, { token: ctx.admin })
  await probe({
    id: 'D5',
    area: 'handoff',
    sev: 'P3',
    method: 'POST',
    pathname: t1Path,
    token: ctx.admin,
    op: '归档项目签发交接码',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await request('POST', `/v1/projects/${ctx.t1.id}/restore`, { token: ctx.admin })

  // Provisioning gates on T2 (probe host, online).
  await request('PUT', `/v1/projects/${ctx.t2.id}/grants`, {
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: ctx.adminUserId, permissions: ['open'] }
  })
  await refreshH1()
  await probe({
    id: 'D6',
    area: 'handoff',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t2.id}/web-handoff`,
    token: ctx.admin,
    body: {},
    op: 'provisioning 项目 web surface 签发',
    expected: '201（web 形态保持旧行为）',
    check: isStatus(201)
  })
  await probe({
    id: 'D7',
    area: 'handoff',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t2.id}/web-handoff`,
    token: ctx.admin,
    body: { surface: 'admin' },
    op: 'provisioning 项目 admin surface 签发',
    expected: '409 PROJECT_PROVISIONING',
    check: isError(409, 'PROJECT_PROVISIONING')
  })
  await refreshH1()
  await request('POST', `/v1/hosts/${ctx.h1.id}/heartbeat`, {
    token: ctx.h1.credential,
    body: { provisioned: [{ projectId: ctx.t2.id, ok: false, error: 'PROBE_FAIL' }] }
  })
  await refreshH1()
  await probe({
    id: 'D8',
    area: 'handoff',
    sev: 'P3',
    method: 'POST',
    pathname: `/v1/projects/${ctx.t2.id}/web-handoff`,
    token: ctx.admin,
    body: { surface: 'admin' },
    op: 'failed 项目 admin surface 签发',
    expected: '409 PROJECT_NOT_PREPARED',
    check: isError(409, 'PROJECT_NOT_PREPARED')
  })

  // Redemption boundaries.
  const invalidRedeem = await request('POST', '/v1/web/handoff', { body: { code: 'not-a-code' } })
  manualCase({
    id: 'D9',
    area: 'handoff',
    sev: 'P3',
    op: '兑换：无效 code',
    expected: '410 HANDOFF_GONE reason=code_invalid',
    actual: `HTTP ${invalidRedeem.status} ${invalidRedeem.json?.error?.code} reason=${invalidRedeem.json?.error?.details?.reason}`,
    ok:
      invalidRedeem.status === 410 && invalidRedeem.json?.error?.details?.reason === 'code_invalid'
  })
  await probe({
    id: 'D10',
    area: 'handoff',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/web/handoff',
    body: {},
    op: '兑换：缺 code',
    expected: '410 HANDOFF_GONE',
    check: isError(410, 'HANDOFF_GONE')
  })
  const validMint = await request('POST', t1Path, { token: ctx.admin, body: {} })
  const code = String(validMint.json?.url ?? '')
    .split('#handoff=')[1]
    ?.split('&')[0]
  const validRedeem = await request('POST', '/v1/web/handoff', { body: { code } })
  const replayRedeem = await request('POST', '/v1/web/handoff', { body: { code } })
  manualCase({
    id: 'D11',
    area: 'handoff',
    sev: 'P3',
    op: '兑换：合法 code 及重放',
    expected: '首次 200，重放 410 code_invalid',
    actual: `first=${validRedeem.status} replay=${replayRedeem.status}`,
    ok:
      validRedeem.status === 200 &&
      replayRedeem.status === 410 &&
      Boolean(validRedeem.json?.accessToken)
  })
  const concurrencyMint = await request('POST', t1Path, { token: ctx.admin, body: {} })
  const concurrencyCode = String(concurrencyMint.json?.url ?? '')
    .split('#handoff=')[1]
    ?.split('&')[0]
  const [raceA, raceB] = await Promise.all([
    request('POST', '/v1/web/handoff', { body: { code: concurrencyCode } }),
    request('POST', '/v1/web/handoff', { body: { code: concurrencyCode } })
  ])
  const raceRedeemStatuses = [raceA.status, raceB.status].sort()
  manualCase({
    id: 'D12',
    area: 'handoff',
    sev: 'P2',
    op: '并发兑换：同一 code 两路',
    expected: '恰好一个 200、一个 410（原子消费）',
    actual: JSON.stringify(raceRedeemStatuses),
    ok: raceRedeemStatuses[0] === 200 && raceRedeemStatuses[1] === 410
  })

  // Permission lost between mint and redeem.
  await request('PUT', `/v1/projects/${ctx.t1.id}/grants`, {
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: ['open'] }
  })
  const devMint = await request('POST', t1Path, { token: ctx.dev, body: {} })
  const devCode = String(devMint.json?.url ?? '')
    .split('#handoff=')[1]
    ?.split('&')[0]
  await request('PUT', `/v1/projects/${ctx.t1.id}/grants`, {
    token: ctx.admin,
    body: { subjectType: 'user', subjectId: DEV.username, permissions: [] }
  })
  // The group grant also carries `open`, so permission_lost needs both removed.
  await request('PUT', `/v1/projects/${ctx.t1.id}/grants`, {
    token: ctx.admin,
    body: { subjectType: 'group', subjectId: 'team-payment', permissions: [] }
  })
  const lostRedeem = await request('POST', '/v1/web/handoff', { body: { code: devCode } })
  manualCase({
    id: 'D15',
    area: 'handoff',
    sev: 'P2',
    op: '签发后撤权再兑换',
    expected: '403 PROJECT_FORBIDDEN reason=permission_lost',
    actual: `HTTP ${lostRedeem.status} ${lostRedeem.json?.error?.code} reason=${lostRedeem.json?.error?.details?.reason}`,
    ok: lostRedeem.status === 403 && lostRedeem.json?.error?.details?.reason === 'permission_lost'
  })

  // Archived between mint and redeem.
  const archiveMint = await request('POST', t1Path, { token: ctx.admin, body: {} })
  const archiveCode = String(archiveMint.json?.url ?? '')
    .split('#handoff=')[1]
    ?.split('&')[0]
  await request('POST', `/v1/projects/${ctx.t1.id}/archive`, { token: ctx.admin })
  const archivedRedeem = await request('POST', '/v1/web/handoff', { body: { code: archiveCode } })
  await request('POST', `/v1/projects/${ctx.t1.id}/restore`, { token: ctx.admin })
  manualCase({
    id: 'D16',
    area: 'handoff',
    sev: 'P3',
    op: '签发后归档再兑换',
    expected: '410 HANDOFF_GONE reason=project_archived',
    actual: `HTTP ${archivedRedeem.status} ${archivedRedeem.json?.error?.code} reason=${archivedRedeem.json?.error?.details?.reason}`,
    ok: archivedRedeem.status === 410
  })

  if (!SKIP_TIMING) {
    const mint58 = await request('POST', t1Path, { token: ctx.admin, body: {} })
    const code58 = String(mint58.json?.url ?? '')
      .split('#handoff=')[1]
      ?.split('&')[0]
    await sleep(58000)
    const redeem58 = await request('POST', '/v1/web/handoff', { body: { code: code58 } })
    manualCase({
      id: 'D13',
      area: 'handoff',
      sev: 'P2',
      op: '60s TTL 边界：58s 兑换',
      expected: '200（未过期）',
      actual: `HTTP ${redeem58.status} ${redeem58.json?.error?.code ?? ''}`,
      ok: redeem58.status === 200
    })
    const mint62 = await request('POST', t1Path, { token: ctx.admin, body: {} })
    const code62 = String(mint62.json?.url ?? '')
      .split('#handoff=')[1]
      ?.split('&')[0]
    await sleep(62000)
    const redeem62 = await request('POST', '/v1/web/handoff', { body: { code: code62 } })
    manualCase({
      id: 'D14',
      area: 'handoff',
      sev: 'P2',
      op: '60s TTL 边界：62s 兑换',
      expected: '410 HANDOFF_GONE（未兑换）',
      actual: `HTTP ${redeem62.status} ${redeem62.json?.error?.code} reason=${redeem62.json?.error?.details?.reason}`,
      ok: redeem62.status === 410 && redeem62.json?.error?.code === 'HANDOFF_GONE'
    })
    manualCase({
      id: 'D14b',
      area: 'handoff',
      sev: 'P3',
      op: '过期码的 reason 稳定性',
      expected: '过期码稳定报告 reason=code_expired',
      actual: `reason=${redeem62.json?.error?.details?.reason}`,
      ok: redeem62.json?.error?.details?.reason === 'code_expired',
      note: '每次签发都会 prune 过期码；并发签发可在兑换前删掉过期行，使 reason 变为 code_invalid（410 契约不变）'
    })
  }

  // --------------------------------------------------------------- connect
  await waitForSeedHostOnline('connect')
  const connectPath = `/v1/projects/${ctx.t1.id}/connect`
  await probe({
    id: 'C1',
    area: 'connect',
    sev: 'P3',
    method: 'POST',
    pathname: connectPath,
    token: ctx.admin,
    body: { clientVersion: '1.5.0' },
    op: 'connect：缺 deviceId',
    expected: '401 DEVICE_NOT_REGISTERED',
    check: isError(401, 'DEVICE_NOT_REGISTERED')
  })
  await probe({
    id: 'C2',
    area: 'connect',
    sev: 'P3',
    method: 'POST',
    pathname: connectPath,
    token: ctx.admin,
    body: { clientVersion: '1.4.9', deviceId: ctx.adminDeviceId },
    op: 'connect：版本过低',
    expected: '426 VERSION_UNSUPPORTED',
    check: isError(426, 'VERSION_UNSUPPORTED')
  })
  await probe({
    id: 'C3',
    area: 'connect',
    sev: 'P3',
    method: 'POST',
    pathname: connectPath,
    token: ctx.admin,
    body: { clientVersion: 'abc', deviceId: ctx.adminDeviceId },
    op: 'connect：非法版本串',
    expected: '426 VERSION_UNSUPPORTED',
    check: isError(426, 'VERSION_UNSUPPORTED')
  })
  const connectOk = await request('POST', connectPath, {
    token: ctx.admin,
    body: {
      clientVersion: '1.5.0',
      deviceId: ctx.adminDeviceId,
      devicePubKey: ctx.adminDevicePubKey
    }
  })
  manualCase({
    id: 'C4',
    area: 'connect',
    sev: 'P3',
    op: 'connect：合法',
    expected: '200 credential + endpoints + workspace',
    actual: `HTTP ${connectOk.status} credential=${Boolean(connectOk.json?.credential)}`,
    ok:
      connectOk.status === 200 &&
      typeof connectOk.json?.credential === 'string' &&
      Array.isArray(connectOk.json?.endpoints?.direct) &&
      Boolean(connectOk.json?.workspace?.projectRoot)
  })
  await probe({
    id: 'C5',
    area: 'connect',
    sev: 'P2',
    method: 'POST',
    pathname: connectPath,
    token: ctx.admin,
    body: { clientVersion: '1.5.0', deviceId: ctx.adminDeviceId, devicePubKey: 'different-key' },
    op: 'connect：设备公钥不匹配',
    expected: '401 DEVICE_KEY_MISMATCH',
    check: isError(401, 'DEVICE_KEY_MISMATCH')
  })
  await request('POST', `/v1/projects/${ctx.t1.id}/archive`, { token: ctx.admin })
  await probe({
    id: 'C6',
    area: 'connect',
    sev: 'P3',
    method: 'POST',
    pathname: connectPath,
    token: ctx.admin,
    body: { clientVersion: '1.5.0', deviceId: ctx.adminDeviceId },
    op: 'connect：归档项目',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })
  await request('POST', `/v1/projects/${ctx.t1.id}/restore`, { token: ctx.admin })
  await probe({
    id: 'C7',
    area: 'connect',
    sev: 'P2',
    method: 'POST',
    pathname: connectPath,
    token: ctx.lisi,
    body: { clientVersion: '1.5.0', deviceId: ctx.lisiDeviceId },
    op: 'connect：无 open 权限用户',
    expected: '404 PROJECT_NOT_FOUND',
    check: isError(404, 'PROJECT_NOT_FOUND')
  })

  // ----------------------------------------------------------------- audit
  await waitForSeedHostOnline('audit-trace')
  const traceId = `r2-trace-${STAMP}`
  const tracedCreate = await request('POST', '/v1/projects', {
    token: ctx.admin,
    headers: { 'x-trace-id': traceId },
    body: {
      key: `r2-trace-${STAMP}`,
      name: 'r2-trace',
      hostId: ctx.hostDev02.id,
      path: `/srv/work/r2-trace-${STAMP}`
    }
  })
  if (tracedCreate.json?.id) ctx.temp.projectIds.push(tracedCreate.json.id)
  const tracedEvents = await request(
    'GET',
    `/v1/audit/events?traceId=${encodeURIComponent(traceId)}&limit=20`,
    {
      token: ctx.admin
    }
  )
  manualCase({
    id: 'U1',
    area: 'audit',
    sev: 'P2',
    op: 'traceId 贯穿：请求头 → 审计事件',
    expected: '按 traceId 能查到该次 project_create 且 traceId 一致',
    actual: `create=${tracedCreate.status} events=${JSON.stringify((tracedEvents.json?.events ?? []).map((e) => [e.eventType, e.traceId]))}`,
    ok:
      tracedCreate.status === 201 &&
      (tracedEvents.json?.events ?? []).some(
        (event) => event.eventType === 'project_create' && event.traceId === traceId
      )
  })

  const verify = await request('GET', '/v1/audit/verify', { token: ctx.admin })
  manualCase({
    id: 'U3',
    area: 'audit',
    sev: 'P0',
    op: '审计链完整性校验',
    expected: '200 ok=true checked>0',
    actual: `HTTP ${verify.status} ${JSON.stringify(verify.json)}`,
    ok: verify.status === 200 && verify.json?.ok === true && (verify.json?.checked ?? 0) > 0
  })
  const auditStatus = await request('GET', '/v1/audit/status', { token: ctx.admin })
  manualCase({
    id: 'U4',
    area: 'audit',
    sev: 'P3',
    op: '审计落盘状态',
    expected: 'ok=true，persisted 字段存在',
    actual: JSON.stringify(auditStatus.json),
    ok: auditStatus.status === 200 && typeof auditStatus.json?.persisted === 'boolean'
  })

  const limitOne = await request('GET', '/v1/audit/events?limit=1', { token: ctx.admin })
  manualCase({
    id: 'U5',
    area: 'audit',
    sev: 'P3',
    op: '分页：limit=1',
    expected: '1 条且 nextCursor 非空',
    actual: `n=${limitOne.json?.events?.length} next=${limitOne.json?.nextCursor}`,
    ok: limitOne.json?.events?.length === 1 && limitOne.json?.nextCursor !== null
  })
  const cursorPage = await request(
    'GET',
    `/v1/audit/events?limit=1&cursor=${limitOne.json?.nextCursor}`,
    { token: ctx.admin }
  )
  manualCase({
    id: 'U6',
    area: 'audit',
    sev: 'P3',
    op: '分页：cursor 翻页',
    expected: '返回更旧的一条且 seq 小于首页',
    actual: `status=${cursorPage.status} seq=${cursorPage.json?.events?.[0]?.seq}`,
    ok:
      cursorPage.status === 200 &&
      cursorPage.json?.events?.length === 1 &&
      cursorPage.json.events[0].seq < limitOne.json.events[0].seq
  })
  const limitCapped = await request('GET', '/v1/audit/events?limit=201', { token: ctx.admin })
  manualCase({
    id: 'U7',
    area: 'audit',
    sev: 'P3',
    op: '分页：limit 上限 200',
    expected: '最多 200 条',
    actual: `n=${limitCapped.json?.events?.length}`,
    ok: (limitCapped.json?.events?.length ?? 0) <= 200
  })
  const totalEvents =
    (await request('GET', '/v1/audit/events?limit=200', { token: ctx.admin })).json?.events
      ?.length ?? 0
  const limitZero = await request('GET', '/v1/audit/events?limit=0', { token: ctx.admin })
  const limitNegative = await request('GET', '/v1/audit/events?limit=-1', { token: ctx.admin })
  const limitNaN = await request('GET', '/v1/audit/events?limit=abc', { token: ctx.admin })
  const zeroCount = limitZero.json?.events?.length ?? 0
  const negativeCount = limitNegative.json?.events?.length ?? 0
  const nanCount = limitNaN.json?.events?.length ?? 0
  manualCase({
    id: 'U8',
    area: 'audit',
    sev: 'P2',
    op: '分页：limit=0 / -1 / abc 的边界',
    expected: 'limit=0 返回 0 条，负数/非数字 400 或 0 条（不得全量返回）',
    actual: `total(limit=200)=${totalEvents} limit0=${zeroCount} limit-1=${negativeCount} limitabc=${nanCount} statuses=${[limitZero.status, limitNegative.status, limitNaN.status]}`,
    ok:
      zeroCount === 0 &&
      negativeCount <= 200 &&
      nanCount === 0 &&
      [limitZero.status, limitNegative.status, limitNaN.status].every((s) => s === 200 || s === 400)
  })
  const since32 = await request(
    'GET',
    `/v1/audit/events?since=${encodeURIComponent(new Date(Date.now() - 32 * 86400000).toISOString())}`,
    { token: ctx.admin }
  )
  manualCase({
    id: 'U11',
    area: 'audit',
    sev: 'P3',
    op: '时间窗：32 天',
    expected: '400 TIME_WINDOW_TOO_LARGE',
    actual: `HTTP ${since32.status} ${since32.json?.error?.code ?? ''}`,
    ok: since32.status === 400 && since32.json?.error?.code === 'TIME_WINDOW_TOO_LARGE'
  })
  // U12: bad since is intentionally ignored for old clients (audit-query.ts:91-95; test/audit-query.test.ts:223).
  const sinceBadUntil = new Date().toISOString()
  const sinceBadControl = await request(
    'GET',
    `/v1/audit/events?limit=50&until=${encodeURIComponent(sinceBadUntil)}`,
    { token: ctx.admin }
  )
  const sinceBad = await request(
    'GET',
    `/v1/audit/events?limit=50&since=not-a-date&until=${encodeURIComponent(sinceBadUntil)}`,
    { token: ctx.admin }
  )
  const sinceBadSeqs = (sinceBad.json?.events ?? []).map((event) => event.seq)
  const sinceBadControlSeqs = (sinceBadControl.json?.events ?? []).map((event) => event.seq)
  manualCase({
    id: 'U12',
    area: 'audit',
    sev: 'P3',
    op: '时间窗：非法日期',
    expected: '200 且忽略 since（与无 since 控制查询一致）',
    actual: `HTTP ${sinceBad.status} n=${sinceBadSeqs.length} sameAsControl=${JSON.stringify(sinceBadSeqs) === JSON.stringify(sinceBadControlSeqs)}`,
    ok:
      sinceBad.status === 200 &&
      sinceBadControl.status === 200 &&
      sinceBadSeqs.length > 0 &&
      JSON.stringify(sinceBadSeqs) === JSON.stringify(sinceBadControlSeqs)
  })
  const cursorBad = await request('GET', '/v1/audit/events?cursor=abc', { token: ctx.admin })
  manualCase({
    id: 'U13',
    area: 'audit',
    sev: 'P3',
    op: '分页：非法 cursor',
    expected: '400 明确拒绝',
    actual: `HTTP ${cursorBad.status} n=${cursorBad.json?.events?.length}`,
    ok: cursorBad.status === 400
  })
  await probe({
    id: 'U14',
    area: 'audit',
    sev: 'P2',
    method: 'GET',
    pathname: '/v1/audit/events',
    token: ctx.dev,
    op: '开发者读审计',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })

  const eventTypes = [
    'login',
    'logout',
    'project_create',
    'project_update',
    'project_archive',
    'project_restore',
    'project_connect',
    'grant_update',
    'policy_update',
    'host_token_create',
    'host_register',
    'host_maintenance',
    'host_grant_update',
    'host_provision_policy_update',
    'web_handoff',
    'audit_verify'
  ]
  for (const eventType of eventTypes) {
    const res = await request('GET', `/v1/audit/events?eventType=${eventType}&limit=5`, {
      token: ctx.admin
    })
    manualCase({
      id: `U2-${eventType}`,
      area: 'audit',
      sev: 'P2',
      op: `敏感操作落链：${eventType}`,
      expected: '至少 1 条事件',
      actual: `n=${res.json?.events?.length ?? 0}`,
      ok: (res.json?.events?.length ?? 0) > 0
    })
  }

  // --------------------------------------------------------- relay/internal
  const relays = await request('GET', '/v1/relays', { token: ctx.admin })
  const relayRow = relays.json?.relays?.[0] ?? {}
  await probe({
    id: 'R1',
    area: 'relay',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/relays',
    token: ctx.admin,
    op: '/v1/relays 形态',
    expected: '200 且含 id/host/browserHost/port/online/lastSeenAt',
    check: has(
      (res) =>
        res.status === 200 &&
        Array.isArray(res.json?.relays) &&
        res.json.relays.every(
          (node) =>
            typeof node.id === 'string' &&
            typeof node.host === 'string' &&
            typeof node.browserHost === 'string' &&
            typeof node.port === 'number' &&
            typeof node.online === 'boolean' &&
            typeof node.lastSeenAt === 'number'
        )
    ),
    note: `observed=${brief(relayRow)}`
  })
  await probe({
    id: 'R2',
    area: 'relay',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/relays',
    token: ctx.dev,
    op: '开发者读中继',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  const internalCases = [
    ['R3', 'GET', '/v1/internal/relays', undefined, 401],
    ['R4', 'GET', '/v1/internal/relays', 'm114-link-token', 200],
    ['R5', 'GET', '/v1/internal/policy', undefined, 401],
    ['R6', 'GET', '/v1/internal/policy', 'm114-link-token', 200],
    ['R7', 'GET', '/v1/internal/revocations', 'm114-link-token', 200],
    ['R8', 'GET', '/v1/internal/relay-routes', 'm114-link-token', 200],
    ['R9', 'GET', '/v1/internal/relay-routes', undefined, 401],
    ['R13', 'GET', '/v1/internal/not-a-route', undefined, 404]
  ]
  for (const [id, method, pathname, token, expectedStatus] of internalCases) {
    await probe({
      id,
      area: 'internal',
      sev: 'P3',
      method,
      pathname,
      headers: token === undefined ? {} : { 'x-internal-token': token },
      op: `内部控制面：${method} ${pathname} ${token ? '带令牌' : '无令牌'}`,
      expected: `HTTP ${expectedStatus}`,
      check: isStatus(expectedStatus)
    })
  }
  await probe({
    id: 'R10',
    area: 'internal',
    sev: 'P2',
    method: 'POST',
    pathname: '/v1/internal/relay-endpoint',
    body: { port: 18443 },
    op: '中继注册：无内部令牌',
    expected: '401 INTERNAL_TOKEN_INVALID',
    check: isError(401, 'INTERNAL_TOKEN_INVALID')
  })
  for (const [id, portValue, label] of [
    ['R11a', 0, 'port=0'],
    ['R11b', 70000, 'port=70000'],
    ['R11c', 'abc', 'port="abc"'],
    ['R11d', undefined, '缺 port']
  ]) {
    await probe({
      id,
      area: 'internal',
      sev: 'P3',
      method: 'POST',
      pathname: '/v1/internal/relay-endpoint',
      headers: { 'x-internal-token': 'm114-link-token' },
      body: { port: portValue },
      op: `中继注册：${label}`,
      expected: '400 RELAY_PORT_INVALID',
      check: isError(400, 'RELAY_PORT_INVALID')
    })
  }

  // CORS.
  const hostOrigin = ctx.hostDev02?.directAddrs?.[0]
    ? `https://${ctx.hostDev02.directAddrs[0]}`
    : ''
  const corsAllowed = await request('GET', '/v1/me', {
    token: ctx.admin,
    headers: { origin: hostOrigin }
  })
  const corsEvil = await request('GET', '/v1/me', {
    token: ctx.admin,
    headers: { origin: 'https://evil.example' }
  })
  manualCase({
    id: 'R14',
    area: 'cors',
    sev: 'P3',
    op: 'CORS：宿主直连 origin 白名单',
    expected: '回显 access-control-allow-origin',
    actual: `allowed=${corsAllowed.headers['access-control-allow-origin']} evil=${corsEvil.headers['access-control-allow-origin'] ?? 'absent'}`,
    ok:
      corsAllowed.headers['access-control-allow-origin'] === hostOrigin &&
      corsEvil.headers['access-control-allow-origin'] === undefined
  })
  const preflight = await request('OPTIONS', '/v1/me', { headers: { origin: hostOrigin } })
  manualCase({
    id: 'R15',
    area: 'cors',
    sev: 'P3',
    op: 'CORS 预检',
    expected: '204 + allow-methods',
    actual: `HTTP ${preflight.status} methods=${preflight.headers['access-control-allow-methods'] ?? 'absent'}`,
    ok: preflight.status === 204 && Boolean(preflight.headers['access-control-allow-methods'])
  })

  // ------------------------------------------------------- static/contract
  await probe({
    id: 'W1',
    area: 'static',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/web/release',
    op: '前端发布清单（公开）',
    expected: '200 contract/minContract/build/assets',
    check: has(
      (res) =>
        res.status === 200 &&
        typeof res.json?.contract === 'number' &&
        typeof res.json?.build === 'string'
    )
  })
  for (const [id, value, expectedStatus] of [
    ['W2', '2', 426],
    ['W3', 'abc', 426],
    ['W4', '1', 200]
  ]) {
    await probe({
      id,
      area: 'static',
      sev: 'P3',
      method: 'GET',
      pathname: '/v1/me',
      token: ctx.admin,
      headers: { 'x-orca-web-contract': value },
      op: `web contract 版本 ${value}`,
      expected: `HTTP ${expectedStatus}`,
      check: isStatus(expectedStatus)
    })
  }
  const malformedEscape = await request('GET', '/%E0%A4%A')
  manualCase({
    id: 'W5',
    area: 'static',
    sev: 'P3',
    op: '静态资源：非法百分号转义',
    expected: '400/404，不得 500',
    actual: `HTTP ${malformedEscape.status} ${brief(malformedEscape.text)}`,
    ok: malformedEscape.status === 400 || malformedEscape.status === 404
  })
  const traversal = await request('GET', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd')
  manualCase({
    id: 'W6',
    area: 'static',
    sev: 'P0',
    op: '静态资源：路径穿越',
    expected: '404 且不泄露 webRoot 外文件',
    actual: `HTTP ${traversal.status} ${brief(traversal.text).slice(0, 80)}`,
    ok: traversal.status === 404
  })
  await probe({
    id: 'W7',
    area: 'static',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/does-not-exist',
    op: '未知 API 路径',
    expected: '404 NOT_FOUND',
    check: isError(404, 'NOT_FOUND')
  })
  await probe({
    id: 'W8',
    area: 'static',
    sev: 'P3',
    method: 'DELETE',
    pathname: '/v1/projects',
    token: ctx.admin,
    op: '集合端点错误方法',
    expected: '404 或 405',
    check: isStatus(404)
  })
  await probe({
    id: 'W9',
    area: 'static',
    sev: 'P2',
    method: 'GET',
    pathname: '/v1/projects',
    op: '无会话读取项目列表',
    expected: '401 SESSION_EXPIRED',
    check: isError(401, 'SESSION_EXPIRED')
  })
  const traceError = await request('GET', '/v1/projects/proj_missing', {
    token: ctx.admin,
    headers: { 'x-trace-id': 'r2-echo-trace' }
  })
  manualCase({
    id: 'W10',
    area: 'static',
    sev: 'P3',
    op: '错误响应回显调用方 traceId',
    expected: 'error.traceId === 调用方提供的值',
    actual: `traceId=${traceError.json?.error?.traceId}`,
    ok: traceError.json?.error?.traceId === 'r2-echo-trace'
  })

  // ------------------------------------------------------- install scripts
  await probe({
    id: 'H45',
    area: 'hosts',
    sev: 'P3',
    method: 'GET',
    pathname: '/install/host.sh',
    op: '安装脚本：无会话',
    expected: '401 SESSION_EXPIRED',
    check: isError(401, 'SESSION_EXPIRED')
  })
  await probe({
    id: 'H46',
    area: 'hosts',
    sev: 'P3',
    method: 'GET',
    pathname: '/install/host.sh?token=bad',
    token: ctx.admin,
    op: '安装脚本：无效一次性令牌',
    expected: '401 HOST_TOKEN_INVALID',
    check: isError(401, 'HOST_TOKEN_INVALID')
  })
  const installTokenRes = await request('POST', '/v1/hosts/tokens', { token: ctx.admin })
  const installScript = await request(
    'GET',
    `/install/host.sh?token=${installTokenRes.json?.token}`,
    { token: ctx.admin }
  )
  manualCase({
    id: 'H47',
    area: 'hosts',
    sev: 'P3',
    op: '安装脚本：管理员 + 有效令牌',
    expected: '200 shell 脚本且内嵌令牌',
    actual: `HTTP ${installScript.status} type=${installScript.headers['content-type']}`,
    ok:
      installScript.status === 200 &&
      String(installScript.text).includes(String(installTokenRes.json?.token))
  })
  await probe({
    id: 'H48',
    area: 'hosts',
    sev: 'P3',
    method: 'GET',
    pathname: `/install/host.sh?token=${installTokenRes.json?.token}`,
    token: ctx.dev,
    op: '安装脚本：开发者',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  const relayScript = await request('GET', '/install/relay.sh', { token: ctx.admin })
  manualCase({
    id: 'H49',
    area: 'hosts',
    sev: 'P3',
    op: '中继安装脚本：管理员',
    expected: '200 shell 脚本',
    actual: `HTTP ${relayScript.status} type=${relayScript.headers['content-type']}`,
    ok:
      relayScript.status === 200 &&
      String(relayScript.headers['content-type']).includes('shellscript')
  })

  // ------------------------------------------- misc management endpoints
  await probe({
    id: 'M1',
    area: 'misc',
    sev: 'P3',
    method: 'GET',
    pathname: '/health',
    op: '健康检查（公开）',
    expected: '200 ok=true',
    check: has((res) => res.status === 200 && res.json?.ok === true)
  })
  await probe({
    id: 'M2',
    area: 'misc',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/client/config',
    op: '客户端配置（公开）',
    expected: '200 managed/supportsDirect',
    check: has(
      (res) => res.status === 200 && res.json?.managed === true && res.json?.supportsDirect === true
    )
  })
  await probe({
    id: 'M3',
    area: 'misc',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/jwks',
    op: 'JWKS（公开）',
    expected: '200 keys 数组（每项有 kid）',
    check: has(
      (res) =>
        res.status === 200 &&
        Array.isArray(res.json?.keys) &&
        res.json.keys.every((key) => typeof key.kid === 'string')
    )
  })
  await probe({
    id: 'M4',
    area: 'misc',
    sev: 'P3',
    method: 'GET',
    pathname: '/',
    op: '静态入口',
    expected: '200 text/html',
    check: isStatus(200)
  })
  await probe({
    id: 'M5',
    area: 'misc',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/me',
    token: ctx.admin,
    op: '/v1/me 形态',
    expected: '200 user.roles 含 platform:admin',
    check: has(
      (res) => res.status === 200 && (res.json?.user?.roles ?? []).includes('platform:admin')
    )
  })
  await probe({
    id: 'M6',
    area: 'misc',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/me/devices',
    token: ctx.admin,
    op: '/v1/me/devices 形态',
    expected: '200 devices 数组',
    check: has((res) => res.status === 200 && Array.isArray(res.json?.devices))
  })
  await probe({
    id: 'M7',
    area: 'misc',
    sev: 'P3',
    method: 'GET',
    pathname: '/v1/directory',
    token: ctx.admin,
    op: '授权目录：管理员',
    expected: '200 users/groups 数组',
    check: has(
      (res) =>
        res.status === 200 && Array.isArray(res.json?.users) && Array.isArray(res.json?.groups)
    )
  })
  await probe({
    id: 'M8',
    area: 'misc',
    sev: 'P2',
    method: 'GET',
    pathname: '/v1/directory',
    token: ctx.dev,
    op: '授权目录：开发者',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  await probe({
    id: 'M9',
    area: 'misc',
    sev: 'P3',
    method: 'POST',
    pathname: '/v1/admin/signing-keys/rotate',
    token: ctx.admin,
    op: '签名密钥轮换：管理员',
    expected: '200 kid/previousKid/publishedKids',
    check: has(
      (res) =>
        res.status === 200 &&
        typeof res.json?.kid === 'string' &&
        Array.isArray(res.json?.publishedKids)
    )
  })
  await probe({
    id: 'M10',
    area: 'misc',
    sev: 'P2',
    method: 'POST',
    pathname: '/v1/admin/signing-keys/rotate',
    token: ctx.dev,
    op: '签名密钥轮换：开发者',
    expected: '403 PERMISSION_DENIED',
    check: isError(403, 'PERMISSION_DENIED')
  })
  await probe({
    id: 'M11',
    area: 'misc',
    sev: 'P2',
    method: 'DELETE',
    pathname: `/v1/me/devices/${ctx.concurrentDev?.device?.id}`,
    token: ctx.admin,
    op: '删除他人设备',
    expected: '404 NOT_FOUND',
    check: isError(404, 'NOT_FOUND')
  })
  const ownDeviceRevoke = await request(
    'DELETE',
    `/v1/me/devices/${ctx.concurrentDevB?.device?.id}`,
    {
      token: ctx.concurrentDevB?.accessToken
    }
  )
  const revokedDeviceMe = await request('GET', '/v1/me', { token: ctx.concurrentDevB?.accessToken })
  manualCase({
    id: 'M12',
    area: 'misc',
    sev: 'P2',
    op: '删除本人设备并撤销其会话',
    expected: 'DELETE 200，随后该 access token 401',
    actual: `delete=${ownDeviceRevoke.status} me=${revokedDeviceMe.status}`,
    ok: ownDeviceRevoke.status === 200 && revokedDeviceMe.status === 401
  })
  for (const eventType of ['device_revoke', 'signing_key_rotate', 'directory_read']) {
    const res = await request('GET', `/v1/audit/events?eventType=${eventType}&limit=5`, {
      token: ctx.admin
    })
    manualCase({
      id: `M-audit-${eventType}`,
      area: 'audit',
      sev: 'P2',
      op: `敏感操作落链：${eventType}`,
      expected: '至少 1 条事件',
      actual: `n=${res.json?.events?.length ?? 0}`,
      ok: (res.json?.events?.length ?? 0) > 0
    })
  }
}

async function snapshotAfter() {
  const admin = await login(ADMIN, { deviceName: 'r2-cleanup' })
  const projects = await request('GET', '/v1/projects?includeArchived=1', {
    token: admin.accessToken
  })
  const hosts = await request('GET', '/v1/hosts', { token: admin.accessToken })
  const policy = await request('GET', '/v1/policies/download', { token: admin.accessToken })
  return {
    adminToken: admin.accessToken,
    projects: projects.json,
    hosts: hosts.json,
    policy: policy.json
  }
}

async function cleanup() {
  let adminToken = null
  try {
    adminToken = (await login(ADMIN, { deviceName: 'r2-cleanup' })).accessToken
  } catch (error) {
    return { ok: false, error: error.message }
  }
  const archived = []
  for (const projectId of new Set(ctx.temp.projectIds.filter(Boolean))) {
    const res = await request('POST', `/v1/projects/${projectId}/archive`, { token: adminToken })
    archived.push({ projectId, status: res.status })
  }
  const restoredPolicy = await request('PUT', '/v1/policies/download', {
    token: adminToken,
    body: {
      downloadDefault: baseline?.policy?.downloadDefault ?? 'allow',
      readRatePerHour: baseline?.policy?.readRatePerHour ?? { calls: 600, bytes: 67108864 }
    }
  })
  const revoked = []
  for (const hostId of new Set(ctx.temp.hostIds.filter(Boolean))) {
    const res = await request('DELETE', `/v1/hosts/${hostId}`, { token: adminToken })
    revoked.push({ hostId, status: res.status })
  }
  return { ok: true, archived, revoked, restoredPolicyStatus: restoredPolicy.status }
}

async function runHostRevokeProbes() {
  if (!ctx.h1?.id) return
  for (const project of [ctx.t2, ctx.t6, ctx.t7]) {
    if (project?.id)
      await request('POST', `/v1/projects/${project.id}/archive`, { token: ctx.admin })
  }
  await probe({
    id: 'H39',
    area: 'hosts',
    sev: 'P3',
    method: 'DELETE',
    pathname: `/v1/hosts/${ctx.h1.id}`,
    token: ctx.admin,
    op: '吊销测试宿主',
    expected: '200 ok',
    check: isStatus(200)
  })
  await probe({
    id: 'H40',
    area: 'hosts',
    sev: 'P3',
    method: 'DELETE',
    pathname: `/v1/hosts/${ctx.h1.id}`,
    token: ctx.admin,
    op: '重复吊销',
    expected: '200（幂等）',
    check: isStatus(200)
  })
  await probe({
    id: 'H41',
    area: 'hosts',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/heartbeat`,
    token: ctx.h1.credential,
    body: { status: 'online' },
    op: '吊销后心跳',
    expected: '200 hostRevoked=true',
    check: has((res) => res.status === 200 && res.json?.hostRevoked === true)
  })
  await probe({
    id: 'H42',
    area: 'hosts',
    sev: 'P2',
    method: 'POST',
    pathname: `/v1/hosts/${ctx.h1.id}/maintenance`,
    token: ctx.admin,
    body: { enabled: true },
    op: '吊销后进入维护',
    expected: '409 HOST_REVOKED',
    check: isError(409, 'HOST_REVOKED')
  })
  await probe({
    id: 'H43',
    area: 'hosts',
    sev: 'P3',
    method: 'DELETE',
    pathname: '/v1/hosts/host_missing',
    token: ctx.admin,
    op: '吊销不存在主机',
    expected: '404 HOST_NOT_FOUND',
    check: isError(404, 'HOST_NOT_FOUND')
  })
}

let cleanupResult = null
let fatal = null

try {
  await main()
  await runHostRevokeProbes()
} catch (error) {
  fatal = { message: error.message, stack: error.stack }
} finally {
  cleanupResult = await cleanup()
}

const summary = {
  baseUrl: BASE,
  capturedAt: new Date().toISOString(),
  totalCases: cases.length,
  passed: cases.filter((row) => row.ok).length,
  failed: cases.filter((row) => !row.ok).length,
  findingsByLevel: findings.reduce((acc, finding) => {
    acc[finding.level] = (acc[finding.level] ?? 0) + 1
    return acc
  }, {}),
  coveredEndpoints: [
    ...new Set(cases.filter((row) => row.method).map((row) => `${row.method} ${row.path}`))
  ].sort()
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
fs.writeFileSync(
  path.join(EVIDENCE_DIR, 'api.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      baseUrl: BASE,
      method: 'live platform exploratory probe (read-only + reversible)',
      summary,
      findings,
      cleanup: cleanupResult,
      fatal,
      baseline: {
        capturedAt: baseline?.capturedAt ?? null,
        projectCount: baseline?.projects?.length ?? null,
        hostCount: baseline?.hosts?.length ?? null,
        policy: baseline?.policy ?? null
      }
    },
    null,
    2
  )}\n`
)
fs.writeFileSync(
  path.join(EVIDENCE_DIR, 'api-raw.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: BASE, baseline, cases, cleanup: cleanupResult, fatal }, null, 2)}\n`
)

const levelLine = ['P0', 'P1', 'P2', 'P3']
  .map((level) => `${level}=${summary.findingsByLevel[level] ?? 0}`)
  .join(' ')
console.log(
  `exploratory-r2: cases=${summary.totalCases} passed=${summary.passed} failed=${summary.failed} findings(${levelLine})`
)
for (const finding of findings) {
  console.log(`[${finding.level}] ${finding.id} ${finding.endpoint} :: ${finding.actual}`)
}
console.log(`cleanup: ${JSON.stringify(cleanupResult)}`)
if (fatal) {
  console.error('fatal:', fatal.message)
  process.exitCode = 2
}
