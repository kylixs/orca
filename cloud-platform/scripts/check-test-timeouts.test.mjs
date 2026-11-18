import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import * as entry from './check-test-timeouts.mjs'
import {
  checkTestTimeouts,
  parseArgs,
  scanSource,
  scanTestTimeouts
} from './check-test-timeouts.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GIT_OPTIONS = { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'test-timeouts-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeFixture(root, name, source) {
  const file = join(root, name)
  writeFileSync(file, source)
  return file
}

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('flags numeric third argument on test/it', () => {
  const violations = scanSource("test('adds', () => {}, 5000)\nit('sub', fn, 30_000)\n")
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'test-numeric-third' },
    { file: '<memory>', line: 2, form: 'test-numeric-third' }
  ])
})

test('flags constant numeric expressions as timeout third/second arguments', () => {
  const violations = scanSource(
    'test(\n  `load`,\n  async () => {},\n  DURATION_S * 1_000 + 300_000\n)\n' +
      'before(setup, TIMEOUT_MS * 1)\n'
  )
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'test-numeric-third' },
    { file: '<memory>', line: 6, form: 'hook-numeric-second' }
  ])
})

test('does not flag lowercase identifiers as numeric timeout', () => {
  assert.deepEqual(scanSource("test('x', fn, callback)\n"), [])
})

test('flags object third argument on test/it (silently ignored by node:test)', () => {
  const violations = scanSource(
    "test('adds', () => {}, { timeout: 5000 })\n" +
      "it('sub', async () => {}, {\n  timeout: 10_000\n})\n"
  )
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'test-object-third' },
    { file: '<memory>', line: 2, form: 'test-object-third' }
  ])
})

test('accepts the legal options-second form on test/it', () => {
  const violations = scanSource(
    "test('adds', { timeout: 5000 }, () => {})\n" +
      "it('sub', { timeout: 10_000 }, async () => {})\n" +
      "test('plain', () => {})\n"
  )
  assert.deepEqual(violations, [])
})

test('flags numeric second argument on hooks', () => {
  const violations = scanSource(
    'before(() => {}, 5000)\nafter(async () => {}, 30_000)\n' +
      'beforeEach(fn, 1_000)\nafterEach(setup, 2_000)\n'
  )
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'hook-numeric-second' },
    { file: '<memory>', line: 2, form: 'hook-numeric-second' },
    { file: '<memory>', line: 3, form: 'hook-numeric-second' },
    { file: '<memory>', line: 4, form: 'hook-numeric-second' }
  ])
})

test('flags numeric third argument on hooks (Node 24 ignores arg 2 options only)', () => {
  const violations = scanSource(
    'before(fn, setup, 5000)\nafterEach(run, opts, 30_000)\n' +
      'before(fn, 5000)\nbefore(fn, opts, callback)\n'
  )
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'hook-numeric-third' },
    { file: '<memory>', line: 2, form: 'hook-numeric-third' },
    { file: '<memory>', line: 3, form: 'hook-numeric-second' }
  ])
})

test('accepts the legal options-second form on hooks', () => {
  const violations = scanSource(
    'before(() => {}, { timeout: 5000 })\nafterEach(fn, { timeout: 1000 })\n'
  )
  assert.deepEqual(violations, [])
})

test('ignores pseudo-code in comments and strings', () => {
  const source = [
    '// test("pseudo", () => {}, 5000)',
    '/* before(fn, 5000)',
    "   test('pseudo', () => {}, { timeout: 1 }) */",
    'const sample = "test(\'pseudo\', fn, 5000)"',
    'const template = `before(fn, 5000)`',
    "test('real', { timeout: 5000 }, () => {})"
  ].join('\n')
  assert.deepEqual(scanSource(source), [])
})

test('does not flag method calls or identifiers ending in a test name', () => {
  const violations = scanSource('latest(fn, 5000)\nedit(fn, 5000)\nobj.test(fn, 5000)\n')
  assert.deepEqual(violations, [])
})

