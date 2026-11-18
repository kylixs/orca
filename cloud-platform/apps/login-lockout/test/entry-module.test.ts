import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isEntryModule } from '../src/entry-module.ts'

/**
 * U302: Node's ESM entry realpaths `import.meta.url`, so the old literal-path
 * check went false for symlinked release dirs/files and the service silently
 * exited without listening.
 */

const SELF_PATH = import.meta.filename
const SELF_URL = import.meta.url

let fixtureRoot: string
let realFile: string
let realFileUrl: string
let dirLink: string
let fileLink: string

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'u302-entry-'))
  const realDir = join(fixtureRoot, 'real')
  mkdirSync(realDir)
  realFile = join(realDir, 'entry.ts')
  writeFileSync(realFile, '// fixture\n')
  // realpath because macOS /var -> /private/var; import.meta.url is a realpath too.
  realFileUrl = pathToFileURL(realpathSync.native(realFile)).href
  dirLink = join(fixtureRoot, 'current')
  symlinkSync(realDir, dirLink, process.platform === 'win32' ? 'junction' : 'dir')
  fileLink = join(fixtureRoot, 'entry-link.ts')
  symlinkSync(realFile, fileLink, 'file')
})

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

// Pre-U302 judgement, kept as the control the symlink cases must fail.
function legacyIsEntryModule(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false
  }
  return metaUrl === pathToFileURL(resolve(argv1)).href
}

test('absolute path to this module is the entry', () => {
  assert.equal(isEntryModule(SELF_URL, SELF_PATH), true)
})

test('relative path from cwd is the entry', () => {
  assert.equal(isEntryModule(SELF_URL, relative(process.cwd(), SELF_PATH)), true)
})

test('entry through a symlinked directory is the entry', () => {
  const viaDirLink = join(dirLink, 'entry.ts')
  assert.equal(isEntryModule(realFileUrl, viaDirLink), true)
  // The old check returned false here — exactly the silent-exit regression.
  assert.equal(legacyIsEntryModule(realFileUrl, viaDirLink), false)
})

test('entry through a symlinked file is the entry', () => {
  assert.equal(isEntryModule(realFileUrl, fileLink), true)
  assert.equal(legacyIsEntryModule(realFileUrl, fileLink), false)
})

test('symlinked metaUrl with the real entry is the entry', () => {
  // Only realpathing the self side makes a symlinked import.meta.url match argv[1].
  assert.equal(isEntryModule(pathToFileURL(fileLink).href, realFile), true)
  assert.equal(isEntryModule(pathToFileURL(join(dirLink, 'entry.ts')).href, realFile), true)
})

test('a non-file metaUrl is not the entry and does not throw', () => {
  assert.equal(isEntryModule('https://example.com/entry.ts', SELF_PATH), false)
  assert.equal(isEntryModule('data:text/javascript,export{}', SELF_PATH), false)
})

test('missing argv[1] is not the entry', () => {
  assert.equal(isEntryModule(SELF_URL, undefined), false)
})

test('nonexistent paths are not the entry', () => {
  const missing = join(fixtureRoot, 'missing.ts')
  assert.equal(isEntryModule(SELF_URL, missing), false)
  assert.equal(isEntryModule(pathToFileURL(missing).href, SELF_PATH), false)
})

test('a different existing file is not the entry', () => {
  assert.equal(isEntryModule(SELF_URL, realFile), false)
})
