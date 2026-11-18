import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  NODE_TEST_IMPORT,
  NODE_TEST_IMPORT_GREP,
  NODE_TEST_IMPORT_SOURCE,
  SCAN_EXCLUSIONS,
  collectScopeFiles,
  headScopeFiles
} from './check-test-timeouts.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'timeout-scope-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeFixture(root, name, source) {
  const file = join(root, name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, source)
  return file
}

const toRelative = (root, file) => relative(root, file).split('\\').join('/')

// U315: scope is decided by "imports node:test OR is referenced by a node --test
// runner", not by a hardcoded directory list. Excluded trees are configurable and
// each carries a reason. This fixture mirrors the four audit categories at once.
test('scope includes real node:test files and excludes archived copies', () => {
  withTempRoot((root) => {
    writeFixture(
      root,
      'package.json',
      JSON.stringify({ scripts: { test: 'node --test spec/*.test.mjs' } })
    )
    writeFixture(root, 'scripts/imported.test.mjs', "import test from 'node:test'\n")
    writeFixture(root, 'spec/runner-only.test.mjs', 'export const value = 1\n')
    writeFixture(root, 'evidence/copy.test.mjs', "import test from 'node:test'\n")
    writeFixture(root, 'cloud-platform/evidence/copy.test.mjs', "import test from 'node:test'\n")
    writeFixture(root, 'src/main/vitest.test.ts', "import { test } from 'vitest'\n")
    writeFixture(root, 'notes/plain.mjs', 'export const nope = 1\n')
    writeFixture(root, 'docs/site/tests/nested.test.mjs', "import test from 'node:test'\n")

    const files = collectScopeFiles({ root }).map((file) => toRelative(root, file))
    assert.deepEqual(files.sort(), [
      'docs/site/tests/nested.test.mjs',
      'scripts/imported.test.mjs',
      'spec/runner-only.test.mjs'
    ])
  })
})

// The exclusion list is data, not control flow: callers can replace it (and the
// reasons stay next to each entry).
test('directory-level exclusions are configurable', () => {
  withTempRoot((root) => {
    writeFixture(root, 'evidence/copy.test.mjs', "import test from 'node:test'\n")
    writeFixture(root, 'scripts/imported.test.mjs', "import test from 'node:test'\n")

    const custom = [{ dir: 'scripts', reason: 'fixture-specific exclusion' }]
    const files = collectScopeFiles({ root, exclusions: custom }).map((file) =>
      toRelative(root, file)
    )
    assert.deepEqual(files, ['evidence/copy.test.mjs'])
  })
})

// U315: the shipped exclusions document why each tree is skipped. The vitest
// trees must stay out because numeric third args there are a legal API.
test('shipped exclusions carry a reason and cover evidence and vitest trees', () => {
  const reasons = new Map(SCAN_EXCLUSIONS.map(({ dir, reason }) => [dir, reason]))
  for (const dir of [
    'evidence',
    'cloud-platform/evidence',
    'src/main',
    'mobile',
    'tests',
    'config/scripts'
  ]) {
    assert.match(reasons.get(dir) ?? '', /\S/, dir)
  }
})

