import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Both entries are served under the same static root, including behind a
// reverse-proxy path prefix, so both must reference assets relatively.
const entries = ['web-index.html', 'cloud-admin.html']
const outDir = resolve('out/web')
const assetsDir = join(outDir, 'assets')

const entryChunks = new Map()
for (const entry of entries) {
  const entryPath = resolve(outDir, entry)
  const html = await readFile(entryPath, 'utf8')
  const absoluteAssetReference = /\b(?:src|href)=["']\/assets\//.exec(html)
  if (absoluteAssetReference) {
    console.error(
      `Web build must use relative asset URLs for reverse-proxy pairing URLs; found ${absoluteAssetReference[0]} in ${entryPath}`
    )
    process.exit(1)
  }
  const entryChunk = /<script[^>]*type="module"[^>]*src="[^"]*assets\/([^"]+\.js)"/.exec(html)
  if (!entryChunk) {
    console.error(`Web build entry ${entryPath} has no module script chunk`)
    process.exit(1)
  }
  entryChunks.set(entry, entryChunk[1])
}

// Why: entry chunks run top-level mount side effects. A shared chunk must never
// import one, or loading that chunk on another entry page mounts the wrong root
// (U49: the cloud-admin page loaded the web entry and rendered WebConnect).
const chunkFiles = (await readdir(assetsDir)).filter((file) => file.endsWith('.js'))
const staleImporters = new Map([...entryChunks.values()].map((chunk) => [chunk, []]))
for (const file of chunkFiles) {
  const source = await readFile(join(assetsDir, file), 'utf8')
  for (const specifier of source.matchAll(/(?:from|import)\s*["'](?:\.\/)?([^"']+\.js)["']/g)) {
    const importers = staleImporters.get(specifier[1])
    if (importers && specifier[1] !== file) {
      importers.push(file)
    }
  }
}
for (const [entry, chunk] of entryChunks) {
  const importers = staleImporters.get(chunk)
  if (importers.length > 0) {
    console.error(
      `Web build entry chunk ${entry} -> ${chunk} is statically imported by ${importers.join(', ')}; ` +
        'entry mount side effects must stay out of shared chunks'
    )
    process.exit(1)
  }
}
