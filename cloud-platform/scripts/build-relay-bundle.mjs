#!/usr/bin/env node
/**
 * Deterministic relay bundle builder (U183 R1).
 *
 * Produces a content-addressed tarball plus an out-of-band manifest:
 *   relay-bundle-<sha256>.tgz
 *   relay-bundle-<sha256>.manifest.json
 *
 * The tarball holds `VERSION` and the `relay.ts` import closure only. It never
 * contains its own sha or a build timestamp: those live in the manifest, so the
 * same inputs produce the same bytes. `VERSION` is { schemaVersion,
 * relayCodeVersion } from relay-version.ts.
 */
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { create, list } from 'tar'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PLATFORM_ROOT = resolve(SCRIPT_DIR, '..')
export const DEFAULT_OUT_DIR = join(DEFAULT_PLATFORM_ROOT, 'dist', 'relay-bundles')

const RELAY_ENTRY = 'apps/relay/src/relay.ts'
const ALLOWED_PREFIXES = ['apps/relay/src/', 'packages/contract/src/']
const VERSION_FILE = 'VERSION'

/**
 * Files the bundle must ship. R1 pins the closure so a new relay import is a
 * deliberate change, not a silent one (design v3 §2.3, P2-4).
 */
export const REQUIRED_FILES = [
  RELAY_ENTRY,
  'apps/relay/src/relay-version.ts',
  'apps/relay/src/sni.ts',
  'packages/contract/src/internal-fetch.ts'
]

const RELATIVE_IMPORT_RE = /(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g

function toPosix(path) {
  return path.split(sep).join('/')
}

function fail(message) {
  throw new Error(`[build-relay-bundle] ${message}`)
}

/** Resolve the relative-import closure starting at relay.ts. */
export function collectImportClosure(platformRoot) {
  const closure = new Set()
  const queue = [RELAY_ENTRY]

  while (queue.length > 0) {
    const file = queue.shift()
    if (closure.has(file)) continue
    const absolute = join(platformRoot, file)
    if (!existsSync(absolute)) fail(`missing source file: ${file}`)
    if (!lstatSync(absolute).isFile()) fail(`source is not a regular file: ${file}`)
    closure.add(file)

    const source = readFileSync(absolute, 'utf8')
    for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
      queue.push(resolveImport(platformRoot, file, match[1]))
    }
    for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      queue.push(resolveImport(platformRoot, file, match[1]))
    }
  }

  for (const file of closure) {
    if (!ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      fail(`import closure escaped the relay/contract source roots: ${file}`)
    }
  }
  for (const file of REQUIRED_FILES) {
    if (!closure.has(file)) fail(`required file is not in the relay import closure: ${file}`)
  }

  return [...closure].sort()
}

function resolveImport(platformRoot, importer, specifier) {
  if (!specifier.endsWith('.ts') && !specifier.endsWith('.mjs') && !specifier.endsWith('.js')) {
    fail(`import in ${importer} must include an extension: ${specifier}`)
  }
  const absolute = resolve(platformRoot, dirname(importer), specifier)
  const relativePath = toPosix(relative(platformRoot, absolute))
  if (relativePath.startsWith('..')) fail(`import in ${importer} escaped root: ${specifier}`)
  return relativePath
}

/** Read version constants from the relay source of truth. */
export async function readRelayVersions(platformRoot) {
  const versionModule = await import(
    pathToFileURL(join(platformRoot, 'apps/relay/src/relay-version.ts')).href
  )
  const { RELAY_BUNDLE_SCHEMA_VERSION, RELAY_CODE_VERSION } = versionModule
  if (!Number.isInteger(RELAY_BUNDLE_SCHEMA_VERSION)) {
    fail('relay-version.ts must export an integer RELAY_BUNDLE_SCHEMA_VERSION')
  }
  if (typeof RELAY_CODE_VERSION !== 'string' || RELAY_CODE_VERSION.length === 0) {
    fail('relay-version.ts must export a non-empty RELAY_CODE_VERSION')
  }
  return { schemaVersion: RELAY_BUNDLE_SCHEMA_VERSION, relayCodeVersion: RELAY_CODE_VERSION }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function writeAtomically(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, contents)
  renameSync(tmp, path)
}