// U315: the real repository now includes the four previously missed runner trees,
// and never scans gitignored evidence copies.
test('collectScopeFiles covers the real runner trees but not evidence', () => {
  const files = collectScopeFiles().map((file) => toRelative(REPO_ROOT, file))
  assert.ok(files.includes('cloud-platform/scripts/check-test-timeouts.test.mjs'))
  assert.ok(files.includes('.github/actions/cloud-sql-rollout-lease/action-contract.test.mjs'))
  assert.ok(files.includes('docs/site/tests/docs-package.test.mjs'))
  assert.ok(files.some((file) => /^cloud\/dev\/scripts\/.+\.test\.mjs$/.test(file)))
  // U317: pin the exact count. A change here means the scan scope itself moved; the
  // baseline's `scannedFiles` and this number are expected to stay in lockstep, and
  // checkTestTimeouts() reports a mismatch against the baseline at check time.
  assert.equal(files.length, 296, `expected exactly 296 files, got ${files.length}`)
  assert.ok(files.every((file) => !/(^|\/)evidence\//.test(file)))
  assert.ok(files.every((file) => !/^(?:src\/main|mobile|tests|config\/scripts)\//.test(file)))
})

// --from-head must apply the same policy to committed content.
test('headScopeFiles uses the same expanded policy', () => {
  const files = headScopeFiles()
  assert.ok(files.includes('cloud-platform/scripts/check-test-timeouts.test.mjs'))
  assert.ok(files.includes('cloud/dev/scripts/infra.test.mjs'))
  assert.ok(files.includes('.github/actions/cloud-sql-rollout-lease/storage-lease.test.mjs'))
  assert.ok(files.includes('docs/site/tests/docs-package.test.mjs'))
  assert.ok(files.every((file) => !/(^|\/)evidence\//.test(file)))
})

// U317 ③: runner references in HEAD mode come from the committed package.json, never
// from the dirty worktree; otherwise an uncommitted script could add files to scope.
test('headScopeFiles reads runner references from committed package.json', () => {
  withTempRoot((root) => {
    writeFixture(
      root,
      'package.json',
      JSON.stringify({ scripts: { test: 'node --test specs/committed.test.mjs' } })
    )
    writeFixture(root, 'specs/committed.test.mjs', 'export const committed = 1\n')
    writeFixture(root, 'specs/dirty-only.test.mjs', 'export const dirty = 1\n')
    const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git(['init', '-q'])
    git(['add', '.'])
    git([
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init'
    ])
    // Uncommitted manifest change must not leak into HEAD scope.
    writeFixture(
      root,
      'package.json',
      JSON.stringify({
        scripts: { test: 'node --test specs/committed.test.mjs specs/dirty-only.test.mjs' }
      })
    )
    assert.deepEqual(headScopeFiles({ root }), ['specs/committed.test.mjs'])
  })
})

// U317 ⑤: the worktree and HEAD import patterns derive from one source, so a change
// to one cannot silently drift from the other.
test('worktree and HEAD import patterns share one source', () => {
  // The authored pattern is POSIX ERE (grep) form; the JS RegExp is the same text
  // with `[[:space:]]` translated to `\s`, so the two cannot drift.
  assert.equal(NODE_TEST_IMPORT_GREP, NODE_TEST_IMPORT_SOURCE)
  assert.equal(NODE_TEST_IMPORT.source, NODE_TEST_IMPORT_SOURCE.replaceAll('[[:space:]]', '\\s'))
  // U321 ②: the POSIX `^` anchors per line, which needs the JS `m` flag.
  assert.equal(NODE_TEST_IMPORT.flags, 'm')
  assert.ok(NODE_TEST_IMPORT.test("import test from 'node:test'"))
  assert.ok(NODE_TEST_IMPORT.test('const test = require("node:test")'))
  assert.ok(NODE_TEST_IMPORT.test('import test\n  from\n  "node:test"'))
  assert.ok(!NODE_TEST_IMPORT.test("import test from 'node:test-extra'"))
})

// U321 ②: side-effect and dynamic imports join the shared pattern. The new
// alternatives are anchored to a statement/expression boundary so text mentions in
// strings and comments, and lookalike module ids, stay out of scope.
test('import pattern covers side-effect and dynamic node:test forms', () => {
  for (const source of [
    "import 'node:test'",
    'import "node:test"',
    "  import 'node:test'\n",
    "import('node:test')",
    "await import('node:test')",
    'await import ( "node:test" )',
    "const { test } = await import('node:test')",
    "const pending = import('node:test')"
  ]) {
    assert.ok(NODE_TEST_IMPORT.test(source), source)
  }
  for (const source of [
    "const label = \"import 'node:test'\"",
    "const label = \"import('node:test')\"",
    "// import 'node:test'",
    "// import('node:test')",
    "// await import('node:test')",
    "/* import 'node:test' */",
    "/* import('node:test') */",
    "import 'node:other'",
    "import('node:other')",
    "import test from 'node:test-extra'"
  ]) {
    assert.ok(!NODE_TEST_IMPORT.test(source), source)
  }
})

// U321 ②: end-to-end scope behavior for the new forms. A real side-effect/dynamic
// importer is scanned; string/comment mentions and other modules are not.
test('scope recognizes side-effect and dynamic node:test imports only as code', () => {
  withTempRoot((root) => {
    writeFixture(root, 'scripts/side-effect.test.mjs', "import 'node:test'\n")
    writeFixture(root, 'scripts/dynamic.test.mjs', "const { test } = await import('node:test')\n")
    writeFixture(root, 'scripts/string.test.mjs', 'const label = "import \'node:test\'"\n')
    writeFixture(root, 'scripts/comment.test.mjs', "// import 'node:test'\n")
    writeFixture(root, 'scripts/other.test.mjs', "import 'node:other'\n")
    const files = collectScopeFiles({ root }).map((file) => toRelative(root, file))
    assert.deepEqual(files.sort(), ['scripts/dynamic.test.mjs', 'scripts/side-effect.test.mjs'])
  })
})
