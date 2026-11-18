import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fixtureDir = ''

before(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'orca-e2e-timeout-selfcheck-'))
})

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

/**
 * U290: gate e2e suites must use `test(name, { timeout }, fn)`. The legacy
 * third-argument form is silently ignored, so a hung test waits forever.
 */
function runFixture(fileName: string, source: string) {
  const file = join(fixtureDir, fileName)
  writeFileSync(file, source)
  // A nested runner must not inherit the outer runner's worker context.
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
    encoding: 'utf8',
    env,
    timeout: 30_000
  })
}

test('U290: { timeout: 10 } turns a hung test red', () => {
  const result = runFixture(
    'enforced.test.mjs',
    `import { test } from 'node:test'
test('timeout enforced', { timeout: 10 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
})
`
  )
  const output = `${result.stdout}${result.stderr}`
  assert.notEqual(result.status, 0, output)
  assert.match(output, /timed out after 10ms/, output)
})

test('U290: legacy third-argument options are ignored', () => {
  const result = runFixture(
    'ignored.test.mjs',
    `import { test } from 'node:test'
test('legacy timeout ignored', async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
}, { timeout: 10 })
`
  )
  const output = `${result.stdout}${result.stderr}`
  assert.equal(result.status, 0, output)
  assert.match(output, /pass 1/, output)
})
