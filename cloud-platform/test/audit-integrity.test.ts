import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AuditChain } from '../apps/api/src/audit.ts'
import { Store } from '../apps/api/src/store.ts'
import type { AuditEvent } from '../apps/api/src/store.ts'

/**
 * The audit log is a single-writer hash chain, but nothing exposed it for
 * verification: an operator could read events and never learn whether they were
 * altered. These cases pin the chain's own semantics with real SHA-256 links,
 * including the tamper cases the wire endpoint cannot produce on its own.
 */

function newChain(): { store: Store; chain: AuditChain } {
  const store = new Store()
  return { store, chain: new AuditChain(store) }
}

function appendSample(chain: AuditChain, count: number): void {
  for (let index = 0; index < count; index += 1) {
    chain.append({
      eventType: 'project_connect',
      actor: `user-${index}`,
      targetType: 'project',
      targetId: `proj_${index}`,
      result: 'success'
    })
  }
}

describe('审计哈希链：可验证性与篡改检测', () => {
  test('空链报告 checked=0，而不是空口的 ok', () => {
    const { chain } = newChain()
    assert.deepEqual(chain.verify(), { ok: true, checked: 0, tip: 'GENESIS' })
  })

  test('追加事件后 verify 报告 checked 与 tip，且 tip 等于最后一条的 hash', () => {
    const { store, chain } = newChain()
    appendSample(chain, 3)
    const verdict = chain.verify()
    assert.equal(verdict.ok, true)
    if (!verdict.ok) return
    assert.equal(verdict.checked, 3)
    assert.equal(verdict.tip, store.audit.at(-1)?.hash)
    assert.equal(store.audit[0]?.prevHash, 'GENESIS')
    assert.equal(store.audit[1]?.prevHash, store.audit[0]?.hash)
  })

  test('改写事件正文被检测到，并指出断链位置', () => {
    const { store, chain } = newChain()
    appendSample(chain, 4)
    const tampered = store.audit[2] as AuditEvent
    tampered.actor = 'someone-else'

    const verdict = chain.verify()
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.brokenAtSeq, tampered.seq)
    assert.equal(verdict.checked, 2)
  })

  test('删除中间事件同样被检测到（prevHash 不再衔接）', () => {
    const { store, chain } = newChain()
    appendSample(chain, 4)
    store.audit.splice(1, 1)

    const verdict = chain.verify()
    assert.equal(verdict.ok, false)
    if (verdict.ok) return
    assert.equal(verdict.brokenAtSeq, 3)
  })

  test('只改 hash 不改正文也被检测到', () => {
    const { store, chain } = newChain()
    appendSample(chain, 2)
    const last = store.audit[1] as AuditEvent
    last.hash = 'f'.repeat(64)
    assert.equal(chain.verify().ok, false)
  })

  test('metadata 参与哈希：改一个字段即断链', () => {
    const { store, chain } = newChain()
    chain.append({
      eventType: 'policy_update',
      actor: 'admin',
      targetType: 'policy',
      targetId: 'download',
      result: 'success',
      metadata: { downloadDefault: 'deny' }
    })
    assert.equal(chain.verify().ok, true)
    const event = store.audit[0] as AuditEvent
    event.metadata = { downloadDefault: 'allow' }
    assert.equal(chain.verify().ok, false)
  })

  test('查询分页不破坏链：游标翻页覆盖全部事件且 seq 递减', () => {
    const { chain } = newChain()
    appendSample(chain, 7)
    const first = chain.query({ limit: 3 })
    assert.equal(first.events.length, 3)
    assert.equal(first.nextCursor, first.events.at(-1)?.seq)
    const second = chain.query({ limit: 3, cursor: first.nextCursor ?? undefined })
    assert.ok((second.events[0]?.seq ?? 0) < (first.events.at(-1)?.seq ?? 0))
    const seen = new Set([...first.events, ...second.events].map((event) => event.seq))
    assert.equal(seen.size, 6)
    assert.equal(chain.verify().ok, true)
  })
})
