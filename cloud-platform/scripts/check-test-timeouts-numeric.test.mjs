import assert from 'node:assert/strict'
import test from 'node:test'
import { scanSource } from './check-test-timeouts.mjs'
import { callSignature, scanSources } from './check-test-timeouts-scan.mjs'

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

// U309 ①: folding must not conflate a sign applied to a whole expression with a sign
// applied to its first operand. Every non-arithmetic operator group keeps its own key.
const NON_ARITHMETIC_OPERATOR_PAIRS = [
  ['a ? b : c', 'conditional'],
  ['a || b', 'logical-or'],
  ['a && b', 'logical-and'],
  ['a ?? b', 'nullish'],
  ['a === b', 'strict-equal'],
  ['a !== b', 'strict-not-equal'],
  ['a == b', 'loose-equal'],
  ['a != b', 'loose-not-equal'],
  ['a < b', 'less-than'],
  ['a > b', 'greater-than'],
  ['a <= b', 'less-or-equal'],
  ['a >= b', 'greater-or-equal'],
  ['a instanceof B', 'instanceof'],
  ['a in b', 'in'],
  ['a & b', 'bit-and'],
  ['a | b', 'bit-or'],
  ['a ^ b', 'bit-xor'],
  ['a << b', 'shift-left'],
  ['a >> b', 'shift-right'],
  ['a >>> b', 'shift-right-unsigned']
]

test('unary-sign folding keeps every non-arithmetic operator group distinct', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  for (const [expression, label] of NON_ARITHMETIC_OPERATOR_PAIRS) {
    assert.notEqual(key(`-(${expression})`), key(`-${expression}`), label)
  }
  // Redundant parens still fold, and a unary `!` is not a binary operator.
  assert.equal(key('-((a || b))'), key('-(a || b)'))
  assert.equal(key('-(((DURATION_S * 1_000)))'), key('-(DURATION_S * 1_000)'))
  assert.equal(key('-(!a)'), key('-!a'))
})

// U309 ①: comments are blanked by sanitize before folding, so operator- or comma-looking
// text inside them cannot change a signature.
test('fold operators and commas inside comments are not seen', () => {
  const source = [
    "test('a', fn, -(TEST_TIMEOUT * 1_000))",
    "test('b', fn, -((TEST_TIMEOUT /* ? : || && === */ * 1_000)))",
    "test('c', fn, TEST_TIMEOUT * 1_000)",
    "test('d', fn, TEST_TIMEOUT /* a, b */ * 1_000)"
  ].join('\n')
  const { violations, contexts } = scanSources([{ file: 'lex.ts', source: `${source}\n` }])
  assert.equal(violations.length, 4)
  const signatures = violations.map((violation) => contexts.get('lex.ts').signatures.get(violation))
  assert.equal(signatures[0], signatures[1])
  assert.equal(signatures[2], signatures[3])
  assert.notEqual(signatures[0], signatures[2])
})

// U309 ②: Node also silently ignores member-access and asserted non-finite spellings.
test('flags member-access and asserted non-finite specials', () => {
  const source = [
    "test('a', fn, Number.POSITIVE_INFINITY)",
    "test('b', fn, Number.NEGATIVE_INFINITY)",
    "test('c', fn, Number.NaN)",
    'before(fn, globalThis.Infinity)',
    'afterEach(fn, globalThis.NaN)',
    "it('d', fn, Infinity as number)",
    'before(fn, -Number.POSITIVE_INFINITY)',
    "test('e', fn, ((globalThis.NaN)))",
    'after(fn, opts, Infinity as number)'
  ].join('\n')
  assert.deepEqual(scanSource(`${source}\n`), [
    { file: '<memory>', line: 1, form: 'numeric-special' },
    { file: '<memory>', line: 2, form: 'numeric-special' },
    { file: '<memory>', line: 3, form: 'numeric-special' },
    { file: '<memory>', line: 4, form: 'numeric-special' },
    { file: '<memory>', line: 5, form: 'numeric-special' },
    { file: '<memory>', line: 6, form: 'numeric-special' },
    { file: '<memory>', line: 7, form: 'numeric-special' },
    { file: '<memory>', line: 8, form: 'numeric-special' },
    { file: '<memory>', line: 9, form: 'numeric-special' }
  ])
})

test('does not flag lookalikes of the newly recognized specials', () => {
  const source = [
    "test('a', fn, isFinite)",
    "test('b', fn, Infinity2)",
    "test('c', fn, myNaN)",
    "test('d', fn, Number.MAX_SAFE_INTEGER)",
    "test('e', fn, globalThis.isNaN)",
    "test('f', fn, Number['MAX_SAFE_INTEGER'])",
    "test('g', fn, global.isNaN)",
    "test('h', fn, Infinity2 satisfies number)"
  ].join('\n')
  assert.deepEqual(scanSource(`${source}\n`), [])
})

