import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  parseArgs,
  parseProcessTable,
  runWithMonitor,
  summarize,
  violations
} from './monitor-system-resources.mjs'

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

test('parseArgs exports options and warns instead of silently disabling NaN limits', () => {
  const warnings = []
  const options = parseArgs(
    ['--interval=abc', '--max-node=abc', '--max-rss-gb=NaN', '--max-load=x', '--', 'node'],
    (message) => warnings.push(message)
  )
  assert.equal(options.intervalSec, 5)
  assert.equal(options.maxNode, 24)
  assert.equal(options.maxRssGb, 12)
  assert.equal(options.maxLoad, 0)
  assert.deepEqual(options.command, ['node'])
  assert.equal(warnings.length, 3)
  assert.ok(warnings.every((message) => message.includes('ignored invalid')))
})

test('parseArgs keeps valid limits', () => {
  const options = parseArgs(['--max-node=40', '--max-rss-gb=8', '--max-load=2.5'], () => {})
  assert.equal(options.maxNode, 40)
  assert.equal(options.maxRssGb, 8)
  assert.equal(options.maxLoad, 2.5)
})

test('runWithMonitor survives a missing command and still writes the summary', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'resource-monitor-spawn-'))
  const code = await runWithMonitor({
    intervalSec: 60,
    outDir,
    maxNode: 24,
    maxRssGb: 12,
    maxLoad: 0,
    command: ['orca-command-that-does-not-exist-xyz']
  })
  assert.equal(code, 1)
  assert.equal(existsSync(join(outDir, 'system-resources-summary.json')), true)
  const summary = JSON.parse(readFileSync(join(outDir, 'system-resources-summary.json'), 'utf8'))
  assert.equal(summary.samples, 0)
})
