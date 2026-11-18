// U315: scan scope policy. A file is a test file when it actually runs under
// node:test, not because it happens to live in a hardcoded directory:
//   1. it imports/requires node:test, or
//   2. a package.json script that invokes `node --test` references it by path/glob.
// Excluded trees are data (see SCAN_EXCLUSIONS) so callers can replace the policy;
// each entry records why it is skipped. `src/main`, `mobile`, `tests` and
// `config/scripts` are vitest, where a numeric third argument is a legal timeout.
import { existsSync, globSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

export const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.js'
])

// Matches the import forms the audit counted (default/named/namespace import and
// CommonJS require); `node:test` only. Dynamic import is not used by node:test files.
// U317 ⑤: one authored pattern feeds both scopes. POSIX ERE (`git grep -E`) spells
// whitespace `[[:space:]]`, while JS RegExp spells it `\s`; deriving both from the
// same text keeps worktree and HEAD enumeration from drifting apart.
export const NODE_TEST_IMPORT_SOURCE = String.raw`(from[[:space:]]*['"]node:test['"]|require[[:space:]]*\([[:space:]]*['"]node:test['"][[:space:]]*\))`
export const NODE_TEST_IMPORT_GREP = NODE_TEST_IMPORT_SOURCE
export const NODE_TEST_IMPORT = new RegExp(
  NODE_TEST_IMPORT_SOURCE.replaceAll('[[:space:]]', String.raw`\s`)
)

export const SCAN_SCOPE = [
  '**/*.{ts,tsx,mts,cts,mjs,cjs,js} importing node:test',
  'files referenced by package.json scripts that invoke `node --test`'
]

// Directory prefixes (repo-relative, POSIX separators) that are never scanned.
// `node_modules`/`.git` match at any depth; every other entry is a prefix.
export const SCAN_EXCLUSIONS = [
  {
    dir: 'evidence',
    reason: 'archived run artifacts/copies at the repo root; no runner executes them (U315)'
  },
  {
    dir: 'cloud-platform/evidence',
    reason: 'gitignored archived probe copies; not executed by any runner (U315)'
  },
  { dir: 'src/main', reason: 'vitest: numeric third arg/hook timeout are legal APIs (audit §5)' },
  { dir: 'mobile', reason: 'mobile vitest workspace' },
  { dir: 'tests', reason: 'root vitest/playwright e2e, not node:test' },
  { dir: 'config/scripts', reason: 'vitest scripts; numeric third arg is legal there' },
  { dir: 'out', reason: 'build output' },
  { dir: 'dist', reason: 'build output' },
  { dir: 'coverage', reason: 'coverage output' },
  { dir: 'test-results', reason: 'test run artifacts' },
  { dir: 'test-reports', reason: 'generated reports' },
  { dir: 'node_modules', reason: 'third-party dependencies' },
  { dir: '.git', reason: 'version-control metadata' }
]

const ANY_DEPTH_SEGMENTS = new Set(['node_modules', '.git'])

const toPosix = (value) => value.split(path.sep).join('/')

export function isExcluded(relativePath, exclusions = SCAN_EXCLUSIONS) {
  const rel = toPosix(relativePath)
  const segments = rel.split('/')
  return exclusions.some(({ dir }) => {
    if (ANY_DEPTH_SEGMENTS.has(dir)) {
      return segments.includes(dir)
    }
    return rel === dir || rel.startsWith(`${dir}/`)
  })
}

function walk(root, exclusions, visitFile, acceptName) {
  const descend = (absoluteDir, relativeDir) => {
    let entries
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      const absolute = path.join(absoluteDir, entry.name)
      if (entry.isDirectory()) {
        if (!isExcluded(relative, exclusions)) {
          descend(absolute, relative)
        }
      } else if (acceptName(entry.name)) {
        visitFile(absolute, relative)
      }
    }
  }
  descend(root, '')
}

const RUNNER_PATTERN = /(?:^|[\s;&|])node\s+--test(?:-only)?(?:\s|$)/
const SHELL_SEPARATORS = new Set(['&&', '||', ';', '|', '&'])

function runnerArguments(script) {
  const match = RUNNER_PATTERN.exec(script)
  if (match === null) {
    return []
  }
  const tail = script.slice(match.index + match[0].length)
  const tokens = []
  for (const raw of tail.split(/\s+/)) {
    if (raw.length === 0) {
      continue
    }
    const token = raw.replace(/^['"]|['"]$/g, '')
    if (SHELL_SEPARATORS.has(token)) {
      break
    }
    if (!token.startsWith('-')) {
      tokens.push(token)
    }
  }
  return tokens
}

// U317 ③: manifest parsing is shared with the HEAD enumeration so both scopes agree
// on which scripts invoke `node --test` and where their arguments end.
export function runnerTokens(manifest) {
  const tokens = []
  for (const script of Object.values(manifest?.scripts ?? {})) {
    if (typeof script === 'string') {
      tokens.push(...runnerArguments(script))
    }
  }
  return tokens
}

// Resolve a runner token against committed paths only. Explicit targets must be
// committed; glob tokens match the committed file list (Node's glob semantics).
export function committedRunnerTargets(directory, token, files) {
  const resolved = toPosix(path.posix.normalize(path.posix.join(directory, token)))
  if (!/[*?[]/.test(token)) {
    return files.includes(resolved) ? [resolved] : []
  }
  return files.filter((file) => path.matchesGlob(file, resolved))
}

export function discoverRunnerReferences({ root = ROOT, exclusions = SCAN_EXCLUSIONS } = {}) {
  const references = new Set()
  walk(
    root,
    exclusions,
    (absolute) => {
      let manifest
      try {
        manifest = JSON.parse(readFileSync(absolute, 'utf8'))
      } catch {
        return
      }
      const directory = path.dirname(absolute)
      for (const token of runnerTokens(manifest)) {
        const resolved = path.resolve(directory, token)
        const relative = toPosix(path.relative(root, resolved))
        if (isExcluded(relative, exclusions)) {
          continue
        }
        const hasGlob = /[*?[]/.test(token)
        const matches = hasGlob ? globSync(resolved) : existsSync(resolved) ? [resolved] : []
        for (const candidate of matches) {
          if (!SOURCE_EXTENSIONS.has(path.extname(candidate))) {
            continue
          }
          try {
            if (statSync(candidate).isFile()) {
              references.add(candidate)
            }
          } catch {
            // Missing or unreadable runner target: ignore rather than crash the gate.
          }
        }
      }
    },
    (name) => name === 'package.json'
  )
  return references
}

// Worktree scope. Reading is limited to candidate source files; runner references
// are added even when the file itself has no node:test import.
export function collectScopeFiles({ root = ROOT, exclusions = SCAN_EXCLUSIONS } = {}) {
  const files = new Set()
  walk(
    root,
    exclusions,
    (absolute) => {
      let source
      try {
        source = readFileSync(absolute, 'utf8')
      } catch {
        return
      }
      if (NODE_TEST_IMPORT.test(source)) {
        files.add(absolute)
      }
    },
    (name) => SOURCE_EXTENSIONS.has(path.extname(name))
  )
  for (const reference of discoverRunnerReferences({ root, exclusions })) {
    files.add(reference)
  }
  return [...files].sort()
}
