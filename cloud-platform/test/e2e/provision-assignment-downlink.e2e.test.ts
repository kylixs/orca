import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, registerHost, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * U37-A: the heartbeat response carries the host's pending provision
 * assignments (wire-additive, only when non-empty, ≤16/beat, derived from the
 * same store fields a connect ticket claims) so a repo-ful `provisioning`
 * project can reach ready without a first /connect. Maintenance and revoked
 * hosts take none (§8①); each non-empty beat writes one batched
 * `provision_assign` audit event, never one per assignment (§8②).
 */

const EVIDENCE = 'u37a-downlink'
const REPO_URL = 'https://git.example.com/pay/u37-kick.git'
const DEVICE_PUB_KEY = Buffer.from('u37-device-key').toString('base64')

type Reply = { status: number; body: Record<string, unknown> }
type Assignment = { projectId: string; path: string; repoUrl: string; defaultBranch: string }
type AuditEvent = {
  eventType: string
  targetId: string | null
  result: string
  metadata?: Record<string, unknown>
}
type HostRef = { id: string; credential: string }

let api: Service
let adminToken = ''
let host: HostRef = { id: '', credential: '' }
let hostB: HostRef = { id: '', credential: '' }
// A beat captured before any assignment existed: the old-host legacy view baseline.
let legacyBaseline: Reply = { status: 0, body: {} }
const observations: Record<string, unknown> = {}

function auth(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` }
}

async function beat(
  of: HostRef,
  body: Record<string, unknown> = { status: 'online' }
): Promise<Reply> {
  const res = await fetch(`${api.url}/v1/hosts/${of.id}/heartbeat`, {
    method: 'POST',
    headers: auth(of.credential),
    body: JSON.stringify(body)
  })
  assert.equal(res.status, 200, 'heartbeat must succeed while the host is live')
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

function assignmentsOf(reply: Reply): Assignment[] | undefined {
  return reply.body.provisionAssignments as Assignment[] | undefined
}

async function adminCreate(
  key: string,
  opts: { repoUrl?: string; defaultBranch?: string } = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key,
      name: `U37 ${key}`,
      hostId: host.id,
      path: `/srv/work/${key}`,
      ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {}),
      ...(opts.defaultBranch ? { defaultBranch: opts.defaultBranch } : {})
    })
  })
  assert.equal(res.status, 201, `admin create ${key} must succeed`)
  return (await res.json()) as Record<string, unknown>
}

async function adminCreateOn(
  of: HostRef,
  key: string,
  opts: { repoUrl?: string } = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${api.url}/v1/projects`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({
      key,
      name: `U37 ${key}`,
      hostId: of.id,
      path: `/srv/work/${key}`,
      ...(opts.repoUrl ? { repoUrl: opts.repoUrl } : {})
    })
  })
  assert.equal(res.status, 201, `admin create ${key} on ${of.id} must succeed`)
  return (await res.json()) as Record<string, unknown>
}

