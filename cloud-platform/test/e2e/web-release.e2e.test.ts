import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, saveEvidence, spawnService, type Service } from './harness.ts'

/**
 * M78 (G-10 / AC-19): the web console ships independently of the API. Two real
 * platform processes see two builds; what a browser cached from the first must
 * still resolve afterwards, and an old frontend must never be met with a 404.
 */

const EVIDENCE = 'm78-web-release'
const WEB_SOURCE = join(ROOT, 'apps/web')

type ReleaseBody = {
  contract: number
  minContract: number
  build: string
  assets: Record<string, { path: string; sha256: string }>
}

/** A console copy whose app.js differs per version, as a real release would. */
function makeWebRoot(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orca-web-${version}-`))
  cpSync(WEB_SOURCE, dir, { recursive: true })
  const app = join(dir, 'app.js')
  writeFileSync(app, `${readFileSync(app, 'utf8')}\n// release ${version}\n`)
  return dir
}

async function startPlatform(webRoot: string, archiveDir: string): Promise<Service> {
  return spawnService(
    'apps/api/src/server.ts',
    { PORT: '0', ORCA_CLOUD_WEB_ROOT: webRoot, ORCA_CLOUD_WEB_ARCHIVE: archiveDir },
    /\[api\] listening on http:\/\/127\.0\.0\.1:(\d+)/,
    'api-web-release'
  )
}

test('AC-19 前端独立发布：旧构建资源仍可取、旧契约可用、不支持的契约返回 426 而非 404', async () => {
  const archiveDir = join(mkdtempSync(join(tmpdir(), 'orca-web-archive-')), 'releases')
  mkdirSync(archiveDir, { recursive: true })
  const buildA = makeWebRoot('v1')
  let first: Service | null = null
  let second: Service | null = null
  try {
    first = await startPlatform(buildA, archiveDir)

    const releaseA = (await (await fetch(`${first.url}/v1/web/release`)).json()) as ReleaseBody
    assert.equal(releaseA.contract, 1)
    assert.equal(releaseA.minContract, 1)
    const appPathA = releaseA.assets['app.js']?.path ?? ''
    assert.match(appPathA, new RegExp(`^/assets/${releaseA.build}/app\\.js$`))

    const index = await fetch(`${first.url}/`)
    const indexHtml = await index.text()
    assert.equal(index.status, 200)
    assert.equal(index.headers.get('cache-control'), 'no-cache')
    assert.equal(index.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(index.headers.get('x-orca-web-build'), releaseA.build)
    assert.ok(indexHtml.includes(appPathA), 'index must reference the hashed asset')
    assert.ok(indexHtml.includes(`/assets/${releaseA.build}/styles.css`))

    const hashed = await fetch(`${first.url}${appPathA}`)
    const hashedBody = await hashed.text()
    assert.equal(hashed.status, 200)
    assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    assert.equal(hashed.headers.get('referrer-policy'), 'no-referrer')
    assert.ok(hashedBody.includes('// release v1'))

    // Legacy unhashed path stays valid: a page cached before hashing existed.
    const legacy = await fetch(`${first.url}/app.js`)
    assert.equal(legacy.status, 200)
    assert.equal(legacy.headers.get('cache-control'), 'max-age=300')
    assert.equal(legacy.headers.get('referrer-policy'), 'no-referrer')
    assert.ok((legacy.headers.get('etag') ?? '').length > 2)

    // An old frontend (contract 1) still calls the endpoints it was built against.
    const oldFrontend = await fetch(`${first.url}/v1/projects`, {
      headers: { 'x-orca-web-contract': '1' }
    })
    // 401 (no token) means the route exists; what must not happen is 404 or 426.
    assert.equal(oldFrontend.status, 401)
    assert.notEqual(oldFrontend.status, 404)

    const tooNew = await fetch(`${first.url}/v1/projects`, {
      headers: { 'x-orca-web-contract': '2' }
    })
    const tooNewBody = (await tooNew.json()) as { error?: { code: string; details?: unknown } }
    assert.equal(tooNew.status, 426)
    assert.equal(tooNewBody.error?.code, 'WEB_CONTRACT_UNSUPPORTED')
    assert.deepEqual(tooNewBody.error?.details, {
      offered: 2,
      minContract: 1,
      maxContract: 1
    })

    const garbage = await fetch(`${first.url}/v1/projects`, {
      headers: { 'x-orca-web-contract': 'beta' }
    })
    assert.equal(garbage.status, 426)

    // Absent header means "current": clients that predate negotiation keep working.
    const noHeader = await fetch(`${first.url}/v1/projects`)
    assert.equal(noHeader.status, 401)

    await first.stop()

    // ---- a new console release is deployed on the same archive ----
    const buildB = makeWebRoot('v2')
    second = await startPlatform(buildB, archiveDir)
    const releaseB = (await (await fetch(`${second.url}/v1/web/release`)).json()) as ReleaseBody
    assert.notEqual(releaseB.build, releaseA.build)
    const indexB = await (await fetch(`${second.url}/`)).text()
    assert.ok(indexB.includes(releaseB.assets['app.js']?.path ?? ''))

    // The old page's own hashed URL must still answer with the OLD bytes.
    const oldAsset = await fetch(`${second.url}${appPathA}`)
    assert.equal(oldAsset.status, 200, 'a cached old page must not white-screen after a deploy')
    assert.ok((await oldAsset.text()).includes('// release v1'))

    // And the API compatibility window still serves contract 1.
    const contractAfterDeploy = await fetch(`${second.url}/v1/projects`, {
      headers: { 'x-orca-web-contract': '1' }
    })
    assert.equal(contractAfterDeploy.status, 401)

    saveEvidence(EVIDENCE, 'web-release.json', {
      buildA: releaseA.build,
      buildB: releaseB.build,
      assetPathA: appPathA,
      indexHeaders: {
        cacheControl: index.headers.get('cache-control'),
        referrerPolicy: index.headers.get('referrer-policy'),
        build: index.headers.get('x-orca-web-build')
      },
      oldContractStatus: oldFrontend.status,
      unsupportedContract: { status: tooNew.status, error: tooNewBody.error },
      oldAssetAfterDeploy: { status: oldAsset.status, retained: true }
    })
  } finally {
    await first?.stop()
    await second?.stop()
  }
})
