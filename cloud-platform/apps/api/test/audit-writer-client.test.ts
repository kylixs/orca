import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createRemoteAudit } from '../src/audit-writer-client.ts'
import type { AuditEventInput } from '../src/store.ts'

/**
 * U249 P3-4: a pre-U246 writer answers `AUDIT_CHAIN_BROKEN` once its sink has
 * failed, so the client must consult the writer's own status before latching a
 * global break. Only a verified `chain_broken` may stop every replica.
 */

const input: AuditEventInput = {
  eventType: 'login',
  actor: 'admin',
  targetType: null,
  targetId: null,
  result: 'success',
  traceId: null
}

type WriterState = { reason: 'write_failed' | 'chain_broken'; statusProbe?: 'fail' | 'ok' }

function fakeWriter(state: WriterState): typeof fetch {
  return async (request: RequestInfo | URL): Promise<Response> => {
    const url = String(request)
    if (url.endsWith('/v1/append')) {
      return new Response(JSON.stringify({ error: { code: 'AUDIT_CHAIN_BROKEN' } }), {
        status: 503
      })
    }
    if (url.endsWith('/v1/status')) {
      if (state.statusProbe === 'fail') throw new Error('status unreachable')
      return new Response(
        JSON.stringify({ ok: false, reason: state.reason, size: 0, tip: 'GENESIS' }),
        { status: 200 }
      )
    }
    throw new Error(`unexpected request ${url}`)
  }
}

function auditWith(state: WriterState) {
  return createRemoteAudit({
    url: 'http://writer.invalid',
    internalToken: 'test-token',
    fetchImpl: fakeWriter(state)
  })
}

async function rejectionCode(audit: ReturnType<typeof auditWith>): Promise<unknown> {
  try {
    await audit.append(input)
  } catch (error) {
    return error instanceof Error ? (error as Error & { code?: string }).code : undefined
  }
  assert.fail('append should have failed')
}

describe('U249 远端 writer 错误码映射', () => {
  test('旧 writer 瞬时 write_failed 被包装成 AUDIT_CHAIN_BROKEN：客户端按可重试处理', async () => {
    const audit = auditWith({ reason: 'write_failed' })
    assert.equal(await rejectionCode(audit), 'AUDIT_UNAVAILABLE')
    assert.deepEqual(audit.getHealth(), {
      ok: false,
      reason: 'write_failed',
      detail: 'audit writer write failed'
    })
  })

  test('writer 自身确认 chain_broken：保持全局锁存语义', async () => {
    const audit = auditWith({ reason: 'chain_broken' })
    assert.equal(await rejectionCode(audit), 'AUDIT_CHAIN_BROKEN')
    assert.equal(audit.getHealth().ok, false)
    assert.equal(audit.getHealth().ok === false && audit.getHealth().reason, 'chain_broken')
  })

  test('status 探测失败：不凭一次 503 锁存 chain_broken', async () => {
    const audit = auditWith({ reason: 'write_failed', statusProbe: 'fail' })
    assert.equal(await rejectionCode(audit), 'AUDIT_UNAVAILABLE')
    assert.equal(audit.getHealth().ok === false && audit.getHealth().reason, 'write_failed')
  })
})