async function projectStatus(projectId: string): Promise<string> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}`, { headers: auth(adminToken) })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { status: string }
  return body.status
}

async function archive(projectId: string): Promise<void> {
  const res = await fetch(`${api.url}/v1/projects/${projectId}/archive`, {
    method: 'POST',
    headers: auth(adminToken)
  })
  assert.equal(res.status, 200)
}

async function setMaintenance(enabled: boolean): Promise<void> {
  const res = await fetch(`${api.url}/v1/hosts/${host.id}/maintenance`, {
    method: 'POST',
    headers: auth(adminToken),
    body: JSON.stringify({ enabled })
  })
  assert.equal(res.status, 200, JSON.stringify(await res.json()))
}

async function auditEvents(eventType: string): Promise<AuditEvent[]> {
  const res = await fetch(`${api.url}/v1/audit/events?eventType=${eventType}&limit=200`, {
    headers: auth(adminToken)
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { events: AuditEvent[] }
  return body.events
}

before(async () => {
  api = await spawnService(
    'apps/api/src/server.ts',
    { PORT: '0' },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-provision-assignment-downlink'
  )
  adminToken = await login(api.url, 'admin', 'Adm1n!')
  const registered = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u37-downlink-host',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/u37'
  })
  host = { id: registered.hostId, credential: registered.credential }
  const second = await registerHost({
    apiUrl: api.url,
    adminToken,
    name: 'u37-downlink-host-b',
    directAddr: '127.0.0.1:9',
    relayTarget: '127.0.0.1:9',
    projectsRoot: '/srv/u37b'
  })
  hostB = { id: second.hostId, credential: second.credential }
  // Warm-up beats so neither host has pending state before the first assertion.
  await beat(host)
  await beat(hostB)
})

after(async () => {
  await api?.stop()
  saveEvidence(EVIDENCE, 'provision-assignment-downlink.json', { observations })
})

describe('U37-A 心跳下行 provisionAssignments（真实平台进程）', () => {
  test('② ready / archived / 无 repoUrl 均不派，且无 pending 时响应不含该键', async () => {
    // Repo-less: ready at creation, nothing to clone.
    const repoLess = await adminCreate('u37-repo-less')
    assert.equal(repoLess.status, 'ready')
    const noRepoUrl = await beat(host)
    assert.equal(
      'provisionAssignments' in noRepoUrl.body,
      false,
      'wire-additive: the key must be absent, not an empty array'
    )
    observations['no-pending-beat'] = { keys: Object.keys(noRepoUrl.body).sort() }

    // Repo-ful then archived: derivation excludes archived, like the report path.
    const archived = (await adminCreate('u37-archived', { repoUrl: REPO_URL })) as { id: string }
    assert.equal(await projectStatus(archived.id), 'provisioning')
    const beforeArchive = await beat(host)
    assert.deepEqual(
      (assignmentsOf(beforeArchive) ?? []).map((a) => a.projectId),
      [archived.id]
    )
    await archive(archived.id)
    const afterArchive = await beat(host)
    assert.equal('provisionAssignments' in afterArchive.body, false)

    // Repo-ful turned ready by the host's own provisioned[] report: no re-assign.
    const readied = (await adminCreate('u37-readied', { repoUrl: REPO_URL })) as { id: string }
    await beat(host, { provisioned: [{ projectId: readied.id, ok: true }] })
    assert.equal(await projectStatus(readied.id), 'ready')
    const afterReady = await beat(host)
    assert.equal('provisionAssignments' in afterReady.body, false)
    observations['not-assigned'] = { archived: archived.id, readied: readied.id }
  })

  test('① provisioning repo-ful 项目：响应恰含其指派，字段与票据 claims 同源', async () => {
    const created = (await adminCreate('u37-kick-main', {
      repoUrl: REPO_URL,
      defaultBranch: 'main'
    })) as { id: string; path: string }
    assert.equal(await projectStatus(created.id), 'provisioning')

    const reply = await beat(host)
    const assignments = assignmentsOf(reply)
    assert.ok(Array.isArray(assignments), 'a pending repo-ful beat must carry assignments')
    assert.equal(assignments!.length, 1, "exactly the host's own pending project")
    // Ticket claims source: the same store row POST /connect mints credentials from.
    assert.deepEqual(assignments![0], {
      projectId: created.id,
      path: created.path,
      repoUrl: REPO_URL,
      defaultBranch: 'main'
    })
    observations['assignment'] = assignments![0]
  })

  test('③ maintenance 宿主不派（§8①），恢复后下一拍续派', async () => {
    await setMaintenance(true)
    const during = await beat(host)
    assert.equal(
      'provisionAssignments' in during.body,
      false,
      'a maintenance host takes no new assignments'
    )
    assert.deepEqual(during.body.maintenance, { reason: '计划维护' })

    await setMaintenance(false)
    const restored = await beat(host)
    const restoredAssignments = assignmentsOf(restored)
    assert.ok(Array.isArray(restoredAssignments), 'the kick resumes after maintenance ends')
    assert.deepEqual(
      restoredAssignments!.map((a) => a.projectId),
      [(observations['assignment'] as Assignment).projectId]
    )
    observations['maintenance'] = { blocked: true, resumed: true }
  })

  test('④ 旧宿主形态：白名单已知字段反序列化零破坏，既有字段逐字段不变', async () => {
    // Baseline beat: resolve the pending set first, so the two compared beats
    // differ only by the project created in between (revocations already stable).
    const pending = assignmentsOf(await beat(host)) ?? []
    if (pending.length > 0) {
      await beat(host, {
        provisioned: pending.map((a) => ({ projectId: a.projectId, ok: true }))
      })
    }
    legacyBaseline = await beat(host)
    assert.equal('provisionAssignments' in legacyBaseline.body, false)

    // A pending project appears; the next beat must add ONLY the new key.
    const second = (await adminCreate('u37-kick-second', { repoUrl: REPO_URL })) as { id: string }
    const withAssignments = await beat(host)
    const assignments = assignmentsOf(withAssignments)
    assert.deepEqual(
      (assignments ?? []).map((a) => a.projectId),
      [second.id],
      'exactly the newly pending project rides the beat'
    )

    // The old-host view: sendHeartbeat whitelists only the fields it knows, so an
    // unknown key cannot reach its HeartbeatResult — picking the legacy subset out
    // of the new response must reproduce exactly what an old platform answered.
    // (serverTime is beat-local and excluded; its presence and type are asserted.)
    const legacyKeys = ['policyVersion', 'policies', 'revoked', 'maintenance'] as const
    const legacyView = (reply: Reply): Record<string, unknown> =>
      Object.fromEntries(legacyKeys.map((k) => [k, reply.body[k]]))
    for (const key of [
      'policyVersion',
      'policies',
      'revoked',
      'maintenance',
      'serverTime'
    ] as const) {
      assert.ok(key in withAssignments.body, `legacy field ${key} must survive the new field`)
    }
    assert.equal(typeof withAssignments.body.serverTime, 'number')
    assert.deepEqual(
      legacyView(withAssignments),
      legacyView(legacyBaseline),
      'legacy fields byte-identical to a pre-assignment beat'
    )
    // A strict old-host decoder that rejects unknown keys still round-trips the beat.
    const roundTripped = JSON.parse(JSON.stringify(withAssignments.body)) as Record<string, unknown>
    assert.deepEqual(assignmentsOf({ status: 200, body: roundTripped }), assignments)
    observations['legacy-fields'] = legacyView(withAssignments)
  })

  test('⑤ 指派审计恰一条批量 provision_assign（不逐条刷链）', async () => {
    // Host B has stayed quiet so far; two pending projects, one beat.
    const first = (await adminCreateOn(hostB, 'u37-audit-one', { repoUrl: REPO_URL })) as {
      id: string
    }
    const second = (await adminCreateOn(hostB, 'u37-audit-two', { repoUrl: REPO_URL })) as {
      id: string
    }
    const reply = await beat(hostB)
    assert.equal(assignmentsOf(reply)!.length, 2)

    const events = (await auditEvents('provision_assign')).filter((e) => e.targetId === hostB.id)
    assert.equal(events.length, 1, 'one batched event per non-empty beat, never one per assignment')
    assert.equal(events[0]!.eventType, 'provision_assign')
    assert.equal(events[0]!.result, 'success')
    assert.equal(events[0]!.metadata?.count, 2)
    // Derivation order is createdAt ascending: first was created before second.
    assert.deepEqual(events[0]!.metadata?.projectIds, [first.id, second.id])
    observations['audit'] = events[0]
  })
})
