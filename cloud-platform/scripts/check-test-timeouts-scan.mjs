// Static scan: node:test ignores numeric timeout positions (Node 24).
// Numeric third arg (test/it and hooks) and numeric second arg (hooks) are silently
// dropped, as is an object third arg on test/it. See ledger U287/U290/U291/U295/U297/U303/U305.
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
  HOOK_NUMERIC_THIRD: 'hook-numeric-third'
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
    if (out[start - 1] === '.') {
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
      parts.push(text.slice(partStart, index).trim())
      partStart = index + 1
    }
  }
  const last = text.slice(partStart, end).trim()
  if (last.length > 0 || parts.length > 0) {
    parts.push(last)
  }
  return parts
}

function objectHasTimeout(arg) {
  const text = arg.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return false
  }
  const entries = splitTopLevel(text, 1, text.length - 1)
  return entries.some((entry) => /^(?:timeout|['"]timeout['"])\s*:/.test(entry.trim()))
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

// Strips outer parens only when the content is not a top-level sequence (`(a, b)`),
// so `before(fn, (a, b))` never collapses into `before(fn, a, b)`.
function stripExpressionParens(arg) {
  let text = arg.trim()
  for (;;) {
    const stripped = stripOuterParens(text)
    if (stripped === text || splitTopLevel(stripped, 0, stripped.length).length > 1) {
      return text
    }
    text = stripped
  }
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

// Exact for integer/radix/BigInt literals; fractions and exponents use Number.
// BigInt drops the `n` on purpose (see normalizeNumericArg).
function canonicalNumericLiteral(body, negative) {
  const bigint = body.endsWith('n')
  const digits = (bigint ? body.slice(0, -1) : body).replace(/_/g, '')
  const isRadix = /^0[xXoObB]/.test(digits)
  try {
    if (bigint || isRadix || !/[.eE]/.test(digits)) {
      const value = BigInt(digits)
      return String(negative && value !== 0n ? -value : value)
    }
    const value = Number(digits)
    if (!Number.isFinite(value)) {
      throw new Error('non-finite')
    }
    return String(negative ? -value : value)
  } catch {
    // Unparseable (e.g. `1e999` -> Infinity): keep the text with a marker so it
    // cannot collide with a parsed canonical value. [U306]
    return `raw:${negative ? '-' : ''}${digits}`
  }
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
    const args = splitTopLevel(clean, openIndex + 1, closeIndex)
    const line = lineAt(lineStarts, match.index)
    const push = (form) => {
      const violation = { file, line, form }
      signatures.set(violation, callSignature(name, args))
      violations.push(violation)
    }
    if (name === 'test' || name === 'it') {
      if (args.length < 3) {
        continue
      }
      const third = args[2]
      if (isNumericTimeout(third)) {
        push(FORMS.TEST_NUMERIC_THIRD)
      } else if (objectHasTimeout(third)) {
        push(FORMS.TEST_OBJECT_THIRD)
      }
      continue
    }
    if (args.length < 2) {
      continue
    }
    if (isNumericTimeout(args[1])) {
      push(FORMS.HOOK_NUMERIC_SECOND)
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
