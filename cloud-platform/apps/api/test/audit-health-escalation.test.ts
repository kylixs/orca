import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { AuditChain } from '../src/audit.ts'
import { Store } from '../src/store.ts'
import type { AuditEvent, AuditEventInput } from '../src/store.ts'

/**
 * U249 P3: health used to latch the first failure reason forever, so a real
 * `chain_broken` that happened after a transient `write_failed` stayed invisible
 * on /health and /v1/status. `chain_broken` is the more severe verdict and must
 * supersede `write_failed`; the reverse is never allowed.
 */

function chainWithSink(): {
  store: Store
  chain: AuditChain
  fail: () => void
  recover: () => void
} {
  const store = new Store()
  let failing = false
  const chain = new AuditChain(store, () => {
    if (failing) throw new Error('EACCES: audit log is read-only')
  })
  return {
    store,
    chain,
    fail: () => {
      failing = true
    },
    recover: () => {
      failing = false
    }
  }
}

function sample(targetId: string): AuditEventInput {
  return {
    eventType: 'project_create',
    actor: 'admin',
    targetType: 'project',
    targetId,
    result: 'success'
  }
}

describe('U249 审计健康：失败原因可升级', () => {
  test('write_failed 之后真实断链：health 升级为 chain_broken，firstFailure 保留首因', () => {
    const { store, chain, fail } = chainWithSink()
    chain.append(sample('before'))

    fail()
    assert.throws(() => chain.append(sample('blocked')), /EACCES/)
    const initial = chain.getHealth()
    assert.equal(initial.ok, false)
    assert.ok(!initial.ok && initial.reason === 'write_failed')

    // A later verify over a tampered event is the more severe, real break.
    const victim = store.audit[0] as AuditEvent
    victim.actor = 'ghost'
    const verdict = chain.verify()
    assert.equal(verdict.ok, false)

    const health = chain.getHealth()
    assert.equal(health.ok, false)
    if (health.ok) return
    assert.equal(health.reason, 'chain_broken', '链断必须覆盖可重试的写失败')
    assert.equal(health.firstFailure, 'write_failed', '首因仍可追溯')
    assert.equal(health.lastFailure, 'chain_broken')
  })

  test('chain_broken 锁存：修复后成功写盘与后续 write_failed 都不得降级', () => {
    const { store, chain, fail } = chainWithSink()
    chain.append(sample('one'))
    const intact = structuredClone(store.audit)

    ;(store.audit[0] as AuditEvent).actor = 'ghost'
    assert.equal(chain.verify().ok, false)
    const broken = chain.getHealth()
    assert.ok(!broken.ok && broken.reason === 'chain_broken')

    // Repair + a successful persist must not launder the latched verdict.
    store.audit = intact
    store.auditSeq = intact.at(-1)?.seq ?? 0
    store.auditTip = intact.at(-1)?.hash ?? 'GENESIS'
    chain.append(sample('two'))
    const afterSuccess = chain.getHealth()
    assert.ok(!afterSuccess.ok && afterSuccess.reason === 'chain_broken')

    // A transient write failure afterwards is less severe: keep chain_broken.
    fail()
    assert.throws(() => chain.append(sample('three')), /EACCES/)
    const health = chain.getHealth()
    assert.equal(health.ok, false)
    if (health.ok) return
    assert.equal(health.reason, 'chain_broken', 'write_failed 不得覆盖 chain_broken')
    assert.equal(health.firstFailure, 'chain_broken')
    assert.equal(health.lastFailure, 'write_failed')
  })

  test('成功写盘仍会清除 write_failed（既有语义不变）', () => {
    const { chain, fail, recover } = chainWithSink()
    fail()
    assert.throws(() => chain.append(sample('blocked')), /EACCES/)
    assert.equal(chain.getHealth().ok, false)

    recover()
    chain.append(sample('recovered'))
    assert.deepEqual(chain.getHealth(), { ok: true })
  })
})
