// Static scan: node:test ignores numeric timeout positions (Node 24).
// Numeric third arg (test/it and hooks) and numeric second arg (hooks) are silently
// dropped, as is an object third arg on test/it. See ledger
// U287/U290/U291/U295/U297/U303/U305/U306/U308/U309.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const PLATFORM_ROOT = path.join(ROOT, 'cloud-platform')

export const SCAN_SCOPE = [
  'cloud-platform/apps/**/test/**/*.ts',
  'cloud-platform/test/**/*.ts',
  'cloud-platform/apps/*/src/**/*.test.ts'
]

export const FORMS = {
  TEST_NUMERIC_THIRD: 'test-numeric-third',
  TEST_OBJECT_THIRD: 'test-object-third',
  HOOK_NUMERIC_SECOND: 'hook-numeric-second',
  HOOK_NUMERIC_THIRD: 'hook-numeric-third',
  NUMERIC_SPECIAL: 'numeric-special'
}

const CALL_PATTERN = /(?<![\w$.])(beforeEach|afterEach|before|after|test|it)\s*\(/g

// Numeric literal forms Node/TS accepts: decimal (fraction/exponent, `_` separators),
// hex/octal/binary, and BigInt (`n`). Signs and outer parens are peeled separately. [U306]
const DECIMAL_DIGITS = String.raw`\d(?:_?\d)*`
const DECIMAL_LITERAL = String.raw`(?:${DECIMAL_DIGITS}(?:\.(?:${DECIMAL_DIGITS})?)?|\.${DECIMAL_DIGITS})(?:[eE][+-]?${DECIMAL_DIGITS})?`
const HEX_LITERAL = String.raw`0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*`
const OCTAL_LITERAL = String.raw`0[oO][0-7](?:_?[0-7])*`
const BINARY_LITERAL = String.raw`0[bB][01](?:_?[01])*`
const RADIX_LITERAL = `(?:${HEX_LITERAL}|${OCTAL_LITERAL}|${BINARY_LITERAL})`
// BigInt precedes radix/decimal so `5000n` and `0x1388n` keep their `n` suffix.
const BIGINT_LITERAL = `(?:${DECIMAL_DIGITS}|${RADIX_LITERAL})n`
const NUMERIC_TOKEN_SOURCE = `(?:${BIGINT_LITERAL}|${RADIX_LITERAL}|${DECIMAL_LITERAL})`
const NUMERIC_LITERAL = new RegExp(`^${NUMERIC_TOKEN_SOURCE}$`)
const NUMERIC_TOKEN = new RegExp(`(?<![\\w$.])${NUMERIC_TOKEN_SOURCE}`, 'g')
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'delete',
  'void',
  'new',
  'throw',
  'yield',
  'await',
  'do',
  'else'
])

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function displayPath(file, root = ROOT) {
  const relative = path.relative(root, file)
  return toPosix(relative.startsWith('..') ? file : relative)
}

const blank = (char) => char !== '\n' && char !== '\r'

// A keyword preceded (ignoring spaces) by `.`/`?.` is a property name. [U311]
function isPropertyName(text, start) {
  let cursor = start - 1
  while (cursor >= 0 && /\s/.test(text[cursor])) {
    cursor -= 1
  }
  return text[cursor] === '.'
}

// `/` opens a regex when the previous token cannot end an expression (else division).
function isRegexStart(out, index) {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(out[cursor])) {
    cursor -= 1
  }
  if (cursor < 0) {
    return true
  }
  const char = out[cursor]
  if (char === ')' || char === ']' || char === '"' || char === "'" || char === '`') {
    return false
  }
  if (/[\w$]/.test(char)) {
    let start = cursor
    while (start > 0 && /[\w$]/.test(out[start - 1])) {
      start -= 1
    }
    // A dotted name is a property, never a keyword (`obj.in / 2` is division). [U303]
    if (isPropertyName(out, start)) {
      return false
    }
    return REGEX_KEYWORDS.has(out.slice(start, cursor + 1).join(''))
  }
  return true
}

// Index of the closing `/` (same line), or -1 when this is not a regex literal.
// Known limitation (U303): `v`-flag nested classes (`/[[a]/]/v`) are unsupported; the
// inner `]` closes the class early, and sanitize() shares this single-level rule.
function regexEnd(source, start) {
  let inClass = false
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\n' || char === '\r') {
      return -1
    }
    if (char === '\\') {
      index += 1
    } else if (char === '[') {
      inClass = true
    } else if (char === ']') {
      inClass = false
    } else if (char === '/' && !inClass) {
      return index
    }
  }
  return -1
}

