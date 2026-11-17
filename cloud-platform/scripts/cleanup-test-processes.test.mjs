import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REPO,
  classifyProcess,
  parseElapsedSeconds,
  parseProcesses,
  revalidateTarget,
  selectTargets
} from './cleanup-test-processes.mjs'

const REPO_VITEST = `${REPO}/node_modules/.bin/vitest`
const REPO_ELECTRON = `${REPO}/node_modules/electron/dist/Electron`

test('parses ps elapsed formats', () => {
  assert.equal(parseElapsedSeconds('12:34'), 754)
  assert.equal(parseElapsedSeconds('01:02:03'), 3723)
  assert.equal(parseElapsedSeconds('2-01:02:03'), 176523)
})

test('never touches the live dev environment', () => {
  assert.equal(
    classifyProcess(
      '/opt/homebrew/bin/node /Users/gongdewei/orca-local-env/bin/host-supervisor.mjs',
      99999
    ),
    'keep'
  )
})

test('keeps recent test processes (an in-flight run)', () => {
  assert.equal(
    classifyProcess('/tmp/node24/bin/node /tmp/orca-run/host/daemon-entry.js', 60),
    'recent'
  )
  assert.equal(classifyProcess(`${REPO_VITEST} run --root /tmp/orca-run-x`, 1800), 'recent')
})

test('cleans stale repo-owned test processes under a test temp dir', () => {
  assert.equal(
    classifyProcess(
      `/tmp/node24/bin/node /private/tmp/w9a-journey-x/host-ud/daemon-entry.js`,
      7200
    ),
    'cleanup'
  )
  assert.equal(
    classifyProcess(`${REPO_ELECTRON} --database=/tmp/orca-jgate-1/x/Crashpad`, 7200),
    'cleanup'
  )
  // P1-1: repo node_modules executables are now genuinely eligible (REPO is not dead code).
  assert.equal(classifyProcess(`${REPO_VITEST} run --root /tmp/orca-run-x`, 7200), 'cleanup')
})

test('keeps user applications that merely mention a temp path', () => {
  // Editor opening a scratch file.
  assert.equal(
    classifyProcess(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron /tmp/orca-notes.md',
      99999
    ),
    'unrelated'
  )
  // User shell tool tailing a log.
  assert.equal(classifyProcess('/usr/bin/tail -f /private/tmp/gate-run.log', 99999), 'unrelated')
  // The user's own Orca app pointed at a temp profile.
  assert.equal(
    classifyProcess(
      '/Applications/Orca.app/Contents/MacOS/Orca --user-data-dir=/tmp/orca-user',
      99999
    ),
    'unrelated'
  )
  // Any user shell command that happens to contain the marker.
  assert.equal(classifyProcess(`/bin/zsh -c 'open /tmp/orca-notes.md'`, 99999), 'unrelated')
})

test('requires both a repo-owned executable and a test temp marker', () => {
  // Repo executable without a test temp arg: not provably test-owned.
  assert.equal(classifyProcess(`${REPO_VITEST} run src/main`, 7200), 'unrelated')
  // Test temp node runtime without a test temp arg: not provably test-owned.
  assert.equal(classifyProcess('/tmp/node24/bin/node scripts/dev.mjs', 7200), 'unrelated')
})

test('selectTargets splits cleanup vs kept rows', () => {
  const psOutput = `
  111 1 01:02 ${REPO_ELECTRON} --database=/tmp/orca-run-x/Crashpad
  222 1 31:00 /tmp/node24/bin/node /private/tmp/c6-drag-x/host-ud/daemon-entry.js
  333 1 02:00 /Users/gongdewei/orca-local-env/bin/forwarder.mjs
`
  const { targets, kept } = selectTargets(psOutput)
  assert.deepEqual(
    targets.map((row) => row.pid),
    [222]
  )
  assert.equal(kept.length, 2)
})

test('revalidateTarget refuses a recycled PID whose command changed', () => {
  const target = { pid: 4242, command: `${REPO_VITEST} run --root /tmp/orca-run-x` }
  assert.equal(revalidateTarget(`4242 1 30:00 ${target.command}`, target), true)
  assert.equal(revalidateTarget(`4242 1 00:05 /usr/bin/tail -f /tmp/orca-other.log`, target), false)
  assert.equal(revalidateTarget('', target), false)
})