/**
 * Build one bundle. `builtAt` is recorded in the manifest only and never enters
 * the tarball, so it cannot change the sha.
 */
export async function buildRelayBundle({
  platformRoot = DEFAULT_PLATFORM_ROOT,
  outDir = process.env.ORCA_RELAY_BUNDLE_OUT || DEFAULT_OUT_DIR,
  builtAt = new Date().toISOString()
} = {}) {
  const sourceFiles = collectImportClosure(platformRoot)
  const versions = await readRelayVersions(platformRoot)
  const versionContents = `${JSON.stringify(versions)}\n`

  mkdirSync(outDir, { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'relay-bundle-'))
  try {
    writeFileSync(join(staging, VERSION_FILE), versionContents)
    for (const file of sourceFiles) {
      const target = join(staging, file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(platformRoot, file), target)
      // Normalize mode so the sha depends on content, not checkout umask.
      chmodSync(target, 0o644)
    }

    const entries = [VERSION_FILE, ...sourceFiles].sort()
    const tmpTgz = join(staging, 'bundle.tgz')
    await create(
      {
        file: tmpTgz,
        cwd: staging,
        // Fixed ustar, sorted file list only, zeroed metadata, gzip without name/mtime.
        format: 'ustar',
        portable: true,
        noMtime: true,
        noDirRecurse: true,
        follow: false,
        gzip: true
      },
      entries
    )

    const tgz = readFileSync(tmpTgz)
    const bundleSha256 = sha256(tgz)
    const packagedVersion = await readVersionFromTarball(tmpTgz)
    const tgzPath = join(outDir, `relay-bundle-${bundleSha256}.tgz`)
    const manifestPath = join(outDir, `relay-bundle-${bundleSha256}.manifest.json`)

    // The manifest must agree with what the tarball actually declares.
    const manifest = {
      bundleSha256,
      schemaVersion: versions.schemaVersion,
      relayCodeVersion: versions.relayCodeVersion,
      files: entries,
      builtAt
    }
    if (manifest.schemaVersion !== packagedVersion.schemaVersion) {
      fail('manifest schemaVersion does not match the packaged VERSION')
    }
    if (manifest.relayCodeVersion !== packagedVersion.relayCodeVersion) {
      fail('manifest relayCodeVersion does not match the packaged VERSION')
    }

    writeFileSync(tgzPath, tgz)
    writeAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    return { tgzPath, manifestPath, bundleSha256, manifest, files: entries, versions }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Read `VERSION` back out of the finished tarball so the manifest is checked, not assumed. */
async function readVersionFromTarball(tgzPath) {
  let contents
  await list({
    file: tgzPath,
    onReadEntry: (entry) => {
      if (entry.path !== VERSION_FILE) return
      const chunks = []
      entry.on('data', (chunk) => chunks.push(chunk))
      entry.on('end', () => {
        contents = Buffer.concat(chunks).toString('utf8')
      })
    }
  })
  if (contents === undefined) fail('tarball is missing VERSION')
  return JSON.parse(contents)
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') options.platformRoot = resolve(argv[++index])
    else if (arg === '--out') options.outDir = resolve(argv[++index])
    else if (arg === '--help' || arg === '-h') options.help = true
    else fail(`unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(
      'usage: node cloud-platform/scripts/build-relay-bundle.mjs [--root <cloud-platform>] [--out <dir>]'
    )
    return
  }
  const result = await buildRelayBundle(options)
  console.log(`relay bundle: ${result.tgzPath}`)
  console.log(`sha256: ${result.bundleSha256}`)
  console.log(`manifest: ${result.manifestPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
