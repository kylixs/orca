import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/**
 * The web console is released separately from the API (design §11.3), so its
 * assets are served by content hash and every build is archived. An old page
 * still cached in a browser keeps resolving its own hashed URLs after a deploy
 * instead of white-screening on a 404.
 */

/** The API contract this build of the frontend speaks (AC-19 compatibility window). */
export const WEB_CONTRACT_VERSION = 1
/** The oldest contract still accepted; older frontends must reload. */
export const MIN_WEB_CONTRACT_VERSION = 1

const HASH_LENGTH = 12
const STATIC_FILES: readonly string[] = ['index.html', 'app.js', 'config.js', 'styles.css']

export type WebAsset = { name: string; sha256: string; bytes: Buffer; contentType: string }

export type WebRelease = {
  build: string
  files: Map<string, WebAsset>
}

function contentTypeFor(name: string): string {
  switch (extname(name)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    default:
      return 'text/html; charset=utf-8'
  }
}

/** A build id is the digest of every file's name and hash, so any change makes a new one. */
export function loadWebRelease(dir: string): WebRelease {
  const files = new Map<string, WebAsset>()
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => STATIC_FILES.includes(name)) : []
  for (const name of names.sort()) {
    const bytes = readFileSync(join(dir, name))
    files.set(name, {
      name,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
      contentType: contentTypeFor(name)
    })
  }
  const manifest = [...files.values()].map((file) => `${file.name}:${file.sha256}`).join('|')
  return { build: createHash('sha256').update(manifest).digest('hex').slice(0, HASH_LENGTH), files }
}

export type WebReleaseStore = {
  current: () => WebRelease
  /** Bytes for a build that is no longer current, restored from the archive. */
  resolve: (build: string, name: string) => WebAsset | null
  /** `index.html` pointing at this build's immutable asset URLs. */
  indexHtml: () => string
  assetPath: (build: string, name: string) => string
  /** Copies the current build aside so the next release can still serve it. */
  archive: () => void
}

export function createWebReleaseStore(options: {
  webRoot: string
  archiveDir?: string
}): WebReleaseStore {
  const current = loadWebRelease(options.webRoot)
  const archived = new Map<string, Map<string, WebAsset>>()

  const readArchived = (build: string): Map<string, WebAsset> | null => {
    const cached = archived.get(build)
    if (cached) {
      return cached
    }
    if (!options.archiveDir) {
      return null
    }
    const dir = join(options.archiveDir, build)
    if (!existsSync(dir)) {
      return null
    }
    const release = loadWebRelease(dir)
    // Why compare: a corrupt or partial archive must not answer for a build it is not.
    if (release.build !== build) {
      return null
    }
    archived.set(build, release.files)
    return release.files
  }

  const assetPath = (build: string, name: string): string => `/assets/${build}/${name}`

  return {
    current: () => current,
    resolve: (build, name) => {
      if (build === current.build) {
        return current.files.get(name) ?? null
      }
      return readArchived(build)?.get(name) ?? null
    },
    assetPath,
    indexHtml: () => {
      const html = current.files.get('index.html')
      if (!html) {
        return ''
      }
      let text = html.bytes.toString('utf8')
      for (const name of STATIC_FILES) {
        if (name === 'index.html') {
          continue
        }
        // Only the console's own top-level references; anything else is left alone.
        text = text.split(`"/${name}"`).join(`"${assetPath(current.build, name)}"`)
      }
      return text
    },
    archive: () => {
      if (!options.archiveDir) {
        return
      }
      const dir = join(options.archiveDir, current.build)
      if (existsSync(join(dir, 'index.html'))) {
        return
      }
      mkdirSync(dir, { recursive: true })
      for (const file of current.files.values()) {
        copyFileSync(join(options.webRoot, basename(file.name)), join(dir, file.name))
      }
    }
  }
}
