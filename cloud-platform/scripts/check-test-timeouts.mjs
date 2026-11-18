#!/usr/bin/env node
// Static gate: node:test ignores numeric timeout positions (Node 24).
// Numeric third arg (test/it) and numeric second arg (hooks) are silently dropped,
// as is an object third arg on test/it. See ledger U287/U290/U291.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PLATFORM_ROOT = path.join(ROOT, 'cloud-platform')
const DEFAULT_BASELINE = path.join(PLATFORM_ROOT, 'scripts', 'test-timeouts-baseline.json')

export const SCAN_SCOPE = [
  'cloud-platform/apps/**/test/**/*.ts',
  'cloud-platform/test/**/*.ts',
  'cloud-platform/apps/*/src/**/*.test.ts'
]

export const FORMS = {
  TEST_NUMERIC_THIRD: 'test-numeric-third',
  TEST_OBJECT_THIRD: 'test-object-third',
  HOOK_NUMERIC_SECOND: 'hook-numeric-second'
}

const CALL_PATTERN = /(?<![\w$.])(beforeEach|afterEach|before|after|test|it)\s*\(/g
const NUMERIC_LITERAL = /^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?$/

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function displayPath(file) {
  const relative = path.relative(ROOT, file)
  return toPosix(relative.startsWith('..') ? file : relative)
}

const blank = (char) => char !== '\n' && char !== '\r'

// Blank comments and string literal bodies so pseudo-code cannot match, keeping newlines intact.
function sanitize(source) {
  const out = source.split('')
  let state = 'normal'
  let quote = ''
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'normal'
      } else if (blank(char)) {
        out[index] = ' '
      }
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        out[index] = ' '
        out[index + 1] = ' '
        state = 'normal'
        index += 1
      } else if (blank(char)) {
        out[index] = ' '
      }
      continue
    }
    if (state === 'string') {
      if (char === '\\') {
        if (blank(char)) {
          out[index] = ' '
        }
        if (next !== undefined && blank(next)) {
          out[index + 1] = ' '
        }
        index += 1
      } else if (char === quote) {
        state = 'normal'
      } else if (blank(char)) {
        out[index] = ' '
      }
      continue
    }
    if (char === '/' && next === '/') {
      out[index] = ' '
      out[index + 1] = ' '
      state = 'line-comment'
      index += 1
    } else if (char === '/' && next === '*') {
      out[index] = ' '
      out[index + 1] = ' '
      state = 'block-comment'
      index += 1
    } else if (char === "'" || char === '"' || char === '`') {
      out[index] = ' '
      quote = char
      state = 'string'
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

function isNumericLiteral(arg) {
  return NUMERIC_LITERAL.test(stripOuterParens(arg))
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
  const withoutNumbers = text.replace(/\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/g, ' ')
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

export function scanSource(source, { file = '<memory>' } = {}) {
  const clean = sanitize(source)
  const lineStarts = lineStartsOf(source)
  const violations = []
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
    if (name === 'test' || name === 'it') {
      if (args.length < 3) {
        continue
      }
      const third = args[2]
      if (isNumericTimeout(third)) {
        violations.push({ file, line, form: FORMS.TEST_NUMERIC_THIRD })
      } else if (objectHasTimeout(third)) {
        violations.push({ file, line, form: FORMS.TEST_OBJECT_THIRD })
      }
      continue
    }
    if (args.length < 2) {
      continue
    }
    if (isNumericTimeout(args[1])) {
      violations.push({ file, line, form: FORMS.HOOK_NUMERIC_SECOND })
    }
  }
  return violations
}

export function scanTestTimeouts({ files }) {
  const violations = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    violations.push(...scanSource(source, { file: displayPath(file) }))
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { files, violations }
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

function violationKey(violation) {
  return `${violation.file}:${violation.line}`
}

function summarize(violations) {
  const byForm = {}
  for (const violation of violations) {
    byForm[violation.form] = (byForm[violation.form] ?? 0) + 1
  }
  return byForm
}

function readBaseline(baselinePath) {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const entries = Array.isArray(parsed) ? parsed : parsed.violations
  if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
    throw new Error(`${baselinePath}: baseline must contain a string "violations" array`)
  }
  return new Set(entries)
}

function writeBaseline(baselinePath, violations, scannedFiles) {
  const payload = {
    generatedAt: new Date().toISOString(),
    scanner: 'cloud-platform/scripts/check-test-timeouts.mjs',
    scanScope: SCAN_SCOPE,
    scannedFiles,
    counts: { total: violations.length, byForm: summarize(violations) },
    violations: [...new Set(violations.map(violationKey))].sort()
  }
  mkdirSync(path.dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

export function checkTestTimeouts({
  files,
  baselinePath = DEFAULT_BASELINE,
  updateBaseline = false
}) {
  const { violations } = scanTestTimeouts({ files })
  const created = !existsSync(baselinePath)
  if (created || updateBaseline) {
    const payload = writeBaseline(baselinePath, violations, files.length)
    return {
      exitCode: 0,
      violations,
      newViolations: [],
      baselinePath,
      baselineWritten: true,
      baselineCount: payload.counts.total,
      scannedFiles: files.length
    }
  }
  const baseline = readBaseline(baselinePath)
  const newViolations = violations.filter((violation) => !baseline.has(violationKey(violation)))
  return {
    exitCode: newViolations.length === 0 ? 0 : 1,
    violations,
    newViolations,
    baselinePath,
    baselineWritten: false,
    baselineCount: baseline.size,
    scannedFiles: files.length
  }
}

export function parseArgs(argv) {
  const options = { baselinePath: DEFAULT_BASELINE, updateBaseline: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--update-baseline') {
      options.updateBaseline = true
    } else if (arg === '--baseline') {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new Error('--baseline requires a path')
      }
      options.baselinePath = path.resolve(value)
      index += 1
    } else if (arg.startsWith('--baseline=')) {
      options.baselinePath = path.resolve(arg.slice('--baseline='.length))
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`test timeout check aborted: ${error.message}`)
    return 2
  }
  const files = collectScopeFiles()
  if (files.length === 0) {
    console.error('test timeout check aborted: no test files matched the scan scope')
    return 2
  }
  let result
  try {
    result = checkTestTimeouts({ files, ...options })
  } catch (error) {
    console.error(`test timeout check aborted: ${error.message}`)
    return 2
  }
  if (result.baselineWritten) {
    console.log(
      `test timeout baseline written: ${result.baselineCount} violation(s) in ${result.scannedFiles} file(s) -> ${result.baselinePath}`
    )
    return 0
  }
  for (const violation of result.newViolations) {
    console.error(`${violation.file}:${violation.line} ${violation.form}`)
  }
  if (result.exitCode === 1) {
    console.error(
      `test timeout check failed: ${result.newViolations.length} new violation(s) (${result.baselineCount} baselined)`
    )
    return 1
  }
  console.log(
    `test timeout check ok: 0 new violation(s) (${result.baselineCount} baselined, ${result.scannedFiles} file(s) scanned)`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
