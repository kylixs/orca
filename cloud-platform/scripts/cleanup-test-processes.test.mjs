import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyProcess, parseElapsedSeconds, parseProcesses, selectTargets } from './cleanup-test-processes.mjs'

test('parses ps elapsed formats', () => {
  assert.equal(parseElapsedSeconds('12:34'), 754)
  assert.equal(parseElapsedSeconds('01:02:03'), 3723)
  assert.equal(parseElapsedSeconds('2-01:02:03'), 176523)
})

test('never touches the live dev environment', () => {
  assert.equal(
    classifyProcess('/opt/homebrew/bin/node /Users/gongdewei/orca-local-env/bin/host-supervisor.mjs', 99999),
    'keep',
  )
})

test('keeps recent test processes (an in-flight run)', () => {
  assert.equal(classifyProcess('/tmp/orca-run/host/daemon-entry.js', 60), 'recent')
})

test('cleans stale temp test processes', () => {
  assert.equal(classifyProcess('/private/tmp/w9a-journey-x/host-ud/daemon-entry.js', 7200), 'cleanup')
  assert.equal(classifyProcess('/tmp/node_modules/electron/dist/Electron --database=/tmp/orca-jgate-1/x/Crashpad', 7200), 'cleanup')
})

test('ignores unrelated user applications', () => {
  assert.equal(classifyProcess('/Applications/Orca.app/Contents/MacOS/Orca', 99999), 'unrelated')
})

test('selectTargets splits cleanup vs kept rows', () => {
  const psOutput = `
  111 1 01:02 /tmp/node_modules/electron/dist/Electron --database=/tmp/orca-run-x/Crashpad
  222 1 30:00 /private/tmp/c6-drag-x/host-ud/daemon-entry.js
  333 1 02:00 /Users/gongdewei/orca-local-env/bin/forwarder.mjs
`
  const { targets, kept } = selectTargets(psOutput)
  assert.deepEqual(targets.map((row) => row.pid), [222])
  assert.equal(kept.length, 2)
})
