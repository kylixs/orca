// Lexical helpers for the timeout scanner: numeric token shapes, comment/string
// sanitizing, regex detection and bracket pairing. Split out of
// check-test-timeouts-scan.mjs so both stay under the max-lines budget (U313 ⑥).

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
export const NUMERIC_LITERAL = new RegExp(`^${NUMERIC_TOKEN_SOURCE}$`)
export const NUMERIC_TOKEN = new RegExp(`(?<![\\w$.])${NUMERIC_TOKEN_SOURCE}`, 'g')
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
// `preserveLiterals` keeps string/regex/template bodies (including delimiters) intact
// while still blanking comments; callers use that view to match `Number["X"]` after
// comments are stripped. Offsets are identical in both views.
export function sanitize(source, { preserveLiterals = false } = {}) {
  const out = source.split('')
  const stack = [{ type: 'code', depth: 0, templateExpr: false }]
  const top = () => stack.at(-1)
  const mask = (index) => {
    if (index < source.length && !preserveLiterals && blank(source[index])) {
      out[index] = ' '
    }
  }
  const maskAlways = (index) => {
    if (index < source.length && blank(source[index])) {
      out[index] = ' '
    }
  }
  let index = 0
  while (index < source.length) {
    const frame = top()
    const char = source[index]
    const next = source[index + 1]
    if (frame.type === 'line-comment') {
      if (char === '\n') {
        stack.pop()
      } else {
        maskAlways(index)
      }
      index += 1
    } else if (frame.type === 'block-comment') {
      if (char === '*' && next === '/') {
        out[index] = ' '
        out[index + 1] = ' '
        stack.pop()
        index += 2
      } else {
        maskAlways(index)
        index += 1
      }
    } else if (frame.type === 'string' || frame.type === 'regex' || frame.type === 'template') {
      const closes =
        (frame.type === 'string' && char === frame.quote) ||
        (frame.type === 'regex' && char === '/' && !frame.inClass) ||
        (frame.type === 'template' && char === '`')
      if (char === '\\') {
        mask(index)
        mask(index + 1)
        index += 2
      } else if (frame.type === 'regex' && (char === '[' || (char === ']' && frame.inClass))) {
        frame.inClass = char === '['
        mask(index)
        index += 1
      } else if (closes) {
        stack.pop()
        index += 1
      } else if (frame.type === 'template' && char === '$' && next === '{') {
        mask(index)
        mask(index + 1)
        stack.push({ type: 'code', depth: 1, templateExpr: true })
        index += 2
      } else {
        mask(index)
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
      mask(index)
      stack.push({ type: 'regex', inClass: false })
      index += 1
    } else if (char === "'" || char === '"') {
      mask(index)
      stack.push({ type: 'string', quote: char })
      index += 1
    } else if (char === '`') {
      mask(index)
      stack.push({ type: 'template' })
      index += 1
    } else if (char === '{') {
      frame.depth += 1
      index += 1
    } else if (char === '}') {
      if (frame.templateExpr && frame.depth === 1) {
        mask(index)
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

export function findCloseParen(text, openIndex) {
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
export function splitTopLevel(text, start, end) {
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

export function stripOuterParens(arg) {
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
export function stripExpressionParens(arg) {
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
export function peelNumericLiteral(arg) {
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
export function canonicalNumericLiteral(body, negative) {
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
