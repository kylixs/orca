#!/usr/bin/env node
/**
 * Exploratory probe: authorization API x multi-host x multi-project combinations.
 *
 * Writes findings to cloud-platform/evidence/exploratory-r2/authz-api-combo.json
 * and a raw request log beside it. Every mutation is reversible: host grants and
 * project grants are snapshotted and replayed, provision policies go back to
 * 'open' (the documented default), and probe projects are archived.
 *
 * Env: ORCA_LOCAL_ENV_ROOT (default ~/orca-local-env), ORCA_LOCAL_PLATFORM_URL
 * (default https://127.0.0.1:18787).
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
const STAMP = Date.now().toString(36).slice(-6)

// Seed IDs change on every reseed: discover by host name / project key at run
// time and fail INVALID before any mutation when a required seed is missing (U192).
let H2
let H3
let P_DEMO
let P_ZHAN
let P_INFRA
let P_LAB
let P_PAYMENT

const PEOPLE = {
  admin: { username: 'admin', password: 'Adm1n!', groups: ['platform-admins'] },
  zhangsan: { username: 'zhangsan', password: 'Passw0rd!', groups: ['developers', 'team-payment'] },
  lisi: { username: 'lisi', password: 'Passw0rd!', groups: ['developers'] }
}

const cases = []
const raw = []
const tokens = {}
const users = {}
const devices = {}

function nowIso() {
  return new Date().toISOString()
}

function brief(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return (text ?? '').replace(/\s+/g, ' ').slice(0, max)
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
          const entry = {
            at: nowIso(),
            method,
            pathname,
            token: token ? 'present' : null,
            body: body === undefined ? undefined : brief(body, 240),
            status: res.statusCode,
            response: brief(json ?? text, 600)
          }
          raw.push(entry)
          resolve({ status: res.statusCode, json, text })
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

async function login(name) {
  const person = PEOPLE[name]
  const res = await request('POST', '/v1/auth/login', {
    body: { username: person.username, password: person.password }
  })
  if (res.status === 200) {
    tokens[name] = res.json.accessToken
    users[name] = res.json.user
    devices[name] = res.json.device
  }
  return res
}

function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  const sa = [...new Set(a)].sort()
  const sb = [...new Set(b)].sort()
  return sa.length === sb.length && sa.every((value, index) => value === sb[index])
}

function rowKey(row) {
  return `${row.subjectType}:${row.subjectId}`
}

function decodeCredential(credential) {
  const parts = String(credential ?? '').split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Records one case. `checks` is a list of {name, ok, detail}; a case fails when
 * any check is false. Severity is the level a failure would carry.
 */
function record(input) {
  const failed = input.checks.filter((check) => !check.ok)
  const verdict = failed.length === 0 ? 'pass' : 'fail'
  const entry = {
    id: input.id,
    area: input.area,
    combo: input.combo,
    endpoint: input.endpoint,
    expected: input.expected,
    actual: input.actual,
    severity: input.severity ?? 'P3',
    verdict,
    failedChecks: failed.map((check) => `${check.name}: ${check.detail ?? ''}`.trim()),
    evidence: input.evidence ?? null
  }
  cases.push(entry)
  console.log(
    `${verdict === 'pass' ? 'PASS' : 'FAIL'} ${input.id} ${input.endpoint} — ${input.combo}`
  )
  return entry
}

async function getHostGrants(hostId, token = tokens.admin) {
  const res = await request('GET', `/v1/hosts/${hostId}/grants`, { token })
  return { res, rows: res.json?.grants ?? [] }
}

async function putHostGrant(hostId, subject, permissions, token = tokens.admin) {
  return request('PUT', `/v1/hosts/${hostId}/grants`, {
    token,
    body: { subjectType: subject.type, subjectId: subject.id, permissions }
  })
}

async function getProjectGrants(projectId, token = tokens.admin) {
  const res = await request('GET', `/v1/projects/${projectId}/grants`, { token })
  return { res, rows: res.json?.grants ?? [] }
}

async function putProjectGrant(projectId, subject, permissions, token = tokens.admin) {
  return request('PUT', `/v1/projects/${projectId}/grants`, {
    token,
    body: { subjectType: subject.type, subjectId: subject.id, permissions }
  })
}

async function available(token) {
  const res = await request('GET', '/v1/hosts/available', { token })
  const byId = new Map((res.json?.hosts ?? []).map((host) => [host.id, host]))
  return { res, byId }
}

async function setPolicy(hostId, mode, token = tokens.admin) {
  return request('PUT', `/v1/hosts/${hostId}/provision-policy`, {
    token,
    body: { mode }
  })
}

async function selfCreate(token, { hostId, name, dir }) {
  const body = { name, dir }
  if (hostId) body.hostId = hostId
  return request('POST', '/v1/projects/self', { token, body })
}

async function adminCreate({ hostId, key, name, projectPath }) {
  return request('POST', '/v1/projects', {
    token: tokens.admin,
    body: { hostId, key, name, path: projectPath, defaultBranch: 'main' }
  })
}

async function archiveProject(projectId, token = tokens.admin) {
  return request('POST', `/v1/projects/${projectId}/archive`, { token, body: {} })
}

async function connect(user, projectId) {
  const res = await request('POST', `/v1/projects/${projectId}/connect`, {
    token: tokens[user],
    body: { deviceId: devices[user].id, clientVersion: '1.5.0' }
  })
  return { res, payload: decodeCredential(res.json?.credential) }
}

async function handoff(user, projectId, surface) {
  const body = surface ? { surface } : {}
  return request('POST', `/v1/projects/${projectId}/web-handoff`, {
    token: tokens[user],
    body
  })
}

async function directory(token = tokens.admin) {
  const res = await request('GET', '/v1/directory', { token })
  return res
}

async function auditQuery(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }
  const res = await request('GET', `/v1/audit/events?${search.toString()}`, { token: tokens.admin })
  return { res, events: res.json?.events ?? [] }
}

function rowOf(rows, subjectType, subjectId) {
  return rows.find((row) => row.subjectType === subjectType && row.subjectId === subjectId)
}

/** Resolve seed IDs by stable host name / project key; abort before any mutation. */
async function discoverSeeds() {
  const hostsRes = await request('GET', '/v1/hosts', { token: tokens.admin })
  const projectsRes = await request('GET', '/v1/projects?includeArchived=0', {
    token: tokens.admin
  })
  if (hostsRes.status !== 200 || projectsRes.status !== 200) {
    fs.writeSync(
      2,
      `INVALID: seed discovery failed: GET /v1/hosts -> ${hostsRes.status}, GET /v1/projects -> ${projectsRes.status}\n`
    )
    process.exit(2)
  }
  const hostByName = new Map((hostsRes.json?.hosts ?? []).map((host) => [host.name, host]))
  const projectByKey = new Map(
    (projectsRes.json?.projects ?? []).map((project) => [project.key, project])
  )
  const missing = []
  const host = (name) => {
    const found = hostByName.get(name)
    if (!found) {
      missing.push(`host ${name}`)
    }
    return found
  }
  const project = (key) => {
    const found = projectByKey.get(key)
    if (!found) {
      missing.push(`project ${key}`)
    }
    return found
  }
  H2 = host('dev-local-02')?.id
  H3 = host('dev-local-03')?.id
  P_DEMO = project('demo-app')?.id
  P_ZHAN = project('zhangsan-demo')?.id
  P_INFRA = project('infra-tools')?.id
  P_LAB = project('zhangsan-lab')?.id
  P_PAYMENT = project('payment-service')?.id
  if (missing.length) {
    fs.writeSync(2, `INVALID: missing required seed(s) on ${BASE}: ${missing.join(', ')}\n`)
    process.exit(2)
  }
  const seeds = {
    hosts: { 'dev-local-02': H2, 'dev-local-03': H3 },
    projects: {
      'demo-app': P_DEMO,
      'zhangsan-demo': P_ZHAN,
      'infra-tools': P_INFRA,
      'zhangsan-lab': P_LAB,
      'payment-service': P_PAYMENT
    }
  }
  console.log('[env] seeds', seeds)
  return seeds
}

