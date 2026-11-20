/**
 * Standalone prototype comparison CLI. Same collection/diff body the resident
 * server exposes through `ui.compareWithPrototype()`; this mode launches its own
 * temporary headless Chromium and exits non-zero when the six §4.5 differences
 * are not all detected.
 */
import { chromium } from 'playwright'
import path from 'node:path'
import { collectComparison } from './prototype-collect.mjs'
import { DEFAULT_COMPARE_ROLES, defaultPrototypePath } from './prototype-inventory.mjs'
import { diffInventories, writeComparisonEvidence } from './prototype-diff.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      continue
    }
    const key = arg.slice(2)
    const value = argv[i + 1]?.startsWith('--') ? undefined : argv[i + 1]
    if (value !== undefined) {
      i += 1
    }
    args[key] = value ?? true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const baseUrl = args.base ?? process.env.ORCA_QA_BASE ?? 'https://127.0.0.1:18787'
const outDir =
  args['evidence-dir'] ??
  process.env.ORCA_PW_EVIDENCE_DIR ??
  'cloud-platform/evidence/ps3-prototype-diff'
const prototypeUrl = args.prototype ? path.resolve(args.prototype) : defaultPrototypePath()
const roles = args.roles
  ? String(args.roles)
      .split(',')
      .map((role) => {
        const name = role.trim()
        const match = DEFAULT_COMPARE_ROLES.find((entry) => entry.role === name)
        return match ?? { role: name, account: name }
      })
  : DEFAULT_COMPARE_ROLES

const browser = await chromium.launch({ headless: true })
try {
  const collection = await collectComparison({
    browser,
    baseUrl,
    prototypeUrl,
    evidenceDir: outDir,
    roles
  })
  const diff = diffInventories(collection)
  const files = writeComparisonEvidence(diff, outDir)
  const payload = {
    status: diff.acceptance.passed ? 'ok' : 'acceptance-failed',
    baseUrl,
    prototypeUrl,
    roles: roles.map((entry) => entry.role),
    ...files,
    summary: diff.summary,
    acceptance: diff.acceptance
  }
  console.log(JSON.stringify(payload, null, 2))
  process.exitCode = diff.acceptance.passed ? 0 : 1
} finally {
  await browser.close().catch(() => undefined)
}
