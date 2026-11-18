// Static scan: node:test ignores numeric timeout positions (Node 24).
// Numeric third arg (test/it and hooks) and numeric second arg (hooks) are silently
// dropped, as is an object third arg on test/it. See ledger
// U287/U290/U291/U295/U297/U303/U305/U306/U308/U309/U311/U313.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  NUMERIC_LITERAL,
  NUMERIC_TOKEN,
  canonicalNumericLiteral,
  findCloseParen,
  peelNumericLiteral,
  sanitize,
  splitTopLevel,
  stripExpressionParens,
  stripOuterParens
} from './check-test-timeouts-lexer.mjs'
import {
  NODE_TEST_IMPORT,
  NODE_TEST_IMPORT_GREP,
  NODE_TEST_IMPORT_SOURCE,
  ROOT,
  SCAN_EXCLUSIONS,
  SCAN_SCOPE,
  collectScopeFiles
} from './check-test-timeouts-scope.mjs'

export {
  NODE_TEST_IMPORT,
  NODE_TEST_IMPORT_GREP,
  NODE_TEST_IMPORT_SOURCE,
  ROOT,
  SCAN_EXCLUSIONS,
  SCAN_SCOPE,
  collectScopeFiles
}

export const PLATFORM_ROOT = path.join(ROOT, 'cloud-platform')

export const FORMS = {
  TEST_NUMERIC_THIRD: 'test-numeric-third',
  TEST_OBJECT_THIRD: 'test-object-third',
  HOOK_NUMERIC_SECOND: 'hook-numeric-second',
  HOOK_NUMERIC_THIRD: 'hook-numeric-third',
  NUMERIC_SPECIAL: 'numeric-special'
}

