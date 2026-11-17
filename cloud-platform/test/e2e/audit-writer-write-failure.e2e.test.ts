import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login, spawnService, type Service } from './harness.ts'

/**
 * U246: a failed writer persist is transient. It must leave no phantom event,
 * must not latch the writer until restart, and must be reported as such instead
 * of as a broken chain (which is global and must stay fail-closed).
 */

const INTERNAL_TOKEN = 'u246-internal-token'

type Writer = { url: string; stop: () => Promise<void> }
type AuditEvent = { seq: number; prevHash: string; hash: string; targetId: string }
type Json = Record<string, unknown>

function event(targetId: string): Record<string, unknown> {
  return {
    eventType: 'project_connect',
    actor: 'admin',
    targetType: 'project',
    targetId,
    result: 'success',
    traceId: null
  }
}

async function startWriter(path: string): Promise<Writer> {
  const svc = await spawnService(
    'apps/audit-writer/src/writer.ts',
    { PORT: '0', INTERNAL_TOKEN, AUDIT_LOG_PATH: path },
    /\[audit-writer\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'audit-writer-u246'
  )
  return { url: svc.url, stop: svc.stop }
}

async function startReplica(writerUrl: string): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    {
      PORT: '0',
      INTERNAL_TOKEN,
      ORCA_CLOUD_AUDIT_WRITER_URL: writerUrl,
      AUDIT_LOG_PATH: ''
    },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-u246'
  )
}

async function append(
  writer: Writer,
  input: Record<string, unknown>
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${writer.url}/v1/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify({ events: [input] })
  })
  return { status: res.status, body: (await res.json()) as Json }
}

async function writerGet<T>(writer: Writer, path: string): Promise<T> {
  const res = await fetch(`${writer.url}${path}`, {
    headers: { 'x-internal-token': INTERNAL_TOKEN }
  })
  assert.equal(res.status, 200)
  return (await res.json()) as T
}

async function createProject(
  replica: Service,
  token: string,
  key: string
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${replica.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ key, name: key, hostId: 'host_dev001', path: `/srv/work/${key}` })
  })
  return { status: res.status, body: (await res.json()) as Json }
}

function errorCode(body: Json): unknown {
  const error = body.error
  return error !== null && typeof error === 'object' ? (error as Json).code : undefined
}

test('U246 writer 写失败可重试、无残留、health 真实、客户端不当作断链', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-u246-'))
  const logPath = join(dir, 'audit.log')
  const writer = await startWriter(logPath)
  let replica: Service | null = null
  try {
    assert.equal((await append(writer, event('one'))).status, 200)

    replica = await startReplica(writer.url)
    const token = await login(replica.url, 'admin', 'Adm1n!')
    assert.equal((await createProject(replica, token, 'u246-before')).status, 201)

    const verifyBefore = await writerGet<{ ok: boolean; checked: number; tip: string }>(
      writer,
      '/v1/verify'
    )
    assert.equal(verifyBefore.ok, true)

    chmodSync(logPath, 0o400)
    const failed = await append(writer, event('phantom'))
    assert.equal(failed.status, 503)
    assert.equal(errorCode(failed.body), 'AUDIT_WRITE_FAILED')

    // No phantom: the failed event is neither counted nor linked.
    const verifyAfterFailure = await writerGet<{ ok: boolean; checked: number; tip: string }>(
      writer,
      '/v1/verify'
    )
    assert.equal(verifyAfterFailure.ok, true)
    assert.equal(verifyAfterFailure.checked, verifyBefore.checked)
    assert.equal(verifyAfterFailure.tip, verifyBefore.tip)

    // /health used to report ok:true while the sink was failing.
    const failedHealth = (await (await fetch(`${writer.url}/health`)).json()) as {
      ok: boolean
      reason?: string
      role: string
    }
    assert.equal(failedHealth.ok, false)
    assert.equal(failedHealth.reason, 'write_failed')
    assert.equal(failedHealth.role, 'leader')

    // Client mapping: transient write failure, not a latched broken chain.
    const blocked = await createProject(replica, token, 'u246-blocked')
    assert.equal(blocked.status, 503)
    assert.equal(errorCode(blocked.body), 'AUDIT_UNAVAILABLE')
    const statusRes = await fetch(`${replica.url}/v1/audit/status`, {
      headers: { authorization: `Bearer ${token}` }
    })
    const status = (await statusRes.json()) as Json & { chain?: { lastSeq: number } }
    assert.equal(status.ok, false)
    assert.equal(status.reason, 'write_failed')
    assert.equal(status.chain?.lastSeq, verifyBefore.checked)

    // Recovery needs no restart: the next append links to the persisted tip.
    chmodSync(logPath, 0o600)
    const recovered = await append(writer, event('two'))
    assert.equal(recovered.status, 200)
    const recoveredEvent = (recovered.body.events as AuditEvent[])[0] as AuditEvent
    assert.equal(recoveredEvent.seq, verifyBefore.checked + 1)
    assert.equal(recoveredEvent.prevHash, verifyBefore.tip)

    const recoveredHealth = (await (await fetch(`${writer.url}/health`)).json()) as {
      ok: boolean
      role: string
    }
    assert.equal(recoveredHealth.ok, true)

    // And the replica heals on its own next successful append.
    const allowed = await createProject(replica, token, 'u246-after')
    assert.equal(allowed.status, 201)
    const verifyAfterRecovery = await writerGet<{ ok: boolean; checked: number }>(
      writer,
      '/v1/verify'
    )
    assert.equal(verifyAfterRecovery.ok, true)
    assert.equal(verifyAfterRecovery.checked, verifyBefore.checked + 2)
  } finally {
    chmodSync(logPath, 0o600)
    await replica?.stop()
    await writer.stop()
  }
}, 40000)
