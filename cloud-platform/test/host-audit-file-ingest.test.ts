import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AuditChain } from '../apps/api/src/audit.ts'
import {
  appendHostAuditReports,
  parseHostAuditReports
} from '../apps/api/src/host-audit-ingest.ts'

/**
 * R-01: the heartbeat `audit[]` ingest accepts the three U66 file event types,
 * lands them under their bare event names with user attribution (§2.1 subject
 * tier, optional device-tier resolver), and keeps the legacy security-refusal
 * shape byte-for-byte.
 */

const host = { id: 'host_1', name: 'dev-001' }

function chain() {
  const store = { audit: [] as unknown[], auditSeq: 0, auditTip: 'GENESIS' }
  return { store, audit: new AuditChain(store, undefined, () => 1_000) }
}

describe('host-audit-ingest file events (U68)', () => {
  it('parses the three file event types with result and metadata', () => {
    const reports = parseHostAuditReports([
      {
        eventType: 'file_copy',
        result: 'success',
        deviceId: 'dev_1',
        subject: 'user:zhangsan',
        projectId: 'proj_1',
        traceId: 'tr_1',
        metadata: { path: 'src/a.ts', fileName: 'a.ts', copyKind: 'content-whole', copiedBytes: 10 }
      },
      { eventType: 'download_blocked', result: 'denied', metadata: { policy: 'deny' } },
      { eventType: 'file_download', result: 'failure', reason: 'client_cancelled' },
      // Legacy refusals still parse.
      { eventType: 'connection_rejected', result: 'denied', reason: 'bad_ticket' },
      // Malformed entries are dropped whole, never half-understood.
      { eventType: 'file_download' },
      { eventType: 'file_download', result: 'success', metadata: { nope: 1 } },
      { eventType: 'file_download', result: 'success', metadata: { path: '/etc/passwd' } },
      'junk'
    ])
    assert.equal(reports.length, 4)
    assert.equal(reports[0].eventType, 'file_copy')
    assert.equal(reports[0].metadata?.copyKind, 'content-whole')
    assert.equal(reports[1].eventType, 'download_blocked')
    assert.equal(reports[2].reason, 'client_cancelled')
    assert.equal(reports[3].eventType, 'connection_rejected')
  })

  it('appends bare-name events with subject-tier attribution; excerpts never land', () => {
    const { store, audit } = chain()
    const appended = appendHostAuditReports(
      audit,
      host,
      parseHostAuditReports([
        {
          eventType: 'file_copy',
          result: 'success',
          deviceId: 'dev_1',
          subject: 'user:zhangsan',
          projectId: 'proj_1',
          traceId: 'tr_1',
          metadata: {
            fileName: 'a.ts',
            surface: 'web',
            excerpt: 'U68_SECRET_MARKER',
            sha256: 'not-hex'
          }
        }
      ]),
      'beat-trace'
    )
    assert.equal(appended, 1)
    assert.equal(store.audit.length, 1)
    const event = store.audit[0]
    assert.equal(event.eventType, 'file_copy')
    assert.equal(event.actor, 'zhangsan')
    assert.equal(event.targetType, 'project')
    assert.equal(event.targetId, 'proj_1')
    assert.equal(event.traceId, 'tr_1')
    assert.equal(event.metadata.actorSource, 'subject')
    assert.equal(event.metadata.subject, 'user:zhangsan')
    assert.equal(event.metadata.deviceId, 'dev_1')
    assert.equal(event.metadata.hostId, 'host_1')
    assert.equal(event.metadata.hostName, 'dev-001')
    assert.equal(event.metadata.fileName, 'a.ts')
    assert.equal(event.metadata.excerpt, undefined)
    assert.equal(event.metadata.sha256, undefined)
    assert.equal(JSON.stringify(event).includes('U68_SECRET_MARKER'), false)
  })

  it('a wired resolver upgrades attribution to the device tier', () => {
    const { store, audit } = chain()
    appendHostAuditReports(
      audit,
      host,
      parseHostAuditReports([
        { eventType: 'file_download', result: 'success', deviceId: 'dev_9', subject: 'user:li' }
      ]),
      'beat',
      (deviceId) => (deviceId === 'dev_9' ? { username: 'zhangsan' } : null)
    )
    assert.equal(store.audit[0].actor, 'zhangsan')
    assert.equal(store.audit[0].metadata.actorSource, 'device')
  })

  it('a bare subject without resolver falls back to the host actor', () => {
    const { store, audit } = chain()
    appendHostAuditReports(
      audit,
      host,
      parseHostAuditReports([
        { eventType: 'file_download', result: 'success', subject: 'zhangsan' }
      ]),
      'beat'
    )
    assert.equal(store.audit[0].actor, 'host:dev-001')
    assert.equal(store.audit[0].metadata.actorSource, 'host')
    assert.equal(store.audit[0].targetId, 'host_1')
  })

  it('legacy security refusals keep their host.* shape untouched', () => {
    const { store, audit } = chain()
    appendHostAuditReports(
      audit,
      host,
      parseHostAuditReports([
        { eventType: 'method_denied', result: 'denied', subject: 'zhangsan', method: 'settings.update' }
      ]),
      'beat'
    )
    const event = store.audit[0]
    assert.equal(event.eventType, 'host.method_denied')
    assert.equal(event.actor, 'host:dev-001')
    assert.equal(event.targetType, 'host')
    assert.equal(event.metadata.subject, 'zhangsan')
    assert.equal(event.metadata.actorSource, undefined)
  })
})
