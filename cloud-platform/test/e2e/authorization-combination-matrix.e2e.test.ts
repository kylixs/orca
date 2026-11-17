import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, type ApiHandle } from '../../apps/api/src/server.ts'
import { makeDeviceKey, saveEvidence } from './harness.ts'

/**
 * Role x endpoint authorization regression on the real platform stack.
 *
 * The matrix below is read off `apps/api/src/server.ts`, not from memory:
 * `requireAuth` answers 401, `denyPrivileged` answers 403 plus a `result:
 * 'denied'` audit event, and project/audit-adjacent writes answer 403 with a
 * hand-written denial event. Cases marked `deniedEvent` prove the refusal also
 * landed on the audit chain, queried back through GET /v1/audit/events.
 *
 * Recorded gaps (kept visible instead of tuned green):
 * - No `/v1/settings*` route exists; the console settings page is backed by
 *   `/v1/policies/download` and `/v1/client/config` (asserted below).
 * - Platform admins do NOT inherit a project `open` bit: `/connect` and
 *   `/web-handoff` refuse them unless an explicit grant exists (U40);
 *   project detail/list/grant reads still admit them through `isAdmin`.
 */

const EVIDENCE = 'authorization-combination-matrix'
const INTERNAL_TOKEN = 'authz-matrix-internal'
const PROJECT_ID = 'proj_payment'
const HOST_ID = 'host_dev001'

type Role = 'admin' | 'auditor' | 'developer'

type Login = { token: string; userId: string; deviceId: string; roles: string[] }

type MatrixCase = {
  name: string
  role: Role
  method: string
  path: string
  body?: Record<string, unknown>
  expected: number[]
  /** The audit event this refusal must leave on the chain. */
  deniedEvent?: { eventType: string; targetId?: string }
  verify?: (body: unknown) => void
  tokenOverride?: string
}

const ROLE_USERNAME: Record<Role, string> = {
  admin: 'admin',
  auditor: 'lisi',
  developer: 'zhangsan'
}

let app: ApiHandle
let base = ''
let admin: Login
let auditor: Login
let developer: Login
let hostInstallToken = ''

const tokens: Record<Role, string> = { admin: '', auditor: '', developer: '' }
const userIds: Record<Role, string> = { admin: '', auditor: '', developer: '' }

async function postLogin(username: string, password: string, device: string): Promise<Login> {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password,
      deviceName: device,
      devicePubKey: makeDeviceKey()
    })
  })
  const body = await readJson<{
    accessToken?: string
    user?: { id: string; roles: string[] }
    device?: { id: string }
    error?: { code?: string }
  }>(res)
  assert.equal(res.status, 200, JSON.stringify(body))
  return {
    token: body.accessToken ?? '',
    userId: body.user?.id ?? '',
    deviceId: body.device?.id ?? '',
    roles: body.user?.roles ?? []
  }
}

async function readJson<T>(res: Response): Promise<T> {
  // SAFETY: callers assert the endpoint's documented reply shape.
  return (await res.json()) as T
}

function request(
  role: Role,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  tokenOverride?: string
): Promise<Response> {
  const token = tokenOverride ?? tokens[role]
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === '' ? {} : { authorization: `Bearer ${token}` })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

type AuditEvent = {
  eventType: string
  actor: string | null
  targetType: string | null
  targetId: string | null
  result: string
  metadata: Record<string, unknown>
}

async function auditEvents(query: Record<string, string>): Promise<AuditEvent[]> {
  const params = new URLSearchParams({ ...query, limit: '200' })
  const res = await request('admin', 'GET', `/v1/audit/events?${params.toString()}`)
  if (res.status !== 200) {
    assert.fail(`audit query failed: ${res.status} ${await res.text()}`)
  }
  const body = await readJson<{ events: AuditEvent[] }>(res)
  return body.events
}

async function assertDeniedOnChain(
  eventType: string,
  username: string,
  targetId?: string
): Promise<AuditEvent> {
  // The writer is synchronous; the handler awaited/attempted the append before replying.
  const events = await auditEvents({ eventType, actor: username, result: 'denied' })
  const match = events.find(
    (event) =>
      event.eventType === eventType &&
      event.actor === username &&
      event.result === 'denied' &&
      (targetId === undefined || event.targetId === targetId)
  )
  assert.ok(
    match,
    `missing denied audit event ${eventType} for ${username}${
      targetId === undefined ? '' : ` (${targetId})`
    }; got ${JSON.stringify(events.map((event) => [event.eventType, event.actor, event.result]))}`
  )
  return match
}

