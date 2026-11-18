import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import {
  DEFAULT_PLATFORM_ROOT,
  REQUIRED_FILES,
  buildRelayBundle,
  collectImportClosure
} from './build-relay-bundle.mjs'

function tempDir(t, prefix = 'relay-bundle-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Walk raw 512-byte ustar headers, so pax/global headers cannot hide from the test. */
function readTarEntries(tgzPath) {
  const tar = gunzipSync(readFileSync(tgzPath))
  const entries = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const text = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '')
    const size = Number.parseInt(text(124, 12).trim() || '0', 8)
    const prefix = text(345, 155)
    const name = text(0, 100)
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(header[156]) || '\0',
      magic: text(257, 6),
      size,
      data: tar.subarray(offset + 512, offset + 512 + size)
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

function stableManifest(manifest) {
  return {
    bundleSha256: manifest.bundleSha256,
    schemaVersion: manifest.schemaVersion,
    relayCodeVersion: manifest.relayCodeVersion,
    files: manifest.files
  }
}

test('import closure matches the pinned required set exactly', () => {
  assert.deepEqual(collectImportClosure(DEFAULT_PLATFORM_ROOT), [...REQUIRED_FILES].sort())
})

test('two builds of the same input produce the same tgz sha and stable manifest', async (t) => {
  const outDir = tempDir(t)
  const first = await buildRelayBundle({ outDir, builtAt: '2026-11-17T00:00:00Z' })
  const second = await buildRelayBundle({ outDir, builtAt: '2027-01-01T00:00:00Z' })

  assert.equal(first.bundleSha256, second.bundleSha256)
  assert.deepEqual(stableManifest(first.manifest), stableManifest(second.manifest))
  assert.match(first.bundleSha256, /^[0-9a-f]{64}$/)
  assert.equal(first.tgzPath, second.tgzPath)
  assert.equal(first.manifestPath, join(outDir, `relay-bundle-${first.bundleSha256}.manifest.json`))
  assert.deepEqual(
    readFileSync(first.tgzPath),
    readFileSync(second.tgzPath),
    'tarball bytes must be identical'
  )
})

test('VERSION carries versions only and the manifest agrees with it', async (t) => {
  const outDir = tempDir(t)
  const { tgzPath, manifestPath, bundleSha256 } = await buildRelayBundle({ outDir })
  const entries = readTarEntries(tgzPath)
  const versionEntry = entries.find((entry) => entry.path === 'VERSION')
  assert.ok(versionEntry, 'VERSION must be packaged')

  const version = JSON.parse(versionEntry.data.toString('utf8'))
  assert.deepEqual(Object.keys(version).sort(), ['relayCodeVersion', 'schemaVersion'])

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.bundleSha256, bundleSha256)
  assert.equal(manifest.schemaVersion, version.schemaVersion)
  assert.equal(manifest.relayCodeVersion, version.relayCodeVersion)
  assert.match(manifestPath, new RegExp(`relay-bundle-${bundleSha256}\\.manifest\\.json$`))
})

test('tarball is fixed ustar with regular files only and no pax headers', async (t) => {
  const outDir = tempDir(t)
  const { tgzPath, manifest } = await buildRelayBundle({ outDir })
  const entries = readTarEntries(tgzPath)

  assert.deepEqual(
    entries.map((entry) => entry.path),
    manifest.files
  )
  for (const entry of entries) {
    assert.equal(entry.magic, 'ustar', `${entry.path} must be ustar`)
    assert.ok(entry.type === '0' || entry.type === '\0', `${entry.path} type ${entry.type}`)
    assert.ok(!['1', '2', '3', '4', '5', '6', 'x', 'g'].includes(entry.type))
  }
  assert.ok(entries.every((entry) => !entry.path.startsWith('/') && !entry.path.includes('..')))
})

test('changing one source byte changes the bundle sha', async (t) => {
  const platformRoot = tempDir(t, 'relay-fixture-')
  cpSync(join(DEFAULT_PLATFORM_ROOT, 'apps/relay/src'), join(platformRoot, 'apps/relay/src'), {
    recursive: true
  })
  cpSync(
    join(DEFAULT_PLATFORM_ROOT, 'apps/login-lockout/src'),
    join(platformRoot, 'apps/login-lockout/src'),
    { recursive: true }
  )
  cpSync(
    join(DEFAULT_PLATFORM_ROOT, 'packages/contract/src'),
    join(platformRoot, 'packages/contract/src'),
    { recursive: true }
  )

  const before = await buildRelayBundle({ platformRoot, outDir: tempDir(t) })
  writeFileSync(
    join(platformRoot, 'apps/relay/src/sni.ts'),
    `${readFileSync(join(platformRoot, 'apps/relay/src/sni.ts'), 'utf8')}\n// changed\n`
  )
  const after = await buildRelayBundle({ platformRoot, outDir: tempDir(t) })

  assert.notEqual(after.bundleSha256, before.bundleSha256)
  assert.notEqual(after.manifest.bundleSha256, before.manifest.bundleSha256)
})