// U295: a regex literal with an escaped paren used to swallow the enclosing call.
test('flags a numeric timeout when the body holds a regex with an escaped paren', () => {
  const source = [
    "test('U58 W5 invalid escape', async () => {",
    "  assert.doesNotMatch(body, /INTERNAL_ERROR|at [\\w./]+\\s*\\(/, 'no leak')",
    '}, 120_000)'
  ].join('\n')
  assert.deepEqual(scanSource(source), [{ file: '<memory>', line: 1, form: 'test-numeric-third' }])
})

test('bracket pairing skips regex, template expressions, comments and strings', () => {
  const source = [
    'const backtickRegex = /return `([\\s\\S]*?)`/.exec(src)',
    'const quoteRegex = /curl -fsSL "([^"]+)"/.exec(command)',
    'test(`label ${fn(1, "a)b")}`, () => {',
    "  // test('pseudo', () => {}, 1)",
    '  const real = /a\\(b\\)/.test(text)',
    '}, 5000)'
  ].join('\n')
  assert.deepEqual(scanSource(source), [{ file: '<memory>', line: 3, form: 'test-numeric-third' }])
})

test('division is not mistaken for a regex literal', () => {
  const source = "const seconds = totalMs / 1000\ntest('x', () => {}, 5000)\n"
  assert.deepEqual(scanSource(source), [{ file: '<memory>', line: 2, form: 'test-numeric-third' }])
})

test('does not treat call-like text inside a regex as a test call', () => {
  const source = "const pattern = /test\\('x', fn, 5000\\)/g\n"
  assert.deepEqual(scanSource(source), [])
})

// U301 ②: \`return\` must open a regex, otherwise its body is scanned as code.
test('does not report a call-like regex after return as a test call', () => {
  const source = [
    "function pattern(value) { return /test('x', fn, 5000)/ }",
    "test('real', () => {}, 5000)"
  ].join('\n')
  assert.deepEqual(scanSource(source), [{ file: '<memory>', line: 2, form: 'test-numeric-third' }])
})

test('regex literals after return, arrow and ternary keep bracket pairing', () => {
  const source = [
    "test('real', () => {",
    '  const arrow = () => /re/',
    '  const pick = (v) => (v ? /a/ : /b/)',
    '  const f = () => { return /re)/ }',
    '}, 5000)'
  ].join('\n')
  assert.deepEqual(scanSource(source), [{ file: '<memory>', line: 1, form: 'test-numeric-third' }])
})

// U301 ①: a \`/\` inside \`[...]\` must not close the regex and leave a stray \`]\`.
test('regex character classes do not truncate the enclosing test call', () => {
  const source = [
    "test('negated class', () => {",
    '  const parts = value.match(/[^/]+/)',
    '}, 5000)',
    "test('class with slash', () => {",
    "  const slash = '/'.match(/[/]/)",
    '}, 5000)'
  ].join('\n')
  assert.deepEqual(scanSource(source), [
    { file: '<memory>', line: 1, form: 'test-numeric-third' },
    { file: '<memory>', line: 4, form: 'test-numeric-third' }
  ])
})

// U303 ②: a dotted name is a property, not a keyword, so `/` after it is division.
test('dotted keyword names do not swallow a following test call', () => {
  const source = [
    "const a = obj.in / 2, x = test('a', () => {}, 5000) / 3",
    "const b = obj.return / 2, y = test('b', () => {}, 6000) / 3"
  ].join('\n')
  assert.deepEqual(scanSource(source), [
    { file: '<memory>', line: 1, form: 'test-numeric-third' },
    { file: '<memory>', line: 2, form: 'test-numeric-third' }
  ])
})

test('escaped parens inside a character class do not break brackets', () => {
  const source = [
    "test('paren class', () => {",
    '  const match = text.match(/[\\(/]+/)',
    '}, 5000)'
  ].join('\n')
  assert.deepEqual(scanSource(source), [{ file: '<memory>', line: 1, form: 'test-numeric-third' }])
})

// U303 ③ known limitation: `v`-flag nested classes close on the first `]`, leaving a
// stray `]` that breaks call pairing. Skip rather than pretend the scanner supports it.
test.skip('v-flag nested character classes are a known unsupported limitation', () => {
  const source = ["test('nested class', () => {", '  const re = /[[a]/]/v', '}, 5000)'].join('\n')
  assert.deepEqual(scanSource(source), [{ file: '<memory>', line: 1, form: 'test-numeric-third' }])
})