const hasOpenGrant = (body: unknown): void => {
  // SAFETY: GET /v1/projects documents `{ projects: [...] }`.
  const projects = (body as { projects: Record<string, unknown>[] }).projects
  assert.ok(
    projects.some((project) => project.id === PROJECT_ID),
    'the team-payment group grant must expose proj_payment'
  )
}

const noProjects = (body: unknown): void => {
  // SAFETY: GET /v1/projects documents `{ projects: [...] }`.
  const projects = (body as { projects: unknown[] }).projects
  assert.deepEqual(projects, [], 'an auditor has no project grant and no admin bypass')
}

/**
 * Ordered: the final row force-offlines the developer, so every developer case
 * must run before it and the disabled-user check must come after all auditors.
 */
/** Built after `before()` so user ids are real; the rows themselves are static. */
function matrix(): MatrixCase[] {
  return [
  // ---- /v1/users: read + role write + session revoke ----
  { name: 'admin list users', role: 'admin', method: 'GET', path: '/v1/users', expected: [200] },
  {
    name: 'auditor list users',
    role: 'auditor',
    method: 'GET',
    path: '/v1/users',
    expected: [403],
    deniedEvent: { eventType: 'user_list' }
  },
  {
    name: 'developer list users',
    role: 'developer',
    method: 'GET',
    path: '/v1/users',
    expected: [403],
    deniedEvent: { eventType: 'user_list' }
  },
  { name: 'admin read directory', role: 'admin', method: 'GET', path: '/v1/directory', expected: [200] },
  {
    name: 'auditor read directory',
    role: 'auditor',
    method: 'GET',
    path: '/v1/directory',
    expected: [403],
    deniedEvent: { eventType: 'directory_read' }
  },
  {
    name: 'developer read directory',
    role: 'developer',
    method: 'GET',
    path: '/v1/directory',
    expected: [403],
    deniedEvent: { eventType: 'directory_read' }
  },
  {
    name: 'admin update developer role',
    role: 'admin',
    method: 'PUT',
    path: `/v1/users/${userIds.developer ?? ''}/roles`,
    body: { role: 'developer' },
    expected: [200]
  },
  {
    name: 'auditor update role',
    role: 'auditor',
    method: 'PUT',
    path: `/v1/users/${userIds.developer ?? ''}/roles`,
    body: { role: 'admin' },
    expected: [403],
    deniedEvent: { eventType: 'role_update', targetId: userIds.developer }
  },
  {
    name: 'developer update role',
    role: 'developer',
    method: 'PUT',
    path: `/v1/users/${userIds.developer ?? ''}/roles`,
    body: { role: 'admin' },
    expected: [403],
    deniedEvent: { eventType: 'role_update', targetId: userIds.developer }
  },
  {
    name: 'auditor revoke user sessions',
    role: 'auditor',
    method: 'POST',
    path: `/v1/users/${userIds.developer ?? ''}/sessions/revoke`,
    body: { reason: 'authz-matrix-auditor' },
    expected: [403],
    deniedEvent: { eventType: 'session_revoke', targetId: userIds.developer }
  },
  {
    name: 'developer revoke user sessions',
    role: 'developer',
    method: 'POST',
    path: `/v1/users/${userIds.developer ?? ''}/sessions/revoke`,
    body: { reason: 'authz-matrix-developer' },
    expected: [403],
    deniedEvent: { eventType: 'session_revoke', targetId: userIds.developer }
  },

  // ---- /v1/relays ----
  { name: 'admin list relays', role: 'admin', method: 'GET', path: '/v1/relays', expected: [200] },
  {
    name: 'auditor list relays',
    role: 'auditor',
    method: 'GET',
    path: '/v1/relays',
    expected: [403],
    deniedEvent: { eventType: 'relay_list' }
  },
  {
    name: 'developer list relays',
    role: 'developer',
    method: 'GET',
    path: '/v1/relays',
    expected: [403],
    deniedEvent: { eventType: 'relay_list' }
  },
  {
    name: 'admin create relay install token',
    role: 'admin',
    method: 'POST',
    path: '/v1/relays/install-tokens',
    expected: [201]
  },
  {
    name: 'auditor create relay install token',
    role: 'auditor',
    method: 'POST',
    path: '/v1/relays/install-tokens',
    expected: [403],
    deniedEvent: { eventType: 'install_download_token_create' }
  },
  {
    name: 'developer create relay install token',
    role: 'developer',
    method: 'POST',
    path: '/v1/relays/install-tokens',
    expected: [403],
    deniedEvent: { eventType: 'install_download_token_create' }
  },

  // ---- /v1/hosts ----
  { name: 'admin list hosts', role: 'admin', method: 'GET', path: '/v1/hosts', expected: [200] },
  {
    name: 'auditor list hosts',
    role: 'auditor',
    method: 'GET',
    path: '/v1/hosts',
    expected: [403],
    deniedEvent: { eventType: 'host_list' }
  },
  {
    name: 'developer list hosts',
    role: 'developer',
    method: 'GET',
    path: '/v1/hosts',
    expected: [403],
    deniedEvent: { eventType: 'host_list' }
  },
  {
    name: 'admin list available hosts',
    role: 'admin',
    method: 'GET',
    path: '/v1/hosts/available',
    expected: [200]
  },
  {
    name: 'auditor list available hosts',
    role: 'auditor',
    method: 'GET',
    path: '/v1/hosts/available',
    expected: [200]
  },
  {
    name: 'developer list available hosts',
    role: 'developer',
    method: 'GET',
    path: '/v1/hosts/available',
    expected: [200]
  },
  {
    name: 'admin create host token',
    role: 'admin',
    method: 'POST',
    path: '/v1/hosts/tokens',
    expected: [201]
  },
  {
    name: 'auditor create host token',
    role: 'auditor',
    method: 'POST',
    path: '/v1/hosts/tokens',
    expected: [403],
    deniedEvent: { eventType: 'host_token_create' }
  },
  {
    name: 'developer create host token',
    role: 'developer',
    method: 'POST',
    path: '/v1/hosts/tokens',
    expected: [403],
    deniedEvent: { eventType: 'host_token_create' }
  },
  {
    name: 'admin read host grants',
    role: 'admin',
    method: 'GET',
    path: `/v1/hosts/${HOST_ID}/grants`,
    expected: [200]
  },
  {
    name: 'auditor read host grants',
    role: 'auditor',
    method: 'GET',
    path: `/v1/hosts/${HOST_ID}/grants`,
    expected: [403],
    deniedEvent: { eventType: 'host_grant_read', targetId: HOST_ID }
  },
  {
    name: 'developer read host grants',
    role: 'developer',
    method: 'GET',
    path: `/v1/hosts/${HOST_ID}/grants`,
    expected: [403],
    deniedEvent: { eventType: 'host_grant_read', targetId: HOST_ID }
  },
  {
    name: 'admin replace host grant row (empty)',
    role: 'admin',
    method: 'PUT',
    path: `/v1/hosts/${HOST_ID}/grants`,
    body: { subjectType: 'user', subjectId: userIds.developer ?? '', permissions: [] },
    expected: [200]
  },
  {
    name: 'auditor write host grants',
    role: 'auditor',
    method: 'PUT',
    path: `/v1/hosts/${HOST_ID}/grants`,
    body: { subjectType: 'user', subjectId: userIds.developer ?? '', permissions: ['maintain'] },
    expected: [403],
    deniedEvent: { eventType: 'host_grant_update', targetId: HOST_ID }
  },
  {
    name: 'developer write host grants',
    role: 'developer',
    method: 'PUT',
    path: `/v1/hosts/${HOST_ID}/grants`,
    body: { subjectType: 'user', subjectId: userIds.developer ?? '', permissions: ['maintain'] },
    expected: [403],
    deniedEvent: { eventType: 'host_grant_update', targetId: HOST_ID }
  },
  {
    name: 'admin set host maintenance off',
    role: 'admin',
    method: 'POST',
    path: `/v1/hosts/${HOST_ID}/maintenance`,
    body: { enabled: false },
    expected: [200]
  },
  {
    name: 'auditor set host maintenance',
    role: 'auditor',
    method: 'POST',
    path: `/v1/hosts/${HOST_ID}/maintenance`,
    body: { enabled: true },
    expected: [403],
    deniedEvent: { eventType: 'host_maintenance', targetId: HOST_ID }
  },
  {
    name: 'developer set host maintenance',
    role: 'developer',
    method: 'POST',
    path: `/v1/hosts/${HOST_ID}/maintenance`,
    body: { enabled: true },
    expected: [403],
    deniedEvent: { eventType: 'host_maintenance', targetId: HOST_ID }
  },
  {
    name: 'admin set host provision policy',
    role: 'admin',
    method: 'PUT',
    path: `/v1/hosts/${HOST_ID}/provision-policy`,
    body: { mode: 'restricted' },
    expected: [200]
  },
  {
    name: 'auditor set host provision policy',
    role: 'auditor',
    method: 'PUT',
    path: `/v1/hosts/${HOST_ID}/provision-policy`,
    body: { mode: 'open' },
    expected: [403],
    deniedEvent: { eventType: 'host_provision_policy_update', targetId: HOST_ID }
  },
  {
    name: 'developer set host provision policy',
    role: 'developer',
    method: 'PUT',
    path: `/v1/hosts/${HOST_ID}/provision-policy`,
    body: { mode: 'open' },
    expected: [403],
    deniedEvent: { eventType: 'host_provision_policy_update', targetId: HOST_ID }
  },

  // ---- /v1/projects: reads and writes ----
  {
    name: 'admin list projects',
    role: 'admin',
    method: 'GET',
    path: '/v1/projects',
    expected: [200],
    verify: hasOpenGrant
  },
  {
    name: 'auditor list projects (ACL-empty)',
    role: 'auditor',
    method: 'GET',
    path: '/v1/projects',
    expected: [200],
    verify: noProjects
  },
  {
    name: 'developer list projects via group grant',
    role: 'developer',
    method: 'GET',
    path: '/v1/projects',
    expected: [200],
    verify: hasOpenGrant
  },
  {
    name: 'admin read project',
    role: 'admin',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}`,
    expected: [200]
  },
  {
    name: 'auditor read project (adminAccess)',
    role: 'auditor',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}`,
    expected: [200]
  },
  {
    name: 'developer read project (open grant)',
    role: 'developer',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}`,
    expected: [200]
  },
  {
    name: 'admin read project grants',
    role: 'admin',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}/grants`,
    expected: [200]
  },
  {
    name: 'auditor read project grants',
    role: 'auditor',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}/grants`,
    expected: [200]
  },
  {
    name: 'developer read project grants',
    role: 'developer',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}/grants`,
    expected: [200]
  },
  {
    name: 'admin read project policy',
    role: 'admin',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}/policy`,
    expected: [200]
  },
  {
    name: 'auditor read project policy',
    role: 'auditor',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}/policy`,
    expected: [200]
  },
  {
    name: 'developer read project policy',
    role: 'developer',
    method: 'GET',
    path: `/v1/projects/${PROJECT_ID}/policy`,
    expected: [200]
  },
  {
    name: 'admin create project',
    role: 'admin',
    method: 'POST',
    path: '/v1/projects',
    body: { hostId: HOST_ID, key: 'authz-matrix-service', path: '/srv/e2e/authz-matrix' },
    expected: [201]
  },
  {
    name: 'auditor create project',
    role: 'auditor',
    method: 'POST',
    path: '/v1/projects',
    body: { hostId: HOST_ID, key: 'authz-auditor-denied', path: '/srv/e2e/authz-auditor' },
    expected: [403],
    deniedEvent: { eventType: 'project_create' }
  },
  {
    name: 'developer create project',
    role: 'developer',
    method: 'POST',
    path: '/v1/projects',
    body: { hostId: HOST_ID, key: 'authz-developer-denied', path: '/srv/e2e/authz-developer' },
    expected: [403],
    deniedEvent: { eventType: 'project_create' }
  },
  {
    name: 'admin replace project grant row (same bits)',
    role: 'admin',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}/grants`,
    body: {
      subjectType: 'group',
      subjectId: 'team-payment',
      permissions: ['open', 'terminal', 'agent', 'file:read', 'file:write']
    },
    expected: [200]
  },
  {
    name: 'auditor write project grants',
    role: 'auditor',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}/grants`,
    body: { subjectType: 'user', subjectId: userIds.developer ?? '', permissions: [] },
    expected: [403],
    deniedEvent: { eventType: 'grant_update', targetId: PROJECT_ID }
  },
  {
    name: 'developer write project grants',
    role: 'developer',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}/grants`,
    body: { subjectType: 'user', subjectId: userIds.developer ?? '', permissions: [] },
    expected: [403],
    deniedEvent: { eventType: 'grant_update', targetId: PROJECT_ID }
  },
  {
    name: 'admin set project policy to inherit',
    role: 'admin',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}/policy`,
    body: { inherit: true },
    expected: [200]
  },
  {
    name: 'auditor write project policy',
    role: 'auditor',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}/policy`,
    body: { inherit: true },
    expected: [403],
    deniedEvent: { eventType: 'policy_update', targetId: PROJECT_ID }
  },
  {
    name: 'developer write project policy',
    role: 'developer',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}/policy`,
    body: { inherit: true },
    expected: [403],
    deniedEvent: { eventType: 'policy_update', targetId: PROJECT_ID }
  },
  {
    name: 'developer connect project (open grant)',
    role: 'developer',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/connect`,
    body: { deviceId: developer?.deviceId ?? '', clientVersion: '1.5.0' },
    expected: [200]
  },
  {
    name: 'auditor connect project (no open bit)',
    role: 'auditor',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/connect`,
    body: { deviceId: auditor?.deviceId ?? '', clientVersion: '1.5.0' },
    expected: [403],
    deniedEvent: { eventType: 'project_connect', targetId: PROJECT_ID }
  },
  {
    name: 'admin connect project (no open bit, U40)',
    role: 'admin',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/connect`,
    body: { deviceId: admin?.deviceId ?? '', clientVersion: '1.5.0' },
    expected: [403],
    deniedEvent: { eventType: 'project_connect', targetId: PROJECT_ID }
  },
  {
    name: 'developer web handoff project',
    role: 'developer',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/web-handoff`,
    body: {},
    expected: [201]
  },
  {
    name: 'auditor web handoff project',
    role: 'auditor',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/web-handoff`,
    body: {},
    expected: [403],
    deniedEvent: { eventType: 'web_handoff', targetId: PROJECT_ID }
  },
  {
    name: 'admin web handoff project (no open bit)',
    role: 'admin',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/web-handoff`,
    body: {},
    expected: [403],
    deniedEvent: { eventType: 'web_handoff', targetId: PROJECT_ID }
  },
  {
    name: 'admin update project (enters provisioning)',
    role: 'admin',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}`,
    body: { defaultBranch: 'main' },
    expected: [200]
  },
  {
    name: 'auditor update project',
    role: 'auditor',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}`,
    body: { defaultBranch: 'main' },
    expected: [403],
    deniedEvent: { eventType: 'project_update', targetId: PROJECT_ID }
  },
  {
    name: 'developer update project',
    role: 'developer',
    method: 'PUT',
    path: `/v1/projects/${PROJECT_ID}`,
    body: { defaultBranch: 'main' },
    expected: [403],
    deniedEvent: { eventType: 'project_update', targetId: PROJECT_ID }
  },

  // ---- /v1/policies/download (settings family) ----
  {
    name: 'admin read download policy',
    role: 'admin',
    method: 'GET',
    path: '/v1/policies/download',
    expected: [200]
  },
  {
    name: 'auditor read download policy',
    role: 'auditor',
    method: 'GET',
    path: '/v1/policies/download',
    expected: [200]
  },
  {
    name: 'developer read download policy',
    role: 'developer',
    method: 'GET',
    path: '/v1/policies/download',
    expected: [200]
  },
  {
    name: 'admin write download policy',
    role: 'admin',
    method: 'PUT',
    path: '/v1/policies/download',
    body: { downloadDefault: 'deny' },
    expected: [200]
  },
  {
    name: 'auditor write download policy',
    role: 'auditor',
    method: 'PUT',
    path: '/v1/policies/download',
    body: { downloadDefault: 'allow' },
    expected: [403],
    deniedEvent: { eventType: 'policy_update', targetId: 'download' }
  },
  {
    name: 'developer write download policy',
    role: 'developer',
    method: 'PUT',
    path: '/v1/policies/download',
    body: { downloadDefault: 'allow' },
    expected: [403],
    deniedEvent: { eventType: 'policy_update', targetId: 'download' }
  },

  // ---- /v1/audit read + export ----
  {
    name: 'admin query audit events',
    role: 'admin',
    method: 'GET',
    path: '/v1/audit/events?limit=5',
    expected: [200]
  },
  {
    name: 'auditor query audit events',
    role: 'auditor',
    method: 'GET',
    path: '/v1/audit/events?limit=5',
    expected: [200]
  },
  {
    name: 'developer query audit events',
    role: 'developer',
    method: 'GET',
    path: '/v1/audit/events?limit=5',
    expected: [403],
    deniedEvent: { eventType: 'audit_query' }
  },
  {
    name: 'admin read audit status',
    role: 'admin',
    method: 'GET',
    path: '/v1/audit/status',
    expected: [200]
  },
  {
    name: 'auditor read audit status',
    role: 'auditor',
    method: 'GET',
    path: '/v1/audit/status',
    expected: [200]
  },
  {
    name: 'developer read audit status',
    role: 'developer',
    method: 'GET',
    path: '/v1/audit/status',
    expected: [403],
    deniedEvent: { eventType: 'audit_query' }
  },
  {
    name: 'admin verify audit chain',
    role: 'admin',
    method: 'GET',
    path: '/v1/audit/verify',
    expected: [200]
  },
  {
    name: 'auditor verify audit chain',
    role: 'auditor',
    method: 'GET',
    path: '/v1/audit/verify',
    expected: [200]
  },
  {
    name: 'developer verify audit chain',
    role: 'developer',
    method: 'GET',
    path: '/v1/audit/verify',
    expected: [403],
    deniedEvent: { eventType: 'audit_verify' }
  },
  {
    name: 'admin accept audit export',
    role: 'admin',
    method: 'POST',
    path: '/v1/audit/export',
    body: { confirm: true, format: 'csv' },
    expected: [202]
  },
  {
    name: 'auditor accept audit export',
    role: 'auditor',
    method: 'POST',
    path: '/v1/audit/export',
    body: { confirm: true, format: 'jsonl' },
    expected: [202]
  },
  {
    name: 'developer accept audit export',
    role: 'developer',
    method: 'POST',
    path: '/v1/audit/export',
    body: { confirm: true, format: 'csv' },
    expected: [403],
    deniedEvent: { eventType: 'audit_export' }
  },
  {
    name: 'admin download unknown export id (token-scoped)',
    role: 'admin',
    method: 'GET',
    path: '/v1/audit/exports/unknown-job/download?token=forged',
    expected: [404]
  },

  // ---- /v1/admin ----
  {
    name: 'admin rotate signing key',
    role: 'admin',
    method: 'POST',
    path: '/v1/admin/signing-keys/rotate',
    expected: [200]
  },
  {
    name: 'auditor rotate signing key',
    role: 'auditor',
    method: 'POST',
    path: '/v1/admin/signing-keys/rotate',
    expected: [403],
    deniedEvent: { eventType: 'signing_key_rotate' }
  },
  {
    name: 'developer rotate signing key',
    role: 'developer',
    method: 'POST',
    path: '/v1/admin/signing-keys/rotate',
    expected: [403],
    deniedEvent: { eventType: 'signing_key_rotate' }
  },

  // ---- install / download family ----
  {
    name: 'admin download host install script',
    role: 'admin',
    method: 'GET',
    path: `/install/host.sh?token=${hostInstallToken}`,
    expected: [200]
  },
  {
    name: 'auditor download host install script',
    role: 'auditor',
    method: 'GET',
    path: `/install/host.sh?token=${hostInstallToken}`,
    expected: [403],
    deniedEvent: { eventType: 'install_script', targetId: '/install/host.sh' }
  },
  {
    name: 'developer download host install script',
    role: 'developer',
    method: 'GET',
    path: `/install/host.sh?token=${hostInstallToken}`,
    expected: [403],
    deniedEvent: { eventType: 'install_script', targetId: '/install/host.sh' }
  },
  {
    name: 'admin download relay install script',
    role: 'admin',
    method: 'GET',
    path: '/install/relay.sh',
    expected: [200]
  },
  {
    name: 'auditor download relay install script',
    role: 'auditor',
    method: 'GET',
    path: '/install/relay.sh',
    expected: [403],
    deniedEvent: { eventType: 'install_script', targetId: '/install/relay.sh' }
  },
  {
    name: 'developer download relay install script',
    role: 'developer',
    method: 'GET',
    path: '/install/relay.sh',
    expected: [403],
    deniedEvent: { eventType: 'install_script', targetId: '/install/relay.sh' }
  },

  // ---- /v1/me and public bootstrap ----
  { name: 'admin read me', role: 'admin', method: 'GET', path: '/v1/me', expected: [200] },
  { name: 'auditor read me', role: 'auditor', method: 'GET', path: '/v1/me', expected: [200] },
  { name: 'developer read me', role: 'developer', method: 'GET', path: '/v1/me', expected: [200] },
  {
    name: 'anonymous client config',
    role: 'admin',
    method: 'GET',
    path: '/v1/client/config',
    tokenOverride: '',
    expected: [200]
  },
  {
    name: 'anonymous jwks',
    role: 'admin',
    method: 'GET',
    path: '/v1/jwks',
    tokenOverride: '',
    expected: [200]
  },

  // ---- project archive/restore last: they change project status ----
  {
    name: 'admin archive project',
    role: 'admin',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/archive`,
    expected: [200]
  },
  {
    name: 'auditor archive project (leak-free 404)',
    role: 'auditor',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/archive`,
    expected: [404]
  },
  {
    name: 'developer archive project (leak-free 404)',
    role: 'developer',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/archive`,
    expected: [404]
  },
  {
    name: 'admin restore project',
    role: 'admin',
    method: 'POST',
    path: `/v1/projects/${PROJECT_ID}/restore`,
    expected: [200]
  },

  // ---- force-offline: must be the last developer-token case ----
  {
    name: 'admin force-offline developer sessions',
    role: 'admin',
    method: 'POST',
    path: `/v1/users/${userIds.developer ?? ''}/sessions/revoke`,
    body: { reason: 'authz-matrix' },
    expected: [200],
    verify: (body) => {
      // SAFETY: the force-offline reply documents `{ ok, revokedSessions }`.
      const revoked = (body as { revokedSessions?: number }).revokedSessions
      assert.ok(typeof revoked === 'number' && revoked >= 1, `expected a revoked session, got ${revoked}`)
    }
  }
  ]
}

before(async () => {
  app = createApp({
    port: 0,
    internalToken: INTERNAL_TOKEN,
    auditExportDir: mkdtempSync(join(tmpdir(), 'authz-matrix-exports-'))
  })
  const port = await app.listen()
  base = `http://127.0.0.1:${port}`

  admin = await postLogin('admin', 'Adm1n!', 'authz-admin-device')
  developer = await postLogin('zhangsan', 'Passw0rd!', 'authz-developer-device')
  auditor = await postLogin('lisi', 'Passw0rd!', 'authz-auditor-device')

  tokens.admin = admin.token
  tokens.developer = developer.token
  tokens.auditor = auditor.token
  userIds.admin = admin.userId
  userIds.developer = developer.userId
  userIds.auditor = auditor.userId

  // lisi starts as a developer; promote through the real admin endpoint.
  const promoted = await request('admin', 'PUT', `/v1/users/${auditor.userId}/roles`, {
    role: 'auditor'
  })
  assert.equal(promoted.status, 200, await promoted.text())

  // The host install script always embeds a one-time registration token.
  const minted = await request('admin', 'POST', '/v1/hosts/tokens')
  if (minted.status !== 201) assert.fail(await minted.text())
  const mintedBody = await readJson<{ token?: string }>(minted)
  hostInstallToken = mintedBody.token ?? ''
  assert.notEqual(hostInstallToken, '', 'the install script needs a real registration token')

  // The promoted session must carry the new role without re-login.
  const me = await request('auditor', 'GET', '/v1/me')
  assert.equal(me.status, 200)
  const meBody = await readJson<{ user: { roles: string[] } }>(me)
  assert.ok(meBody.user.roles.includes('platform:auditor'))
})