// Blank comments, string/regex/template bodies so their brackets cannot break pairing.
function sanitize(source) {
  const out = source.split('')
  const stack = [{ type: 'code', depth: 0, templateExpr: false }]
  const top = () => stack.at(-1)
  let index = 0
  while (index < source.length) {
    const frame = top()
    const char = source[index]
    const next = source[index + 1]
    if (frame.type === 'line-comment') {
      if (char === '\n') {
        stack.pop()
      } else if (blank(char)) {
        out[index] = ' '
      }
      index += 1
    } else if (frame.type === 'block-comment') {
      if (char === '*' && next === '/') {
        out[index] = ' '
        out[index + 1] = ' '
        stack.pop()
        index += 2
      } else {
        if (blank(char)) {
          out[index] = ' '
        }
        index += 1
      }
    } else if (frame.type === 'string' || frame.type === 'regex' || frame.type === 'template') {
      const closes =
        (frame.type === 'string' && char === frame.quote) ||
        (frame.type === 'regex' && char === '/' && !frame.inClass) ||
        (frame.type === 'template' && char === '`')
      if (char === '\\') {
        if (blank(char)) {
          out[index] = ' '
        }
        if (next !== undefined && blank(next)) {
          out[index + 1] = ' '
        }
        index += 2
      } else if (frame.type === 'regex' && (char === '[' || (char === ']' && frame.inClass))) {
        frame.inClass = char === '['
        out[index] = ' '
        index += 1
      } else if (closes) {
        stack.pop()
        index += 1
      } else if (frame.type === 'template' && char === '$' && next === '{') {
        out[index] = ' '
        out[index + 1] = ' '
        stack.push({ type: 'code', depth: 1, templateExpr: true })
        index += 2
      } else {
        if (blank(char)) {
          out[index] = ' '
        }
        index += 1
      }
    } else if (char === '/' && next === '/') {
      out[index] = ' '
      out[index + 1] = ' '
      stack.push({ type: 'line-comment' })
      index += 2
    } else if (char === '/' && next === '*') {
      out[index] = ' '
      out[index + 1] = ' '
      stack.push({ type: 'block-comment' })
      index += 2
    } else if (char === '/' && isRegexStart(out, index) && regexEnd(source, index) !== -1) {
      out[index] = ' '
      stack.push({ type: 'regex', inClass: false })
      index += 1
    } else if (char === "'" || char === '"') {
      out[index] = ' '
      stack.push({ type: 'string', quote: char })
      index += 1
    } else if (char === '`') {
      out[index] = ' '
      stack.push({ type: 'template' })
      index += 1
    } else if (char === '{') {
      frame.depth += 1
      index += 1
    } else if (char === '}') {
      if (frame.templateExpr && frame.depth === 1) {
        out[index] = ' '
        stack.pop()
      } else {
        frame.depth -= 1
      }
      index += 1
    } else {
      index += 1
    }
  }
  return out.join('')
}

function findCloseParen(text, openIndex) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) {
        return char === ')' ? index : -1
      }
    }
  }
  return -1
}

// Only type-argument angle brackets matter here (`Promise<Map<string, number>>`).
function isAngleOpen(text, index) {
  const previous = text[index - 1]
  return previous !== undefined && /[\w$>\]]/.test(previous)
}

// Ranges let callers recover raw text for positions that sanitize blanks (strings). [U311]
function splitTopLevel(text, start, end) {
  const parts = []
  let depth = 0
  let angle = 0
  let partStart = start
  for (let index = start; index < end; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
    } else if (char === '<' && isAngleOpen(text, index)) {
      angle += 1
    } else if (char === '>' && angle > 0) {
      angle -= 1
    } else if (char === ',' && depth === 0 && angle === 0) {
      parts.push({ start: partStart, end: index })
      partStart = index + 1
    }
  }
  const last = text.slice(partStart, end).trim()
  if (last.length > 0 || parts.length > 0) {
    parts.push({ start: partStart, end })
  }
  return parts
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

function stripOuterParens(arg) {
  let text = arg.trim()
  while (text.startsWith('(') && text.endsWith(')')) {
    const close = findCloseParen(text, 0)
    if (close !== text.length - 1) {
      break
    }
    text = text.slice(1, -1).trim()
  }
  return text
}

// Top-level operator or comma outside nested brackets. A leading unary sign does not
// count, so `-a` stays one operand while `-a + b` does not. [U309]
const WORD_OPERATORS = new Set(['in', 'instanceof'])
const SYMBOL_OPERATORS = new Set(['*', '/', '%', '?', '|', '&', '^', '=', '<', '>'])