// U311 ②: equivalent non-finite spellings collapse to one canonical special key, so a
// pure spelling refactor at an already-ignored call site never reports a new violation.
test('equivalent non-finite spellings share canonical special keys', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  assert.equal(key('Infinity'), "test('a',special:infinity)")
  for (const spelling of [
    'Number.POSITIVE_INFINITY',
    'globalThis.Infinity',
    'Infinity as number',
    'Infinity satisfies number',
    'Number . POSITIVE_INFINITY',
    '(Number).POSITIVE_INFINITY',
    'Number["POSITIVE_INFINITY"]',
    'global.Infinity',
    '+Infinity',
    '((Infinity))'
  ]) {
    assert.equal(key(spelling), key('Infinity'), spelling)
  }
  assert.equal(key('Number.NEGATIVE_INFINITY'), key('-Infinity'))
  assert.equal(key('-Number.NEGATIVE_INFINITY'), key('Infinity'))
  for (const spelling of ['Number.NaN', 'globalThis.NaN', 'global.NaN', '-NaN', 'NaN as any']) {
    assert.equal(key(spelling), key('NaN'), spelling)
  }
  assert.equal(key('NaN'), "test('a',special:nan)")
  assert.notEqual(key('Infinity'), key('-Infinity'))
  // U313 ③: NaN's sign is unobservable at a timeout position, so `-NaN` shares the
  // NaN key while staying distinct from the signed infinities.
  assert.equal(key('-NaN'), key('NaN'))
  assert.notEqual(key('-NaN'), key('-Infinity'))
})

// U313 ①: comments used to blank the bracket member (sanitize blanks string bodies),
// so these three forms silently escaped. The special view strips comments but keeps
// string literals, so the member name survives.
const COMMENTED_BRACKET_SPECIALS = [
  ['Number /* c */ ["POSITIVE_INFINITY"]', 'Number.POSITIVE_INFINITY'],
  ['Number["NEGATIVE_INFINITY"] /* c */', 'Number.NEGATIVE_INFINITY'],
  ['(Number /* c */)["NaN"]', 'Number.NaN']
]

const scanSpecialKey = (timeout) => {
  const { violations, contexts } = scanSources([
    { file: 'lex.ts', source: `test('a', () => {}, ${timeout})\n` }
  ])
  return contexts.get('lex.ts').signatures.get(violations[0])
}

for (const [spelling, canonical] of COMMENTED_BRACKET_SPECIALS) {
  test(`flags commented bracket special: ${spelling}`, () => {
    assert.deepEqual(scanSource(`test('a', fn, ${spelling})\n`), [
      { file: '<memory>', line: 1, form: 'numeric-special' }
    ])
    // Comments are blanked before the signature is keyed, so the comment variant
    // collapses onto the canonical special key.
    assert.equal(scanSpecialKey(spelling), scanSpecialKey(canonical))
  })
}

test('comment placement around dotted specials keeps the canonical key', () => {
  assert.equal(
    scanSpecialKey('Number /* c */ . POSITIVE_INFINITY'),
    scanSpecialKey('Number.POSITIVE_INFINITY')
  )
  assert.equal(
    scanSpecialKey('(Number) /* c */ . POSITIVE_INFINITY'),
    scanSpecialKey('Number.POSITIVE_INFINITY')
  )
})

// U313 ②: bare signed infinities are not JS globals, and globalThis/global do not
// expose POSITIVE_INFINITY/NEGATIVE_INFINITY (the value is undefined). Reporting them
// was an over-match; they must stay silent, including comment and lookalike variants.
test('does not flag bare or undefined-global signed infinity spellings', () => {
  const source = [
    "test('a', fn, POSITIVE_INFINITY)",
    "test('b', fn, NEGATIVE_INFINITY)",
    "test('c', fn, globalThis.POSITIVE_INFINITY)",
    "test('d', fn, global.NEGATIVE_INFINITY)",
    'before(fn, globalThis["POSITIVE_INFINITY"])',
    'after(fn, global["NEGATIVE_INFINITY"])',
    "test('e', fn, (globalThis /* c */).POSITIVE_INFINITY)",
    "test('f', fn, globalTh.is)",
    "test('g', fn, globalThisX.POSITIVE_INFINITY)"
  ].join('\n')
  assert.deepEqual(scanSource(`${source}\n`), [])
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  // Real members still canonicalize, so the tightening did not disable the fix.
  assert.equal(key('Number.POSITIVE_INFINITY'), key('Infinity'))
  assert.equal(key('Number["NEGATIVE_INFINITY"]'), key('-Infinity'))
  assert.equal(key('globalThis.Infinity'), key('Infinity'))
  assert.equal(key('global.NaN'), key('NaN'))
  assert.notEqual(key('POSITIVE_INFINITY'), key('Infinity'))
  assert.notEqual(key('globalThis.POSITIVE_INFINITY'), key('Infinity'))
})


