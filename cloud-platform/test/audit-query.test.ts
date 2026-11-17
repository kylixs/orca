import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_MAX_LIMIT,
  AUDIT_RECENT_WINDOW_MS,
  AUDIT_WINDOW_MS,
  parseAuditQuery
} from '../apps/api/src/audit-query.ts'

/**
 * These cases pin the audit query parser that both the query route and the
 * export route share: same accepted ranges, same messages, same clamping.
 */

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60_000

function parse(query: string, now = NOW) {
  return parseAuditQuery(new URLSearchParams(query), now)
}

function value(query: string, now = NOW) {
  const result = parse(query, now)
  assert.equal(result.ok, true, `expected ok for ${query}`)
  if (!result.ok) throw new Error('unreachable')
  return result.value
}

function errorOf(query: string, now = NOW) {
  const result = parse(query, now)
  assert.equal(result.ok, false, `expected error for ${query}`)
  if (result.ok) throw new Error('unreachable')
  return result
}

describe('audit query parser: limit', () => {
  test('defaults to 50 when absent', () => {
    assert.equal(value('').limit, 50)
  })

  test('0 / -1 / NaN fall back to 50', () => {
    assert.equal(value('limit=0').limit, 50)
    assert.equal(value('limit=-1').limit, 50)
    assert.equal(value('limit=abc').limit, 50)
  })

  test('clamps above the cap and keeps in-range values', () => {
    assert.equal(value('limit=201').limit, AUDIT_MAX_LIMIT)
    assert.equal(value('limit=200').limit, 200)
    assert.equal(value('limit=7').limit, 7)
  })
})

describe('audit query parser: eventTypes and eventFamily', () => {
  test('rejects more than 20 event types', () => {
    const many = Array.from({ length: 21 }, (_, index) => `type_${index}`).join(',')
    assert.deepEqual(errorOf(`eventTypes=${many}`), {
      ok: false,
      code: 'INVALID_QUERY',
      message: 'eventTypes 最多 20 个。'
    })
  })

  test('accepts 20 event types', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `type_${index}`).join(',')
    assert.equal(value(`eventTypes=${twenty}`).eventTypes?.length, 20)
  })

  test('rejects a single value longer than 64 characters', () => {
    assert.deepEqual(errorOf(`eventTypes=${'a'.repeat(65)}`), {
      ok: false,
      code: 'INVALID_QUERY',
      message: 'eventTypes 每个最多 64 字符。'
    })
  })

  test('accepts a 64-character value', () => {
    assert.deepEqual(value(`eventTypes=${'a'.repeat(64)}`).eventTypes, ['a'.repeat(64)])
  })

  test('trims blanks and drops empty comma segments', () => {
    assert.deepEqual(value('eventTypes=,,file_copy,user_login,,').eventTypes, [
      'file_copy',
      'user_login'
    ])
    assert.equal(value('eventTypes=').eventTypes, undefined)
  })

  test('maps eventFamily download and copy', () => {
    assert.deepEqual(value('eventFamily=download').eventTypes, [
      'file_download',
      'download_blocked'
    ])
    assert.deepEqual(value('eventFamily=copy').eventTypes, ['file_copy'])
  })

  test('explicit eventTypes wins over eventFamily', () => {
    assert.deepEqual(value('eventFamily=copy&eventTypes=user_login').eventTypes, ['user_login'])
  })

  test('rejects an unknown eventFamily and ignores an empty one', () => {
    assert.deepEqual(errorOf('eventFamily=terminal'), {
      ok: false,
      code: 'INVALID_QUERY',
      message: 'eventFamily 仅支持 download/copy。'
    })
    assert.equal(value('eventFamily=').eventTypes, undefined)
  })
})

describe('audit query parser: fileName and keyword', () => {
  test('rejects fileName longer than 128 characters and accepts 128', () => {
    assert.deepEqual(errorOf(`fileName=${'x'.repeat(129)}`), {
      ok: false,
      code: 'INVALID_QUERY',
      message: 'fileName 最多 128 字符。'
    })
    assert.equal(value(`fileName=${'x'.repeat(128)}`).fileName, 'x'.repeat(128))
  })

  test('trims fileName and treats blank as absent', () => {
    assert.equal(value('fileName=%20report.csv%20').fileName, 'report.csv')
    assert.equal(value('fileName=%20%20').fileName, undefined)
  })

  test('rejects a one-character q', () => {
    assert.deepEqual(errorOf('q=a'), {
      ok: false,
      code: 'INVALID_QUERY',
      message: 'q 至少 2 个字符。'
    })
  })

  test('rejects q longer than 128 characters', () => {
    assert.deepEqual(errorOf(`q=${'a'.repeat(129)}`), {
      ok: false,
      code: 'INVALID_QUERY',
      message: 'q 最多 128 字符。'
    })
  })

  test('accepts q and the keyword alias, q taking precedence', () => {
    assert.equal(value('q=secret').keyword, 'secret')
    assert.equal(value('keyword=secret').keyword, 'secret')
    assert.equal(value('q=first&keyword=second').keyword, 'first')
  })
})

describe('audit query parser: time bounds', () => {
  const until = new Date(NOW).toISOString()

  test('ignores an invalid since', () => {
    const parsed = value(`since=not-a-date&until=${until}`)
    assert.equal(parsed.since, NOW - AUDIT_WINDOW_MS)
  })

  test('rejects an invalid until', () => {
    assert.deepEqual(errorOf('until=not-a-date'), {
      ok: false,
      code: 'INVALID_QUERY',
      message: 'until 不是有效时间。'
    })
  })

  test('accepts explicit since and until as numbers', () => {
    const since = new Date(NOW - DAY).toISOString()
    const parsed = value(`since=${since}&until=${until}`)
    assert.equal(typeof parsed.since, 'number')
    assert.equal(parsed.until, Date.parse(until))
  })

  test('rejects a window larger than 31 days', () => {
    const tooOld = new Date(NOW - AUDIT_WINDOW_MS - DAY).toISOString()
    assert.deepEqual(errorOf(`since=${tooOld}&until=${until}`), {
      ok: false,
      code: 'TIME_WINDOW_TOO_LARGE',
      message: '查询时间窗最大 31 天。'
    })
    assert.deepEqual(errorOf(`since=${until}&until=${tooOld}`), {
      ok: false,
      code: 'TIME_WINDOW_TOO_LARGE',
      message: '查询时间窗最大 31 天。'
    })
  })

  test('rejects a since older than 31 days when no until is given', () => {
    const tooOld = new Date(NOW - AUDIT_WINDOW_MS - DAY).toISOString()
    assert.deepEqual(errorOf(`since=${tooOld}`), {
      ok: false,
      code: 'TIME_WINDOW_TOO_LARGE',
      message: '查询时间窗最大 31 天。'
    })
  })

  test('defaults the window when only until is given', () => {
    assert.equal(value(`until=${until}`).since, NOW - AUDIT_WINDOW_MS)
  })

  test('defaults q/fileName without a window to the recent 7 days', () => {
    assert.equal(value('q=secret').since, NOW - AUDIT_RECENT_WINDOW_MS)
    assert.equal(value('fileName=report.csv').since, NOW - AUDIT_RECENT_WINDOW_MS)
  })

  test('keeps since/until absent for an unfiltered query', () => {
    const parsed = value('')
    assert.equal(parsed.since, undefined)
    assert.equal(parsed.until, undefined)
  })
})
