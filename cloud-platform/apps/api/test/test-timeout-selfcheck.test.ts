import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fixtureDir = ''

before(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'orca-test-timeout-'))
})

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
})

// Nested runner must not inherit the outer runner's worker context.
function runFixture(fileName: string, source: string) {
  const file = join(fixtureDir, fileName)
  writeFileSync(file, source)
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env, timeout: 30_000 })
}

test('timeout option is enforced: sleep(50) with timeout: 10 fails', () => {
  const result = runFixture(
    'enforced.test.mjs',
    `import { test } from 'node:test'
test('timeout enforced', { timeout: 10 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
})
`
  )
  const output = `${result.stdout}${result.stderr}`
  assert.equal(result.status, 1, output)
  assert.match(output, /test timed out after 10ms/, output)
})

test('legacy third-argument options are ignored: sleep(50) with { timeout: 10 } as third arg passes', () => {
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