// U311 ①: a dot separated by spaces is still property access, and a generic call's `<`
// is not an operator, so redundant parens fold across a unary sign on both forms.
test('spaced property access and generic calls keep one key across unary parens', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  assert.equal(key('-(obj. in)'), key('-obj. in'))
  assert.equal(key('-(obj?.in)'), key('-obj?.in'))
  assert.equal(key('-(f<T>())'), key('-f<T>()'))
  assert.equal(key('-(f<T, U>())'), key('-f<T, U>()'))
  // Real comparisons still split, so the conservative generic rule did not over-fold.
  assert.notEqual(key('-(a < b)'), key('-a < b'))
  assert.notEqual(key('-(a < b > (c))'), key('-a < b > (c)'))
})

// U311 ④: `?.` / `?.[` are member access, not the conditional operator.
test('optional chaining is not treated as a binary operator', () => {
  const key = (spelling) => callSignature('test', ["'a'", '() => {}', spelling])
  assert.equal(key('-(a?.b)'), key('-a?.b'))
  assert.equal(key('-(a?.[0])'), key('-a?.[0]'))
  assert.notEqual(key('-(a ? b : c)'), key('-a ? b : c'))
})

// U311 ③: spaced dots, bracket/parenthesized object access and `satisfies` are all
// ignored by node:test exactly like the bare spellings.
test('flags spaced, bracketed, parenthesized and satisfies special spellings', () => {
  const source = [
    "test('a', fn, Number . POSITIVE_INFINITY)",
    'test(\'b\', fn, Number["POSITIVE_INFINITY"])',
    "test('c', fn, (Number).POSITIVE_INFINITY)",
    "test('d', fn, global.Infinity)",
    "test('e', fn, Infinity satisfies number)",
    "test('f', fn, Number['NEGATIVE_INFINITY'])",
    'test(\'g\', fn, (Number)["NaN"])',
    'before(fn, globalThis . NaN)',
    'after(fn, opts, Infinity satisfies number)'
  ].join('\n')
  assert.deepEqual(
    scanSource(`${source}\n`),
    Array.from({ length: 9 }, (_, index) => ({
      file: '<memory>',
      line: index + 1,
      form: 'numeric-special'
    }))
  )
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

// U315: node:test's `test.skip/only/todo` (and the `it` variants) are the same
// collector, so numeric/object timeouts there are dropped just like `test(...)`.
test('flags timeout arguments on chained test modifiers', () => {
  const source = [
    "test.skip('a', fn, 5000)",
    "test.only('b', fn, 6000)",
    "test.todo('c', fn, { timeout: 7000 })",
    "it.skip('d', fn, 8000)",
    "it.only('e', fn, 9000)",
    "it.todo('f', fn, 10_000)",
    "test.skip('plain', fn)",
    "test.only('legal', { timeout: 5000 }, fn)"
  ].join('\n')
  const { violations, contexts } = scanSources([{ file: 'chain.ts', source: `${source}\n` }])
  assert.deepEqual(violations, [
    { file: 'chain.ts', line: 1, form: 'test-numeric-third' },
    { file: 'chain.ts', line: 2, form: 'test-numeric-third' },
    { file: 'chain.ts', line: 3, form: 'test-object-third' },
    { file: 'chain.ts', line: 4, form: 'test-numeric-third' },
    { file: 'chain.ts', line: 5, form: 'test-numeric-third' },
    { file: 'chain.ts', line: 6, form: 'test-numeric-third' }
  ])
  // The modifier never leaks into the baseline key, so renaming skip -> only at the
  // same call site is not a new violation. Compare against a plain `test(...)` scan
  // because sanitize blanks the title in both signatures.
  const plain = scanSources([{ file: 'plain.ts', source: "test('a', fn, 5000)\n" }])
  const plainSignature = plain.contexts
    .get('plain.ts')
    .signatures.get(plain.violations[0])
  assert.equal(contexts.get('chain.ts').signatures.get(violations[0]), plainSignature)
})

test('chained-modifier detection does not match properties on other objects', () => {
  const source = [
    'obj.test.skip(fn, 5000)',
    'latest.skip(fn, 5000)',
    'submit.only(fn, 5000)',
    'edit.todo(fn, 5000)',
    "test.skip('pseudo', fn)"
  ].join('\n')
  assert.deepEqual(scanSource(`${source}\n`), [])
})

// U315: object timeouts are the legal form on hooks, including when the hook is
// wrapped in chained modifiers? Hooks have no modifiers, but the object must never
// be mistaken for a dropped numeric argument.
test('accepts object timeouts on before and after hooks', () => {
  const source = [
    'before(startApp, { timeout: 30_000 })',
    'after(stopApp, { timeout: 60_000 })',
    'beforeEach(setup, { timeout: 1_000 })',
    'afterEach(cleanup, { timeout: 2_000 })',
    'before(setup, { timeout: TEST_TIMEOUT })'
  ].join('\n')
  assert.deepEqual(scanSource(`${source}\n`), [])
})