after(async () => {
  await app?.close()
})

test('未认证请求统一 401 SESSION_EXPIRED', async () => {
  for (const path of ['/v1/projects', '/v1/users', '/v1/audit/events', '/v1/me']) {
    const res = await fetch(`${base}${path}`)
    const body = await readJson<{ error?: { code?: string } }>(res)
    assert.equal(res.status, 401, `${path} must be 401`)
    assert.equal(body.error?.code, 'SESSION_EXPIRED', `${path} must name the session failure`)
  }
})

test('角色 x 端点授权矩阵（真实栈）', async (t) => {
  const results: { name: string; role: Role; status: number; expected: number[] }[] = []

  for (const entry of matrix()) {
    await t.test(entry.name, async () => {
      const res = await request(
        entry.role,
        entry.method,
        entry.path,
        entry.body,
        entry.tokenOverride
      )
      if (!entry.expected.includes(res.status)) {
        assert.fail(
          `${entry.role} ${entry.method} ${entry.path}: expected ${entry.expected.join(
            '/'
          )}, got ${res.status} ${await res.text()}`
        )
      }
      results.push({
        name: entry.name,
        role: entry.role,
        status: res.status,
        expected: entry.expected
      })
      if (entry.verify) entry.verify(await res.json())
      if (entry.deniedEvent) {
        await assertDeniedOnChain(
          entry.deniedEvent.eventType,
          ROLE_USERNAME[entry.role],
          entry.deniedEvent.targetId
        )
      }
    })
  }

  saveEvidence(EVIDENCE, 'matrix.json', {
    roles: ROLE_USERNAME,
    cases: results
  })
})

