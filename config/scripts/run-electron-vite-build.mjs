import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { appendBuildOldSpaceOption } from './node-old-space-limit.mjs'
import { RENDERER_BUILD_DIR, verifyRendererBootGraph } from './renderer-boot-graph.mjs'
import { verifyCloudBuildDefines } from './verify-cloud-build-defines.mjs'

const require = createRequire(import.meta.url)
const electronVitePackageJson = require.resolve('electron-vite/package.json')
const electronViteCli = path.join(path.dirname(electronVitePackageJson), 'bin', 'electron-vite.js')

// Release builds have started OOMing on GitHub's macOS runners during the
// renderer bundle. Reserve memory on smaller hosts so the OS does not kill Vite.
const nodeOptions = appendBuildOldSpaceOption(process.env.NODE_OPTIONS)

const child = spawn(process.execPath, [electronViteCli, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions
  }
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  if (code !== 0) {
    process.exit(code ?? 1)
  }

  // Why here: this is the only place a real renderer bundle exists, and the
  // boot graph is exactly what a stray static import silently regresses. The
  // target gate keeps the parallel runner's concurrent main/preload builds from
  // reading out/renderer while the renderer target is still writing it.
  const target = process.env.ORCA_ELECTRON_VITE_TARGET
  const builtRenderer =
    (!target || target === 'renderer') && fs.existsSync(path.join(RENDERER_BUILD_DIR, 'index.html'))
  // Why only a full build: per-target children run concurrently, so neither may
  // audit the bundle a sibling is still writing; the parallel runner audits once
  // after every target has finished.
  let exitCode = 0
  if (!target) {
    exitCode = verifyCloudBuildDefines()
  }
  if (exitCode === 0 && builtRenderer) {
    exitCode = verifyRendererBootGraph()
  }
  process.exit(exitCode)
})