// Conservative generic call: `f<T>()` / `f<T, U>()` only — identifier before `<`,
// simple identifier type arguments, then `(`. Richer type syntax stays an operator:
// an extra key split is safe, while folding a real operator comparison is not. [U311]
function genericCallEnd(text, index) {
  if (!/[\w$>\]]/.test(text[index - 1] ?? '')) {
    return -1
  }
  const match = /^<\s*[\w$]+(?:\s*,\s*[\w$]+)*\s*>\s*\(/.exec(text.slice(index))
  return match ? index + match[0].indexOf('>') : -1
}

function hasTopLevelOperator(text) {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') {
      depth += 1
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
    } else if (depth === 0) {
      if (char === ',') {
        return true
      }
      if (char === '+' || char === '-') {
        if (index > 0) {
          return true
        }
        continue
      }
      if (char === '!') {
        // `!a` is unary; only `!=`/`!==` are binary.
        if (text[index + 1] === '=') {
          return true
        }
        continue
      }
      // `?.` / `?.[` / `?.(` are member access, not the conditional operator.
      if (char === '?' && text[index + 1] === '.') {
        continue
      }
      if (char === '<') {
        const genericEnd = genericCallEnd(text, index)
        if (genericEnd !== -1) {
          index = genericEnd
          continue
        }
      }
      if (SYMBOL_OPERATORS.has(char)) {
        return true
      }
      if (/[A-Za-z_$]/.test(char)) {
        let end = index + 1
        while (end < text.length && /[\w$]/.test(text[end])) {
          end += 1
        }
        // A dotted name is a property (`obj. in`), never the `in` operator. [U311]
        if (!isPropertyName(text, index) && WORD_OPERATORS.has(text.slice(index, end))) {
          return true
        }
        index = end - 1
      }
    }
  }
  return false
}

// Strips outer parens only when the content is not a top-level sequence (`(a, b)`),
// so `before(fn, (a, b))` never collapses into `before(fn, a, b)`. Folds redundant
// parens across unary signs too, so `-((EXPR))` and `-(EXPR)` share a key. [U308]
function stripExpressionParens(arg) {
  let text = arg.trim()
  let negative = false
  let peeled = false
  for (;;) {
    const stripped = stripOuterParens(text)
    if (stripped !== text) {
      if (splitTopLevel(stripped, 0, stripped.length).length > 1) {
        return text
      }
      text = stripped
      continue
    }
    if (text[0] !== '+' && text[0] !== '-') {
      return peeled ? composeSignedExpression(text, negative) : text
    }
    const rest = text.slice(1).trim()
    // `--a`/`++a` are decrement/increment, not a foldable unary chain.
    if (rest.length === 0 || rest[0] === text[0]) {
      return peeled ? composeSignedExpression(text, negative) : text
    }
    const inner = stripOuterParens(rest)
    if (inner !== rest) {
      // Never peel a sign off a parenthesized sequence: `-((a, b))` keeps its shape.
      if (splitTopLevel(inner, 0, inner.length).length > 1) {
        return peeled ? composeSignedExpression(text, negative) : text
      }
    } else if (hasTopLevelOperator(rest)) {
      // `-a + b` binds to `a`, not to `a + b`.
      return peeled ? composeSignedExpression(text, negative) : text
    }
    if (text[0] === '-') {
      negative = !negative
    }
    peeled = true
    text = inner
  }
}

function composeSignedExpression(operand, negative) {
  const needsParens =
    operand.startsWith('+') || operand.startsWith('-') || hasTopLevelOperator(operand)
  return `${negative ? '-' : ''}${needsParens ? `(${operand})` : operand}`
}

// `-((+5000))` -> { negative: true, body: '5000' }.
function peelNumericLiteral(arg) {
  let text = arg.trim()
  let negative = false
  for (;;) {
    const stripped = stripOuterParens(text)
    if (stripped !== text) {
      text = stripped
    } else if (text.startsWith('+') || text.startsWith('-')) {
      if (text[0] === '-') {
        negative = !negative
      }
      text = text.slice(1).trim()
    } else {
      return { negative, body: text }
    }
  }
}

// Number first: every literal form is compared by its runtime Number value. Safe
// integers use plain decimal; larger integral values use BigInt to render the exact
// double in plain decimal (never `1e+21`), so `1e21`, its full decimal spelling and
// `0x3635C9ADC5DEA00000` share one key. BigInt literals drop the `n` on purpose and
// share the key of an equal Number (Node ignores both alike). [U308]
function canonicalNumericLiteral(body, negative) {
  const bigint = body.endsWith('n')
  const digits = (bigint ? body.slice(0, -1) : body).replace(/_/g, '')
  try {
    const value = negative ? -Number(digits) : Number(digits)
    if (!Number.isFinite(value)) {
      throw new Error('non-finite')
    }
    if (Number.isSafeInteger(value) || !Number.isInteger(value)) {
      return String(value)
    }
    return BigInt(value).toString()
  } catch {
    // Unparseable (e.g. `1e999` -> Infinity): keep the text with a marker so it
    // cannot collide with a parsed canonical value. [U306]
    return `raw:${negative ? '-' : ''}${digits}`
  }
}