// U305 ②: plain, underscored, parenthesized and signed spellings share one baseline key.
test('numeric literal spellings normalize to one baseline key', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    const [key] = Object.keys(JSON.parse(readFileSync(baselinePath, 'utf8')).entries)

    for (const spelling of ['5_000', '(5000)', '+5000', '((5_000))']) {
      writeFileSync(file, `test('a', () => {}, ${spelling})\n`)
      const result = checkTestTimeouts({ files: [file], baselinePath })
      assert.equal(result.exitCode, 0, spelling)
      assert.deepEqual(result.newViolations, [], spelling)

      checkTestTimeouts({ files: [file], baselinePath, updateBaseline: true })
      const [rewritten] = Object.keys(JSON.parse(readFileSync(baselinePath, 'utf8')).entries)
      assert.equal(rewritten, key, spelling)
    }
  })
})

// U305 ③: duplicate paths replaced the per-file signature map and threw a TypeError.
test('duplicate files are scanned once instead of throwing', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    const created = checkTestTimeouts({ files: [file, file], baselinePath })
    assert.equal(created.baselineWritten, true)
    assert.equal(created.scannedFiles, 1)
    assert.equal(created.baselineCount, 1)

    const repeat = checkTestTimeouts({ files: [file, file], baselinePath })
    assert.equal(repeat.exitCode, 0)
    assert.deepEqual(repeat.newViolations, [])
    assert.deepEqual(scanTestTimeouts({ files: [file, file] }).violations, [
      { file, line: 1, form: 'test-numeric-third' }
    ])
  })
})

// U305 ⑤: the key must not include the callback body.
test('unrelated callback body edits keep the baseline key', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => { alpha(1) }, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    const [key] = Object.keys(JSON.parse(readFileSync(baselinePath, 'utf8')).entries)

    writeFileSync(file, "test('a', () => { beta(2, 3) }, 5000)\n")
    const checked = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(checked.exitCode, 0)
    assert.deepEqual(checked.newViolations, [])

    checkTestTimeouts({ files: [file], baselinePath, updateBaseline: true })
    const [rewritten] = Object.keys(JSON.parse(readFileSync(baselinePath, 'utf8')).entries)
    assert.equal(rewritten, key)
  })
})

// U305 ①: fewer occurrences than the baseline is a tighten candidate, not a failure.
test('stale baseline keys are reported without failing the check', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', 'before(fn, 5000)\nbefore(fn, 5000)\n')
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })

    writeFileSync(file, 'before(fn, 5000)\n')
    const result = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.newViolations, [])
    assert.equal(result.staleKeys.length, 1)
    assert.equal(result.staleKeys[0].baselineCount, 2)
    assert.equal(result.staleKeys[0].currentCount, 1)
  })
})

test('CLI prints a stale-key note and stays green', () => {
  withTempDir((root) => {
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: entry.collectScopeFiles(), baselinePath })
    const payload = JSON.parse(readFileSync(baselinePath, 'utf8'))
    payload.entries['cloud-platform/test/gone.test.ts|hook-numeric-second|000000000000'] = 1
    writeFileSync(baselinePath, JSON.stringify(payload))

    const stdout = execFileSync(
      process.execPath,
      ['cloud-platform/scripts/check-test-timeouts.mjs', '--check', '--baseline', baselinePath],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    assert.match(stdout, /baseline note: 1 baseline key\(s\) currently below their count/)
    assert.match(stdout, /cloud-platform\/test\/gone\.test\.ts\|hook-numeric-second\|000000000000/)
  })
})

test('baseline mode stays green when nothing is added', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    const created = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(created.baselineWritten, true)
    assert.equal(created.exitCode, 0)
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.equal(baseline.counts.total, 1)
    assert.deepEqual(baseline.counts.byForm, { 'test-numeric-third': 1 })
    assert.equal(Object.keys(baseline.entries).length, 1)

    const repeat = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(repeat.exitCode, 0)
    assert.deepEqual(repeat.newViolations, [])
  })
})

