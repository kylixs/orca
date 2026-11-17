import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_EXPORT_CSV_COLUMNS,
  AUDIT_EXPORT_CSV_EOL,
  AUDIT_EXPORT_CSV_HEADER,
  serializeAuditCsv,
  serializeAuditJsonl,
  toAuditCsvRow,
  toAuditJsonlLine
} from '../src/audit-export-format.ts'
import type { AuditEvent } from '../src/store.ts'

/**
 * U201 E4: CSV must survive real commas/quotes/newlines without becoming extra
 * rows, neutralize spreadsheet formulas, and JSONL must stay one parseable
 * event per line so offline chain verification works.
 */

const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  seq: 1,
  ts: 1_700_000_000_000,
  eventType: 'file_download',
  actor: 'user:alice',
  targetType: 'host',
  targetId: 'host_1',
  result: 'success',
  traceId: 'trace_1',
  metadata: { fileName: 'report.csv' },
  prevHash: 'GENESIS',
  hash: 'h1',
  ...over
})

/** Minimal RFC 4180 reader used to prove the emitted quoting is reversible. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]!
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"') {
      quoted = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += ch === '\r' && input[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    i += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const columnsOf = (row: string[]): Record<string, string> =>
  Object.fromEntries(AUDIT_EXPORT_CSV_COLUMNS.map((column, index) => [column, row[index]]))

describe('audit export CSV', () => {
  test('fixed header and empty export is header plus CRLF', () => {
    assert.equal(
      AUDIT_EXPORT_CSV_HEADER,
      'seq,ts,eventType,actor,targetType,targetId,result,traceId,metadata,prevHash,hash'
    )
    assert.equal(serializeAuditCsv([]), AUDIT_EXPORT_CSV_HEADER + AUDIT_EXPORT_CSV_EOL)
  })

  test('commas, quotes, and newlines round-trip through a standard reader', () => {
    const tricky = event({
      eventType: 'file_download',
      metadata: { fileName: 'a,b"c.csv', note: 'line1\nline2' },
      actor: 'alice "the, admin"'
    })
    const parsed = parseCsv(serializeAuditCsv([tricky]))
    assert.equal(parsed.length, 2)
    const row = columnsOf(parsed[1]!)
    assert.equal(row.actor, 'alice "the, admin"')
    assert.equal(row.metadata, '{"fileName":"a,b\\"c.csv","note":"line1\\nline2"}')
    assert.equal(JSON.parse(row.metadata!).fileName, 'a,b"c.csv')
  })

  test('formula prefixes are neutralized with a leading apostrophe', () => {
    for (const value of ['=cmd', '+x', '-x', '@x']) {
      const parsed = parseCsv(toAuditCsvRow(event({ actor: value })))
      assert.equal(columnsOf(parsed[0]!).actor, `'${value}`)
    }
  })

  test('tab-prefixed and formula+quote fields stay neutralized and quoted', () => {
    const tabbed = columnsOf(parseCsv(toAuditCsvRow(event({ actor: '\tcmd' })))[0]!)
    assert.equal(tabbed.actor, "'\tcmd")
    const encoded = toAuditCsvRow(event({ actor: '=a,"b' }))
    assert.equal(encoded.includes(`"'=a,""b"`), true)
    assert.equal(columnsOf(parseCsv(encoded)[0]!).actor, `'=a,"b`)
  })

  test('null fields and empty metadata become empty cells', () => {
    const row = columnsOf(
      parseCsv(
        toAuditCsvRow(
          event({
            actor: null,
            targetType: null,
            targetId: null,
            traceId: null,
            metadata: undefined
          })
        )
      )[0]!
    )
    assert.equal(row.actor, '')
    assert.equal(row.targetType, '')
    assert.equal(row.targetId, '')
    assert.equal(row.traceId, '')
    assert.equal(row.metadata, '')
    // An empty object is still a JSON column, not an absent metadata value.
    assert.equal(columnsOf(parseCsv(toAuditCsvRow(event({ metadata: {} })))[0]!).metadata, '{}')
  })

  test('Chinese and emoji survive unchanged', () => {
    const row = columnsOf(
      parseCsv(toAuditCsvRow(event({ actor: '张三 👩‍💻', metadata: { note: '审计导出' } })))[0]!
    )
    assert.equal(row.actor, '张三 👩‍💻')
    assert.equal(row.metadata, '{"note":"审计导出"}')
  })

  test('CRLF and bare CR inside fields do not create extra records', () => {
    const events = [
      event({ seq: 1, actor: 'a\r\nb' }),
      event({ seq: 2, actor: 'c\rd', traceId: 't\r\n2' })
    ]
    const parsed = parseCsv(serializeAuditCsv(events))
    assert.equal(parsed.length, 3)
    assert.equal(columnsOf(parsed[1]!).actor, 'a\r\nb')
    assert.equal(columnsOf(parsed[2]!).actor, 'c\rd')
    assert.equal(columnsOf(parsed[2]!).traceId, 't\r\n2')
  })

  test('extra fields are dropped without disturbing the header order', () => {
    const extended: AuditEvent & { extra: string } = { ...event(), extra: 'ignored' }
    const raw = toAuditCsvRow(extended)
    assert.equal(raw, toAuditCsvRow(event()))
    const parsed = parseCsv(serializeAuditCsv([extended]))
    assert.deepEqual(parsed[0], [...AUDIT_EXPORT_CSV_COLUMNS])
    assert.equal(columnsOf(parsed[1]!).extra, undefined)
  })
})

describe('audit export JSONL', () => {
  test('one parseable object per line in input order with chain hashes', () => {
    const events = [
      event({ seq: 1, prevHash: 'GENESIS', hash: 'h1' }),
      event({ seq: 2, prevHash: 'h1', hash: 'h2' }),
      event({ seq: 3, prevHash: 'h2', hash: 'h3' })
    ]
    const output = serializeAuditJsonl(events)
    assert.equal(output.endsWith('\n'), true)
    const lines = output.split('\n')
    assert.equal(lines.pop(), '')
    assert.equal(lines.length, 3)
    const parsed = lines.map((line) => JSON.parse(line) as AuditEvent)
    assert.deepEqual(
      parsed.map((item) => item.seq),
      [1, 2, 3]
    )
    assert.equal(parsed[1]!.prevHash, 'h1')
    assert.equal(parsed[1]!.hash, 'h2')
  })

  test('null fields stay present and newlines inside values stay escaped', () => {
    const output = serializeAuditJsonl([
      event({ actor: null, targetType: null, targetId: null, traceId: null, metadata: undefined }),
      event({ seq: 2, metadata: { note: 'a\r\nb' } })
    ])
    const [first, second] = output.split('\n')
    assert.equal(output.split('\n').length, 3)
    const parsedFirst = JSON.parse(first!) as AuditEvent
    assert.equal(parsedFirst.actor, null)
    assert.equal(parsedFirst.targetType, null)
    assert.equal(parsedFirst.targetId, null)
    assert.equal(parsedFirst.traceId, null)
    assert.equal(JSON.parse(second!).metadata.note, 'a\r\nb')
    assert.equal(output.includes('\r'), false)
  })

  test('extra fields are preserved for offline inspection', () => {
    const extended: AuditEvent & { extra: string } = { ...event(), extra: 'kept' }
    const line = toAuditJsonlLine(extended)
    assert.equal((JSON.parse(line) as { extra: string }).extra, 'kept')
    assert.equal(serializeAuditJsonl([]), '')
  })

  test('unicode is emitted as valid UTF-8 JSON', () => {
    const line = toAuditJsonlLine(event({ actor: '张三 👩‍💻' }))
    assert.equal((JSON.parse(line) as AuditEvent).actor, '张三 👩‍💻')
  })
})
