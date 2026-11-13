import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Both entries are served under the same static root, including behind a
// reverse-proxy path prefix, so both must reference assets relatively.
const entries = ['web-index.html', 'cloud-admin.html']

for (const entry of entries) {
  const entryPath = resolve('out/web', entry)
  const html = await readFile(entryPath, 'utf8')
  const absoluteAssetReference = /\b(?:src|href)=["']\/assets\//.exec(html)
  if (absoluteAssetReference) {
    console.error(
      `Web build must use relative asset URLs for reverse-proxy pairing URLs; found ${absoluteAssetReference[0]} in ${entryPath}`
    )
    process.exit(1)
  }
}