test('baseline entries key on file + form + normalized call signature, not line numbers', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    const [key] = Object.keys(baseline.entries)
    assert.match(key, /\|test-numeric-third\|[0-9a-f]{12}$/)
    assert.equal(baseline.entries[key], 1)
  })
})

test('line drift with unchanged content does not create a new violation', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })

    writeFileSync(file, `\n\n// moved down\n${readFileSync(file, 'utf8')}`)
    const result = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.newViolations, [])
  })
})

// U300: a call re-wrapped across lines must keep the same key.
test('the same call wrapped across lines keeps its baseline key', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, DURATION_S * 1_000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    const [singleLineKey] = Object.keys(JSON.parse(readFileSync(baselinePath, 'utf8')).entries)

    writeFileSync(file, "test(\n  'a',\n  () => {},\n  DURATION_S *\n    1_000\n)\n")
    const checked = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(checked.exitCode, 0)
    assert.deepEqual(checked.newViolations, [])

    checkTestTimeouts({ files: [file], baselinePath, updateBaseline: true })
    const [wrappedKey] = Object.keys(JSON.parse(readFileSync(baselinePath, 'utf8')).entries)
    assert.equal(wrappedKey, singleLineKey)
  })
})

test('changed timeout content yields a different key and one new violation', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })

    for (const changed of [
      "test('a', () => {}, 5001)\n",
      "test('a', () => {}, { timeout: 5000 })\n",
      "test('a', () => {}, DURATION_S * 1_000)\n"
    ]) {
      writeFileSync(file, changed)
      const result = checkTestTimeouts({ files: [file], baselinePath })
      assert.equal(result.exitCode, 1, changed)
      assert.equal(result.newViolations.length, 1, changed)
    }
  })
})

test('identical calls are counted, so replacing one reports one new violation', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', 'before(fn, 5000)\nbefore(fn, 5000)\n')
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.deepEqual(Object.values(baseline.entries), [2])

    writeFileSync(file, 'before(fn, 5000)\nbefore(fn, 6000)\n')
    const result = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(result.exitCode, 1)
    assert.deepEqual(
      result.newViolations.map((violation) => violation.line),
      [2]
    )
  })
})

test('duplicate content keys are counted so only the excess occurrence is new', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', 'before(fn, 5000)\nbefore(fn, 5000)\n')
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.deepEqual(Object.values(baseline.entries), [2])

    writeFileSync(file, `${readFileSync(file, 'utf8')}before(fn, 5000)\n`)
    const result = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(result.exitCode, 1)
    assert.deepEqual(
      result.newViolations.map((violation) => `${violation.file}:${violation.line}`),
      [`${file}:3`]
    )
  })
})

test('baseline mode reports a newly added violation', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    writeFileSync(file, `${readFileSync(file, 'utf8')}\ntest('b', () => {}, { timeout: 10 })\n`)

    const result = checkTestTimeouts({ files: [file], baselinePath })
    assert.equal(result.exitCode, 1)
    assert.deepEqual(
      result.newViolations.map((violation) => `${violation.file}:${violation.line}`),
      [`${file}:3`]
    )
  })
})

test('--update-baseline rewrites the full list', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    checkTestTimeouts({ files: [file], baselinePath })
    writeFileSync(file, `${readFileSync(file, 'utf8')}before(fn, 5000)\n`)

    const result = checkTestTimeouts({ files: [file], baselinePath, updateBaseline: true })
    assert.equal(result.exitCode, 0)
    assert.equal(result.baselineCount, 2)
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.equal(Object.keys(baseline.entries).length, 2)
    assert.deepEqual(baseline.counts.byForm, {
      'test-numeric-third': 1,
      'hook-numeric-second': 1
    })
  })
})

test('legacy file:line baselines are rejected with a regeneration hint', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'a.test.ts', "test('a', () => {}, 5000)\n")
    const baselinePath = join(root, 'baseline.json')
    writeFileSync(baselinePath, JSON.stringify({ violations: [`${file}:1`] }))
    assert.throws(
      () => checkTestTimeouts({ files: [file], baselinePath }),
      /regenerate with --from-head or --update-baseline/
    )
  })
})