async function main() {
  const auditSince = new Date(Date.now() - 2000).toISOString()
  const probeProjects = []
  const scratch = []

  // ---------- Phase 0: identities and baseline ----------
  const logins = {}
  for (const name of Object.keys(PEOPLE)) logins[name] = await login(name)
  const seeds = await discoverSeeds()
  record({
    id: 'A1',
    area: 'identity',
    combo: 'admin + zhangsan + lisi 登录（lisi 首次登录落目录）',
    endpoint: 'POST /v1/auth/login',
    expected: '三个身份均 200，user id/device id 互异；admin 含 platform:admin',
    actual: Object.fromEntries(
      Object.entries(logins).map(([name, res]) => [
        name,
        {
          status: res.status,
          userId: res.json?.user?.id,
          deviceId: res.json?.device?.id,
          roles: res.json?.user?.roles
        }
      ])
    ),
    severity: 'P2',
    checks: [
      { name: 'all 200', ok: Object.values(logins).every((res) => res.status === 200) },
      {
        name: 'distinct users',
        ok: new Set(Object.values(users).map((user) => user.id)).size === 3
      },
      { name: 'admin role', ok: users.admin.roles.includes('platform:admin') }
    ]
  })

  const dirBaseline = await directory()
  const baseGroups = dirBaseline.json?.groups ?? []
  record({
    id: 'A2',
    area: 'directory',
    combo: '目录基线（登录后已知组并集）',
    endpoint: 'GET /v1/directory',
    expected: '200；含 developers / platform-admins / team-payment',
    actual: { status: dirBaseline.status, groups: baseGroups },
    severity: 'P3',
    checks: [
      { name: 'status', ok: dirBaseline.status === 200 },
      {
        name: 'baseline groups',
        ok: ['developers', 'platform-admins', 'team-payment'].every((group) =>
          baseGroups.includes(group)
        )
      }
    ]
  })

  // The instance is shared with other operators, so hold the pre-run host-grant
  // snapshot, clear both hosts for a known baseline, and replay the snapshot at
  // the end. A pre-run row is recorded, never asserted away.
  const hostGrantSnapshot = {
    h2: (await getHostGrants(H2)).rows,
    h3: (await getHostGrants(H3)).rows
  }
  for (const [hostId, snapshot] of [
    [H2, hostGrantSnapshot.h2],
    [H3, hostGrantSnapshot.h3]
  ]) {
    for (const row of snapshot) {
      await putHostGrant(hostId, { type: row.subjectType, id: row.subjectId }, [])
    }
  }
  const h2Baseline = await getHostGrants(H2)
  const h3Baseline = await getHostGrants(H3)
  record({
    id: 'A3',
    area: 'host-grants',
    combo: '双主机主授权基线（快照 → 隔离清空）',
    endpoint: 'GET/PUT /v1/hosts/{id}/grants × 2',
    expected: '清空后两台主机无主机授权行；清空前的行集完整记录并以快照在收尾还原',
    actual: {
      snapshot: hostGrantSnapshot,
      afterClear: { h2: h2Baseline.rows, h3: h3Baseline.rows }
    },
    severity: 'P2',
    checks: [
      { name: 'h2 empty after clear', ok: h2Baseline.rows.length === 0 },
      { name: 'h3 empty after clear', ok: h3Baseline.rows.length === 0 }
    ],
    evidence: { note: '共享实例：其它操作者的行以 ENV 记录，不作为缺陷' }
  })

  const seedProjectIds = [P_DEMO, P_ZHAN, P_INFRA, P_LAB, P_PAYMENT]
  const projectBaseline = new Map()
  for (const projectId of seedProjectIds) {
    const snapshot = await getProjectGrants(projectId)
    projectBaseline.set(projectId, snapshot.rows)
  }
  record({
    id: 'A4',
    area: 'project-grants',
    combo: '种子项目授权快照（用于逐行还原）',
    endpoint: 'GET /v1/projects/{id}/grants × 5',
    expected: '每个项目返回 grants 数组（admin 可读）',
    actual: Object.fromEntries(
      [...projectBaseline].map(([id, rows]) => [
        id,
        rows.map((row) => ({ k: rowKey(row), p: row.permissions }))
      ])
    ),
    severity: 'P2',
    checks: [
      {
        name: 'all readable',
        ok: [...projectBaseline.values()].every((rows) => Array.isArray(rows))
      },
      {
        name: 'admin has open on h2/h3 seeds used for handoff',
        ok: [P_DEMO, P_ZHAN, P_INFRA].every((id) =>
          projectBaseline
            .get(id)
            .some(
              (row) =>
                row.subjectType === 'user' &&
                row.subjectId === users.admin.id &&
                row.permissions.includes('open')
            )
        )
      }
    ],
    evidence: { note: 'P_LAB 的 admin 无显式 open（矩阵外侧证）' }
  })

  const verifyBaseline = await request('GET', '/v1/audit/verify', { token: tokens.admin })
  record({
    id: 'A5',
    area: 'audit',
    combo: '开局审计链完整性',
    endpoint: 'GET /v1/audit/verify',
    expected: '200 ok=true checked>0',
    actual: { status: verifyBaseline.status, body: brief(verifyBaseline.json) },
    severity: 'P0',
    checks: [
      { name: 'status', ok: verifyBaseline.status === 200 },
      { name: 'ok', ok: verifyBaseline.json?.ok === true },
      { name: 'checked', ok: Number(verifyBaseline.json?.checked) > 0 }
    ]
  })

  const lisiSub = { type: 'user', id: users.lisi.id }
  const zhangSub = { type: 'user', id: users.zhangsan.id }
  const devGroup = { type: 'group', id: 'developers' }
  const paymentGroup = { type: 'group', id: 'team-payment' }
  const adminSub = { type: 'user', id: users.admin.id }

  // ---------- Phase 1: host-grant row semantics x two hosts ----------
  let res = await putHostGrant(H2, lisiSub, ['provision'])
  let h2 = await getHostGrants(H2)
  let h3 = await getHostGrants(H3)
  record({
    id: 'B1',
    area: 'host-grants',
    combo: '同主体仅 host2 直授 provision',
    endpoint: 'PUT/GET /v1/hosts/{id}/grants',
    expected: 'h2 200 且仅 lisi/provision；h3 仍为空（按主机隔离）',
    actual: { put: res.status, h2: h2.rows, h3: h3.rows },
    severity: 'P1',
    checks: [
      { name: 'put 200', ok: res.status === 200 },
      {
        name: 'h2 row',
        ok:
          h2.rows.length === 1 &&
          h2.rows[0].subjectType === 'user' &&
          h2.rows[0].subjectId === users.lisi.id &&
          sameSet(h2.rows[0].permissions, ['provision']) &&
          h2.rows[0].username === 'lisi'
      },
      { name: 'h3 empty', ok: h3.rows.length === 0 }
    ]
  })

  res = await putHostGrant(H3, lisiSub, ['provision'])
  h3 = await getHostGrants(H3)
  h2 = await getHostGrants(H2)
  record({
    id: 'B2',
    area: 'host-grants',
    combo: '同主体跨主机双行独立存在',
    endpoint: 'PUT/GET /v1/hosts/{id}/grants',
    expected: 'h3 200 且出现同主体另一行；h2 行不受影响',
    actual: { put: res.status, h2: h2.rows, h3: h3.rows },
    severity: 'P1',
    checks: [
      { name: 'put 200', ok: res.status === 200 },
      {
        name: 'h3 row',
        ok: rowOf(h3.rows, 'user', users.lisi.id)?.permissions?.includes('provision') === true
      },
      {
        name: 'h2 unaffected',
        ok: rowOf(h2.rows, 'user', users.lisi.id)?.permissions?.includes('provision') === true
      }
    ]
  })

  res = await putHostGrant(H3, lisiSub, [])
  h3 = await getHostGrants(H3)
  record({
    id: 'B3',
    area: 'host-grants',
    combo: 'PUT 空数组 = 删除整行（仅该主机）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '200；h3 行消失；h2 行保留',
    actual: { put: res.status, h2: (await getHostGrants(H2)).rows, h3: h3.rows },
    severity: 'P2',
    checks: [
      { name: 'put 200', ok: res.status === 200 },
      { name: 'h3 row gone', ok: rowOf(h3.rows, 'user', users.lisi.id) === undefined },
      {
        name: 'h2 row kept',
        ok: rowOf((await getHostGrants(H2)).rows, 'user', users.lisi.id) !== undefined
      }
    ]
  })

  await putHostGrant(H2, lisiSub, ['provision'])
  res = await putHostGrant(H2, lisiSub, ['maintain'])
  h2 = await getHostGrants(H2)
  record({
    id: 'B4',
    area: 'host-grants',
    combo: 'PUT 全量替换（部分位）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '第二次 PUT 后行为 maintain，provision 不残留（非合并）',
    actual: { put: res.status, rows: h2.rows },
    severity: 'P2',
    checks: [
      { name: 'put 200', ok: res.status === 200 },
      {
        name: 'exact replace',
        ok: sameSet(rowOf(h2.rows, 'user', users.lisi.id)?.permissions ?? [], ['maintain'])
      }
    ]
  })

  res = await putHostGrant(H2, lisiSub, ['provision', 'view'])
  h2 = await getHostGrants(H2)
  const superset = sameSet(rowOf(h2.rows, 'user', users.lisi.id)?.permissions ?? [], [
    'provision',
    'view'
  ])
  await putHostGrant(H2, lisiSub, ['provision'])
  record({
    id: 'B5',
    area: 'host-grants',
    combo: '超集往返（provision+view → provision）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '超集 200 原样回读；回落 200 仅 provision',
    actual: {
      superset: rowOf((await getHostGrants(H2)).rows, 'user', users.lisi.id),
      supersetOk: superset
    },
    severity: 'P2',
    checks: [
      { name: 'superset exact', ok: superset },
      {
        name: 'round-trip back',
        ok: sameSet(
          rowOf((await getHostGrants(H2)).rows, 'user', users.lisi.id)?.permissions ?? [],
          ['provision']
        )
      }
    ]
  })

  res = await putHostGrant(H2, devGroup, ['provision'])
  h2 = await getHostGrants(H2)
  record({
    id: 'B6',
    area: 'host-grants',
    combo: '组行与用户行并存（同主机同权限位）',
    endpoint: 'PUT/GET /v1/hosts/{id}/grants',
    expected: '200；两条独立行：group developers 与 user lisi 均 provision',
    actual: { put: res.status, rows: h2.rows },
    severity: 'P2',
    checks: [
      { name: 'put 200', ok: res.status === 200 },
      {
        name: 'two rows',
        ok:
          h2.rows.filter((row) => row.permissions.includes('provision')).length === 2 &&
          rowOf(h2.rows, 'group', 'developers') !== undefined &&
          rowOf(h2.rows, 'user', users.lisi.id) !== undefined
      }
    ]
  })

  res = await putHostGrant(H2, zhangSub, ['root'])
  h2 = await getHostGrants(H2)
  record({
    id: 'B7',
    area: 'host-grants',
    combo: '非法主机权限位',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '400 HOST_GRANT_PERMISSION_INVALID；既有组/用户行保持',
    actual: { status: res.status, code: res.json?.error?.code, rows: h2.rows },
    severity: 'P3',
    checks: [
      { name: 'status 400', ok: res.status === 400 },
      { name: 'code', ok: res.json?.error?.code === 'HOST_GRANT_PERMISSION_INVALID' },
      { name: 'rows preserved', ok: h2.rows.length === 2 }
    ]
  })

  res = await putHostGrant(H2, zhangSub, 'provision')
  h2 = await getHostGrants(H2)
  record({
    id: 'B8',
    area: 'host-grants',
    combo: 'permissions 类型错误（字符串）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '400 HOST_GRANT_PERMISSION_INVALID；既有行不得被静默删除',
    actual: { status: res.status, code: res.json?.error?.code, rows: h2.rows },
    severity: 'P2',
    checks: [
      { name: 'status 400', ok: res.status === 400 },
      { name: 'code', ok: res.json?.error?.code === 'HOST_GRANT_PERMISSION_INVALID' },
      { name: 'rows preserved', ok: h2.rows.length === 2 }
    ]
  })

  const missUser = await putHostGrant(H2, { type: 'user', id: 'no-such-user' }, ['provision'])
  const missGroup1 = await putHostGrant(H2, { type: 'group', id: 'no-such-group' }, ['provision'])
  const missGroup2 = await putHostGrant(H2, { type: 'group', id: 'no-such-group' }, ['provision'])
  const dirAfterMiss = await directory()
  record({
    id: 'B9',
    area: 'host-grants',
    combo: '未知用户 / 未知组（幂等 400）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '400 USER_NOT_FOUND / 400 GROUP_NOT_FOUND ×2 一致；目录不新增组',
    actual: {
      user: { status: missUser.status, code: missUser.json?.error?.code },
      group: [
        { status: missGroup1.status, code: missGroup1.json?.error?.code },
        { status: missGroup2.status, code: missGroup2.json?.error?.code }
      ],
      groups: dirAfterMiss.json?.groups
    },
    severity: 'P3',
    checks: [
      {
        name: 'user 400',
        ok: missUser.status === 400 && missUser.json?.error?.code === 'USER_NOT_FOUND'
      },
      {
        name: 'group 400 x2',
        ok:
          missGroup1.status === 400 &&
          missGroup1.json?.error?.code === 'GROUP_NOT_FOUND' &&
          missGroup2.status === 400 &&
          missGroup2.json?.error?.code === 'GROUP_NOT_FOUND'
      },
      {
        name: 'directory unchanged',
        ok: sameSet(dirAfterMiss.json?.groups ?? [], baseGroups)
      }
    ]
  })

  res = await putHostGrant(H2, lisiSub, ['provision'], tokens.zhangsan)
  const denyAudit = await auditQuery({
    actor: 'zhangsan',
    eventType: 'host_grant_update',
    since: auditSince
  })
  record({
    id: 'B10',
    area: 'host-grants',
    combo: '开发者写主机授权被拒',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '403 PERMISSION_DENIED + denied 审计（host_grant_update, targetId=host）',
    actual: {
      status: res.status,
      code: res.json?.error?.code,
      audit: denyAudit.events.map((event) => ({ r: event.result, t: event.targetId }))
    },
    severity: 'P2',
    checks: [
      { name: '403', ok: res.status === 403 && res.json?.error?.code === 'PERMISSION_DENIED' },
      {
        name: 'denied audit',
        ok: denyAudit.events.some((event) => event.result === 'denied' && event.targetId === H2)
      }
    ]
  })

  const beforeReadDenied = await auditQuery({
    actor: 'zhangsan',
    eventType: 'host_grant_update',
    result: 'denied',
    since: auditSince
  })
  res = await request('GET', `/v1/hosts/${H2}/grants`, { token: tokens.zhangsan })
  const readDenyAudit = await auditQuery({
    actor: 'zhangsan',
    eventType: 'host_grant_update',
    result: 'denied',
    since: auditSince
  })
  record({
    id: 'B11',
    area: 'host-grants',
    combo: '开发者读主机授权被拒 + 审计事件类型',
    endpoint: 'GET /v1/hosts/{id}/grants',
    expected: '403；读请求不应被记成 host_grant_update（写事件类型）',
    actual: {
      status: res.status,
      code: res.json?.error?.code,
      deniedUpdateEventsBeforeRead: beforeReadDenied.events.length,
      deniedUpdateEventsAfterRead: readDenyAudit.events.length
    },
    severity: 'P3',
    checks: [
      { name: '403', ok: res.status === 403 },
      {
        name: 'read adds no write-type denied event',
        ok: readDenyAudit.events.length === beforeReadDenied.events.length
      }
    ],
    evidence: { note: 'server.ts GET /grants 的 denyPrivileged 复用 host_grant_update' }
  })

  res = await putHostGrant(H2, lisiSub, ['provision', 'view'], tokens.admin)
  const roleAttempt = await request('PUT', `/v1/hosts/${H2}/grants`, {
    token: tokens.admin,
    body: { subjectType: 'role', subjectId: users.lisi.id, permissions: ['maintain'] }
  })
  h2 = await getHostGrants(H2)
  record({
    id: 'B12',
    area: 'host-grants',
    combo: '非法 subjectType（role）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '400（subjectType 契约仅 user|group），不得按 user 落行',
    actual: {
      status: roleAttempt.status,
      code: roleAttempt.json?.error?.code,
      lisiRow: rowOf(h2.rows, 'user', users.lisi.id)
    },
    severity: 'P3',
    checks: [
      { name: 'rejected', ok: roleAttempt.status === 400 },
      {
        name: 'row not rewritten',
        ok: sameSet(rowOf(h2.rows, 'user', users.lisi.id)?.permissions ?? [], ['provision', 'view'])
      }
    ]
  })

  const emptyUnknown = await putHostGrant(H2, { type: 'user', id: 'no-such-user' }, [])
  record({
    id: 'B13',
    area: 'host-grants',
    combo: '删除未知主体（空数组）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '400 USER_NOT_FOUND（先解析后删除），无行被删',
    actual: {
      status: emptyUnknown.status,
      code: emptyUnknown.json?.error?.code,
      rows: (await getHostGrants(H2)).rows.length
    },
    severity: 'P3',
    checks: [
      {
        name: '400',
        ok: emptyUnknown.status === 400 && emptyUnknown.json?.error?.code === 'USER_NOT_FOUND'
      },
      { name: 'rows intact', ok: (await getHostGrants(H2)).rows.length === 2 }
    ]
  })

  const groupAsUser = await putHostGrant(H2, { type: 'group', id: 'zhangsan' }, ['provision'])
  record({
    id: 'B14',
    area: 'host-grants',
    combo: '组行用用户名（subjectType 混淆）',
    endpoint: 'PUT /v1/hosts/{id}/grants',
    expected: '400 GROUP_NOT_FOUND（组主体只接受已知组名）',
    actual: { status: groupAsUser.status, code: groupAsUser.json?.error?.code },
    severity: 'P3',
    checks: [
      {
        name: '400',
        ok: groupAsUser.status === 400 && groupAsUser.json?.error?.code === 'GROUP_NOT_FOUND'
      }
    ]
  })

  // Union precedence: a user row with fewer bits must not subtract group bits.
  await setPolicy(H2, 'restricted')
  await putHostGrant(H2, devGroup, ['provision'])
  await putHostGrant(H2, lisiSub, ['view'])
  const unionAvail = await available(tokens.lisi)
  const unionCreate = await selfCreate(tokens.lisi, {
    hostId: H2,
    name: `combo-union-${STAMP}`,
    dir: `combo-union-${STAMP}`
  })
  if (unionCreate.status === 201) {
    scratch.push(unionCreate.json.id)
    probeProjects.push(unionCreate.json.id)
  }
  record({
    id: 'B15',
    area: 'host-grants',
    combo: '组行 provision + 用户行仅 view（位不相交）',
    endpoint: 'PUT host grants × 2 + GET available + POST self',
    expected: '权限为并集：用户行 view 不削弱组行 provision → available=true 且自助 201',
    actual: {
      rows: (await getHostGrants(H2)).rows,
      provisionAllowed: unionAvail.byId.get(H2)?.provisionAllowed,
      create: unionCreate.status
    },
    severity: 'P1',
    checks: [
      { name: 'allowed by group', ok: unionAvail.byId.get(H2)?.provisionAllowed === true },
      { name: 'create 201', ok: unionCreate.status === 201 }
    ],
    evidence: { note: 'hasHostPermission 为行并集；没有 deny 覆盖语义' }
  })
  await putHostGrant(H2, lisiSub, [])
  await putHostGrant(H2, devGroup, [])
  await setPolicy(H2, 'open')

  // Host bits must never enter a credential.
  await putHostGrant(H2, lisiSub, ['provision', 'maintain', 'view'])
  const lisiHostBitsTicket = await connect('lisi', P_DEMO)
  const ticketPerms = lisiHostBitsTicket.payload?.perms ?? []
  record({
    id: 'B16',
    area: 'host-grants',
    combo: '主机位不进凭证',
    endpoint: 'PUT host grants + POST /v1/projects/{id}/connect',
    expected: '票据 perms 只含项目位；provision/maintain/view 不出现',
    actual: { status: lisiHostBitsTicket.res.status, perms: ticketPerms },
    severity: 'P1',
    checks: [
      { name: 'connect 200', ok: lisiHostBitsTicket.res.status === 200 },
      {
        name: 'no host bits in ticket',
        ok: !['provision', 'maintain', 'view'].some((bit) => ticketPerms.includes(bit))
      }
    ]
  })
  await putHostGrant(H2, lisiSub, [])

  // ---------- Phase 2: provision policy x grants ----------
  await putHostGrant(H2, devGroup, [])
  await putHostGrant(H2, lisiSub, ['provision'])
  const pA = await setPolicy(H2, 'restricted')
  const pB = await setPolicy(H3, 'restricted')
  const availLisiRestricted = await available(tokens.lisi)
  const availAdminRestricted = await available(tokens.admin)
  const availZhangRestricted = await available(tokens.zhangsan)
  record({
    id: 'C1',
    area: 'provision-policy',
    combo: '双主机 restricted 下的可见自助资格',
    endpoint: 'PUT /v1/hosts/{id}/provision-policy + GET /v1/hosts/available',
    expected: 'lisi: h2 true(直授)/h3 false；zhangsan: h2 false/h3 false；admin: 两台 true',
    actual: {
      policy: [pA.status, pB.status],
      lisi: [
        availLisiRestricted.byId.get(H2)?.provisionAllowed,
        availLisiRestricted.byId.get(H3)?.provisionAllowed
      ],
      zhangsan: [
        availZhangRestricted.byId.get(H2)?.provisionAllowed,
        availZhangRestricted.byId.get(H3)?.provisionAllowed
      ],
      admin: [
        availAdminRestricted.byId.get(H2)?.provisionAllowed,
        availAdminRestricted.byId.get(H3)?.provisionAllowed
      ]
    },
    severity: 'P2',
    checks: [
      { name: 'policies 200', ok: pA.status === 200 && pB.status === 200 },
      {
        name: 'lisi per-host',
        ok:
          availLisiRestricted.byId.get(H2)?.provisionAllowed === true &&
          availLisiRestricted.byId.get(H3)?.provisionAllowed === false
      },
      {
        name: 'zhangsan both false',
        ok:
          availZhangRestricted.byId.get(H2)?.provisionAllowed === false &&
          availZhangRestricted.byId.get(H3)?.provisionAllowed === false
      },
      {
        name: 'admin both true',
        ok:
          availAdminRestricted.byId.get(H2)?.provisionAllowed === true &&
          availAdminRestricted.byId.get(H3)?.provisionAllowed === true
      }
    ]
  })

  const lisiH3Denied = await selfCreate(tokens.lisi, {
    hostId: H3,
    name: `combo-lisi-h3-${STAMP}`,
    dir: `combo-lisi-h3-${STAMP}`
  })
  const deniedAudit = await auditQuery({
    actor: 'lisi',
    eventType: 'project_create',
    result: 'denied',
    since: auditSince
  })
  record({
    id: 'C2',
    area: 'provision-policy',
    combo: 'restricted 主机上无 provision 直授 → 自助建项目',
    endpoint: 'POST /v1/projects/self',
    expected: '403 HOST_PROVISION_FORBIDDEN；审计 project_create/denied reason',
    actual: {
      status: lisiH3Denied.status,
      code: lisiH3Denied.json?.error?.code,
      audit: deniedAudit.events.slice(0, 3).map((event) => event.metadata)
    },
    severity: 'P2',
    checks: [
      {
        name: '403',
        ok:
          lisiH3Denied.status === 403 &&
          lisiH3Denied.json?.error?.code === 'HOST_PROVISION_FORBIDDEN'
      },
      {
        name: 'audit reason',
        ok: deniedAudit.events.some(
          (event) => event.metadata?.reason === 'HOST_PROVISION_FORBIDDEN'
        )
      }
    ]
  })

  const lisiH2Create = await selfCreate(tokens.lisi, {
    hostId: H2,
    name: `combo-lisi-h2-${STAMP}`,
    dir: `combo-lisi-h2-${STAMP}`
  })
  if (lisiH2Create.status === 201) {
    scratch.push(lisiH2Create.json.id)
    probeProjects.push(lisiH2Create.json.id)
  }
  const lisiH2Grants = lisiH2Create.json?.id
    ? await getProjectGrants(lisiH2Create.json.id)
    : { rows: [] }
  record({
    id: 'C3',
    area: 'provision-policy',
    combo: '直授 provision 的成员在 restricted 主机自助建项目',
    endpoint: 'POST /v1/projects/self',
    expected: '201；创建者自动获 open/terminal/agent/file:read/file:write（无 download）',
    actual: {
      status: lisiH2Create.status,
      id: lisiH2Create.json?.id,
      permissions: lisiH2Create.json?.permissions,
      grantRow: lisiH2Grants.rows
    },
    severity: 'P2',
    checks: [
      { name: '201', ok: lisiH2Create.status === 201 },
      {
        name: 'auto grant exact',
        ok: sameSet(lisiH2Create.json?.permissions ?? [], [
          'open',
          'terminal',
          'agent',
          'file:read',
          'file:write'
        ])
      }
    ]
  })

  await putHostGrant(H2, devGroup, ['provision'])
  const availZhangGroup = await available(tokens.zhangsan)
  const zhangH2Create = await selfCreate(tokens.zhangsan, {
    hostId: H2,
    name: `combo-zhang-h2-${STAMP}`,
    dir: `combo-zhang-h2-${STAMP}`
  })
  if (zhangH2Create.status === 201) {
    scratch.push(zhangH2Create.json.id)
    probeProjects.push(zhangH2Create.json.id)
  }
  record({
    id: 'C4',
    area: 'provision-policy',
    combo: '组授权成员在 restricted 主机自助建项目',
    endpoint: 'PUT host grants(group) + GET available + POST /v1/projects/self',
    expected: '组 developers 的 provision 使 zhangsan provisionAllowed=true；创建 201',
    actual: {
      available: availZhangGroup.byId.get(H2)?.provisionAllowed,
      status: zhangH2Create.status,
      id: zhangH2Create.json?.id
    },
    severity: 'P2',
    checks: [
      {
        name: 'provisionAllowed via group',
        ok: availZhangGroup.byId.get(H2)?.provisionAllowed === true
      },
      { name: '201', ok: zhangH2Create.status === 201 }
    ]
  })

  const adminRestrictedCreate = await selfCreate(tokens.admin, {
    hostId: H2,
    name: `combo-admin-h2-${STAMP}`,
    dir: `combo-admin-h2-${STAMP}`
  })
  if (adminRestrictedCreate.status === 201) {
    scratch.push(adminRestrictedCreate.json.id)
    probeProjects.push(adminRestrictedCreate.json.id)
  }
  record({
    id: 'C5',
    area: 'provision-policy',
    combo: 'admin 例外：restricted 主机无授权仍可自助建项目',
    endpoint: 'POST /v1/projects/self',
    expected: '201（admin 不受 restricted 限制）',
    actual: { status: adminRestrictedCreate.status, id: adminRestrictedCreate.json?.id },
    severity: 'P2',
    checks: [{ name: '201', ok: adminRestrictedCreate.status === 201 }]
  })

  const lisiH3StillDenied = await selfCreate(tokens.lisi, {
    hostId: H3,
    name: `combo-lisi-h3b-${STAMP}`,
    dir: `combo-lisi-h3b-${STAMP}`
  })
  record({
    id: 'C6',
    area: 'provision-policy',
    combo: '同一主体 h2 允许 / h3 拒绝（跨主机差异化判定）',
    endpoint: 'POST /v1/projects/self',
    expected: 'h3 仍 403 HOST_PROVISION_FORBIDDEN（h2 已 201，授权按主机隔离）',
    actual: { status: lisiH3StillDenied.status, code: lisiH3StillDenied.json?.error?.code },
    severity: 'P1',
    checks: [
      {
        name: '403',
        ok:
          lisiH3StillDenied.status === 403 &&
          lisiH3StillDenied.json?.error?.code === 'HOST_PROVISION_FORBIDDEN'
      }
    ]
  })

  await putHostGrant(H3, paymentGroup, ['provision'])
  const zhangH3Create = await selfCreate(tokens.zhangsan, {
    hostId: H3,
    name: `combo-zhang-h3-${STAMP}`,
    dir: `combo-zhang-h3-${STAMP}`
  })
  if (zhangH3Create.status === 201) {
    scratch.push(zhangH3Create.json.id)
    probeProjects.push(zhangH3Create.json.id)
  }
  const lisiH3GroupProbe = await selfCreate(tokens.lisi, {
    hostId: H3,
    name: `combo-lisi-h3c-${STAMP}`,
    dir: `combo-lisi-h3c-${STAMP}`
  })
  record({
    id: 'C7',
    area: 'provision-policy',
    combo: 'restricted 下组授权成员与直授成员并存（跨主机）',
    endpoint: 'PUT host grants(group team-payment on h3) + POST self',
    expected: 'zhangsan(组成员) h3 201；lisi(非组、h3 无直授) h3 403',
    actual: {
      zhangsan: { status: zhangH3Create.status, id: zhangH3Create.json?.id },
      lisi: { status: lisiH3GroupProbe.status, code: lisiH3GroupProbe.json?.error?.code }
    },
    severity: 'P2',
    checks: [
      { name: 'zhangsan 201', ok: zhangH3Create.status === 201 },
      { name: 'lisi 403', ok: lisiH3GroupProbe.status === 403 }
    ]
  })

  // Group row keeps access after the user row is removed (union semantics).
  h2 = await getHostGrants(H2)
  const beforeRemove = (await available(tokens.lisi)).byId.get(H2)?.provisionAllowed
  await putHostGrant(H2, lisiSub, [])
  const afterRemoveAvail = (await available(tokens.lisi)).byId.get(H2)?.provisionAllowed
  const afterRemoveCreate = await selfCreate(tokens.lisi, {
    hostId: H2,
    name: `combo-lisi-h2b-${STAMP}`,
    dir: `combo-lisi-h2b-${STAMP}`
  })
  record({
    id: 'C8',
    area: 'provision-policy',
    combo: '直授行删除后组行仍生效（组/用户行并集，无 deny 覆盖）',
    endpoint: 'PUT host grants + GET available + POST self',
    expected: '删除 lisi 直授后，developers 组行仍给 lisi provision → available=true 且自助 201',
    actual: {
      beforeRows: h2.rows,
      beforeRemove,
      afterRemoveAvail,
      createStatus: afterRemoveCreate.status
    },
    severity: 'P2',
    checks: [
      { name: 'group row present', ok: rowOf(h2.rows, 'group', 'developers') !== undefined },
      { name: 'still allowed', ok: beforeRemove === true && afterRemoveAvail === true },
      { name: 'create 201', ok: afterRemoveCreate.status === 201 }
    ]
  })
  if (afterRemoveCreate.status === 201) {
    scratch.push(afterRemoveCreate.json.id)
    probeProjects.push(afterRemoveCreate.json.id)
  }

  await putHostGrant(H2, devGroup, [])
  await putHostGrant(H2, lisiSub, [])
  await putHostGrant(H3, paymentGroup, [])
  const noGrantLisi = await available(tokens.lisi)
  const noGrantCreate = await selfCreate(tokens.lisi, {
    hostId: H2,
    name: `combo-lisi-h2c-${STAMP}`,
    dir: `combo-lisi-h2c-${STAMP}`
  })
  record({
    id: 'C9',
    area: 'provision-policy',
    combo: '撤净授权后 restricted 立即生效（无遗留允许）',
    endpoint: 'PUT host grants [] × 两组/两主机 + GET available + POST self',
    expected: 'lisi 两台 provisionAllowed=false；自助 403 HOST_PROVISION_FORBIDDEN',
    actual: {
      avail: [
        noGrantLisi.byId.get(H2)?.provisionAllowed,
        noGrantLisi.byId.get(H3)?.provisionAllowed
      ],
      create: { status: noGrantCreate.status, code: noGrantCreate.json?.error?.code }
    },
    severity: 'P1',
    checks: [
      {
        name: 'both false',
        ok:
          noGrantLisi.byId.get(H2)?.provisionAllowed === false &&
          noGrantLisi.byId.get(H3)?.provisionAllowed === false
      },
      {
        name: 'create 403',
        ok:
          noGrantCreate.status === 403 &&
          noGrantCreate.json?.error?.code === 'HOST_PROVISION_FORBIDDEN'
      }
    ]
  })

  const omitted = await selfCreate(tokens.lisi, {
    name: `combo-lisi-auto-${STAMP}`,
    dir: `combo-lisi-auto-${STAMP}`
  })
  record({
    id: 'C10',
    area: 'provision-policy',
    combo: '双 restricted 主机、省略 hostId 的自助选择',
    endpoint: 'POST /v1/projects/self',
    expected:
      '按调用者可用性裁决：无任何 provisionAllowed 主机时应 409 NO_PROVISIONABLE_HOST（details 不得把不可用主机列为候选）',
    actual: {
      status: omitted.status,
      code: omitted.json?.error?.code,
      details: omitted.json?.error?.details,
      available: {
        h2: (await available(tokens.lisi)).byId.get(H2)?.provisionAllowed,
        h3: (await available(tokens.lisi)).byId.get(H3)?.provisionAllowed
      }
    },
    severity: 'P3',
    checks: [
      { name: 'denied', ok: omitted.status === 409 },
      {
        name: 'authorization-aware code',
        ok: omitted.json?.error?.code === 'NO_PROVISIONABLE_HOST'
      }
    ],
    evidence: { note: 'selectSelfServiceHost 只按 online+projectsRoot 计数，provision 门禁在其后' }
  })

  const raceResults = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await setPolicy(H2, 'open')
    const name = `combo-race-${attempt}-${STAMP}`
    const [flip, create] = await Promise.all([
      setPolicy(H2, 'restricted'),
      selfCreate(tokens.lisi, { hostId: H2, name, dir: name })
    ])
    if (create.status === 201) {
      scratch.push(create.json.id)
      probeProjects.push(create.json.id)
    }
    raceResults.push({ flip: flip.status, create: create.status, code: create.json?.error?.code })
  }
  await setPolicy(H2, 'restricted')
  record({
    id: 'C11',
    area: 'provision-policy',
    combo: '在途自助创建 × open→restricted 并发（4 轮）',
    endpoint: 'PUT provision-policy ∥ POST /v1/projects/self',
    expected:
      '每轮 create ∈ {201(判定时仍 open), 403 HOST_PROVISION_FORBIDDEN}；无 5xx；终态 restricted',
    actual: {
      races: raceResults,
      finalMode: (await available(tokens.lisi)).byId.get(H2)?.provisionAllowed
    },
    severity: 'P1',
    checks: [
      {
        name: 'no 5xx',
        ok: raceResults.every(
          (row) => row.flip === 200 && (row.create === 201 || row.create === 403)
        )
      },
      {
        name: 'final restricted',
        ok: (await available(tokens.lisi)).byId.get(H2)?.provisionAllowed === false
      }
    ]
  })

  const badMode = await setPolicy(H2, 'nope')
  const devPolicy = await setPolicy(H3, 'open', tokens.zhangsan)
  record({
    id: 'C12',
    area: 'provision-policy',
    combo: '非法 mode / 开发者写策略',
    endpoint: 'PUT /v1/hosts/{id}/provision-policy',
    expected: '400 HOST_PROVISION_POLICY_INVALID；开发者 403 PERMISSION_DENIED',
    actual: {
      badMode: { status: badMode.status, code: badMode.json?.error?.code },
      dev: devPolicy.status,
      devCode: devPolicy.json?.error?.code
    },
    severity: 'P2',
    checks: [
      {
        name: 'invalid mode 400',
        ok: badMode.status === 400 && badMode.json?.error?.code === 'HOST_PROVISION_POLICY_INVALID'
      },
      {
        name: 'developer 403',
        ok: devPolicy.status === 403 && devPolicy.json?.error?.code === 'PERMISSION_DENIED'
      }
    ]
  })

  // Restore policies to their documented default. U67: this only records the
  // legacy field; the provision bit alone grants creation.
  const policyOpenH2 = await setPolicy(H2, 'open')
  const policyOpenH3 = await setPolicy(H3, 'open')
  const availOpen = await available(tokens.lisi)
  record({
    id: 'C13',
    area: 'provision-policy',
    combo: 'restricted→open 往返恢复（policy 不再回授权限）',
    endpoint: 'PUT provision-policy + GET /v1/hosts/available',
    expected:
      '两台 policy 恢复 open（PUT 200）；无 provision 位的 lisi 两台 provisionAllowed=false（授权驱动）',
    actual: {
      policyPut: { h2: policyOpenH2.status, h3: policyOpenH3.status },
      h2: availOpen.byId.get(H2)?.provisionAllowed,
      h3: availOpen.byId.get(H3)?.provisionAllowed
    },
    severity: 'P2',
    checks: [
      { name: 'policy PUT 200', ok: policyOpenH2.status === 200 && policyOpenH3.status === 200 },
      {
        name: 'policy does not grant',
        ok:
          availOpen.byId.get(H2)?.provisionAllowed === false &&
          availOpen.byId.get(H3)?.provisionAllowed === false
      }
    ]
  })

  // ---------- Phase 3: project grants x hosts x identities ----------
  await putProjectGrant(P_DEMO, lisiSub, ['open', 'file:read'])
  await putProjectGrant(P_INFRA, lisiSub, ['open', 'file:write'])
  const lisiDemoView = await request('GET', `/v1/projects/${P_DEMO}`, { token: tokens.lisi })
  const lisiInfraView = await request('GET', `/v1/projects/${P_INFRA}`, { token: tokens.lisi })
  const lisiDemoConn = await connect('lisi', P_DEMO)
  const lisiInfraConn = await connect('lisi', P_INFRA)
  record({
    id: 'D1',
    area: 'project-grants',
    combo: '同一用户跨主机不同权限位（h2 read / h3 write）',
    endpoint: 'PUT /v1/projects/{id}/grants + GET project + POST connect × 2',
    expected:
      'demo(h2)=open,file:read；infra(h3)=open,file:write；两票据 perms 与各自项目视图逐位一致',
    actual: {
      demo: {
        view: lisiDemoView.json?.permissions,
        ticket: lisiDemoConn.payload?.perms,
        aud: lisiDemoConn.payload?.aud
      },
      infra: {
        view: lisiInfraView.json?.permissions,
        ticket: lisiInfraConn.payload?.perms,
        aud: lisiInfraConn.payload?.aud
      }
    },
    severity: 'P1',
    checks: [
      {
        name: 'demo view',
        ok: sameSet(lisiDemoView.json?.permissions ?? [], ['open', 'file:read'])
      },
      {
        name: 'infra view',
        ok: sameSet(lisiInfraView.json?.permissions ?? [], ['open', 'file:write'])
      },
      {
        name: 'demo ticket',
        ok: sameSet(lisiDemoConn.payload?.perms ?? [], ['open', 'file:read'])
      },
      {
        name: 'infra ticket',
        ok: sameSet(lisiInfraConn.payload?.perms ?? [], ['open', 'file:write'])
      },
      {
        name: 'ticket host binding',
        ok: lisiDemoConn.payload?.host === H2 && lisiInfraConn.payload?.host === H3
      }
    ]
  })

  await putProjectGrant(P_DEMO, lisiSub, ['open', 'file:read', 'file:write', 'terminal'])
  await putProjectGrant(P_INFRA, lisiSub, ['open'])
  const lisiDemoConn2 = await connect('lisi', P_DEMO)
  const lisiInfraConn2 = await connect('lisi', P_INFRA)
  record({
    id: 'D2',
    area: 'project-grants',
    combo: '逐主机独立演进（h2 加 write/terminal；h3 撤 read）',
    endpoint: 'PUT project grants + POST connect × 2',
    expected: 'demo=open,terminal,file:read,file:write；infra=open；互不影响',
    actual: { demo: lisiDemoConn2.payload?.perms, infra: lisiInfraConn2.payload?.perms },
    severity: 'P1',
    checks: [
      {
        name: 'demo perms',
        ok: sameSet(lisiDemoConn2.payload?.perms ?? [], [
          'open',
          'terminal',
          'file:read',
          'file:write'
        ])
      },
      { name: 'infra perms', ok: sameSet(lisiInfraConn2.payload?.perms ?? [], ['open']) }
    ]
  })

  const lisiDemoHandoff = await handoff('lisi', P_DEMO, 'admin')
  const lisiInfraHandoff = await handoff('lisi', P_INFRA, 'admin')
  const demoUrl = lisiDemoHandoff.json?.url ?? ''
  const infraUrl = lisiInfraHandoff.json?.url ?? ''
  record({
    id: 'D3',
    area: 'handoff',
    combo: 'open 权限者跨主机 handoff（admin surface）',
    endpoint: 'POST /v1/projects/{id}/web-handoff',
    expected:
      '201；URL 的 project 参数分别为两个项目 id；page 主机分别对应 h2/h3 的 relay 入口；api=平台 origin',
    actual: {
      demo: brief(demoUrl, 260),
      infra: brief(infraUrl, 260),
      statuses: [lisiDemoHandoff.status, lisiInfraHandoff.status]
    },
    severity: 'P2',
    checks: [
      { name: 'both 201', ok: lisiDemoHandoff.status === 201 && lisiInfraHandoff.status === 201 },
      {
        name: 'demo project param',
        ok: demoUrl.includes(`project=${P_DEMO}`) && demoUrl.includes('embed=1')
      },
      {
        name: 'infra project param',
        ok: infraUrl.includes(`project=${P_INFRA}`) && infraUrl.includes('embed=1')
      },
      {
        name: 'host routing',
        ok: demoUrl.includes('dev-local-02') && infraUrl.includes('dev-local-03')
      },
      {
        name: 'api param',
        ok:
          demoUrl.includes(encodeURIComponent(BASE)) && infraUrl.includes(encodeURIComponent(BASE))
      }
    ]
  })

  // Union semantics: same group, different users, different bits.
  await putProjectGrant(P_ZHAN, paymentGroup, ['open', 'file:read'])
  await putProjectGrant(P_ZHAN, zhangSub, ['open', 'terminal'])
  await putProjectGrant(P_ZHAN, lisiSub, ['open', 'file:write'])
  await putProjectGrant(P_ZHAN, adminSub, ['open'])
  const zhangConn = await connect('zhangsan', P_ZHAN)
  const lisiConn = await connect('lisi', P_ZHAN)
  const zhangView = await request('GET', `/v1/projects/${P_ZHAN}`, { token: tokens.zhangsan })
  const lisiView = await request('GET', `/v1/projects/${P_ZHAN}`, { token: tokens.lisi })
  const zhanGrants = await getProjectGrants(P_ZHAN)
  record({
    id: 'D4',
    area: 'identity-matrix',
    combo: '同组不同用户不同位（team-payment 组 + 各用户行并集）',
    endpoint: 'PUT project grants × 3 + GET project + POST connect × 2',
    expected:
      'zhangsan=组(open,file:read)∪用户(open,terminal)=open,file:read,terminal；lisi=open,file:write；票据逐位一致',
    actual: {
      zhangsan: { view: zhangView.json?.permissions, ticket: zhangConn.payload?.perms },
      lisi: { view: lisiView.json?.permissions, ticket: lisiConn.payload?.perms },
      rows: zhanGrants.rows.map((row) => ({ k: rowKey(row), p: row.permissions }))
    },
    severity: 'P1',
    checks: [
      {
        name: 'zhangsan union',
        ok: sameSet(zhangConn.payload?.perms ?? [], ['open', 'file:read', 'terminal'])
      },
      { name: 'lisi own row', ok: sameSet(lisiConn.payload?.perms ?? [], ['open', 'file:write']) },
      {
        name: 'view == ticket (zhangsan)',
        ok: sameSet(zhangView.json?.permissions ?? [], zhangConn.payload?.perms ?? [])
      },
      {
        name: 'view == ticket (lisi)',
        ok: sameSet(lisiView.json?.permissions ?? [], lisiConn.payload?.perms ?? [])
      }
    ]
  })

  // Group removal affects members, leaves direct rows alone.
  await putProjectGrant(P_ZHAN, paymentGroup, [])
  const zhangConn2 = await connect('zhangsan', P_ZHAN)
  const lisiConn2 = await connect('lisi', P_ZHAN)
  record({
    id: 'D5',
    area: 'identity-matrix',
    combo: '撤组行只影响组来源的位（直授位保留）',
    endpoint: 'PUT project grants(group []) + POST connect × 2',
    expected: 'zhangsan=open,terminal（组 file:read 消失）；lisi=open,file:write 不变',
    actual: { zhangsan: zhangConn2.payload?.perms, lisi: lisiConn2.payload?.perms },
    severity: 'P1',
    checks: [
      {
        name: 'zhangsan loses group read',
        ok: sameSet(zhangConn2.payload?.perms ?? [], ['open', 'terminal'])
      },
      {
        name: 'lisi unchanged',
        ok: sameSet(lisiConn2.payload?.perms ?? [], ['open', 'file:write'])
      }
    ]
  })

  // Same user across projects / hosts: three-dimensional ticket check.
  await putProjectGrant(P_LAB, zhangSub, ['open', 'file:read'])
  await putProjectGrant(P_ZHAN, zhangSub, ['open', 'file:write', 'terminal'])
  const zhangLab = await connect('zhangsan', P_LAB)
  const zhangZhan = await connect('zhangsan', P_ZHAN)
  record({
    id: 'D6',
    area: 'identity-matrix',
    combo: '同一用户跨项目跨主机不同位（zhangsan: h3 read / h2 write+terminal）',
    endpoint: 'PUT project grants × 2 + POST connect × 2',
    expected:
      'lab(h3)=open,file:read；zhangsan-demo(h2)=open,file:write,terminal；票据 host 分别 H3/H2',
    actual: {
      lab: { p: zhangLab.payload?.perms, host: zhangLab.payload?.host },
      zhan: { p: zhangZhan.payload?.perms, host: zhangZhan.payload?.host }
    },
    severity: 'P1',
    checks: [
      {
        name: 'lab',
        ok:
          sameSet(zhangLab.payload?.perms ?? [], ['open', 'file:read']) &&
          zhangLab.payload?.host === H3
      },
      {
        name: 'zhan',
        ok:
          sameSet(zhangZhan.payload?.perms ?? [], ['open', 'file:write', 'terminal']) &&
          zhangZhan.payload?.host === H2
      }
    ]
  })

  // A user with no row cannot see/connect (existence not leaked), while admin can.
  const lisiLabGet = await request('GET', `/v1/projects/${P_LAB}`, { token: tokens.lisi })
  const lisiLabConn = await connect('lisi', P_LAB)
  const lisiLabGrants = await request('GET', `/v1/projects/${P_LAB}/grants`, { token: tokens.lisi })
  const lisiLabHandoff = await handoff('lisi', P_LAB, 'web')
  record({
    id: 'D7',
    area: 'identity-matrix',
    combo: '无授权用户 vs 授权用户（同项目）',
    endpoint: 'GET project / connect / GET grants / POST web-handoff',
    expected:
      '无 open → GET/connect/grants 404 PROJECT_NOT_FOUND；handoff 403/404；不得泄露授权矩阵',
    actual: {
      get: lisiLabGet.status,
      getCode: lisiLabGet.json?.error?.code,
      connect: lisiLabConn.res.status,
      connectCode: lisiLabConn.res.json?.error?.code,
      grantsRead: lisiLabGrants.status,
      handoff: lisiLabHandoff.status,
      handoffCode: lisiLabHandoff.json?.error?.code
    },
    severity: 'P2',
    checks: [
      { name: 'get 404', ok: lisiLabGet.status === 404 },
      { name: 'connect 404', ok: lisiLabConn.res.status === 404 },
      { name: 'grants not readable', ok: lisiLabGrants.status === 404 },
      {
        name: 'handoff rejected',
        ok: lisiLabHandoff.status === 403 || lisiLabHandoff.status === 404
      }
    ]
  })

  // Admin lacking an explicit open grant must not be able to connect/handoff.
  const adminLabConn = await connect('admin', P_LAB)
  const adminLabHandoff = await handoff('admin', P_LAB, 'admin')
  record({
    id: 'D8',
    area: 'identity-matrix',
    combo: 'admin 无显式 open 的项目（zhangsan-lab）',
    endpoint: 'POST connect / POST web-handoff',
    expected:
      'admin 可见项目但无 open → connect/handoff 均 403 PROJECT_FORBIDDEN（open 是显式位，admin 不隐式持有）',
    actual: {
      connect: adminLabConn.res.status,
      connectCode: adminLabConn.res.json?.error?.code,
      ticketPerms: adminLabConn.payload?.perms,
      ticketProject: adminLabConn.payload?.project,
      handoff: adminLabHandoff.status,
      handoffCode: adminLabHandoff.json?.error?.code
    },
    severity: 'P2',
    checks: [
      {
        name: 'connect rejected',
        ok:
          adminLabConn.res.status === 403 &&
          adminLabConn.res.json?.error?.code === 'PROJECT_FORBIDDEN'
      },
      {
        name: 'handoff rejected',
        ok: adminLabHandoff.status === 403 || adminLabHandoff.status === 404
      }
    ],
    evidence: {
      note: 'U67 后 connect 与 web-handoff 共用 open 谓词：admin 可见项目但不隐式持有 open，两端均 403'
    }
  })

  // Ticket vs grant rows consistency across all probes.
  const consistency = []
  for (const projectId of [P_DEMO, P_ZHAN, P_INFRA, P_LAB]) {
    const rows = (await getProjectGrants(projectId)).rows
    for (const name of ['admin', 'zhangsan', 'lisi']) {
      const view = await request('GET', `/v1/projects/${projectId}`, { token: tokens[name] })
      const effective = view.status === 200 ? view.json.permissions : []
      const groups = PEOPLE[name].groups
      const merged = new Set()
      for (const row of rows) {
        const matches =
          (row.subjectType === 'user' && row.subjectId === users[name].id) ||
          (row.subjectType === 'group' && groups.includes(row.subjectId))
        if (matches) for (const bit of row.permissions) merged.add(bit)
      }
      const conn = effective.includes('open') ? await connect(name, projectId) : null
      const ticketPerms = conn?.payload?.perms ?? null
      consistency.push({
        projectId,
        user: name,
        viewPerms: effective,
        rowsUnion: [...merged].sort(),
        ticketPerms: ticketPerms ? [...new Set(ticketPerms)].sort() : null,
        ok:
          sameSet(effective, [...merged]) &&
          (ticketPerms === null || sameSet(ticketPerms, effective))
      })
    }
  }
  record({
    id: 'D9',
    area: 'identity-matrix',
    combo: '票据 perms × 授权行 × 项目视图 全量逐位核对（4 项目 × 3 身份）',
    endpoint: 'GET grants + GET project + POST connect',
    expected: '每一格：票据 perms = 项目视图 perms = 用户行∪组行；不一致即缺陷',
    actual: consistency.filter((row) => !row.ok),
    severity: 'P1',
    checks: [{ name: 'all consistent', ok: consistency.every((row) => row.ok) }],
    evidence: { checked: consistency.length }
  })

  // Restore seed project grants exactly.
  for (const [projectId, baselineRows] of projectBaseline) {
    const current = (await getProjectGrants(projectId)).rows
    const baselineKeys = new Set(baselineRows.map(rowKey))
    for (const row of current) {
      if (!baselineKeys.has(rowKey(row))) {
        await putProjectGrant(projectId, { type: row.subjectType, id: row.subjectId }, [])
      }
    }
    for (const row of baselineRows) {
      await putProjectGrant(
        projectId,
        { type: row.subjectType, id: row.subjectId },
        row.permissions
      )
    }
  }
  const restoreProjectChecks = []
  for (const [projectId, baselineRows] of projectBaseline) {
    const current = (await getProjectGrants(projectId)).rows
    const norm = (rows) =>
      rows.map((row) => `${rowKey(row)}=${[...row.permissions].sort().join(',')}`).sort()
    restoreProjectChecks.push({
      projectId,
      ok: sameSet(norm(current), norm(baselineRows))
    })
  }
  record({
    id: 'D10',
    area: 'cleanup',
    combo: '种子项目授权逐行还原',
    endpoint: 'PUT /v1/projects/{id}/grants',
    expected: '5 个种子项目的行集合与权限位与快照逐字一致',
    actual: restoreProjectChecks,
    severity: 'P1',
    checks: restoreProjectChecks.map((row) => ({ name: row.projectId, ok: row.ok }))
  })

  // ---------- Phase 4: directory x authorization evolution ----------
  const dirBeforeHostGroup = await directory()
  await putHostGrant(H2, devGroup, ['provision'])
  const dirAfterHostGroup = await directory()
  const dirUnknownHost = await putHostGrant(H2, { type: 'group', id: `ghost-${STAMP}` }, [
    'provision'
  ])
  const dirUnknownHost2 = await putHostGrant(H2, { type: 'group', id: `ghost-${STAMP}` }, [
    'provision'
  ])
  const dirAfterUnknown = await directory()
  record({
    id: 'E1',
    area: 'directory',
    combo: '目录组清单 × 主机组授权演进',
    endpoint: 'PUT host grants(group) + GET /v1/directory',
    expected: '已在目录中的组重复授权不新增条目；未知组 400 ×2 且目录不变（knownGroups 并集去重）',
    actual: {
      before: dirBeforeHostGroup.json?.groups,
      afterHostGrant: dirAfterHostGroup.json?.groups,
      afterUnknown: dirAfterUnknown.json?.groups,
      unknown: [
        { status: dirUnknownHost.status, code: dirUnknownHost.json?.error?.code },
        { status: dirUnknownHost2.status, code: dirUnknownHost2.json?.error?.code }
      ]
    },
    severity: 'P3',
    checks: [
      {
        name: 'no duplicate growth',
        ok: sameSet(dirAfterHostGroup.json?.groups ?? [], dirBeforeHostGroup.json?.groups ?? [])
      },
      {
        name: 'unknown 400 x2',
        ok: dirUnknownHost.status === 400 && dirUnknownHost2.status === 400
      },
      {
        name: 'directory unchanged',
        ok: sameSet(dirAfterUnknown.json?.groups ?? [], dirBeforeHostGroup.json?.groups ?? [])
      }
    ],
    evidence: {
      note: '未知组在解析前被拒，故 hostGrants 组主体不可能引入新组；目录增长只能来自登录用户组'
    }
  })

  const dirProjectUnknown = await putProjectGrant(P_LAB, { type: 'group', id: `ghost2-${STAMP}` }, [
    'open'
  ])
  const dirProjectUnknown2 = await putProjectGrant(
    P_LAB,
    { type: 'group', id: `ghost2-${STAMP}` },
    ['open']
  )
  record({
    id: 'E2',
    area: 'directory',
    combo: '项目组授权 × 未知组幂等',
    endpoint: 'PUT /v1/projects/{id}/grants',
    expected: '400 GROUP_NOT_FOUND ×2；目录与项目授权不变',
    actual: {
      statuses: [dirProjectUnknown.status, dirProjectUnknown2.status],
      codes: [dirProjectUnknown.json?.error?.code, dirProjectUnknown2.json?.error?.code],
      grants: (await getProjectGrants(P_LAB)).rows.map(rowKey)
    },
    severity: 'P3',
    checks: [
      {
        name: 'both 400',
        ok: dirProjectUnknown.status === 400 && dirProjectUnknown2.status === 400
      },
      {
        name: 'codes',
        ok:
          dirProjectUnknown.json?.error?.code === 'GROUP_NOT_FOUND' &&
          dirProjectUnknown2.json?.error?.code === 'GROUP_NOT_FOUND'
      },
      {
        name: 'no row',
        ok: !(await getProjectGrants(P_LAB)).rows.some((row) => row.subjectId === `ghost2-${STAMP}`)
      }
    ]
  })

  await putHostGrant(H2, devGroup, ['provision', 'view'])
  await putProjectGrant(P_LAB, devGroup, ['open'])
  const dirDedup = await directory()
  await putProjectGrant(P_LAB, devGroup, [])
  await putHostGrant(H2, devGroup, [])
  record({
    id: 'E4',
    area: 'directory',
    combo: '同一组被主机行与项目行同时引用（目录去重）',
    endpoint: 'PUT host grants(group) + PUT project grants(group) + GET /v1/directory',
    expected: '组清单中 developers 只出现一次（并集去重），不随引用数增长',
    actual: {
      groups: dirDedup.json?.groups,
      developersCount: (dirDedup.json?.groups ?? []).filter((group) => group === 'developers')
        .length
    },
    severity: 'P3',
    checks: [
      {
        name: 'deduped',
        ok: (dirDedup.json?.groups ?? []).filter((group) => group === 'developers').length === 1
      }
    ]
  })

  const dirDev = await directory(tokens.zhangsan)
  record({
    id: 'E3',
    area: 'directory',
    combo: '目录端点越权',
    endpoint: 'GET /v1/directory',
    expected: '开发者 403 PERMISSION_DENIED',
    actual: { status: dirDev.status, code: dirDev.json?.error?.code },
    severity: 'P2',
    checks: [
      { name: '403', ok: dirDev.status === 403 && dirDev.json?.error?.code === 'PERMISSION_DENIED' }
    ]
  })

  await putHostGrant(H2, devGroup, [])

  // ---------- Phase 5: boundary combinations ----------
  const key = `r2c-key-${STAMP}`
  const h2Key = await adminCreate({
    hostId: H2,
    key,
    name: key,
    projectPath: `/tmp/orca-r2-combo/${key}-h2`
  })
  if (h2Key.status === 201) {
    scratch.push(h2Key.json.id)
    probeProjects.push(h2Key.json.id)
    await putProjectGrant(h2Key.json.id, adminSub, ['open'])
  }
  const h3SameKey = await adminCreate({
    hostId: H3,
    key,
    name: key,
    projectPath: `/tmp/orca-r2-combo/${key}-h3`
  })
  record({
    id: 'F1',
    area: 'boundary',
    combo: '双主机同 key 项目共存合法性',
    endpoint: 'POST /v1/projects × 2',
    expected: 'key 为平台级唯一（design §DB: key 唯一）→ 第二台 409 PROJECT_EXISTS',
    actual: {
      h2: { status: h2Key.status, id: h2Key.json?.id },
      h3: { status: h3SameKey.status, code: h3SameKey.json?.error?.code }
    },
    severity: 'P2',
    checks: [
      { name: 'h2 201', ok: h2Key.status === 201 },
      {
        name: 'h3 rejected globally',
        ok: h3SameKey.status === 409 && h3SameKey.json?.error?.code === 'PROJECT_EXISTS'
      }
    ]
  })

  const sharedPath = `/tmp/orca-r2-combo/shared-${STAMP}`
  const h2Shared = await adminCreate({
    hostId: H2,
    key: `r2c-shared-h2-${STAMP}`,
    name: 'shared-h2',
    projectPath: sharedPath
  })
  if (h2Shared.status === 201) {
    scratch.push(h2Shared.json.id)
    probeProjects.push(h2Shared.json.id)
  }
  const h3Shared = await adminCreate({
    hostId: H3,
    key: `r2c-shared-h3-${STAMP}`,
    name: 'shared-h3',
    projectPath: sharedPath
  })
  if (h3Shared.status === 201) {
    scratch.push(h3Shared.json.id)
    probeProjects.push(h3Shared.json.id)
  }
  record({
    id: 'F2',
    area: 'boundary',
    combo: '跨主机 path 占用（同一绝对路径登记到两台主机）',
    endpoint: 'POST /v1/projects × 2',
    expected: 'design 的占用键是 (host_id, path) → 不同主机同路径应 201 共存',
    actual: {
      h2: { status: h2Shared.status, id: h2Shared.json?.id },
      h3: { status: h3Shared.status, id: h3Shared.json?.id, code: h3Shared.json?.error?.code }
    },
    severity: 'P2',
    checks: [
      { name: 'h2 201', ok: h2Shared.status === 201 },
      { name: 'h3 allowed on another host', ok: h3Shared.status === 201 }
    ],
    evidence: {
      note: 'projectPathTaken(store,path) 只比较 path，不含 hostId（project-occupancy.ts:20）'
    }
  })

  const h3Unique = await adminCreate({
    hostId: H3,
    key: `r2c-unique-h3-${STAMP}`,
    name: 'unique-h3',
    projectPath: `/tmp/orca-r2-combo/unique-h3-${STAMP}`
  })
  if (h3Unique.status === 201) {
    scratch.push(h3Unique.json.id)
    probeProjects.push(h3Unique.json.id)
  }
  record({
    id: 'F3',
    area: 'boundary',
    combo: '不同主机不同 path 正常共存（对照）',
    endpoint: 'POST /v1/projects',
    expected: '201',
    actual: { status: h3Unique.status, id: h3Unique.json?.id },
    severity: 'P3',
    checks: [{ name: '201', ok: h3Unique.status === 201 }]
  })

  // Admin-surface handoff routing for the two hosts' probe projects.
  const adminOpenH2 =
    h2Key.status === 201 ? await putProjectGrant(h2Key.json.id, adminSub, ['open']) : null
  const adminOpenH3 =
    h3Unique.status === 201 ? await putProjectGrant(h3Unique.json.id, adminSub, ['open']) : null
  const hoffH2 =
    h2Key.status === 201 ? await handoff('admin', h2Key.json.id, 'admin') : { status: 0, json: {} }
  const hoffH3 =
    h3Unique.status === 201
      ? await handoff('admin', h3Unique.json.id, 'admin')
      : { status: 0, json: {} }
  const h2Url = hoffH2.json?.url ?? ''
  const h3Url = hoffH3.json?.url ?? ''
  record({
    id: 'F4',
    area: 'handoff',
    combo: 'handoff surface=admin 对双主机项目的 URL 路由键',
    endpoint: 'POST /v1/projects/{id}/web-handoff {surface:admin}',
    expected:
      '201 ×2；URL 分别指向 dev-local-02 / dev-local-03 的 cloud-admin.html；embed=1、project=<对应 id>、#handoff 码存在',
    actual: {
      grants: [adminOpenH2?.status, adminOpenH3?.status],
      urls: [brief(h2Url, 240), brief(h3Url, 240)],
      statuses: [hoffH2.status, hoffH3.status]
    },
    severity: 'P2',
    checks: [
      { name: 'both 201', ok: hoffH2.status === 201 && hoffH3.status === 201 },
      {
        name: 'page per host',
        ok: h2Url.includes('dev-local-02') && h3Url.includes('dev-local-03')
      },
      {
        name: 'project params',
        ok:
          h2Url.includes(`project=${h2Key.json?.id}`) &&
          h3Url.includes(`project=${h3Unique.json?.id}`)
      },
      {
        name: 'embed + handoff code',
        ok: h2Url.includes('embed=1') && h2Url.includes('#handoff=') && h3Url.includes('#handoff=')
      }
    ]
  })

  const h3Code = h3Url.split('#handoff=')[1]?.split('&')[0]
  const redeem1 = await request('POST', '/v1/web/handoff', {
    body: { code: h3Code },
    headers: { 'x-orca-web-contract': '1' }
  })
  const redeem2 = await request('POST', '/v1/web/handoff', {
    body: { code: h3Code },
    headers: { 'x-orca-web-contract': '1' }
  })
  record({
    id: 'F5',
    area: 'handoff',
    combo: '双主机 admin handoff 兑换与单次语义',
    endpoint: 'POST /v1/web/handoff',
    expected: '首次 200（签发 token），重放 410 HANDOFF_GONE',
    actual: {
      first: redeem1.status,
      replay: redeem2.status,
      replayCode: redeem2.json?.error?.code
    },
    severity: 'P2',
    checks: [
      { name: 'first 200', ok: redeem1.status === 200 },
      { name: 'replay 410', ok: redeem2.status === 410 }
    ]
  })

  // Self-service derived paths use different roots per host, so same dir coexists.
  // U67: creation needs the provision bit; grant it explicitly instead of the
  // legacy policy=open assumption.
  await putHostGrant(H2, lisiSub, ['provision'])
  await putHostGrant(H3, lisiSub, ['provision'])
  const sameDir = `combo-samedir-${STAMP}`
  const lisiDirH2 = await selfCreate(tokens.lisi, { hostId: H2, name: sameDir, dir: sameDir })
  const lisiDirH3 = await selfCreate(tokens.lisi, {
    hostId: H3,
    name: `${sameDir}-h3`,
    dir: sameDir
  })
  for (const created of [lisiDirH2, lisiDirH3]) {
    if (created.status === 201) {
      scratch.push(created.json.id)
      probeProjects.push(created.json.id)
    }
  }
  record({
    id: 'F6',
    area: 'boundary',
    combo: '自助建项目同目录名跨主机（平台推导路径）',
    endpoint: 'POST /v1/projects/self × 2',
    expected: '两主机根不同 → 两个项目 201；记录路径分别为各自根下同名单级目录',
    actual: {
      h2: { status: lisiDirH2.status, path: lisiDirH2.json?.path },
      h3: { status: lisiDirH3.status, path: lisiDirH3.json?.path }
    },
    severity: 'P2',
    checks: [
      { name: 'both 201', ok: lisiDirH2.status === 201 && lisiDirH3.status === 201 },
      { name: 'paths differ', ok: lisiDirH2.json?.path !== lisiDirH3.json?.path }
    ]
  })
  await putHostGrant(H2, lisiSub, [])
  await putHostGrant(H3, lisiSub, [])

  const keyAgain = `r2c-key2-${STAMP}`
  const keyH2 = await adminCreate({
    hostId: H2,
    key: keyAgain,
    name: keyAgain,
    projectPath: `/tmp/orca-r2-combo/${keyAgain}`
  })
  if (keyH2.status === 201) {
    scratch.push(keyH2.json.id)
    probeProjects.push(keyH2.json.id)
  }
  await archiveProject(keyH2.json?.id)
  const keyH3AfterArchive = await adminCreate({
    hostId: H3,
    key: keyAgain,
    name: keyAgain,
    projectPath: `/tmp/orca-r2-combo/${keyAgain}-h3`
  })
  if (keyH3AfterArchive.status === 201) {
    scratch.push(keyH3AfterArchive.json.id)
    probeProjects.push(keyH3AfterArchive.json.id)
  }
  record({
    id: 'F7',
    area: 'boundary',
    combo: '归档释放 key 后跨主机复用',
    endpoint: 'POST archive + POST /v1/projects',
    expected: '归档项目不再占 key → 另一主机同 key 201',
    actual: {
      h2: keyH2.status,
      h3: keyH3AfterArchive.status,
      code: keyH3AfterArchive.json?.error?.code
    },
    severity: 'P2',
    checks: [
      { name: 'h2 201', ok: keyH2.status === 201 },
      { name: 'h3 201', ok: keyH3AfterArchive.status === 201 }
    ]
  })

  // ---------- Phase 6: audit ----------
  const auditTypes = {}
  for (const eventType of [
    'host_grant_update',
    'host_provision_policy_update',
    'grant_update',
    'web_handoff',
    'project_create'
  ]) {
    const page = await auditQuery({ eventType, since: auditSince, limit: 200 })
    auditTypes[eventType] = {
      status: page.res.status,
      count: page.events.length,
      sample: page.events[0]?.metadata
    }
  }
  const hostGrantComboEvents = (
    await auditQuery({ eventType: 'host_grant_update', since: auditSince, limit: 200 })
  ).events
  const policyComboEvents = (
    await auditQuery({ eventType: 'host_provision_policy_update', since: auditSince, limit: 200 })
  ).events
  record({
    id: 'G1',
    area: 'audit',
    combo:
      '组合变更审计事件序列（host_grant_update / provision_policy / grant_update / web_handoff）',
    endpoint: 'GET /v1/audit/events?eventType=…',
    expected:
      '各事件类型均有记录；host_grant_update 含 subjectType/subjectId/permissions/hostId；provision 含 mode',
    actual: {
      counts: Object.fromEntries(Object.entries(auditTypes).map(([k, v]) => [k, v.count])),
      hostGrantRows: hostGrantComboEvents.slice(0, 3).map((event) => event.metadata),
      policyRows: policyComboEvents.slice(0, 3).map((event) => event.metadata)
    },
    severity: 'P2',
    checks: [
      { name: 'host_grant_update present', ok: hostGrantComboEvents.length > 0 },
      { name: 'provision policy present', ok: policyComboEvents.length > 0 },
      { name: 'grant_update present', ok: auditTypes.grant_update.count > 0 },
      { name: 'web_handoff present', ok: auditTypes.web_handoff.count > 0 },
      {
        name: 'grant metadata complete',
        ok: hostGrantComboEvents.some(
          (event) =>
            event.metadata?.hostId &&
            event.metadata?.subjectType &&
            event.metadata?.subjectId &&
            Array.isArray(event.metadata?.permissions)
        )
      },
      {
        name: 'policy metadata mode',
        ok: policyComboEvents.some(
          (event) => event.metadata?.mode === 'restricted' || event.metadata?.mode === 'open'
        )
      }
    ]
  })

  const deniedCreateEvents = (
    await auditQuery({
      eventType: 'project_create',
      result: 'denied',
      since: auditSince,
      limit: 200
    })
  ).events
  const deniedHostGrant = (
    await auditQuery({
      eventType: 'host_grant_update',
      result: 'denied',
      since: auditSince,
      limit: 200
    })
  ).events
  record({
    id: 'G2',
    area: 'audit',
    combo: '拒绝路径审计（restricted 自助拒绝、非 admin 主机授权写拒绝）',
    endpoint: 'GET /v1/audit/events?result=denied',
    expected:
      'project_create denied 含 HOST_PROVISION_FORBIDDEN/selfService；host_grant_update denied 含 actor=zhangsan',
    actual: {
      projectCreateDenied: deniedCreateEvents
        .filter((event) => event.metadata?.selfService)
        .slice(0, 4)
        .map((event) => ({ a: event.actor, r: event.metadata?.reason })),
      hostGrantDenied: deniedHostGrant.map((event) => ({ a: event.actor, t: event.targetId }))
    },
    severity: 'P2',
    checks: [
      {
        name: 'self-service denial reason',
        ok: deniedCreateEvents.some(
          (event) =>
            event.metadata?.selfService === true &&
            event.metadata?.reason === 'HOST_PROVISION_FORBIDDEN'
        )
      },
      {
        name: 'host grant denial',
        ok: deniedHostGrant.some((event) => event.actor === 'zhangsan' && event.result === 'denied')
      }
    ]
  })

  const deniedPolicyEvents = (
    await auditQuery({
      eventType: 'host_provision_policy_update',
      result: 'denied',
      since: auditSince,
      limit: 200
    })
  ).events
  const deniedGrantEvents = (
    await auditQuery({
      eventType: 'host_grant_update',
      result: 'denied',
      since: auditSince,
      limit: 200
    })
  ).events
  record({
    id: 'G4',
    area: 'audit',
    combo: 'denied 审计元数据完整性（主机授权 / 自助策略）',
    endpoint: 'GET /v1/audit/events?result=denied',
    expected:
      '设计表要求 denied 也带 hostId/mode（策略）与 hostId/subjectType/subjectId/permissions（授权）',
    actual: {
      policyDenied: deniedPolicyEvents.map((event) => ({
        targetId: event.targetId,
        metadata: event.metadata
      })),
      grantDenied: deniedGrantEvents.map((event) => ({
        targetId: event.targetId,
        metadata: event.metadata
      }))
    },
    severity: 'P3',
    checks: [
      {
        name: 'policy denied carries hostId+mode',
        ok: deniedPolicyEvents.every(
          (event) =>
            event.metadata?.hostId &&
            (event.metadata?.mode === 'open' || event.metadata?.mode === 'restricted')
        )
      },
      {
        name: 'grant denied carries hostId+subject',
        ok: deniedGrantEvents.every(
          (event) =>
            event.metadata?.hostId && event.metadata?.subjectType && event.metadata?.subjectId
        )
      }
    ],
    evidence: {
      note: 'denyPrivileged 在读取 body 前拒绝，只写通用 {reason, requiredPermission}；hostId 仅在 targetId'
    }
  })

  const verifyAfter = await request('GET', '/v1/audit/verify', { token: tokens.admin })
  record({
    id: 'G3',
    area: 'audit',
    combo: '组合变更后审计链完整性',
    endpoint: 'GET /v1/audit/verify',
    expected: '200 ok=true',
    actual: {
      status: verifyAfter.status,
      ok: verifyAfter.json?.ok,
      checked: verifyAfter.json?.checked
    },
    severity: 'P0',
    checks: [
      { name: 'ok', ok: verifyAfter.status === 200 && verifyAfter.json?.ok === true },
      {
        name: 'checked grew',
        ok: Number(verifyAfter.json?.checked) > Number(verifyBaseline.json?.checked)
      }
    ]
  })

  // ---------- Phase 7: cleanup and restoration ----------
  const archiveResults = []
  for (const projectId of [...new Set(probeProjects)]) {
    const archived = await archiveProject(projectId)
    archiveResults.push({ projectId, status: archived.status })
  }
  const beforeSnapshotRestore = {
    h2: (await getHostGrants(H2)).rows,
    h3: (await getHostGrants(H3)).rows
  }
  for (const [hostId, snapshot] of [
    [H2, hostGrantSnapshot.h2],
    [H3, hostGrantSnapshot.h3]
  ]) {
    const current = (await getHostGrants(hostId)).rows
    const snapshotKeys = new Set(snapshot.map(rowKey))
    for (const row of current) {
      if (!snapshotKeys.has(rowKey(row))) {
        await putHostGrant(hostId, { type: row.subjectType, id: row.subjectId }, [])
      }
    }
    for (const row of snapshot) {
      await putHostGrant(hostId, { type: row.subjectType, id: row.subjectId }, row.permissions)
    }
  }
  const restoredHostGrants = {
    h2: (await getHostGrants(H2)).rows,
    h3: (await getHostGrants(H3)).rows
  }
  const sameRows = (left, right) => {
    const norm = (rows) =>
      rows.map((row) => `${rowKey(row)}=${[...row.permissions].sort().join(',')}`).sort()
    return JSON.stringify(norm(left)) === JSON.stringify(norm(right))
  }
  const finalPolicy = {
    h2: (await available(tokens.admin)).byId.get(H2)?.provisionAllowed,
    h3: (await available(tokens.admin)).byId.get(H3)?.provisionAllowed
  }
  const finalProjects = await request('GET', '/v1/projects?includeArchived=1', {
    token: tokens.admin
  })
  const finalById = new Map(
    (finalProjects.json?.projects ?? []).map((project) => [project.id, project])
  )
  const probeArchived = [...new Set(probeProjects)].every(
    (projectId) => finalById.get(projectId)?.status === 'archived'
  )
  const seedIntact = [P_DEMO, P_ZHAN, P_INFRA, P_LAB, P_PAYMENT].every(
    (projectId) => finalById.get(projectId)?.status === 'ready'
  )
  record({
    id: 'H1',
    area: 'cleanup',
    combo: '探针项目归档 / 主机授权快照还原 / 策略恢复',
    endpoint: 'POST archive × N + PUT grants (快照) + PUT provision-policy open',
    expected:
      '全部探针项目 archived；主机授权还原到开跑快照；两台 provisionAllowed=true；种子项目保持 ready',
    actual: {
      archived: archiveResults,
      beforeSnapshotRestore,
      restoredHostGrants,
      snapshot: hostGrantSnapshot,
      policy: finalPolicy,
      probeArchived,
      seedIntact,
      activeProjects: (finalProjects.json?.projects ?? []).filter(
        (project) => project.status !== 'archived'
      ).length
    },
    severity: 'P1',
    checks: [
      { name: 'archives 200', ok: archiveResults.every((row) => row.status === 200) },
      { name: 'probe projects archived', ok: probeArchived },
      {
        name: 'host grants restored to snapshot',
        ok:
          sameRows(restoredHostGrants.h2, hostGrantSnapshot.h2) &&
          sameRows(restoredHostGrants.h3, hostGrantSnapshot.h3)
      },
      { name: 'policy open', ok: finalPolicy.h2 === true && finalPolicy.h3 === true },
      { name: 'seed projects ready', ok: seedIntact }
    ],
    evidence: {
      note: 'beforeSnapshotRestore 若含非本探针写入的行，说明共享实例有并发操作者（ENV，不记缺陷）'
    }
  })

  // ---------- write evidence ----------
  const capabilityPath = path.join(EVIDENCE_DIR, 'authz-api-combo-capability.json')
  let capabilityProbe = null
  if (fs.existsSync(capabilityPath)) {
    const capability = JSON.parse(fs.readFileSync(capabilityPath, 'utf8'))
    capabilityProbe = {
      verdict: capability.verdict,
      note: '真实桌面客户端（隐藏启动）按票据实际执行 files.read / files.write / terminal.create；单独脚本 probe-authz-capability.mjs 生成',
      sessions: (capability.sessions ?? []).map((session) => ({
        user: session.user,
        ticketPerms: session.rpc?.workspaceInfo?.result?.perms ?? null,
        observed: session.observed ?? null,
        expected: session.expect ?? null,
        ok: session.steps?.find((step) => step.step === 'capability')?.ok === true,
        denials: {
          write: session.rpc?.write?.error?.data ?? null,
          terminalCreate: session.rpc?.terminalCreate?.error?.data ?? null
        }
      }))
    }
  }
  const findings = cases.filter((entry) => entry.verdict === 'fail')
  const byLevel = findings.reduce((acc, entry) => {
    acc[entry.severity] = (acc[entry.severity] ?? 0) + 1
    return acc
  }, {})
  const output = {
    generatedAt: nowIso(),
    platform: BASE,
    seeds,
    hosts: { h2: H2, h3: H3 },
    identities: Object.fromEntries(
      Object.entries(users).map(([name, user]) => [
        name,
        { id: user.id, deviceId: devices[name].id, groups: PEOPLE[name].groups }
      ])
    ),
    summary: {
      totalCases: cases.length,
      passed: cases.length - findings.length,
      failed: findings.length,
      byLevel,
      byArea: cases.reduce((acc, entry) => {
        acc[entry.area] = (acc[entry.area] ?? 0) + 1
        return acc
      }, {}),
      restored: {
        projectGrants: restoreProjectChecks.every((row) => row.ok),
        hostGrants:
          sameRows(restoredHostGrants.h2, hostGrantSnapshot.h2) &&
          sameRows(restoredHostGrants.h3, hostGrantSnapshot.h3),
        provisionPolicies: finalPolicy.h2 === true && finalPolicy.h3 === true,
        probeProjectsArchived: archiveResults.every((row) => row.status === 200) && probeArchived
      },
      preRunHostGrantSnapshot: hostGrantSnapshot
    },
    findings,
    capabilityProbe,
    cases
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'authz-api-combo.json'),
    `${JSON.stringify(output, null, 2)}\n`
  )
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'authz-api-combo-raw.json'),
    `${JSON.stringify({ generatedAt: output.generatedAt, requests: raw }, null, 2)}\n`
  )
  console.log(
    JSON.stringify(
      {
        total: cases.length,
        passed: cases.length - findings.length,
        failed: findings.length,
        byLevel
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