// U311 ②: equivalent non-finite spellings share one canonical key, mirroring the U306
// invariant that a pure spelling refactor never reports a new violation.
const SPECIAL_OBJECT = String.raw`(?:Number|globalThis|global)`
const SPECIAL_MEMBERS = new Map([
  ['Infinity', 'special:infinity'],
  ['POSITIVE_INFINITY', 'special:infinity'],
  ['NEGATIVE_INFINITY', 'special:-infinity'],
  ['NaN', 'special:nan']
])
const SPECIAL_ACCESS = new RegExp(
  String.raw`^(?:(?:${SPECIAL_OBJECT}\s*\.|\(\s*${SPECIAL_OBJECT}\s*\)\s*\.)\s*)?(Infinity|NaN|POSITIVE_INFINITY|NEGATIVE_INFINITY)$`
)
const SPECIAL_BRACKET = new RegExp(
  String.raw`^(?:${SPECIAL_OBJECT}\s*|\(\s*${SPECIAL_OBJECT}\s*\)\s*)\[\s*(['"])(Infinity|NaN|POSITIVE_INFINITY|NEGATIVE_INFINITY)\1\s*\]$`
)
// `as`/`satisfies` only annotate the type; the runtime value is unchanged. [U309/U311]
const TS_TYPE_CLAUSE = /\s+(?:as|satisfies)\s+\S[\s\S]*$/

const applySpecialSign = (key, negative) =>
  key === null || !negative || key === 'special:nan' ? key : flipSpecialSign(key)

function flipSpecialSign(key) {
  return key === 'special:infinity' ? 'special:-infinity' : 'special:infinity'
}

function canonicalSpecialBody(body) {
  const text = body.trim().replace(TS_TYPE_CLAUSE, '').trim()
  const member = SPECIAL_ACCESS.exec(text) ?? SPECIAL_BRACKET.exec(text)
  return member ? SPECIAL_MEMBERS.get(member.at(-1)) : null
}

function canonicalSpecialKey(arg) {
  const { negative, body } = peelNumericLiteral(arg)
  return applySpecialSign(canonicalSpecialBody(body), negative)
}

// Raw text keeps bracketed string properties visible; the clean fallback covers a
// comment inside the clause, which raw text would not parse. [U311]
function pickSpecialArg(cleanArg, rawArg) {
  const rawKey = canonicalSpecialKey(rawArg)
  return rawKey !== null ? rawArg : canonicalSpecialKey(cleanArg) !== null ? cleanArg : null
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
  const lineStarts = lineStartsOf(source)
  const violations = []
  const signatures = new Map()
  CALL_PATTERN.lastIndex = 0
  let match
  while ((match = CALL_PATTERN.exec(clean)) !== null) {
    const name = match[1]
    const openIndex = match.index + match[0].length - 1
    const closeIndex = findCloseParen(clean, openIndex)
    if (closeIndex === -1) {
      continue
    }
    const parts = splitTopLevel(clean, openIndex + 1, closeIndex)
    const args = parts.map((part) => clean.slice(part.start, part.end).trim())
    const rawArgs = parts.map((part) => source.slice(part.start, part.end).trim())
    // sanitize blanks string bodies, so recover raw text to see `Number["X"]`. [U311]
    const specialArgs = parts.map((_, index) => pickSpecialArg(args[index], rawArgs[index]))
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
  const special = canonicalSpecialBody(body)
  if (special !== null) {
    return applySpecialSign(special, negative)
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

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function walk(dir, predicate, output) {
  if (!existsSync(dir)) {
    return
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walk(full, predicate, output)
      }
    } else if (predicate(entry.name)) {
      output.add(full)
    }
  }
}

export function collectScopeFiles() {
  const files = new Set()
  const appRoot = path.join(PLATFORM_ROOT, 'apps')
  const apps = existsSync(appRoot)
    ? readdirSync(appRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []
  for (const app of apps) {
    walk(path.join(appRoot, app, 'test'), (name) => name.endsWith('.ts'), files)
    walk(path.join(appRoot, app, 'src'), (name) => name.endsWith('.test.ts'), files)
  }
  walk(path.join(PLATFORM_ROOT, 'test'), (name) => name.endsWith('.ts'), files)
  return [...files].sort()
}