test('scanTestTimeouts walks explicit files and reports file:line form', () => {
  withTempDir((root) => {
    const file = writeFixture(root, 'b.test.ts', "test('b', () => {}, 5000)\n")
    const { violations } = scanTestTimeouts({ files: [file] })
    assert.deepEqual(violations, [{ file, line: 1, form: 'test-numeric-third' }])
  })
})

test('--from-head baseline matches an independent scan of committed HEAD', () => {
  withTempDir((root) => {
    const baselinePath = join(root, 'baseline.json')
    const result = checkTestTimeouts({ baselinePath, fromHead: true })
    assert.equal(result.exitCode, 0)
    assert.equal(result.baselineWritten, true)
    assert.equal(result.source, 'HEAD')

    const listed = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', '--full-tree', 'HEAD', '--', 'cloud-platform'],
      GIT_OPTIONS
    )
    const files = listed
      .split('\n')
      .map((line) => line.trim())
      .filter((file) => {
        if (!file.endsWith('.ts')) {
          return false
        }
        const parts = file.split('/')
        if (parts[0] !== 'cloud-platform') {
          return false
        }
        if (parts[1] === 'test') {
          return true
        }
        if (parts[1] === 'apps' && parts[3] === 'test' && parts.length >= 5) {
          return true
        }
        return parts[1] === 'apps' && parts[3] === 'src' && file.endsWith('.test.ts')
      })
    assert.ok(files.length > 0)
    let independentTotal = 0
    for (const file of files) {
      const source = execFileSync('git', ['show', `HEAD:${file}`], GIT_OPTIONS)
      independentTotal += scanSource(source, { file }).length
    }
    assert.equal(result.baselineCount, independentTotal)
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
    assert.equal(baseline.counts.total, independentTotal)
    assert.equal(baseline.scannedFiles, files.length)

    const recheck = checkTestTimeouts({ baselinePath, fromHead: true, checkOnly: true })
    assert.equal(recheck.exitCode, 0)
    assert.deepEqual(recheck.newViolations, [])
  })
})

test(
  'from-head baseline ignores a dirty worktree in a minimal repo',
  { skip: !gitAvailable() },
  () => {
    withTempDir((root) => {
      const testDir = join(root, 'cloud-platform', 'test')
      mkdirSync(testDir, { recursive: true })
      const file = join(testDir, 'a.test.ts')
      writeFileSync(file, "test('a', () => {}, 5000)\n")
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

      // Dirty worktree: line drift plus an uncommitted object-third violation.
      writeFileSync(file, `\n${readFileSync(file, 'utf8')}test('b', () => {}, { timeout: 10 })\n`)
      const baselinePath = join(root, 'baseline.json')

      const clean = checkTestTimeouts({ baselinePath, fromHead: true, headRoot: root })
      assert.equal(clean.baselineCount, 1)
      const dirtyOnly = checkTestTimeouts({ files: [file], baselinePath: join(root, 'dirty.json') })
      assert.equal(dirtyOnly.baselineCount, 2)

      const checked = checkTestTimeouts({ files: [file], baselinePath, root })
      assert.equal(checked.exitCode, 1)
      assert.deepEqual(
        checked.newViolations.map((violation) => `${violation.file}:${violation.line}`),
        ['cloud-platform/test/a.test.ts:3']
      )
    })
  }
)

// U303 ①: the entry file re-exports both split modules; a dropped re-export breaks callers.
test('entry re-exports the split scanner and baseline API', () => {
  for (const name of [
    'SCAN_SCOPE',
    'FORMS',
    'scanSource',
    'scanTestTimeouts',
    'collectScopeFiles',
    'headScopeFiles',
    'scanHeadSources',
    'checkTestTimeouts',
    'parseArgs'
  ]) {
    assert.ok(name in entry, name)
  }
})

test('parseArgs rejects unknown flags and missing paths', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  assert.throws(() => parseArgs(['--baseline']), /requires a path/)
  assert.equal(parseArgs(['--update-baseline']).updateBaseline, true)
  assert.equal(parseArgs(['--from-head']).fromHead, true)
  assert.equal(parseArgs(['--from-head', '--check']).checkOnly, true)
})