test('/v1/settings 路由不存在（缺口登记）', async () => {
  // The console settings page is backed by /v1/policies/download + /v1/client/config.
  for (const role of ['admin', 'auditor', 'developer'] as const) {
    const res = await request(role, 'GET', '/v1/settings')
    assert.equal(res.status, 404, `no /v1/settings family is served (${role})`)
  }
  saveEvidence(EVIDENCE, 'settings-route-absent.json', {
    paths: ['/v1/settings'],
    status: 404,
    replacementEndpoints: ['GET/PUT /v1/policies/download', 'GET /v1/client/config']
  })
})

test('已撤销 session 的身份一律 401', async () => {
  // The matrix force-offlined the developer after every developer-token case.
  for (const path of ['/v1/me', '/v1/projects', '/v1/audit/events']) {
    const res = await request('developer', 'GET', path)
    const body = await readJson<{ error?: { code?: string } }>(res)
    assert.equal(res.status, 401, `${path} with a revoked session must be 401`)
    assert.equal(body.error?.code, 'SESSION_EXPIRED')
  }
  saveEvidence(EVIDENCE, 'revoked-session.json', {
    identity: 'zhangsan',
    endpoints: ['/v1/me', '/v1/projects', '/v1/audit/events'],
    status: 401
  })
})

