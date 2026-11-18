import assert from 'node:assert/strict'
import test from 'node:test'
import { scanSource } from './check-test-timeouts.mjs'
import { callSignature } from './check-test-timeouts-scan.mjs'

// U306: every numeric literal form Node silently drops from a timeout position.
test('flags every numeric literal form node:test silently ignores', () => {
  const spellings = [
    '5000',
    '5_000',
    '5e3',
    '1e1_0',
    '0x1388',
    '0o11610',
    '0b1001110001000',
    '5000n',
    '0x1388n',
    '5000.0',
    '+5000',
    '-(5000)',
    '((5_000))'
  ]
  const source = spellings.map((spelling, index) => `test('t${index}', () => {}, ${spelling})`)
  const violations = scanSource(`${source.join('\n')}\n`)
  assert.deepEqual(
    violations,
    spellings.map((_, index) => ({
      file: '<memory>',
      line: index + 1,
      form: 'test-numeric-third'
    }))
  )
})

// U306: equivalent spellings collapse to one decimal canonical string, so a pure
// formatting change keeps the baseline key. BigInt intentionally shares the key with
// an equal Number: Node ignores `5000n` exactly like `5000`.
test('equivalent numeric literal spellings normalize to one baseline key', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  const canonical = key('5000')
  for (const spelling of [
    '5_000',
    '5e3',
    '5000.0',
    '0x1388',
    '0o11610',
    '0b1001110001000',
    '+5000',
    '((5_000))',
    '5000n',
    '0x1388n'
  ]) {
    assert.equal(key(spelling), canonical, spelling)
  }
  assert.equal(key('-(5000)'), key('-5000'))
  assert.equal(key('1e1_0'), key('10000000000'))
})

test('different numeric values keep different baseline keys', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  assert.notEqual(key('5000'), key('5001'))
  assert.notEqual(key('5000n'), key('5001n'))
  assert.notEqual(key('0x1388'), key('0x1389'))
})

// U308 ①: special identifiers are ignored by node:test just like numeric literals.
test('flags Infinity, -Infinity and NaN timeout identifiers in test and hook positions', () => {
  const source = [
    "test('a', () => {}, Infinity)",
    "it('b', fn, -Infinity)",
    "test('c', fn, NaN)",
    'before(fn, Infinity)',
    'afterEach(fn, -Infinity)',
    'before(fn, opts, NaN)',
    "test('d', fn, ((NaN)))"
  ].join('\n')
  assert.deepEqual(scanSource(`${source}\n`), [
    { file: '<memory>', line: 1, form: 'numeric-special' },
    { file: '<memory>', line: 2, form: 'numeric-special' },
    { file: '<memory>', line: 3, form: 'numeric-special' },
    { file: '<memory>', line: 4, form: 'numeric-special' },
    { file: '<memory>', line: 5, form: 'numeric-special' },
    { file: '<memory>', line: 6, form: 'numeric-special' },
    { file: '<memory>', line: 7, form: 'numeric-special' }
  ])
})

// U308 ②: Number is the common denominator, so the same runtime value shares a key
// no matter which literal spelling or representation produced it. Values beyond the
// safe integer range render as plain decimal (BigInt of the exact double), never 1e+21.
test('out-of-safe-integer spellings normalize to one plain decimal key', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  const decimal = '1000000000000000000000'
  assert.equal(key('1e21'), `test('a',${decimal})`)
  for (const spelling of [decimal, `${decimal}.0`, '0x3635C9ADC5DEA00000', '1E21']) {
    assert.equal(key(spelling), key('1e21'), spelling)
  }
  assert.equal(key('9007199254740993'), key('9007199254740992.0'))
  assert.equal(key('9007199254740993'), "test('a',9007199254740992)")
  assert.doesNotMatch(key('1e21'), /e\+/)
})

// U308 ③: redundant parens fold across a unary sign, without conflating different
// groupings such as `-(a * b)` and `-a * b`.
test('unary-sign expressions fold redundant parentheses into one key', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  const bare = key('-(DURATION_S * 1_000)')
  assert.equal(key('-((DURATION_S * 1_000))'), bare)
  assert.equal(key('-(((DURATION_S * 1_000)))'), bare)
  assert.notEqual(bare, key('-DURATION_S * 1_000'))
  assert.equal(key('-(-(DURATION_S))'), key('DURATION_S'))
})

// U308 ④: the non-finite fallback must stay text-marked and never throw.
test('non-finite numeric literals keep a raw marker without crashing', () => {
  const violations = scanSource("test('a', () => {}, 1e999)\nit('b', fn, -1e999)\n")
  assert.deepEqual(violations, [
    { file: '<memory>', line: 1, form: 'test-numeric-third' },
    { file: '<memory>', line: 2, form: 'test-numeric-third' }
  ])
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  assert.equal(key('1e999'), "test('a',raw:1e999)")
  assert.equal(key('-1e999'), "test('a',raw:-1e999)")
  assert.notEqual(key('1e999'), key('Infinity'))
})

// U308 ④: boundary literal forms were only covered in test position before.
test('flags fractional, trailing-dot, exponent and radix-separator forms on hooks', () => {
  const source = [
    'before(fn, .5)',
    'after(fn, 1.)',
    'beforeEach(fn, 1.5e-3)',
    'afterEach(fn, 0x1_388)',
    'before(fn, opts, 0o11_610)',
    'afterEach(fn, opts, 0b1001_1100_1000)',
    'before(fn, 0x1388n)'
  ].join('\n')
  assert.deepEqual(scanSource(`${source}\n`), [
    { file: '<memory>', line: 1, form: 'hook-numeric-second' },
    { file: '<memory>', line: 2, form: 'hook-numeric-second' },
    { file: '<memory>', line: 3, form: 'hook-numeric-second' },
    { file: '<memory>', line: 4, form: 'hook-numeric-second' },
    { file: '<memory>', line: 5, form: 'hook-numeric-third' },
    { file: '<memory>', line: 6, form: 'hook-numeric-third' },
    { file: '<memory>', line: 7, form: 'hook-numeric-second' }
  ])
  assert.equal(callSignature('before', ['fn', '.5']), callSignature('before', ['fn', '5e-1']))
  assert.equal(
    callSignature('before', ['fn', 'opts', '0x1_388']),
    callSignature('before', ['fn', 'opts', '5000'])
  )
})

// U306: expressions are text-normalized only — outer parens fold, nothing is evaluated.
test('constant expressions fold redundant outer parens into one key', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  const bare = key('DURATION_S * 1_000')
  assert.equal(key('(DURATION_S * 1_000)'), bare)
  assert.equal(key('((DURATION_S * 1_000))'), bare)
  assert.equal(key('DURATION_S * 0x3e8'), bare)
})

test('sequence parentheses are not folded into separate arguments', () => {
  const oneArg = callSignature('before', ['fn', '(5000, 6000)'])
  const twoArgs = callSignature('before', ['fn', '5000', '6000'])
  assert.notEqual(oneArg, twoArgs)
})