// U315: node:test collectors can be chained: `test.skip/only/todo` and the `it`
// variants accept the same arguments, so they must be matched too. The negative
// lookbehind still rejects properties on other objects (`obj.test.skip(...)`).
const CALL_PATTERN =
  /(?<![\w$.])(beforeEach|afterEach|before|after|(?:test|it)(?:\.(?:skip|only|todo))?)\s*\(/g

function baseCallName(name) {
  const dot = name.indexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function displayPath(file, root = ROOT) {
  const relative = path.relative(root, file)
  return toPosix(relative.startsWith('..') ? file : relative)
}

function objectHasTimeout(arg) {
  const text = arg.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return false
  }
  const entries = splitTopLevel(text, 1, text.length - 1)
  return entries.some(({ start, end }) =>
    /^(?:timeout|['"]timeout['"])\s*:/.test(text.slice(start, end).trim())
  )
}

// U313 ②: bare `POSITIVE_INFINITY`/`NEGATIVE_INFINITY` are not JS globals, and
// `globalThis.POSITIVE_INFINITY`/`global.POSITIVE_INFINITY` evaluate to undefined.
// Only `Number` carries the signed-infinite members; every object carries Infinity/NaN.
const SPECIAL_OBJECTS = new Set(['Number', 'globalThis', 'global'])
const SPECIAL_MEMBER = String.raw`(?:Infinity|NaN|POSITIVE_INFINITY|NEGATIVE_INFINITY)`
const SPECIAL_MEMBERS = new Map([
  ['Infinity', 'special:infinity'],
  ['POSITIVE_INFINITY', 'special:infinity'],
  ['NEGATIVE_INFINITY', 'special:-infinity'],
  ['NaN', 'special:nan']
])
const NUMBER_ONLY_MEMBERS = new Set(['POSITIVE_INFINITY', 'NEGATIVE_INFINITY'])
// U321 ①: `Number.Infinity`/`Number?.Infinity` are `undefined` — Number exposes only
// the signed infinities plus NaN. An undefined value is not a numeric infinity, so
// these spellings stay unreported; bare `Infinity`/`globalThis.Infinity` still report.
const NUMBER_UNDEFINED_MEMBERS = new Set(['Infinity'])

// U317: access may use optional chaining and the bracket member may be a backtick
// string. The object is normalized separately, so `((Number))` and `(Number as any)`
// collapse onto `Number`.
const SPECIAL_QUOTE = '(?<quote>[\'"`])'
const SPECIAL_ACCESS = new RegExp(
  String.raw`^(?<object>.*?)\s*(?:\?\.|\.)\s*(?<member>${SPECIAL_MEMBER})$`
)
const SPECIAL_BRACKET = new RegExp(
  String.raw`^(?<object>.*?)\s*\??\.?\s*\[\s*` +
    SPECIAL_QUOTE +
    String.raw`(?<member>${SPECIAL_MEMBER})\k<quote>\s*\]$`
)
const TYPE_CLAUSE_KEYWORDS = new Set(['as', 'satisfies'])

// Index of a top-level ` as `/` satisfies ` clause, or -1. Parentheses/brackets only
// nest here; a clause inside them is handled after the outer parens are peeled.
function typeClauseStart(text) {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
    } else if (depth === 0 && /[A-Za-z_$]/.test(char) && /\s/.test(text[index - 1] ?? '')) {
      let end = index + 1
      while (end < text.length && /[\w$]/.test(text[end])) {
        end += 1
      }
      if (TYPE_CLAUSE_KEYWORDS.has(text.slice(index, end)) && /\s/.test(text[end] ?? '')) {
        return index
      }
      index = end - 1
    }
  }
  return -1
}

// `as`/`satisfies` only annotate the type and outer parens do not change the value.
// Peel both repeatedly so `(Infinity) as number` and `((Number))` normalize away.
function normalizeSpecialExpression(value) {
  let text = value.trim()
  for (;;) {
    const clause = typeClauseStart(text)
    const withoutClause = clause === -1 ? text : text.slice(0, clause).trim()
    const stripped = stripOuterParens(withoutClause)
    if (stripped === text) {
      return text
    }
    text = stripped
  }
}

function specialObject(objectText) {
  const object = normalizeSpecialExpression(objectText)
  return SPECIAL_OBJECTS.has(object) ? object : null
}

// U313 ③: `-NaN` and `NaN` share one key because the sign is unobservable at a
// node:test timeout position — the argument is dropped either way. (`Object.is`
// distinguishes them, but that distinction cannot affect a timeout.)
const applySpecialSign = (key, negative) =>
  key === null || !negative || key === 'special:nan' ? key : flipSpecialSign(key)

function flipSpecialSign(key) {
  return key === 'special:infinity' ? 'special:-infinity' : 'special:infinity'
}

function specialMemberKey(object, member) {
  const key = SPECIAL_MEMBERS.get(member)
  if (key === undefined) {
    return null
  }
  if (object === undefined) {
    return NUMBER_ONLY_MEMBERS.has(member) ? null : key
  }
  if (object !== 'Number' && NUMBER_ONLY_MEMBERS.has(member)) {
    return null
  }
  if (object === 'Number' && NUMBER_UNDEFINED_MEMBERS.has(member)) {
    return null
  }
  return key
}

function canonicalSpecialBody(body) {
  const text = normalizeSpecialExpression(body)
  const access = SPECIAL_ACCESS.exec(text)
  if (access !== null) {
    const object = specialObject(access.groups.object)
    return object === null ? null : specialMemberKey(object, access.groups.member)
  }
  const bracket = SPECIAL_BRACKET.exec(text)
  if (bracket !== null) {
    const object = specialObject(bracket.groups.object)
    return object === null ? null : specialMemberKey(object, bracket.groups.member)
  }
  return SPECIAL_MEMBERS.has(text) ? specialMemberKey(undefined, text) : null
}

function canonicalSpecialKey(arg) {
  const peeled = peelNumericLiteral(arg)
  const normalized = normalizeSpecialExpression(peeled.body)
  const signed = peelNumericLiteral(normalized)
  return applySpecialSign(
    canonicalSpecialBody(signed.body),
    peeled.negative !== signed.negative
  )
}

// U313 ①: match on sanitize(source, { preserveLiterals: true }) — comments are blanked
// while string bodies survive, so `Number /*c*/ ["X"]`, `Number["X"] /*c*/` and
// `(Number /*c*/)["X"]` all keep the bracket member. Raw source is never matched.
function pickSpecialArg(specialArg) {
  return canonicalSpecialKey(specialArg) === null ? null : specialArg
}

function isNumericLiteral(arg) {
  return NUMERIC_LITERAL.test(peelNumericLiteral(arg).body)
}

// Numeric literals plus constant arithmetic like `DURATION_S * 1_000 + 300_000`.
function isNumericTimeout(arg) {
  if (isNumericLiteral(arg)) {
    return true
  }
  const text = stripOuterParens(arg)
  if (!/\d/.test(text) || !/^[\w$+\-*/%.()\s]+$/.test(text)) {
    return false
  }
  const withoutNumbers = text.replace(NUMERIC_TOKEN, ' ')
  const identifiers = withoutNumbers.match(/[A-Za-z_$][\w$]*/g) ?? []
  return identifiers.every((identifier) => /^[A-Z][A-Z0-9_]*$/.test(identifier))
}

function lineAt(lineStarts, index) {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (lineStarts[mid] <= index) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low + 1
}

function lineStartsOf(source) {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      starts.push(index + 1)
    }
  }
  return starts
}