test('已禁用用户：既有 token 401，重新登录 403 USER_DISABLED', async (t) => {
  const user = app.store.users.get(auditor.userId)
  assert.ok(user, 'lisi must exist in the real store')
  user.status = 'disabled'

  await t.test('existing auditor token is rejected as unauthenticated', async () => {
    for (const path of ['/v1/me', '/v1/audit/events', '/v1/users']) {
      const res = await request('auditor', 'GET', path)
      const body = await readJson<{ error?: { code?: string } }>(res)
      assert.equal(res.status, 401, `${path} must not fall through to a role check`)
      assert.equal(body.error?.code, 'SESSION_EXPIRED')
    }
  })

  await t.test('login refuses the disabled account', async () => {
    const res = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'lisi',
        password: 'Passw0rd!',
        deviceName: 'authz-disabled-device',
        devicePubKey: makeDeviceKey()
      })
    })
    const body = await readJson<{ error?: { code?: string } }>(res)
    assert.equal(res.status, 403)
    assert.equal(body.error?.code, 'USER_DISABLED')
  })

  saveEvidence(EVIDENCE, 'disabled-user.json', {
    identity: 'lisi',
    existingTokenStatus: 401,
    loginStatus: 403,
    loginCode: 'USER_DISABLED'
  })
})
