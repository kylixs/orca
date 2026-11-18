#!/usr/bin/env node
// CLI entry: scanning lives in check-test-timeouts-scan.mjs, baseline I/O in
// check-test-timeouts-baseline.mjs. Public exports are kept for compatibility.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkTestTimeouts, DEFAULT_BASELINE } from './check-test-timeouts-baseline.mjs'
import { collectScopeFiles } from './check-test-timeouts-scan.mjs'

export {
  FORMS,
  SCAN_SCOPE,
  collectScopeFiles,
  scanSource,
  scanTestTimeouts
} from './check-test-timeouts-scan.mjs'
export {
  headScopeFiles,
  scanHeadSources,
  checkTestTimeouts
} from './check-test-timeouts-baseline.mjs'

export function parseArgs(argv) {
  const options = { baselinePath: DEFAULT_BASELINE, updateBaseline: false, fromHead: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--update-baseline') {
      options.updateBaseline = true
    } else if (arg === '--from-head') {
      options.fromHead = true
    } else if (arg === '--check') {
      options.checkOnly = true
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
  const files = options.fromHead && !options.checkOnly ? [] : collectScopeFiles()
  if (!options.fromHead && files.length === 0) {
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
    const origin = options.fromHead ? ' from HEAD' : ''
    console.log(
      `test timeout baseline written${origin}: ${result.baselineCount} violation(s) in ${result.scannedFiles} file(s) -> ${result.baselinePath}`
    )
    return 0
  }
  for (const violation of result.newViolations) {
    console.error(`${violation.file}:${violation.line} ${violation.form}`)
  }
  if (result.baselineWritten === false && result.staleKeys.length > 0) {
    console.log(
      `test timeout baseline note: ${result.staleKeys.length} baseline key(s) currently below their count`
    )
    for (const stale of result.staleKeys) {
      console.log(`  ${stale.key} (baseline ${stale.baselineCount}, current ${stale.currentCount})`)
    }
  }
  const origin = options.fromHead ? ' in HEAD' : ''
  if (result.exitCode === 1) {
    console.error(
      `test timeout check failed${origin}: ${result.newViolations.length} new violation(s) (${result.baselineCount} baselined)`
    )
    return 1
  }
  console.log(
    `test timeout check ok${origin}: 0 new violation(s) (${result.baselineCount} baselined, ${result.scannedFiles} file(s) scanned)`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