function scanSourceInternal(source, { file = '<memory>' } = {}) {
  const clean = sanitize(source)
  const specialSource = sanitize(source, { preserveLiterals: true })
  const lineStarts = lineStartsOf(source)
  const violations = []
  const signatures = new Map()
  CALL_PATTERN.lastIndex = 0
  let match
  while ((match = CALL_PATTERN.exec(clean)) !== null) {
    const name = baseCallName(match[1])
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findCloseParen(clean, openIndex)
    if (closeIndex === -1) {
      continue
    }
    const parts = splitTopLevel(clean, openIndex + 1, closeIndex)
    const args = parts.map((part) => clean.slice(part.start, part.end).trim())
    const specialArgs = parts.map((part) =>
      pickSpecialArg(specialSource.slice(part.start, part.end).trim())
    )
    const signatureArgs = args.map((arg, index) => specialArgs[index] ?? arg)
    const line = lineAt(lineStarts, match.index)
    const push = (form) => {
      const violation = { file, line, form }
      signatures.set(violation, callSignature(name, signatureArgs))
      violations.push(violation)
    }
    if (name === 'test' || name === 'it') {
      if (args.length < 3) {
        continue
      }
      if (specialArgs[2] !== null) {
        push(FORMS.NUMERIC_SPECIAL)
      } else if (isNumericTimeout(args[2])) {
        push(FORMS.TEST_NUMERIC_THIRD)
      } else if (objectHasTimeout(args[2])) {
        push(FORMS.TEST_OBJECT_THIRD)
      }
      continue
    }
    if (args.length < 2) {
      continue
    }
    if (specialArgs[1] !== null) {
      push(FORMS.NUMERIC_SPECIAL)
    } else if (isNumericTimeout(args[1])) {
      push(FORMS.HOOK_NUMERIC_SECOND)
    } else if (args.length >= 3 && specialArgs[2] !== null) {
      push(FORMS.NUMERIC_SPECIAL)
    } else if (args.length >= 3 && isNumericTimeout(args[2])) {
      // Node 24 reads hook options from arg 2, so a numeric third arg is dropped.
      push(FORMS.HOOK_NUMERIC_THIRD)
    }
  }
  return { violations, signatures }
}

export function scanSource(source, options = {}) {
  return scanSourceInternal(source, options).violations
}

// U306: equivalent spellings (`5_000`, `5e3`, `0x1388`, `(5000)`, `-(5000)`) share
// one key, so a pure formatting change never reports a new violation. BigInt maps to
// the same key as an equal Number: Node ignores `5000n` exactly like `5000`, so the
// spelling change is the same violation, not a new call site.
function normalizeNumericArg(arg) {
  const { negative, body } = peelNumericLiteral(arg)
  if (NUMERIC_LITERAL.test(body)) {
    return canonicalNumericLiteral(body, negative)
  }
  const special = canonicalSpecialKey(arg)
  if (special !== null) {
    return special
  }
  // Expressions stay textual: fold redundant outer parens and canonicalize each
  // numeric token; never evaluate the expression (a scanner must not execute input,
  // and evaluating arbitrary constant expressions is more machinery than warranted).
  return stripExpressionParens(arg).replace(NUMERIC_TOKEN, (token) => {
    const peeled = peelNumericLiteral(token)
    return canonicalNumericLiteral(peeled.body, peeled.negative)
  })
}

// U300: key on callee + non-callback args (the callback body is not the violation), so
// re-wraps and unrelated body edits keep the key. Args are already comment/string-blanked.
export function callSignature(name, args) {
  const callbackIndex = name === 'test' || name === 'it' ? 1 : 0
  const kept = args.filter((_, index) => index !== callbackIndex)
  return `${name}(${kept.map((arg) => normalizeNumericArg(arg).replace(/\s+/g, '')).join(',')})`
}

function compareViolations(a, b) {
  return a.file.localeCompare(b.file) || a.line - b.line || a.form.localeCompare(b.form)
}

export function scanSources(sources) {
  const contexts = new Map()
  const violations = []
  for (const { file, source } of sources) {
    // U305 ③: duplicate files would replace the per-file signature map under the
    // first scan's violation objects; scan each file once.
    if (contexts.has(file)) {
      continue
    }
    const result = scanSourceInternal(source, { file })
    contexts.set(file, result)
    violations.push(...result.violations)
  }
  violations.sort(compareViolations)
  return { violations, contexts, scannedFiles: contexts.size }
}

export function scanTestTimeouts({ files, root = ROOT }) {
  const sources = files.map((file) => ({
    file: displayPath(file, root),
    source: readFileSync(file, 'utf8')
  }))
  const { violations, contexts, scannedFiles } = scanSources(sources)
  return { files, violations, contexts, scannedFiles }
}
