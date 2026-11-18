import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUDIT_EVENT_MAX_BYTES,
  AUDIT_METADATA_MAX_BYTES,
  AuditChain,
  boundedAuditMetadata
} from '../src/audit.ts'
import { openAuditLogFile } from '../src/audit-log-file.ts'
import { canonicalJson } from '../../../packages/contract/src/credential.ts'
import { MAX_EVENT_BYTES } from '../../audit-writer/src/writer-limits.ts'
import type { AuditEvent, AuditEventInput, Store } from '../src/store.ts'

/**
 * U257: one bound applies at both write entries (`AuditChain.append` and the
 * remote client), so these fixtures pin the normalizer, the marker shape, and
 * the JSON roundtrip that restart verification depends on.
 */

const base: AuditEventInput = {
  eventType: 'project_create',
  actor: 'admin',
  targetType: 'project',
  targetId: 'proj_u257',
  result: 'denied',
  traceId: 'trace_u257'
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function metadataOf(input: AuditEventInput): Record<string, unknown> {
  return input.metadata ?? {}
}

function auditSizeOf(input: AuditEventInput): Record<string, unknown> {
  const mark = metadataOf(input).auditSize
  assert.ok(mark !== null && typeof mark === 'object', 'a truncation marker must be present')
  return mark as Record<string, unknown>
}

type AuditStoreView = Pick<Store, 'audit' | 'auditSeq' | 'auditTip'>

function newChain(
  persist?: (event: AuditEvent) => void,
  now?: () => number
): { audit: AuditChain; store: AuditStoreView } {
  const store: AuditStoreView = { audit: [], auditSeq: 0, auditTip: 'GENESIS' }
  return { audit: new AuditChain(store, persist, now), store }
}

describe('U257 审计事件归一器', () => {
  test('正常值逐字节不变且不加标记', () => {
    const input: AuditEventInput = {
      ...base,
      metadata: {
        reason: 'PROJECT_PATH_INVALID',
        key: 'k'.repeat(64),
        path: `/${'p'.repeat(4095)}`
      }
    }
    const bounded = boundedAuditMetadata(input)
    assert.deepEqual(bounded.input, input)
    assert.equal(bounded.truncated, false)
    assert.equal('auditSize' in metadataOf(bounded.input), false)
  })

  test('幂等：归一后的输入再次归一不变', () => {
    const first = boundedAuditMetadata({
      ...base,
      metadata: {
        note: 'n'.repeat(10_000),
        projectIds: Array.from({ length: 300 }, (_, i) => `p${i}`)
      }
    })
    const second = boundedAuditMetadata(first.input)
    assert.deepEqual(second.input, first.input)
    assert.equal(second.truncated, true)
  })

  test('超长字符串截到字段上限并记录 auditSize', () => {
    const bounded = boundedAuditMetadata({ ...base, metadata: { note: 'n'.repeat(10_000) } })
    assert.equal(bounded.truncated, true)
    const note = metadataOf(bounded.input).note
    assert.equal(typeof note, 'string')
    assert.equal((note as string).length, 1024)
    assert.equal(auditSizeOf(bounded.input).truncated, true)
    assert.deepEqual(auditSizeOf(bounded.input).droppedFields, ['note'])
  })

  test('数组只保留前 50 项并累计 droppedItems', () => {
    const bounded = boundedAuditMetadata({
      ...base,
      metadata: { projectIds: Array.from({ length: 300 }, (_, i) => `proj_${i}`) }
    })
    const items = metadataOf(bounded.input).projectIds
    assert.ok(Array.isArray(items))
    assert.equal(items.length, 50)
    assert.equal(auditSizeOf(bounded.input).droppedItems, 250)
  })

  test('多余顶层字段被丢弃，正常顶层字段保留', () => {
    const input = Object.assign(
      { ...base, metadata: { reason: 'ok' } },
      { unexpected: 'x', another: { deep: true } }
    )
    const bounded = boundedAuditMetadata(input)
    assert.equal('unexpected' in bounded.input, false)
    assert.equal('another' in bounded.input, false)
    assert.deepEqual(bounded.input.metadata, { reason: 'ok' })
    assert.equal(bounded.truncated, false)
  })

  test('控制字符按字节预算兜底，2700 个 NUL 仍不超限', () => {
    const bounded = boundedAuditMetadata({ ...base, metadata: { path: '\u0000'.repeat(2700) } })
    assert.equal(bounded.truncated, true)
    assert.ok(bytes(bounded.input) <= AUDIT_EVENT_MAX_BYTES)
    assert.ok(bytes(bounded.input.metadata) <= AUDIT_METADATA_MAX_BYTES)
    assert.equal(typeof metadataOf(bounded.input).path, 'string')
  })

  test('截断不切断代理对', () => {
    const emoji = '😀'.repeat(2_000)
    const bounded = boundedAuditMetadata({ ...base, metadata: { note: emoji } })
    const note = metadataOf(bounded.input).note as string
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    assert.equal(lone.test(note), false)
    assert.equal(note, '😀'.repeat(1024))
  })

  test('600 个 astral 字符未超码点上限：值原样且无 auditSize 标记', () => {
    const emoji = '😀'.repeat(600)
    const bounded = boundedAuditMetadata({ ...base, metadata: { note: emoji } })
    assert.equal(bounded.truncated, false)
    assert.equal(metadataOf(bounded.input).note, emoji)
    assert.equal('auditSize' in metadataOf(bounded.input), false)
  })

  test('超过码点上限的 astral 字符串才截断，长度按码点计算', () => {
    const emoji = '😀'.repeat(1_200)
    const bounded = boundedAuditMetadata({ ...base, metadata: { note: emoji } })
    assert.equal(bounded.truncated, true)
    const note = metadataOf(bounded.input).note as string
    // 1024 codepoints is 2048 UTF-16 units; both must agree with the cap.
    assert.equal(Array.from(note).length, 1_024)
    assert.equal(note.length, 2_048)
    assert.equal(note, '😀'.repeat(1_024))
    assert.equal(auditSizeOf(bounded.input).truncated, true)
    assert.deepEqual(auditSizeOf(bounded.input).droppedFields, ['note'])
  })

  test('数组中的 undefined 变成 null，JSON 往返后 canonicalJson 不变', () => {
    const bounded = boundedAuditMetadata({
      ...base,
      metadata: { list: [1, undefined, 2], nested: { value: undefined, keep: 'x' } }
    })
    assert.deepEqual(metadataOf(bounded.input).list, [1, null, 2])
    const metadata = metadataOf(bounded.input)
    const roundTripped: unknown = JSON.parse(JSON.stringify(metadata))
    assert.equal(canonicalJson(metadata), canonicalJson(roundTripped))
  })

  test('稀疏数组空洞归一为 null，JSON 往返后 canonicalJson 不变', () => {
    const sparse: unknown[] = []
    sparse[0] = 1
    sparse[2] = 3
    const bounded = boundedAuditMetadata({
      ...base,
      metadata: { sparse, withUndefined: [1, undefined, 2] }
    })
    const metadata = metadataOf(bounded.input)
    assert.deepEqual(metadata.sparse, [1, null, 3])
    assert.deepEqual(metadata.withUndefined, [1, null, 2])
    const roundTripped: unknown = JSON.parse(JSON.stringify(metadata))
    assert.equal(canonicalJson(metadata), canonicalJson(roundTripped))
  })

  test('稀疏数组落盘后重启 verify 仍 ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-audit-sparse-'))
    try {
      const log = openAuditLogFile(join(dir, 'audit.log'))
      const { audit } = newChain(log.append, () => 1_700_000_000_000)
      const sparse: unknown[] = []
      sparse[0] = 1
      sparse[2] = 3
      audit.append({ ...base, metadata: { sparse, list: [1, undefined, 2] } })
      // A fresh chain reads what actually landed on disk, as a restart does.
      const restarted = newChain()
      restarted.audit.restore(log.load())
      assert.deepEqual(restarted.audit.getHealth(), { ok: true })
      assert.equal(restarted.audit.verify().ok, true)
      assert.equal(restarted.audit.size, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('归一后 hash 链仍可验证', () => {
    const { audit, store } = newChain()
    const fixtures: AuditEventInput[] = [
      { ...base, metadata: { list: [1, undefined, 2] } },
      { ...base, metadata: { path: '\u0000'.repeat(2700) } },
      { ...base, metadata: { note: 'x'.repeat(20_000) } },
      { ...base, metadata: { projectIds: Array.from({ length: 300 }, (_, i) => `p${i}`) } }
    ]
    for (const fixture of fixtures) audit.append(fixture)
    assert.equal(audit.size, fixtures.length)
    const verdict = audit.verify()
    assert.equal(verdict.ok, true)
    for (const event of store.audit) {
      const metadata = event.metadata ?? {}
      const roundTripped: unknown = JSON.parse(JSON.stringify(metadata))
      assert.equal(canonicalJson(metadata), canonicalJson(roundTripped))
    }
  })

  test('不可序列化 metadata 降级为骨架而不抛', () => {
    const bigint = boundedAuditMetadata({ ...base, metadata: { value: 10n } })
    assert.equal(bigint.truncated, true)
    assert.deepEqual(auditSizeOf(bigint.input), {
      truncated: true,
      originalBytes: 0,
      reason: 'unserializable'
    })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const cyclic = boundedAuditMetadata({ ...base, metadata: circular })
    assert.equal(cyclic.truncated, true)
    assert.doesNotThrow(() => JSON.stringify(cyclic.input))
  })

  test('metadata 预算边界：8192 B 不加标记，8193 B 归一', () => {
    const build = (extra: number): Record<string, unknown> => {
      const metadata: Record<string, unknown> = {}
      for (let index = 0; index < 7; index += 1) metadata[`k${index}`] = 'x'.repeat(1020)
      metadata.pad = ''
      const needed = AUDIT_METADATA_MAX_BYTES - bytes(metadata) + extra
      assert.ok(needed <= 1024, 'the padding itself must stay inside the field cap')
      metadata.pad = 'x'.repeat(needed)
      return metadata
    }

    const exact = build(0)
    assert.equal(bytes(exact), AUDIT_METADATA_MAX_BYTES)
    const atLimit = boundedAuditMetadata({ ...base, metadata: exact })
    assert.equal(atLimit.truncated, false)
    assert.equal(atLimit.input.metadata?.auditSize, undefined)

    const over = build(1)
    assert.equal(bytes(over), AUDIT_METADATA_MAX_BYTES + 1)
    const bounded = boundedAuditMetadata({ ...base, metadata: over })
    assert.equal(bounded.truncated, true)
    assert.ok(bytes(bounded.input.metadata) <= AUDIT_METADATA_MAX_BYTES)
    assert.ok(bytes(bounded.input) <= AUDIT_EVENT_MAX_BYTES)
  })

  test('跨模块预算：API 事件上限给 writer 留出余量', () => {
    assert.ok(AUDIT_EVENT_MAX_BYTES + 256 <= MAX_EVENT_BYTES)
    assert.ok(AUDIT_METADATA_MAX_BYTES < AUDIT_EVENT_MAX_BYTES)
  })

  test('正常事件的序列化字节与 hash 不变', () => {
    const { audit } = newChain(undefined, () => 1_700_000_000_000)
    const event = audit.append({ ...base, metadata: { reason: 'PROJECT_PATH_INVALID' } })
    // Pinned so any normalization drift on the normal path shows up here.
    assert.equal(Buffer.byteLength(JSON.stringify(event)), 300)
    assert.equal(event.hash, '4978ebca9056d619783217583d2cd12ce89de059e441976d8c45de7c8834d1f4')
  })
})
