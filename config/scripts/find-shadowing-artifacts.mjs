#!/usr/bin/env node
// Finds untracked or gitignored .js/.jsx artifacts that shadow a same-stem .ts/.tsx
// source. Vite resolves .js before .ts, so a stale tsc emit silently replaces the source.
// Usage: node config/scripts/find-shadowing-artifacts.mjs [repoRoot]
// Output: one "artifact <- source" per line (sorted). Exit 0 = clean, 1 = shadows found.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] ?? process.cwd())
const SKIP = /(^|\/)(node_modules|\.git|out|dist|build|coverage|evidence)(\/|$)/

function gitLsFiles(args) {
  return execFileSync('git', ['-C', root, 'ls-files', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter(Boolean)
}

const candidates = [
  ...gitLsFiles(['--others', '--exclude-standard']),
  ...gitLsFiles(['--others', '--ignored', '--exclude-standard'])
].filter((file) => /\.(js|jsx)$/.test(file) && !SKIP.test(file))

const pairs = []
for (const artifact of new Set(candidates)) {
  const stem = artifact.replace(/\.(js|jsx)$/, '')
  for (const ext of ['.ts', '.tsx']) {
    const source = `${stem}${ext}`
    if (existsSync(path.join(root, source))) {
      pairs.push({ artifact, source })
      break
    }
  }
}

pairs.sort((a, b) => a.artifact.localeCompare(b.artifact))
for (const { artifact, source } of pairs) console.log(`${artifact} <- ${source}`)
console.log(`find-shadowing-artifacts: ${pairs.length} shadowing artifact(s)`)
process.exitCode = pairs.length > 0 ? 1 : 0
