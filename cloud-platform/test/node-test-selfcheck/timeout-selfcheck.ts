import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/**
 * U293: the API and e2e timeout self-checks run the same fixtures, so the
 * source, the nested-runner environment and the assertions live here once.
 */

export const ENFORCED_TIMEOUT_FIXTURE = `import { test } from 'node:test'
test('timeout enforced', { timeout: 10 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
})
`

export const LEGACY_TIMEOUT_FIXTURE = `import { test } from 'node:test'
test('legacy timeout ignored', async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
}, { timeout: 10 })
`

export type NodeTestFixtureResult = { status: number | null; output: string }

const scratchDirs: string[] = []

after(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Runs a fixture through a nested `node --test`, outside the outer worker context. */
export function runNodeTestFixture(
  fileName: string,
  source: string,
  options: { tapReporter?: boolean } = {}
): NodeTestFixtureResult {
  const dir = mkdtempSync(join(tmpdir(), 'orca-test-timeout-selfcheck-'))
  scratchDirs.push(dir)
  const file = join(dir, fileName)
  writeFileSync(file, source)
  const env = { ...process.env }
  // A nested runner must not inherit the outer runner's worker context.
  delete env.NODE_TEST_CONTEXT
  const args = options.tapReporter ? ['--test', '--test-reporter=tap', file] : ['--test', file]
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 30_000 })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** `{ timeout: 10 }` must turn a 50ms test red. */
export function assertTimeoutEnforced(result: NodeTestFixtureResult): void {
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /timed out after 10ms/, result.output)
}

/** The legacy third-argument form is silently ignored, so the same test passes. */
export function assertLegacyTimeoutIgnored(result: NodeTestFixtureResult): void {
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /pass 1/, result.output)
}
