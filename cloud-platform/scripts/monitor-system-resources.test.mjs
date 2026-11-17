import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProcessTable, summarize, violations } from './monitor-system-resources.mjs'

const TABLE = `pid rss command
100 204800 /usr/bin/node server.js
200 1048576 /Applications/Electron.app/Contents/MacOS/Electron
300 51200 /usr/bin/sleep 10
`

test('parses ps rows and ignores header noise', () => {
  const rows = parseProcessTable(TABLE)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { pid: 100, rssKb: 204800, command: '/usr/bin/node server.js' })
})

test('summarize counts node/electron processes and total RSS', () => {
  const rows = parseProcessTable(TABLE)
  const value = summarize(rows, [1.5, 2, 3], 8)
  assert.equal(value.processCount, 3)
  assert.equal(value.nodeProcessCount, 2)
  assert.equal(value.rssGb, 1.24)
  assert.equal(value.topRss[0].pid, 200)
})

test('violations flag node count, rss, and load thresholds', () => {
  const value = summarize(parseProcessTable(TABLE), [9, 2, 3], 8)
  const found = violations(value, { maxNode: 1, maxRssGb: 1, maxLoad: 8 })
  assert.equal(found.length, 3)
})

test('violations stay quiet under limits', () => {
  const value = summarize(parseProcessTable(TABLE), [0.5, 0, 0], 8)
  assert.deepEqual(violations(value, { maxNode: 8, maxRssGb: 8, maxLoad: 4 }), [])
})
